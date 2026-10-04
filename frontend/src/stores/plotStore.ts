/**
 * 地块状态管理（Zustand）
 * 维护地块列表、当前选中地块、筛选条件与地块级派生统计；
 * 所有写操作同步落 IndexedDB，写完后由 liveQuery 自动回灌。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Plot, PlotDraft, Substrate, TideZone } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey, RateLevel } from '../types/survey';
import type { PlotLedger } from '../types/plotLedger';
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  db,
  initDatabase,
  putPlot,
  removePlot,
} from '../utils/db';
import { buildSurvivalSummary, type SurvivalSummary } from '../hooks/useSurvivalRate';
import { reconcilePlot, type ReconciledLedger } from '../utils/reconcile';
import { nowIso, uuid } from '../utils/id';

/** 地块筛选条件（关键字 + 潮位带 + 底质），由 <FilterBar> 同步到 URL query */
export interface PlotFilters {
  keyword: string;
  tideZone: TideZone | 'all';
  substrate: Substrate | 'all';
}

/** 单个地块的派生统计，供地块台账与补植计划页复用 */
export interface PlotStat {
  plotId: string;
  /** 苗木批次数 */
  seedlingCount: number;
  /** 进场苗木合计（株） */
  seedlingQuantity: number;
  /** 栽植总株数（株）——优先取项目部台账最新值，回退栽植记录合计 */
  plantTotal: number;
  /** 验收测次数 */
  surveyCount: number;
  /** 最新成活率（%） */
  latestRate: number;
  /** 最新等级 */
  level: RateLevel;
  /** 成活率环比变化（百分点） */
  trend: number;
  /** 建议补植株数（最新一致台账算出的缺株数；无台账时按栽植 − 成活兜底） */
  suggestReplant: number;
  /** 最新缺株数（项目部台账口径） */
  missingCount: number;
  /** 是否存在挂起待复核的对账（挂起期间不生成补植计划） */
  suspended: boolean;
  /** 挂起待复核的条数 */
  suspendedCount: number;
}

const EMPTY_FILTERS: PlotFilters = { keyword: '', tideZone: 'all', substrate: 'all' };
const CURRENT_PLOT_KEY = 'gbmangrove:currentPlotId';

function readCurrentPlotId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_PLOT_KEY);
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

function writeCurrentPlotId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_PLOT_KEY, id ?? '');
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

interface PlotStoreState {
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  ledgers: PlotLedger[];
  currentPlotId: string | null;
  loading: boolean;
  ready: boolean;
  error: string;
  filters: PlotFilters;
  counts: Record<string, number>;
  stats: Record<string, PlotStat>;
  summaries: Record<string, SurvivalSummary>;
  /** 地块 → 对账后台账视图（按测次升序） */
  reconciliations: Record<string, ReconciledLedger[]>;
  /** 订阅 Dexie 并载入全部派生数据（幂等，可重复调用） */
  loadAll: () => Promise<void>;
  selectPlot: (plotId: string | null) => void;
  createPlot: (draft: PlotDraft) => Promise<Plot>;
  updatePlot: (plotId: string, draft: PlotDraft) => Promise<void>;
  deletePlot: (plotId: string) => Promise<void>;
  setFilters: (patch: Partial<PlotFilters>) => void;
  resetFilters: () => void;
  visiblePlots: () => Plot[];
  statOf: (plotId: string) => PlotStat;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  /** 取地块对账后的台账行（按测次升序） */
  ledgersOf: (plotId: string) => ReconciledLedger[];
  refreshCounts: () => Promise<void>;
}

const EMPTY_STAT: Omit<PlotStat, 'plotId'> = {
  seedlingCount: 0,
  seedlingQuantity: 0,
  plantTotal: 0,
  surveyCount: 0,
  latestRate: 0,
  level: 'poor',
  trend: 0,
  suggestReplant: 0,
  missingCount: 0,
  suspended: false,
  suspendedCount: 0,
};

let subscribed = false;

