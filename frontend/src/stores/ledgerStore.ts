/**
 * 项目部地块台账状态管理（Zustand）
 * 项目部只记「栽植总株数」（缺株数由对账算出），按地块 + 测次与外业验收对账；
 * 离线交回 / 对账失败重试都以「地块 + 测次」为幂等键 upsert，只动自己这一份，外业测次不触碰。
 * 挂起待复核的台账走复核（recheck），复核通过前不生成补植计划。
 */
import { create } from 'zustand';
import type { PlotLedger, PlotLedgerDraft, ReconcileState } from '../types/plotLedger';
import {
  db,
  initDatabase,
  recheckPlotLedger,
  removePlotLedger,
  submitProjectLedger,
  ROW_REVISION,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { usePlotStore } from './plotStore';

/** 台账筛选条件 */
export interface LedgerFilters {
  plotId: string | 'all';
  reconcileState: ReconcileState | 'all';
  keyword: string;
}

export interface LedgerStoreState {
  filters: LedgerFilters;
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  setFilters: (patch: Partial<LedgerFilters>) => void;
  resetFilters: () => void;
  /** 项目部（离线）交回一条台账：同地块同测次幂等 upsert，并立即对账 */
  submitLedger: (draft: PlotLedgerDraft) => Promise<PlotLedger>;
  /** 对账失败 / 挂起后只重试自己那一份（外业测次照旧不动） */
  retryLedger: (ledgerId: string) => Promise<PlotLedger | null>;
  /** 复核：按最新外业记录重新对账（仍对不上则保持挂起） */
  recheckLedger: (ledgerId: string) => Promise<PlotLedger | null>;
  /** 复核时修正项目部栽植总株数后重新交回对账 */
  correctAndSubmit: (ledgerId: string, patch: Pick<PlotLedgerDraft, 'plantedTotal' | 'date'>) => Promise<PlotLedger | null>;
  deleteLedger: (ledgerId: string) => Promise<void>;
}

const EMPTY_FILTERS: LedgerFilters = { plotId: 'all', reconcileState: 'all', keyword: '' };

/** 组装一条待交回台账（缺株数 / 对账状态在 submitProjectLedger 内算出） */
function buildLedger(draft: PlotLedgerDraft, existing?: PlotLedger): PlotLedger {
  const stamp = nowIso();
  return {
    id: existing?.id ?? uuid('ledger'),
    plotId: draft.plotId,
    round: draft.round,
    plantedTotal: draft.plantedTotal,
    // 交回前的占位值，真正结果由 submitProjectLedger 对账后写回
    missingCount: existing?.missingCount ?? 0,
    latestAliveCount: existing?.latestAliveCount ?? null,
    reconcileState: existing?.reconcileState ?? 'pending',
    reconcileNote: existing?.reconcileNote ?? '',
    date: draft.date,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
}

export const useLedgerStore = create<LedgerStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
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
    set({ filters: { ...EMPTY_FILTERS } });
  },

  async submitLedger(draft) {
    const surveys = usePlotStore.getState().surveys;
    const existing = await db.plotLedgers.where({ plotId: draft.plotId, round: draft.round }).first();
    const saved = await submitProjectLedger(buildLedger(draft, existing), surveys);
    set({
      revision: get().revision + 1,
      lastMessage:
        saved.reconcileState === 'suspended'
          ? `第 ${saved.round} 测次对账挂起：${saved.reconcileNote}`
          : `第 ${saved.round} 测次对账一致，缺株 ${saved.missingCount} 株`,
    });
    return saved;
  },

  async retryLedger(ledgerId) {
    const existing = await db.plotLedgers.get(ledgerId);
    if (existing === undefined) return null;
    // 只重试项目部自己这一份：栽植总株数沿用原值，按最新外业成活株数重新对账
    const surveys = usePlotStore.getState().surveys;
    const saved = await submitProjectLedger(existing, surveys);
    set({
      revision: get().revision + 1,
      lastMessage:
        saved.reconcileState === 'suspended'
          ? `重试后仍挂起：${saved.reconcileNote}`
          : `重试成功，第 ${saved.round} 测次已对账一致`,
    });
    return saved;
  },

  async recheckLedger(ledgerId) {
    const surveys = usePlotStore.getState().surveys;
    const saved = await recheckPlotLedger(ledgerId, surveys);
    if (saved === null) return null;
    set({
      revision: get().revision + 1,
      lastMessage:
        saved.reconcileState === 'suspended'
          ? `复核后仍对不上，继续挂起：${saved.reconcileNote}`
          : `复核通过，第 ${saved.round} 测次已对账一致`,
    });
    return saved;
  },

  async correctAndSubmit(ledgerId, patch) {
    const existing = await db.plotLedgers.get(ledgerId);
    if (existing === undefined) return null;
    const surveys = usePlotStore.getState().surveys;
    const corrected: PlotLedger = {
      ...existing,
      plantedTotal: patch.plantedTotal,
      date: patch.date,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    const saved = await submitProjectLedger(corrected, surveys);
    set({ revision: get().revision + 1, lastMessage: `已按修正后的栽植总株数重新交回对账` });
    return saved;
  },

  async deleteLedger(ledgerId) {
    await removePlotLedger(ledgerId);
    set({ revision: get().revision + 1, lastMessage: '已删除该项目部台账（外业测次不受影响）' });
  },
}));
