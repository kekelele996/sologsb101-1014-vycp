/**
 * 验收状态管理（Zustand）
 * 维护验收筛选条件、批量选中的记录与成活率等级草稿；
 * 外业验收队（成活株数/株高）与项目部（栽植总株数/缺株数）分开写各自的记录，
 * 按（地块 + 测次）对账，挂起期间不生成补植计划；
 * 成活率派生值统一由 hooks/useSurvivalRate 的纯函数产出，避免口径分散。
 */
import { create } from 'zustand';
import type { FieldSurveyDraft, OfficeSurveyDraft, OfflineSurveyPayload, RateLevel, Survey } from '../types/survey';
import {
  ROW_REVISION,
  db,
  initDatabase,
  patchSurveyGrades,
  putSurvey,
  removeSurvey,
  retryOfficeEntry,
  submitOfflineSurveys,
  syncPlotMissingCount,
  type OfflineSubmitResult,
  type OfficeRetryResult,
} from '../utils/db';
import type { SurvivalSummary } from '../hooks/useSurvivalRate';
import { nowIso, uuid } from '../utils/id';
import { calcSurvivalRate, rateLevel } from '../utils/rate';
import { buildReconciliation, latestRoundOf, resolveOfficeMissing, type ReconRound } from '../utils/reconcile';
import { usePlotStore } from './plotStore';

/** 验收筛选条件（地块 + 等级 + 对账状态 + 关键字 + 日期区间） */
export interface SurveyFilters {
  plotId: string | 'all';
  level: RateLevel | 'all';
  recon: 'all' | 'matched' | 'suspended';
  keyword: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: SurveyFilters = { plotId: 'all', level: 'all', recon: 'all', keyword: '', from: '', to: '' };

interface SurveyStoreState {
  filters: SurveyFilters;
  /** 批量操作选中的外业记录 id */
  selectedIds: string[];
  /** 批量调整使用的目标等级 */
  gradeDraft: RateLevel;
  /** 每次写操作后的版本号，页面据此重新拉取列表 */
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  setFilters: (patch: Partial<SurveyFilters>) => void;
  resetFilters: () => void;
  setSelectedIds: (ids: string[]) => void;
  setGradeDraft: (level: RateLevel) => void;
  /** 外业验收队录入测次：只写成活株数与株高 */
  createFieldEntry: (draft: FieldSurveyDraft) => Promise<Survey>;
  /** 项目部交回台账：只写栽植总株数，缺株数按口径算出 */
  createOfficeEntry: (draft: OfficeSurveyDraft) => Promise<Survey>;
  /** 编辑已有记录：按记录来源只改本方字段 */
  updateSurvey: (surveyId: string, draft: FieldSurveyDraft | OfficeSurveyDraft) => Promise<void>;
  deleteSurvey: (surveyId: string) => Promise<void>;
  /** 批量调整成活率等级（人工复核，仅外业行） */
  bulkApplyGrade: (level: RateLevel) => Promise<number>;
  /** 离线交回：批量接收两边记录，同（地块 + 测次 + 来源）重复交只留一份 */
  submitOffline: (payloads: OfflineSurveyPayload[]) => Promise<OfflineSubmitResult>;
  /** 项目部对账失败后重试：只重存项目部那一份，外业测次照旧 */
  retryOffice: (plotId: string, round: number) => Promise<OfficeRetryResult>;
  /** 按最新测次生成补植计划（最新测次挂起时拒绝生成） */
  generateReplant: (plotId: string) => Promise<{ ok: boolean; message: string }>;
  /** 全量对账结果（派生，不落库） */
  reconciliation: () => ReconRound[];
  summaryOf: (plotId: string | null) => SurvivalSummary;
  rateStats: () => { total: number; warnCount: number; avgRate: number };
}

/** 栽植记录合计（未对平时的暂定分母） */
function totalPlantedOf(plotId: string): number {
  return usePlotStore
    .getState()
    .plantings.filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);
}

/** 外业行成活率分母：同测次项目部栽植总株数优先，否则回退栽植记录合计 */
function rateDenominatorOf(plotId: string, round: number): number {
  const office = usePlotStore
    .getState()
    .surveys.find((row) => row.plotId === plotId && row.round === round && row.source === 'office');
  if (office !== undefined && office.totalPlanted > 0) return office.totalPlanted;
  return totalPlantedOf(plotId);
}

