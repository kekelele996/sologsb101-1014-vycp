/**
 * 验收测次对账（纯函数）
 * 外业验收队与项目部按（地块编号 + 测次）对账：
 * - 两边都交且数值自洽（缺株数 = 栽植总株数 − 成活株数）→ 对平；
 * - 缺任何一方、或数值对不上 → 挂起待复核，挂起期间不生成补植计划。
 * 离线交回重复记录按（地块 + 测次 + 来源）去重，只留最新一份。
 */
import type { ReconcileState, Survey, SurveySource } from '../types/survey';
import { calcMissingCount, calcSurvivalRate, rateLevel } from './rate';
import { nowIso, uuid } from './id';

/** 单个（地块 + 测次）的对账结果 */
export interface ReconRound {
  plotId: string;
  round: number;
  /** 外业验收队那一份（去重后），未交为 null */
  field: Survey | null;
  /** 项目部那一份（去重后），未交为 null */
  office: Survey | null;
  /** 对账状态：对平 / 挂起待复核 */
  state: ReconcileState;
  /** 挂起原因（对平时为空数组） */
  problems: string[];
  /** 对平后的缺株数（栽植总株数 − 成活株数）；对不上时为 null */
  missingCount: number | null;
  /** 对平后按项目部栽植总株数算的成活率；对不上时为 null（不用过期数） */
  survivalRate: number | null;
}

/** 去重键：同一地块同一测次同一来源只留一份 */
export function surveyKey(plotId: string, round: number, source: SurveySource): string {
  return `${plotId}|${round}|${source}`;
}

/** 取两份中较新的一份（updatedAt 晚的优先，并列时保留后出现的一份） */
function newerOf(a: Survey, b: Survey): Survey {
  return b.updatedAt >= a.updatedAt ? b : a;
}

/**
 * 按（地块 + 测次 + 来源）去重：离线重复交回的记录只留最新一份。
 * 输入顺序无关，输出保持 id 稳定（保留较新那一份的 id 与 createdAt 中较早者）。
 */
export function dedupeSurveys(rows: Survey[]): Survey[] {
  const byKey = new Map<string, Survey>();
  rows.forEach((row) => {
    const key = surveyKey(row.plotId, row.round, row.source);
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? row : newerOf(existing, row));
  });
  return [...byKey.values()];
}

/** 对单个（地块 + 测次）配对两边记录并判定对账状态 */
export function reconcileRound(plotId: string, round: number, field: Survey | null, office: Survey | null): ReconRound {
  const problems: string[] = [];
  if (field === null) problems.push('缺外业验收记录');
  if (office === null) problems.push('缺项目部台账记录');
  if (field !== null && office !== null) {
    if (field.aliveCount > office.totalPlanted) {
      problems.push(`成活株数 ${field.aliveCount} 超过栽植总株数 ${office.totalPlanted}`);
    }
    const expected = calcMissingCount(office.totalPlanted, field.aliveCount);
    if (office.missingCount !== expected) {
      problems.push(`缺株数对不上：台账 ${office.missingCount} 株，按口径应为 ${expected} 株`);
    }
  }
  const matched = problems.length === 0 && field !== null && office !== null;
  return {
    plotId,
    round,
    field,
    office,
    state: matched ? 'matched' : 'suspended',
    problems,
    missingCount: matched && office !== null ? office.missingCount : null,
    survivalRate: matched && field !== null && office !== null ? calcSurvivalRate(field.aliveCount, office.totalPlanted) : null,
  };
}

/**
 * 全量对账：先按（地块 + 测次 + 来源）去重，再按（地块 + 测次）配对。
 * 返回按地块、测次升序排列的对账结果。
 */