export const usePlotStore = create<PlotStoreState>((set, get) => ({
  plots: [],
  seedlings: [],
  plantings: [],
  surveys: [],
  ledgers: [],
  currentPlotId: readCurrentPlotId(),
  loading: true,
  ready: false,
  error: '',
  filters: { ...EMPTY_FILTERS },
  counts: {},
  stats: {},
  summaries: {},
  reconciliations: {},

  async loadAll() {
    set({ loading: true, error: '' });
    try {
      await initDatabase();
      if (!subscribed) {
        subscribed = true;
        liveQuery(async () => {
          const [plots, seedlings, plantings, surveys, ledgers] = await Promise.all([
            db.plots.toArray(),
            db.seedlings.toArray(),
            db.plantings.toArray(),
            db.surveys.toArray(),
            db.plotLedgers.toArray(),
          ]);
          return { plots, seedlings, plantings, surveys, ledgers };
        }).subscribe({
          next: ({ plots, seedlings, plantings, surveys, ledgers }) => {
            const stats: Record<string, PlotStat> = {};
            const summaries: Record<string, SurvivalSummary> = {};
            const reconciliations: Record<string, ReconciledLedger[]> = {};
            plots.forEach((plot) => {
              const plotSeedlings = seedlings.filter((row) => row.plotId === plot.id);
              const summary = buildSurvivalSummary(plot.id, surveys, plantings);
              const reconciled = reconcilePlot(plot.id, ledgers, surveys);
              reconciliations[plot.id] = reconciled;
              const latestMatched = reconciled.filter((row) => row.reconcileState === 'matched').at(-1);
              const suspendedRows = reconciled.filter((row) => row.reconcileState === 'suspended');
              summaries[plot.id] = summary;
              stats[plot.id] = {
                plotId: plot.id,
                seedlingCount: plotSeedlings.length,
                seedlingQuantity: plotSeedlings.reduce((acc, row) => acc + row.quantity, 0),
                // 项目部台账有栽植总株数时以台账为准，否则回退栽植记录合计
                plantTotal: latestMatched?.plantedTotal ?? summary.totalCount,
                surveyCount: summary.points.length,
                latestRate: summary.latestRate,
                level: summary.level,
                trend: summary.trend,
                suggestReplant: latestMatched ? latestMatched.missingCount : summary.suggestReplant,
                missingCount: latestMatched?.missingCount ?? plot.missingCount,
                suspended: suspendedRows.length > 0,
                suspendedCount: suspendedRows.length,
              };
            });
            const sorted = [...plots].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
            const current = get().currentPlotId;
            const stillExists = current !== null && plots.some((plot) => plot.id === current);
            set({
              plots: sorted,
              seedlings,
              plantings,
              surveys,
              ledgers,
              stats,
              summaries,
              reconciliations,
              loading: false,
              ready: true,
              error: '',
            });
            if (!stillExists) {
              const nextId = sorted.length > 0 ? sorted[0].id : null;
              set({ currentPlotId: nextId });
              writeCurrentPlotId(nextId);
            }
          },
          error: (err: unknown) => {
            set({ loading: false, error: err instanceof Error ? err.message : '读取地块数据失败' });
          },
        });
      }
      await get().refreshCounts();
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '初始化本地数据库失败' });
    }
  },

  selectPlot(plotId) {
    set({ currentPlotId: plotId });
    writeCurrentPlotId(plotId);
  },

  async createPlot(draft) {
    const stamp = nowIso();
    const row: Plot = {
      id: uuid('plot'),
      name: draft.name.trim() || '未命名地块',
      areaMu: draft.areaMu,
      tideZone: draft.tideZone,
      substrate: draft.substrate,
      restoreMode: draft.restoreMode,
      state: draft.state,
      missingCount: 0,
      lastReplantDate: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putPlot(row);
    get().selectPlot(row.id);
    return row;
  },

  async updatePlot(plotId, draft) {
    const existing = await db.plots.get(plotId);
    if (!existing) return;
    await putPlot({
      ...existing,
      name: draft.name.trim() || existing.name,
      areaMu: draft.areaMu,
      tideZone: draft.tideZone,
      substrate: draft.substrate,
      restoreMode: draft.restoreMode,
      state: draft.state,
    });
  },

  async deletePlot(plotId) {
    await removePlot(plotId);
    if (get().currentPlotId === plotId) {
      get().selectPlot(null);
    }
    await get().refreshCounts();
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS } });
  },

  visiblePlots() {
    const { plots, filters } = get();
    const keyword = filters.keyword.trim().toLowerCase();
    return plots.filter((plot) => {
      if (filters.tideZone !== 'all' && plot.tideZone !== filters.tideZone) return false;
      if (filters.substrate !== 'all' && plot.substrate !== filters.substrate) return false;
      if (keyword === '') return true;
      return (
        plot.name.toLowerCase().includes(keyword) ||
        plot.restoreMode.toLowerCase().includes(keyword) ||
        plot.state.toLowerCase().includes(keyword)
      );
    });
  },

  statOf(plotId) {
    return get().stats[plotId] ?? { plotId, ...EMPTY_STAT };
  },

  summaryOf(plotId) {
    if (plotId === null) return buildSurvivalSummary('', [], []);
    return get().summaries[plotId] ?? buildSurvivalSummary(plotId, [], []);
  },

  ledgersOf(plotId) {
    return get().reconciliations[plotId] ?? [];
  },

  async refreshCounts() {
    const counts = await countAll();
    set({ counts: { ...counts, schemaVersion: DB_SCHEMA_VERSION } });
  },
}));