export const useSurveyStore = create<SurveyStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  selectedIds: [],
  gradeDraft: 'good',
  revision: 0,
  lastMessage: '',

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS }, selectedIds: [] });
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setGradeDraft(level) {
    set({ gradeDraft: level });
  },

  async createFieldEntry(draft) {
    const survivalRate = calcSurvivalRate(draft.aliveCount, rateDenominatorOf(draft.plotId, draft.round));
    const stamp = nowIso();
    const row: Survey = {
      id: uuid('survey'),
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      source: 'field',
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      totalPlanted: 0,
      missingCount: 0,
      survivalRate,
      grade: rateLevel(survivalRate),
      gradeManual: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putSurvey(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async createOfficeEntry(draft) {
    const surveys = usePlotStore.getState().surveys;
    // 缺株数按「栽植总株数 − 最新成活株数」算出，不由项目部手填
    const missingCount = resolveOfficeMissing(draft.plotId, draft.round, draft.totalPlanted, surveys);
    const stamp = nowIso();
    const row: Survey = {
      id: uuid('survey'),
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      source: 'office',
      aliveCount: 0,
      avgHeightCm: 0,
      totalPlanted: draft.totalPlanted,
      missingCount,
      survivalRate: 0,
      grade: 'poor',
      gradeManual: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putSurvey(row);
    // 最新测次对平时回写地块台账缺株数；挂起则保持原值
    await syncPlotMissingCount(draft.plotId);
    set({ revision: get().revision + 1 });
    return row;
  },

  async updateSurvey(surveyId, draft) {
    const existing = await db.surveys.get(surveyId);
    if (!existing) return;
    if (existing.source === 'field') {
      const fieldDraft = draft as FieldSurveyDraft;
      const survivalRate = calcSurvivalRate(fieldDraft.aliveCount, rateDenominatorOf(fieldDraft.plotId, fieldDraft.round));
      await putSurvey({
        ...existing,
        plotId: fieldDraft.plotId,
        round: fieldDraft.round,
        date: fieldDraft.date,
        aliveCount: fieldDraft.aliveCount,
        avgHeightCm: fieldDraft.avgHeightCm,
        survivalRate,
      });
    } else {
      const officeDraft = draft as OfficeSurveyDraft;
      const surveys = usePlotStore.getState().surveys;
      const missingCount = resolveOfficeMissing(officeDraft.plotId, officeDraft.round, officeDraft.totalPlanted, surveys);
      await putSurvey({
        ...existing,
        plotId: officeDraft.plotId,
        round: officeDraft.round,
        date: officeDraft.date,
        totalPlanted: officeDraft.totalPlanted,
        missingCount,
      });
      await syncPlotMissingCount(officeDraft.plotId);
    }
    set({ revision: get().revision + 1 });
  },

  async deleteSurvey(surveyId) {
    await removeSurvey(surveyId);
    set({ selectedIds: get().selectedIds.filter((id) => id !== surveyId), revision: get().revision + 1 });
  },

  async bulkApplyGrade(level) {
    const ids = get().selectedIds;
    if (ids.length === 0) return 0;
    // 人工复核只改写等级标注，不改写实测成活率数值，保证数据可追溯
    await patchSurveyGrades(ids, level);
    set({ revision: get().revision + 1, lastMessage: `已批量调整 ${ids.length} 条外业记录的成活率等级` });
    return ids.length;
  },

  async submitOffline(payloads) {
    const stamp = nowIso();
    const rows: Array<Partial<Survey>> = payloads.map((payload) => {
      const denominator = rateDenominatorOf(payload.plotId, payload.round);
      const survivalRate =
        payload.source === 'field' ? calcSurvivalRate(payload.aliveCount ?? 0, denominator) : 0;
      return {
        id: uuid('survey'),
        plotId: payload.plotId,
        round: payload.round,
        date: payload.date,
        source: payload.source,
        aliveCount: payload.source === 'field' ? payload.aliveCount ?? 0 : 0,
        avgHeightCm: payload.source === 'field' ? payload.avgHeightCm ?? 0 : 0,
        totalPlanted: payload.source === 'office' ? payload.totalPlanted ?? 0 : 0,
        survivalRate,
        grade: rateLevel(survivalRate),
        gradeManual: false,
        createdAt: stamp,
        updatedAt: stamp,
      };
    });
    const result = await submitOfflineSurveys(rows);
    // 交回后按最新对账结果回写相关地块的台账缺株数
    const plotIds = [...new Set(payloads.map((payload) => payload.plotId))];
    for (const plotId of plotIds) {
      await syncPlotMissingCount(plotId);
    }
    set({
      revision: get().revision + 1,
      lastMessage: `离线交回完成：落库 ${result.saved} 份，去重 ${result.duplicates} 份，当前挂起 ${result.suspended} 个测次`,
    });
    return result;
  },

  async retryOffice(plotId, round) {
    const result = await retryOfficeEntry(plotId, round);
    set({ revision: get().revision + 1, lastMessage: result.message });
    return result;
  },

  async generateReplant(plotId) {
    const plot = usePlotStore.getState().plots.find((row) => row.id === plotId);
    if (!plot) return { ok: false, message: '地块不存在，无法生成补植计划' };
    const surveys = usePlotStore.getState().surveys.filter((row) => row.plotId === plotId);
    const latest = latestRoundOf(buildReconciliation(surveys), plotId);
    if (latest === null) return { ok: false, message: '该地块尚无验收测次，无法生成补植计划' };
    if (latest.state !== 'matched') {
      return {
        ok: false,
        message: `第 ${latest.round} 测次挂起待复核（${latest.problems.join('；')}），挂起期间不生成补植计划`,
      };
    }
    const missing = latest.missingCount ?? 0;
    if (missing <= 0) return { ok: false, message: '该地块当前无缺株，无需生成补植计划' };
    const species = usePlotStore.getState().seedlings.find((row) => row.plotId === plotId)?.species ?? '秋茄';
    const stamp = nowIso();
    await db.replants.put({
      id: uuid('replant'),
      plotId,
      missingCount: missing,
      planDate: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      species,
      state: '待补植',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    const message = `已为「${plot.name}」生成补植计划：缺株 ${missing} 株`;
    set({ revision: get().revision + 1, lastMessage: message });
    return { ok: true, message };
  },

  reconciliation() {
    return buildReconciliation(usePlotStore.getState().surveys);
  },

  summaryOf(plotId) {
    return usePlotStore.getState().summaryOf(plotId);
  },

  rateStats() {
    const { summaries } = usePlotStore.getState();
    const list = Object.values(summaries);
    const withSurvey = list.filter((item) => item.latest !== null);
    if (withSurvey.length === 0) return { total: 0, warnCount: 0, avgRate: 0 };
    const sum = withSurvey.reduce((acc, item) => acc + item.latestRate, 0);
    return {
      total: withSurvey.length,
      warnCount: withSurvey.filter((item) => item.warn).length,
      avgRate: Math.round((sum / withSurvey.length) * 10) / 10,
    };
  },
}));
