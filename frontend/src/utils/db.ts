/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3 起验收测次与项目部台账分开记：按来源（外业验收队 / 项目部）各存各的行，
 *   同一（地块 + 测次 + 来源）重复交回只留一份；按（地块 + 测次）对账，挂起期间不生成补植计划
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { ReconcileState, Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import { calcMissingCount, rateLevel } from './rate';
import { buildReconciliation, dedupeSurveys, latestRoundOf, normalizeSurveyRows, reconcileRound, resolveOfficeMissing } from './reconcile';
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
    this.version(2)
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
            row.revision = 2;
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

    // ---------- v3：验收测次与项目部台账分开记，旧记录补外业归属 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        // source 区分外业验收队 / 项目部；[plotId+round+source] 支撑按测次对账与去重
        surveys: 'id, plotId, [plotId+round], [plotId+round+source], date, grade, source',
      })
      .upgrade(async (tx) => {
        // 迁移 1：旧记录没标来源，按现有测次补上外业归属（source = 'field'），
        // 并按（地块 + 测次 + 来源）去重只留一份，升上来后即可参与对账
        const raw = (await tx.table('surveys').toArray()) as Array<Partial<Survey>>;
        const normalized = normalizeSurveyRows(raw);
        await tx.table('surveys').clear();
        await tx.table('surveys').bulkPut(normalized);
        // 迁移 2：全表行修订号升到当前版本
        const tables = ['plots', 'seedlings', 'plantings', 'surveys', 'replants'];
        for (const name of tables) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
            });
        }
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

/** 删除地块并级联清理其下苗木批次、栽植、验收与补植计划 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
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

/**
 * 写入一条验收/台账记录。
 * 同一（地块 + 测次 + 来源）只留一份：重复交回时合并到已有行（保留原 id 与创建时间），
 * 外业与项目部各写各的行，互不顶掉。
 */
export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.source === 'field' ? (row.gradeManual ? row.grade : rateLevel(row.survivalRate)) : row.grade;
  await db.transaction('rw', db.surveys, async () => {
    const dup = await db.surveys
      .where('[plotId+round+source]')
      .equals([row.plotId, row.round, row.source])
      .first();
    if (dup !== undefined && dup.id !== row.id) {
      await db.surveys.delete(row.id);
      await db.surveys.put({ ...row, id: dup.id, createdAt: dup.createdAt, grade, updatedAt: nowIso(), revision: ROW_REVISION });
      return;
    }
    await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
  });
}

/** 批量调整成活率等级（人工复核覆盖，只作用于外业行） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined && row.source === 'field')
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/** 离线交回结果统计 */
export interface OfflineSubmitResult {
  /** 去重后实际落库份数 */
  saved: number;
  /** 批内重复被合并掉的份数 */
  duplicates: number;
  /** 交回后全库仍挂起待复核的测次数 */
  suspended: number;
}

/**
 * 离线交回：批量接收外业/项目部记录。
 * 同一（地块 + 测次 + 来源）重复交只留最新一份（批内与库内都去重）；
 * 项目部行缺株数按「栽植总株数 − 最新成活株数」口径落库。
 */
export async function submitOfflineSurveys(rows: Array<Partial<Survey>>): Promise<OfflineSubmitResult> {
  const incoming = normalizeSurveyRows(rows);
  const existing = await db.surveys.toArray();
  // 合并视图（批内优先），用于按最新外业成活株数算项目部缺株数
  const merged = dedupeSurveys([...existing, ...incoming]);
  const adjusted = incoming.map((row) =>
    row.source === 'office'
      ? { ...row, missingCount: resolveOfficeMissing(row.plotId, row.round, row.totalPlanted, merged) }
      : row,
  );
  for (const row of adjusted) {
    await putSurvey(row);
  }
  const all = await db.surveys.toArray();
  const suspended = buildReconciliation(all).filter((round) => round.state === 'suspended').length;
  return { saved: adjusted.length, duplicates: Math.max(0, rows.length - adjusted.length), suspended };
}

/** 项目部重试结果 */
export interface OfficeRetryResult {
  ok: boolean;
  state: ReconcileState;
  message: string;
}

/**
 * 项目部对账失败后重试：只重存项目部那一份（按最新外业成活株数重算缺株数），
 * 外业测次照旧不动。
 */
export async function retryOfficeEntry(plotId: string, round: number): Promise<OfficeRetryResult> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  const office = rows.find((row) => row.round === round && row.source === 'office');
  if (office === undefined) {
    return { ok: false, state: 'suspended', message: '项目部尚未交回该测次台账，请先补录项目部记录' };
  }
  const field = rows.find((row) => row.round === round && row.source === 'field') ?? null;
  if (field === null) {
    return { ok: false, state: 'suspended', message: '该测次缺外业验收记录，待外业交回后再对账' };
  }
  // 只重算项目部那一份的缺株数，外业行保持原样
  const missingCount = calcMissingCount(office.totalPlanted, field.aliveCount);
  await putSurvey({ ...office, missingCount });
  const recon = reconcileRound(plotId, round, field, { ...office, missingCount });
  if (recon.state === 'matched') {
    await syncPlotMissingCount(plotId);
    return { ok: true, state: 'matched', message: `第 ${round} 测次已对平：缺株 ${missingCount} 株` };
  }
  return { ok: false, state: 'suspended', message: `重试后仍挂起：${recon.problems.join('；')}` };
}

/**
 * 对账后回写地块台账缺株数：最新测次对平时按项目部口径（栽植总株数 − 最新成活株数）回写；
 * 挂起时保持原值，避免过期/未复核数据顶掉台账。
 */
export async function syncPlotMissingCount(plotId: string): Promise<void> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  const latest = latestRoundOf(buildReconciliation(rows), plotId);
  if (latest === null || latest.state !== 'matched' || latest.missingCount === null) return;
  await db.plots.update(plotId, { missingCount: latest.missingCount, updatedAt: nowIso() });
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
 * 1）扣减地块缺株数；2）写入最近补植日期；
 * 3）按补植后的成活株数重算最新一次外业测次的成活率（只动外业行）；
 * 4）同测次项目部行的缺株数按口径同步重算，保持两边对平。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
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

    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    const fieldRows = surveys.filter((row) => row.source === 'field');
    if (fieldRows.length === 0) return;
    const latest = fieldRows.reduce((acc, item) => (item.round > acc.round ? item : acc));
    const office = surveys.find((row) => row.source === 'office' && row.round === latest.round) ?? null;
    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const fallbackTotal = plantings.reduce((acc, item) => acc + item.count, 0);
    const total = office !== null && office.totalPlanted > 0 ? office.totalPlanted : fallbackTotal;
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
    if (office !== null) {
      await db.surveys.update(office.id, {
        missingCount: calcMissingCount(office.totalPlanted, aliveAfter),
        updatedAt: nowIso(),
      });
    }
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
  replants: Replant[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
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
    replants,
  };
}

/** 用快照覆盖整库（导入存档）；验收/台账记录先补来源、去重，保证导入后可直接对账 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const surveys = normalizeSurveyRows(snapshot.surveys).map((row) => ({ ...row, revision: ROW_REVISION }));
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
    await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(surveys);
    await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants };
}
