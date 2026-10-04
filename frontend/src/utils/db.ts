/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { PlotLedger } from '../types/plotLedger';
import type { Replant, ReplantState } from '../types/replant';
import { rateLevel } from './rate';
import { reconcileLedger } from './reconcile';
import { nowIso, today } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  plotLedgers!: Table<PlotLedger, string>;
  replants!: Table<Replant, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：外业验收 / 项目部台账分开记账 ----------
    // surveys 仍归外业验收队（成活株数、株高），新增 owner 归属；
    // 新增 plotLedgers 表归项目部（栽植总株数、缺株数），[plotId+round] 为对账唯一键。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        plotLedgers: 'id, plotId, [plotId+round], date, reconcileState',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：旧验收记录没标来源，统一补上外业归属，升上来后仍能参与对账
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          if (row.owner !== 'field' && row.owner !== 'project') row.owner = 'field';
        });

        // 迁移 2：按现有测次给项目部补台账（栽植总株数沿用当时栽植记录合计），
        // 缺株数按 栽植总株数 − 成活株数 算出，使旧数据升级后立即可对账。
        const surveyTable = tx.table('surveys');
        const plantingTable = tx.table('plantings');
        const ledgerTable = tx.table('plotLedgers');
        const [oldSurveys, oldPlantings] = await Promise.all([
          surveyTable.toArray() as Promise<Survey[]>,
          plantingTable.toArray() as Promise<Planting[]>,
        ]);
        const totalByPlot = new Map<string, number>();
        for (const planting of oldPlantings) {
          totalByPlot.set(planting.plotId, (totalByPlot.get(planting.plotId) ?? 0) + planting.count);
        }
        const stamp = nowIso();
        const ledgers: PlotLedger[] = oldSurveys
          .slice()
          .sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round)
          .map((survey) => {
            const plantedTotal = totalByPlot.get(survey.plotId) ?? 0;
            const result = reconcileLedger(
              { plotId: survey.plotId, round: survey.round, plantedTotal },
              oldSurveys,
            );
            return {
              id: `ledger-${survey.plotId}-r${survey.round}`,
              plotId: survey.plotId,
              round: survey.round,
              plantedTotal,
              missingCount: result.missingCount,
              latestAliveCount: result.latestAliveCount,
              reconcileState: result.reconcileState,
              reconcileNote: result.reconcileNote,
              date: survey.date,
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            } satisfies PlotLedger;
          });
        if (ledgers.length > 0) await ledgerTable.bulkPut(ledgers);
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下苗木批次、栽植、验收、项目部台账与补植计划 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.plotLedgers, db.replants],
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.plotLedgers.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      await db.plots.delete(id);
    },
  );
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  // 验收测次只归外业验收队，任何写入都钉死 owner = 'field'，防止项目部侧覆盖归属
  await db.surveys.put({ ...row, owner: 'field', grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 外业离线交回结果：duplicated 表示同一地块同一测次重复交回（只留一份） */
export interface SurveyHandoverResult {
  row: Survey;
  duplicated: boolean;
}

/**
 * 外业验收队离线交回一条测次（成活株数、株高）。
 * 同一地块同一测次已存在时视为重复交回：保留既有那一份，本次丢弃，绝不覆盖。
 */
export async function submitFieldSurvey(row: Survey): Promise<SurveyHandoverResult> {
  const existing = await db.surveys.where({ plotId: row.plotId, round: row.round }).first();
  if (existing !== undefined) {
    return { row: existing, duplicated: true };
  }
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  const saved: Survey = {
    ...row,
    owner: 'field',
    grade,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.surveys.put(saved);
  return { row: saved, duplicated: false };
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* --------------------------- 项目部地块台账 --------------------------- */

export async function listPlotLedgers(): Promise<PlotLedger[]> {
  const rows = await db.plotLedgers.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listPlotLedgersByPlot(plotId: string): Promise<PlotLedger[]> {
  const rows = await db.plotLedgers.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putPlotLedger(row: PlotLedger): Promise<void> {
  await db.plotLedgers.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlotLedger(id: string): Promise<void> {
  await db.plotLedgers.delete(id);
}

/**
 * 项目部离线交回 / 重试一条台账（栽植总株数；缺株数对账时算出）。
 * 以「地块编号 + 测次」为幂等键 upsert：对账失败后项目部只重试自己这一份，
 * 重复交回或重试都落到同一行，外业测次不动。交回时立即按最新外业成活株数对账。
 * 返回写回后的台账行（含最新对账结果）。
 */
export async function submitProjectLedger(row: PlotLedger, surveys: Survey[]): Promise<PlotLedger> {
  const existing = await db.plotLedgers.where({ plotId: row.plotId, round: row.round }).first();
  const result = reconcileLedger(row, surveys);
  const stamp = nowIso();
  const saved: PlotLedger = {
    ...(existing ?? row),
    plotId: row.plotId,
    round: row.round,
    plantedTotal: row.plantedTotal,
    date: row.date,
    missingCount: result.missingCount,
    latestAliveCount: result.latestAliveCount,
    reconcileState: result.reconcileState,
    reconcileNote: result.reconcileNote,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.plotLedgers.put(saved);
  return saved;
}

/** 复核通过：把挂起台账重新按最新外业记录对账（仍对不上则保持挂起） */
export async function recheckPlotLedger(id: string, surveys: Survey[]): Promise<PlotLedger | null> {
  const existing = await db.plotLedgers.get(id);
  if (existing === undefined) return null;
  const result = reconcileLedger(existing, surveys);
  const saved: PlotLedger = {
    ...existing,
    missingCount: result.missingCount,
    latestAliveCount: result.latestAliveCount,
    reconcileState: result.reconcileState,
    reconcileNote: result.reconcileNote,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.plotLedgers.put(saved);
  return saved;
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期。
 * 只回写项目部台账与地块汇总，绝不改写外业成活株数 / 株高 / 成活率。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.plotLedgers, db.surveys, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    // 只回写项目部自己那份台账：最新一条已对账一致的记录；外业测次不改
    const ledgers = await db.plotLedgers.where('plotId').equals(plot.id).toArray();
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    const matched = ledgers
      .map((ledger) => ({ ledger, result: reconcileLedger(ledger, surveys) }))
      .filter((item) => item.result.reconcileState === 'matched')
      .sort((a, b) => a.ledger.round - b.ledger.round);
    if (matched.length === 0) return;
    const target = matched[matched.length - 1].ledger;
    await db.plotLedgers.update(target.id, {
      missingCount: Math.max(0, target.missingCount - replant.missingCount),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  /** v3 起存在；旧版存档没有该数组，导入时按现有测次补建 */
  plotLedgers?: PlotLedger[];
  replants: Replant[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, plotLedgers, replants] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.plotLedgers.toArray(),
    db.replants.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    plotLedgers,
    replants,
  };
}

/**
 * 归一化存档：外业记录补 owner；旧版存档缺 plotLedgers 时按现有测次补建项目部台账，
 * 保证旧数据导进来后仍能参与对账（与 v3 升级同口径）。
 */
function normalizeSnapshot(snapshot: DatabaseSnapshot): {
  surveys: Survey[];
  plotLedgers: PlotLedger[];
} {
  const stamp = nowIso();
  const surveys: Survey[] = snapshot.surveys.map((row) => ({
    ...row,
    owner: row.owner === 'project' ? 'project' : 'field',
    revision: ROW_REVISION,
  }));

  if (snapshot.plotLedgers !== undefined) {
    return { surveys, plotLedgers: snapshot.plotLedgers.map((row) => ({ ...row, revision: ROW_REVISION })) };
  }

  const totalByPlot = new Map<string, number>();
  for (const planting of snapshot.plantings) {
    totalByPlot.set(planting.plotId, (totalByPlot.get(planting.plotId) ?? 0) + planting.count);
  }
  const plotLedgers: PlotLedger[] = surveys
    .slice()
    .sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round)
    .map((survey) => {
      const plantedTotal = totalByPlot.get(survey.plotId) ?? 0;
      const result = reconcileLedger({ plotId: survey.plotId, round: survey.round, plantedTotal }, surveys);
      return {
        id: `ledger-${survey.plotId}-r${survey.round}`,
        plotId: survey.plotId,
        round: survey.round,
        plantedTotal,
        missingCount: result.missingCount,
        latestAliveCount: result.latestAliveCount,
        reconcileState: result.reconcileState,
        reconcileNote: result.reconcileNote,
        date: survey.date,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      } satisfies PlotLedger;
    });
  return { surveys, plotLedgers };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const { surveys, plotLedgers } = normalizeSnapshot(snapshot);
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.plotLedgers, db.replants],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.plotLedgers.clear(),
        db.replants.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut(surveys);
      await db.plotLedgers.bulkPut(plotLedgers);
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.plotLedgers, db.replants],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.plotLedgers.clear(),
        db.replants.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, plotLedgers, replants] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.plotLedgers.count(),
    db.replants.count(),
  ]);
  return { plots, seedlings, plantings, surveys, plotLedgers, replants };
}
