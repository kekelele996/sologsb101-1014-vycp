/**
 * 数据归属（谁负责记录）
 * - field：外业验收队 —— 成活株数、平均株高
 * - project：项目部 —— 栽植总株数、缺株数
 * 两边各记各的，不再混在同一行互相覆盖。
 */
export type DataOwner = 'field' | 'project';

export const DATA_OWNER_LABEL: Record<DataOwner, string> = {
  field: '外业验收队',
  project: '项目部',
};