export function buildReconciliation(surveys: Survey[]): ReconRound[] {
  const deduped = dedupeSurveys(surveys);
  const groups = new Map<string, { plotId: string; round: number; field: Survey | null; office: Survey | null }>();
  deduped.forEach((row) => {
    const key = `${row.plotId}|${row.round}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { plotId: row.plotId, round: row.round, field: null, office: null };
      groups.set(key, group);
    }
    if (row.source === 'field') group.field = row;
    else group.office = row;
  });
  return [...groups.values()]
    .map((group) => reconcileRound(group.plotId, group.round, group.field, group.office))
    .sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

/** 取某地块的对账结果（按测次升序） */
export function roundsOfPlot(rounds: ReconRound[], plotId: string): ReconRound[] {
  return rounds.filter((round) => round.plotId === plotId).sort((a, b) => a.round - b.round);
}

/** 某地块最新一个测次的对账结果（无测次时为 null） */
export function latestRoundOf(rounds: ReconRound[], plotId: string): ReconRound | null {
  const own = roundsOfPlot(rounds, plotId);
  return own.length > 0 ? own[own.length - 1] : null;
}

/** 某地块当前是否有挂起待复核的测次 */
export function hasSuspendedRound(rounds: ReconRound[], plotId: string): boolean {
  return roundsOfPlot(rounds, plotId).some((round) => round.state === 'suspended');
}

/**
 * 项目部缺株数口径：栽植总株数 − 最新成活株数。
 * 优先取同测次外业成活株数；该测次外业未交时取该地块最新外业测次；都没有则为 0。
 */
export function resolveOfficeMissing(plotId: string, round: number, totalPlanted: number, surveys: Survey[]): number {
  const fieldRows = surveys
    .filter((row) => row.plotId === plotId && row.source === 'field')
    .sort((a, b) => a.round - b.round);
  const sameRound = fieldRows.find((row) => row.round === round);
  const latest = fieldRows.length > 0 ? fieldRows[fieldRows.length - 1] : null;
  const alive = sameRound?.aliveCount ?? latest?.aliveCount ?? 0;
  return calcMissingCount(totalPlanted, alive);
}

/**
 * 规范化验收/台账记录（升级迁移与离线导入共用）：
 * 1）旧记录没标来源的，按现有测次补上外业归属（source = 'field'）；
 * 2）按（地块 + 测次 + 来源）去重，只留最新一份；
 * 3）补齐缺省字段，项目部行缺株数按口径重算；
 * 处理后的记录可直接参与对账。
 */
export function normalizeSurveyRows(rows: Array<Partial<Survey>>): Survey[] {
  const stamp = nowIso();
  const cleaned: Survey[] = [];
  rows.forEach((row) => {
    if (typeof row.plotId !== 'string' || row.plotId === '') return;
    if (typeof row.round !== 'number' || !Number.isFinite(row.round)) return;
    const source: SurveySource = row.source === 'office' ? 'office' : 'field';
    const survivalRate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
    cleaned.push({
      id: typeof row.id === 'string' && row.id !== '' ? row.id : uuid('survey'),
      plotId: row.plotId,
      round: row.round,
      date: typeof row.date === 'string' ? row.date : stamp.slice(0, 10),
      source,
      aliveCount: source === 'field' && typeof row.aliveCount === 'number' ? row.aliveCount : 0,
      avgHeightCm: source === 'field' && typeof row.avgHeightCm === 'number' ? row.avgHeightCm : 0,
      totalPlanted: source === 'office' && typeof row.totalPlanted === 'number' ? row.totalPlanted : 0,
      missingCount: source === 'office' && typeof row.missingCount === 'number' ? row.missingCount : 0,
      survivalRate: source === 'field' ? survivalRate : 0,
      grade: source === 'field' && typeof row.grade === 'string' ? row.grade : rateLevel(survivalRate),
      gradeManual: source === 'field' && row.gradeManual === true,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : stamp,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : stamp,
      revision: typeof row.revision === 'number' ? row.revision : 0,
    });
  });
  const deduped = dedupeSurveys(cleaned);
  // 项目部行缺株数按「栽植总株数 − 最新成活株数」口径重算，保证升上来即可对账
  return deduped.map((row) =>
    row.source === 'office'
      ? { ...row, missingCount: resolveOfficeMissing(row.plotId, row.round, row.totalPlanted, deduped) }
      : row,
  );
}
