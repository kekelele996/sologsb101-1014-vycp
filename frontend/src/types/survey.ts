/**
 * 成活率验收（Survey）
 * 验收测次与项目部台账分开记：同一（地块 + 测次）下，
 * 外业验收队只写「成活株数 / 平均株高」，项目部只写「栽植总株数 / 缺株数」，
 * 两边各存各的行，互不顶掉；按（地块编号 + 测次）对账，对不上先挂起待复核。
 */

/** 成活率等级：优 / 良 / 一般 / 差 */
export type RateLevel = 'excellent' | 'good' | 'fair' | 'poor';

export const RATE_LEVEL_LABEL: Record<RateLevel, string> = {
  excellent: '优',
  good: '良',
  fair: '一般',
  poor: '差',
};

export const RATE_LEVEL_OPTIONS: RateLevel[] = ['excellent', 'good', 'fair', 'poor'];

/** 记录来源：field = 外业验收队；office = 项目部 */
export type SurveySource = 'field' | 'office';

export const SURVEY_SOURCE_LABEL: Record<SurveySource, string> = {
  field: '外业验收队',
  office: '项目部',
};

export const SURVEY_SOURCE_OPTIONS: SurveySource[] = ['field', 'office'];

/** 对账状态：matched = 对平；suspended = 挂起待复核 */
export type ReconcileState = 'matched' | 'suspended';

export const RECONCILE_STATE_LABEL: Record<ReconcileState, string> = {
  matched: '对平',
  suspended: '挂起待复核',
};

export interface Survey {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 测次（1、2、3……） */
  round: number;
  /** 验收/交回日期 YYYY-MM-DD */
  date: string;
  /** 记录来源：外业验收队 / 项目部（升级迁移时旧记录统一补记为外业） */
  source: SurveySource;
  /** 成活株数（外业验收队填写；项目部行恒为 0） */
  aliveCount: number;
  /** 平均株高（厘米）（外业验收队填写；项目部行恒为 0） */
  avgHeightCm: number;
  /** 栽植总株数（项目部填写；外业行恒为 0） */
  totalPlanted: number;
  /** 缺株数（项目部行）——按「栽植总株数 − 最新成活株数」算出，不手填 */
  missingCount: number;
  /** 成活率（百分比，保留 1 位小数）——默认由成活株数 / 栽植总株数派生 */
  survivalRate: number;
  /** 成活率等级——默认按区间自动判定，可人工批量调整（仅外业行使用） */
  grade: RateLevel;
  /** 该等级是否被人工调整过 */
  gradeManual: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 外业验收队录入测次的表单草稿：只含成活株数与株高 */
export interface FieldSurveyDraft {
  plotId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
}

/** 项目部交回台账的表单草稿：只含栽植总株数，缺株数由系统按口径算出 */
export interface OfficeSurveyDraft {
  plotId: string;
  round: number;
  date: string;
  totalPlanted: number;
}

/** 离线交回的单条记录：来源决定有效字段，重复交按（地块 + 测次 + 来源）去重 */
export interface OfflineSurveyPayload {
  plotId: string;
  round: number;
  date: string;
  source: SurveySource;
  /** 外业字段 */
  aliveCount?: number;
  avgHeightCm?: number;
  /** 项目部字段 */
  totalPlanted?: number;
}

/** @deprecated 兼容旧引用，请改用 FieldSurveyDraft */
export type SurveyDraft = FieldSurveyDraft;
