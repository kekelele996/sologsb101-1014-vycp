/**
 * 外业验收（Survey）与项目部台账（PlotLedger）对账纯函数
 *
 * 口径：
 * - 两边都按「地块编号 plotId + 测次 round」配对；
 * - 缺株数 = 项目部栽植总株数 − 最新成活株数（本测次外业登记值，即截至该测次的最新值）；
 * - 对不上（外业缺测次、或成活株数大于栽植总株数）时置「挂起待复核」，挂起期间不生成补植计划。
 *
 * 纯函数不触碰数据库，便于单测与在 liveQuery 派生中复用。
 */
import type { Survey } from '../types/survey';
import type { PlotLedger, ReconcileState } from '../types/plotLedger';
import { suggestReplantCount } from './rate';

/** 某地块的外业测次，按测次升序 */
export function surveysOfPlot(plotId: string, surveys: Survey[]): Survey[] {
  return surveys
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round);
}

/** 取某地块指定测次的外业记录（对账配对用） */
export function findSurveyRound(plotId: string, round: number, surveys: Survey[]): Survey | undefined {
  return surveys.find((row) => row.plotId === plotId && row.round === round);
}

/** 某地块最新一次外业测次（round 最大） */
export function latestSurveyOfPlot(plotId: string, surveys: Survey[]): Survey | undefined {
  return surveysOfPlot(plotId, surveys).at(-1);
}

/** 对账计算结果（在台账行上派生，不直接落库，由保存/交回时写回） */
export interface ReconcileResult {
  missingCount: number;
  latestAliveCount: number | null;
  reconcileState: ReconcileState;
  reconcileNote: string;
}

/**
 * 对单条项目部台账按地块 + 测次与外业记录对账。
 * @param ledger 项目部台账行（用到 plotId / round / plantedTotal）
 * @param surveys 全部外业验收记录
 */
export function reconcileLedger(ledger: Pick<PlotLedger, 'plotId' | 'round' | 'plantedTotal'>, surveys: Survey[]): ReconcileResult {
  const pair = findSurveyRound(ledger.plotId, ledger.round, surveys);

  // 对不上 1：外业还没有同一地块同一测次的记录，挂起等外业交回复核
  if (pair === undefined) {
    return {
      missingCount: 0,
      latestAliveCount: null,
      reconcileState: 'suspended',
      reconcileNote: `外业验收队尚未交回第 ${ledger.round} 测次，暂无法对账`,
    };
  }

  // 对不上 2：成活株数大于栽植总株数，数据矛盾，挂起等复核
  if (pair.aliveCount > ledger.plantedTotal) {
    return {
      missingCount: 0,
      latestAliveCount: pair.aliveCount,
      reconcileState: 'suspended',
      reconcileNote: `第 ${ledger.round} 测次成活 ${pair.aliveCount} 株，多于栽植总株数 ${ledger.plantedTotal} 株，请复核`,
    };
  }

  // 一致：缺株数 = 栽植总株数 − 最新成活株数
  const missingCount = suggestReplantCount(ledger.plantedTotal, pair.aliveCount);
  return {
    missingCount,
    latestAliveCount: pair.aliveCount,
    reconcileState: 'matched',
    reconcileNote: `第 ${ledger.round} 测次对账一致：栽植 ${ledger.plantedTotal} − 成活 ${pair.aliveCount} = 缺株 ${missingCount}`,
  };
}

/** 对账后的台账视图（台账行 + 派生结果） */
export interface ReconciledLedger extends PlotLedger, ReconcileResult {}

/** 对某地块全部台账行逐条对账，按测次升序返回 */
export function reconcilePlot(plotId: string, ledgers: PlotLedger[], surveys: Survey[]): ReconciledLedger[] {
  return ledgers
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round)
    .map((row) => ({ ...row, ...reconcileLedger(row, surveys) }));
}

/** 该地块是否存在挂起待复核的台账（挂起期间不生成补植计划） */
export function plotHasSuspended(plotId: string, ledgers: PlotLedger[], surveys: Survey[]): boolean {
  return ledgers
    .filter((row) => row.plotId === plotId)
    .some((row) => reconcileLedger(row, surveys).reconcileState === 'suspended');
}

/** 取该地块最新一条「已对账一致」台账的缺株数；无一致记录时返回 null */
export function latestMatchedMissing(plotId: string, ledgers: PlotLedger[], surveys: Survey[]): number | null {
  const rows = reconcilePlot(plotId, ledgers, surveys).filter((row) => row.reconcileState === 'matched');
  if (rows.length === 0) return null;
  return rows[rows.length - 1].missingCount;
}
