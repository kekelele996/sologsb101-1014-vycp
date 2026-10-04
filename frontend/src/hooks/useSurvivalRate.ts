/**
 * 成活率派生 hook
 * 按地块与测次算成活率、株高增幅与补植建议；被验收台与补植计划页复用。
 * 外业测次与项目部台账分开记后：成活率分母优先取对平测次的项目部栽植总株数，
 * 挂起测次不用来生成补植建议，避免按过期/未复核数据发补植计划。
 */
import { useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import type { ReconcileState, Survey, RateLevel } from '../types/survey';
import type { Planting } from '../types/planting';
import { db, initDatabase } from '../utils/db';
import { reconcileRound } from '../utils/reconcile';
import {
  SURVIVAL_WARN_RATE,
  calcSurvivalRate,
  heightGrowth,
  rateLevel,
  round1,
} from '../utils/rate';

/** 单个测次的成活率数据点 */
export interface SurvivalPoint {
  surveyId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
  /** 该测次的成活率（%） */
  rate: number;
  /** 该测次是否已与项目部台账对平 */
  reconciled: boolean;
  /** 是否被人工复核过等级 */
  gradeManual: boolean;
  level: RateLevel;
}

/** 单个地块的成活率派生汇总 */
export interface SurvivalSummary {
  plotId: string;
  /** 栽植总株数（最新对平测次的项目部口径；未对平时回退为栽植记录合计） */
  totalCount: number;
  /** 按测次排序的数据点 */
  points: SurvivalPoint[];
  /** 最新测次 */
  latest: SurvivalPoint | null;
  /** 上一次测次 */
  previous: SurvivalPoint | null;
  /** 最新成活率（%） */
  latestRate: number;
  /** 与上一测次的成活率差（百分点） */
  trend: number;
  /** 株高增幅（cm） */
  heightDelta: number;
  /** 株高增幅百分比（%） */
  heightPct: number;
  /** 建议补植株数（最新测次对平时 = 项目部缺株数；挂起时为 0，不生成补植计划） */
  suggestReplant: number;
  /** 最新等级 */
  level: RateLevel;
  /** 是否低于告警阈值 */
  warn: boolean;
  /** 最新测次是否挂起待复核 */
  suspended: boolean;
  /** 挂起待复核的测次数 */
  suspendedRounds: number;
  /** 最新测次的对账状态（无测次为 null） */
  latestReconState: ReconcileState | null;
}

/** 纯函数：由验收/台账记录与栽植记录派生地块成活率汇总 */
export function buildSurvivalSummary(
  plotId: string,
  surveys: Survey[],
  plantings: Planting[],
  threshold: number = SURVIVAL_WARN_RATE,
): SurvivalSummary {
  const fallbackTotal = plantings
    .filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);

  const fieldRows = surveys
    .filter((row) => row.plotId === plotId && row.source === 'field')
    .sort((a, b) => a.round - b.round);
  const officeByRound = new Map(
    surveys.filter((row) => row.plotId === plotId && row.source === 'office').map((row) => [row.round, row]),
  );

  let suspendedRounds = 0;
  const points: SurvivalPoint[] = fieldRows.map((row) => {
    const office = officeByRound.get(row.round) ?? null;
    const recon = reconcileRound(plotId, row.round, row, office);
    if (recon.state === 'suspended') suspendedRounds += 1;
    // 对平时用项目部栽植总株数作分母；挂起时回退栽植记录合计，仅作暂定展示
    const denominator = recon.state === 'matched' && office !== null ? office.totalPlanted : fallbackTotal;
    const rate = denominator > 0 ? calcSurvivalRate(row.aliveCount, denominator) : row.survivalRate;
    return {
      surveyId: row.id,
      round: row.round,
      date: row.date,
      aliveCount: row.aliveCount,
      avgHeightCm: row.avgHeightCm,
      rate,
      reconciled: recon.state === 'matched',
      gradeManual: row.gradeManual,
      level: row.gradeManual ? row.grade : rateLevel(rate),
    };
  });

  // 项目部只有台账行、外业未交的测次也计入挂起数
  officeByRound.forEach((_office, round) => {
    if (!fieldRows.some((row) => row.round === round)) suspendedRounds += 1;
  });

  const latest = points.length > 0 ? points[points.length - 1] : null;
  const previous = points.length > 1 ? points[points.length - 2] : null;
  const growth = latest && previous ? heightGrowth(previous.avgHeightCm, latest.avgHeightCm) : { delta: 0, pct: 0 };

  const latestRound = latest !== null ? latest.round : null;
  const latestOffice = latestRound !== null ? officeByRound.get(latestRound) ?? null : null;
  const latestRecon =
    latestRound !== null
      ? reconcileRound(plotId, latestRound, fieldRows.find((row) => row.round === latestRound) ?? null, latestOffice)
      : null;
  const matched = latestRecon !== null && latestRecon.state === 'matched';

  return {
    plotId,
    totalCount: matched && latestOffice !== null ? latestOffice.totalPlanted : fallbackTotal,
    points,
    latest,
    previous,
    latestRate: latest ? latest.rate : 0,
    trend: latest && previous ? round1(latest.rate - previous.rate) : 0,
    heightDelta: growth.delta,
    heightPct: growth.pct,
    suggestReplant: matched && latestRecon.missingCount !== null ? latestRecon.missingCount : 0,
    level: latest ? latest.level : 'poor',
    warn: latest !== null && latest.rate < threshold,
    suspended: latestRecon !== null && latestRecon.state === 'suspended',
    suspendedRounds,
    latestReconState: latestRecon !== null ? latestRecon.state : null,
  };
}

export interface UseSurvivalRateResult {
  summary: SurvivalSummary;
  loading: boolean;
  error: string;
}

/** 空汇总，用于地块不存在或尚无数据时兜底，避免页面白屏 */
export function emptySummary(plotId: string): SurvivalSummary {
  return buildSurvivalSummary(plotId, [], []);
}

/**
 * 订阅某地块的验收与栽植记录，实时派生成活率、株高增幅与补植建议。
 */
export function useSurvivalRate(plotId: string | null, threshold: number = SURVIVAL_WARN_RATE): UseSurvivalRateResult {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [plantings, setPlantings] = useState<Planting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const subscription = liveQuery(async () => {
      await initDatabase();
      const [surveyRows, plantingRows] = await Promise.all([db.surveys.toArray(), db.plantings.toArray()]);
      return { surveyRows, plantingRows };
    }).subscribe({
      next: ({ surveyRows, plantingRows }) => {
        if (!active) return;
        setSurveys(surveyRows);
        setPlantings(plantingRows);
        setError('');
        setLoading(false);
      },
      error: (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : '读取成活率数据失败');
        setLoading(false);
      },
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const summary = useMemo(
    () => (plotId === null ? emptySummary('') : buildSurvivalSummary(plotId, surveys, plantings, threshold)),
    [plotId, surveys, plantings, threshold],
  );

  return { summary, loading, error };
}
