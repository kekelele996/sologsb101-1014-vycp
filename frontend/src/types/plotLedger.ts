/**
 * 项目部地块台账（PlotLedger）
 * 与外业验收（Survey）分开记账：
 * - 外业验收队记成活株数、平均株高（surveys 表）；
 * - 项目部记栽植总株数、缺株数（本表）。
 * 两边都按「地块编号 + 测次」对账；缺株数由 栽植总株数 − 最新成活株数 派生，
 * 对账对不上时把对账状态置为「挂起」，挂起期间不生成补植计划。
 */

/** 对账状态：未对账 / 一致 / 挂起待复核 */
export type ReconcileState = 'pending' | 'matched' | 'suspended';

export const RECONCILE_STATE_LABEL: Record<ReconcileState, string> = {
  pending: '未对账',
  matched: '一致',
  suspended: '挂起待复核',
};

export interface PlotLedger {
  id: string;
  /** 所属地块（地块编号） */
  plotId: string;
  /** 测次（1、2、3……），与外业验收同一口径 */
  round: number;
  /** 栽植总株数（项目部口径） */
  plantedTotal: number;
  /** 缺株数 = 栽植总株数 − 最新外业成活株数（对账时算出，非手填） */
  missingCount: number;
  /** 外业最新成活株数快照（对账时写入，用于解释缺株数与挂起原因） */
  latestAliveCount: number | null;
  /** 对账状态 */
  reconcileState: ReconcileState;
  /** 挂起 / 对账备注（如：外业测次缺失、成活株数大于栽植总株数） */
  reconcileNote: string;
  /** 台账登记日期 YYYY-MM-DD */
  date: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 项目部离线交回 / 编辑台账的表单草稿（缺株数不由人工填写） */
export interface PlotLedgerDraft {
  plotId: string;
  round: number;
  plantedTotal: number;
  date: string;
}
