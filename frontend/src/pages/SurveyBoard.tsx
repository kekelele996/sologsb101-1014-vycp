/**
 * /surveys 成活率与株高验收台（对账台）
 * 外业验收队录成活株数与株高，项目部交栽植总株数（缺株数按口径自动算），两边分开记；
 * 按（地块 + 测次）对账，对不上先挂起待复核，挂起期间不生成补植计划；
 * 支持离线交回（重复交只留一份）与项目部重试（只重存项目部那一份）。
 * 消费模型：Survey、Plot、Planting；复用组件：<RateTag>、<EmptyPanel>、<StatBadge>、<ReconcileTag>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  RiseOutlined,
  FallOutlined,
  SyncOutlined,
  ToolOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import RateTag from '../components/common/RateTag';
import ReconcileTag from '../components/common/ReconcileTag';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import { useSurveyStore } from '../stores/surveyStore';
import {
  RATE_LEVEL_LABEL,
  RATE_LEVEL_OPTIONS,
  SURVEY_SOURCE_LABEL,
  type OfflineSurveyPayload,
  type RateLevel,
  type SurveySource,
} from '../types/survey';
import { buildReconciliation, resolveOfficeMissing, type ReconRound } from '../utils/reconcile';
import { SURVIVAL_WARN_RATE, percentText } from '../utils/rate';

interface SurveyFormValues {
  source: SurveySource;
  plotId: string;
  round: number;
  date: Dayjs;
  aliveCount: number;
  avgHeightCm: number;
  totalPlanted: number;
}

/** 校验离线交回 JSON，返回解析后的记录或错误信息 */
function parseOfflinePayloads(text: string, knownPlotIds: Set<string>): { ok: boolean; message: string; rows: OfflineSurveyPayload[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认文件内容完整。', rows: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: '离线交回文件必须是数组，每项为一条外业/项目部记录。', rows: [] };
  }
  const rows: OfflineSurveyPayload[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (typeof item !== 'object' || item === null) return { ok: false, message: '存在格式不正确的记录。', rows: [] };
    const plotId = typeof item.plotId === 'string' ? item.plotId : '';
    const round = typeof item.round === 'number' ? item.round : NaN;
    const date = typeof item.date === 'string' ? item.date : '';
    const source = item.source === 'office' ? 'office' : item.source === 'field' ? 'field' : null;
    if (plotId === '' || !Number.isFinite(round) || round < 1 || date === '' || source === null) {
      return { ok: false, message: '记录缺少必填字段（plotId / round / date / source）。', rows: [] };
    }
    if (!knownPlotIds.has(plotId)) {
      return { ok: false, message: `地块 ${plotId} 不存在，请先核对地块编号。`, rows: [] };
    }
    rows.push({
      plotId,
      round,
      date,
      source,
      aliveCount: typeof item.aliveCount === 'number' ? item.aliveCount : 0,
      avgHeightCm: typeof item.avgHeightCm === 'number' ? item.avgHeightCm : 0,
      totalPlanted: typeof item.totalPlanted === 'number' ? item.totalPlanted : 0,
    });
  }
  return { ok: true, message: '', rows };
}

export default function SurveyBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const surveys = usePlotStore((state) => state.surveys);
  const plantings = usePlotStore((state) => state.plantings);
  const ready = usePlotStore((state) => state.ready);
  const statOf = usePlotStore((state) => state.statOf);
  const summaryOf = usePlotStore((state) => state.summaryOf);
  const filters = useSurveyStore((state) => state.filters);
  const setFilters = useSurveyStore((state) => state.setFilters);
  const resetFilters = useSurveyStore((state) => state.resetFilters);
  const selectedIds = useSurveyStore((state) => state.selectedIds);
  const setSelectedIds = useSurveyStore((state) => state.setSelectedIds);
  const gradeDraft = useSurveyStore((state) => state.gradeDraft);
  const setGradeDraft = useSurveyStore((state) => state.setGradeDraft);
  const bulkApplyGrade = useSurveyStore((state) => state.bulkApplyGrade);
  const generateReplant = useSurveyStore((state) => state.generateReplant);
  const createFieldEntry = useSurveyStore((state) => state.createFieldEntry);
  const createOfficeEntry = useSurveyStore((state) => state.createOfficeEntry);
  const updateSurvey = useSurveyStore((state) => state.updateSurvey);
  const deleteSurvey = useSurveyStore((state) => state.deleteSurvey);
  const submitOffline = useSurveyStore((state) => state.submitOffline);
  const retryOffice = useSurveyStore((state) => state.retryOffice);

  const [open, setOpen] = useState(false);
  /** 正在编辑的记录 id；null 表示新建/补录 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 从行内「编辑/补录」进入时锁定记录方，工具栏新建时可在弹窗内切换 */
  const [lockSource, setLockSource] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SurveyFormValues>();
  const watchSource = Form.useWatch('source', form);
  const watchPlotId = Form.useWatch('plotId', form);
  const watchRound = Form.useWatch('round', form);
  const watchTotalPlanted = Form.useWatch('totalPlanted', form);

  /** 全量对账结果（派生） */
  const rounds = useMemo(() => buildReconciliation(surveys), [surveys]);

  const filtered = useMemo(() => {
    const key = filters.keyword.trim().toLowerCase();
    return rounds
      .filter((round) => {
        if (filters.plotId !== 'all' && round.plotId !== filters.plotId) return false;
        if (filters.recon !== 'all' && round.state !== filters.recon) return false;
        const anyDate = round.field?.date ?? round.office?.date ?? '';
        if (filters.from !== '' && anyDate !== '' && anyDate < filters.from) return false;
        if (filters.to !== '' && anyDate !== '' && anyDate > filters.to) return false;
        if (filters.level !== 'all') {
          if (round.field === null) return false;
          const point = summaryOf(round.plotId).points.find((item) => item.surveyId === round.field?.id);
          const level: RateLevel = point?.level ?? round.field.grade;
          if (level !== filters.level) return false;
        }
        if (key === '') return true;
        const plotName = plots.find((item) => item.id === round.plotId)?.name ?? '';
        return plotName.toLowerCase().includes(key) || anyDate.includes(key) || `第${round.round}`.includes(key);
      })
      .sort((a, b) => {
        const dateA = a.field?.date ?? a.office?.date ?? '';
        const dateB = b.field?.date ?? b.office?.date ?? '';
        return dateB.localeCompare(dateA) || b.round - a.round;
      });
  }, [rounds, filters, plots, summaryOf]);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const stats = useMemo(() => {
    const matched = rounds.filter((round) => round.state === 'matched').length;
    const suspended = rounds.length - matched;
    const rated = plots.filter((plot) => statOf(plot.id).surveyCount > 0);
    const warn = rated.filter((plot) => statOf(plot.id).latestRate < SURVIVAL_WARN_RATE);
    const avgRate =
      rated.length === 0
        ? 0
        : Math.round((rated.reduce((acc, plot) => acc + statOf(plot.id).latestRate, 0) / rated.length) * 10) / 10;
    return { matched, suspended, avgRate, warnCount: warn.length };
  }, [rounds, plots, statOf]);

  const suspendedRounds = useMemo(() => rounds.filter((round) => round.state === 'suspended'), [rounds]);

  const nextRoundOf = (plotId: string): number => {
    const own = rounds.filter((round) => round.plotId === plotId);
    return own.length === 0 ? 1 : Math.max(...own.map((round) => round.round)) + 1;
  };

  const openCreate = (source: SurveySource = 'field'): void => {
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    const fallbackTotal = plantings.filter((row) => row.plotId === plotId).reduce((acc, row) => acc + row.count, 0);
    setEditingId(null);
    setLockSource(false);
    form.setFieldsValue({
      source,
      plotId,
      round: nextRoundOf(plotId),
      date: dayjs(),
      aliveCount: 0,
      avgHeightCm: 0,
      totalPlanted: fallbackTotal,
    });
    setOpen(true);
  };

  const openEdit = (round: ReconRound, source: SurveySource): void => {
    const row = source === 'field' ? round.field : round.office;
    const plotId = round.plotId;
    const fallbackTotal = plantings.filter((item) => item.plotId === plotId).reduce((acc, item) => acc + item.count, 0);
    setEditingId(row?.id ?? null);
    setLockSource(true);
    form.setFieldsValue({
      source,
      plotId,
      round: round.round,
      date: row !== null ? dayjs(row.date) : dayjs(),
      aliveCount: source === 'field' ? row?.aliveCount ?? 0 : 0,
      avgHeightCm: source === 'field' ? row?.avgHeightCm ?? 0 : 0,
      totalPlanted: source === 'office' ? row?.totalPlanted ?? fallbackTotal : fallbackTotal,
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const date = values.date.format('YYYY-MM-DD');
      if (values.source === 'field') {
        const payload = { plotId: values.plotId, round: values.round, date, aliveCount: values.aliveCount, avgHeightCm: values.avgHeightCm };
        if (editingId !== null) {
          await updateSurvey(editingId, payload);
          message.success('外业验收记录已更新');
        } else {
          const row = await createFieldEntry(payload);
          message.success(`已录入第 ${row.round} 测次外业记录，成活率 ${row.survivalRate}%`);
          if (row.survivalRate < SURVIVAL_WARN_RATE) {
            message.warning(`成活率 ${row.survivalRate}% 低于告警阈值 ${SURVIVAL_WARN_RATE}%，待对账对平后可生成补植计划`, 6);
          }
        }
      } else {
        const payload = { plotId: values.plotId, round: values.round, date, totalPlanted: values.totalPlanted };
        if (editingId !== null) {
          await updateSurvey(editingId, payload);
          message.success('项目部台账记录已更新');
        } else {
          const row = await createOfficeEntry(payload);
          message.success(`已交回第 ${row.round} 测次项目部台账：栽植 ${row.totalPlanted} 株，缺株 ${row.missingCount} 株`);
        }
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkGrade = async (): Promise<void> => {
    const count = await bulkApplyGrade(gradeDraft);
    if (count === 0) {
      message.info('请先在列表中勾选需要调整等级的外业记录');
      return;
    }
    message.success(`已把 ${count} 条记录的成活率等级调整为「${RATE_LEVEL_LABEL[gradeDraft]}」`);
  };

  const handleGenerateReplant = async (): Promise<void> => {
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    if (plotId === '') {
      message.info('请先选择地块');
      return;
    }
    const result = await generateReplant(plotId);
    if (result.ok) message.success(result.message);
    else message.warning(result.message, 6);
  };

  const handleRetry = async (round: ReconRound): Promise<void> => {
    const result = await retryOffice(round.plotId, round.round);
    if (result.ok) message.success(result.message);
    else message.warning(result.message, 6);
  };

  const handleDeleteRound = async (round: ReconRound): Promise<void> => {
    if (round.field !== null) await deleteSurvey(round.field.id);
    if (round.office !== null) await deleteSurvey(round.office.id);
    message.success(`已删除第 ${round.round} 测次的两边记录`);
  };

  const handleOfflineFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const parsed = parseOfflinePayloads(text, new Set(plots.map((plot) => plot.id)));
    if (!parsed.ok) {
      message.error(parsed.message);
      return;
    }
    if (parsed.rows.length === 0) {
      message.info('离线文件为空，没有需要交回的记录');
      return;
    }
    const result = await submitOffline(parsed.rows);
    message.success(`离线交回完成：落库 ${result.saved} 份，重复去重 ${result.duplicates} 份，当前挂起 ${result.suspended} 个测次`, 6);
  };

  /** 项目部缺株数预览：栽植总株数 − 最新成活株数 */
  const officeMissingPreview = useMemo(() => {
    if (watchSource !== 'office' || typeof watchPlotId !== 'string' || watchPlotId === '') return null;
    const round = typeof watchRound === 'number' ? watchRound : 0;
    const total = typeof watchTotalPlanted === 'number' ? watchTotalPlanted : 0;
    return resolveOfficeMissing(watchPlotId, round, total, surveys);
  }, [watchSource, watchPlotId, watchRound, watchTotalPlanted, surveys]);

  const columns: ColumnsType<ReconRound> = [
    {
      title: '地块',
      key: 'plot',
      width: 190,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            栽植总株数 {statOf(record.plotId).plantTotal.toLocaleString('zh-CN')} 株
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '测次',
      dataIndex: 'round',
      key: 'round',
      width: 84,
      align: 'center',
      render: (value: number) => <Tag color="blue">第 {value} 次</Tag>,
      sorter: (a, b) => a.round - b.round,
    },
    {
      title: '对账状态',
      key: 'recon',
      width: 190,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <ReconcileTag state={record.state} problems={record.problems} />
          {record.problems.length > 0 ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {record.problems[0]}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '外业验收队（成活株数 / 株高）',
      key: 'field',
      width: 220,
      render: (_value, record) => {
        if (record.field === null) return <Tag>未交回</Tag>;
        const summary = summaryOf(record.plotId);
        const index = summary.points.findIndex((item) => item.surveyId === record.field?.id);
        const previous = index > 0 ? summary.points[index - 1] : null;
        return (
          <Space direction="vertical" size={0}>
            <span>
              成活 {record.field.aliveCount.toLocaleString('zh-CN')} 株 · 株高 {record.field.avgHeightCm} cm
              {previous !== null ? (
                <Typography.Text
                  type={record.field.avgHeightCm >= previous.avgHeightCm ? 'success' : 'danger'}
                  style={{ fontSize: 12, marginLeft: 6 }}
                >
                  {record.field.avgHeightCm >= previous.avgHeightCm ? <RiseOutlined /> : <FallOutlined />}
                  {Math.abs(Math.round((record.field.avgHeightCm - previous.avgHeightCm) * 10) / 10)} cm
                </Typography.Text>
              ) : null}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.field.date} 交回
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '项目部（栽植总株数 / 缺株数）',
      key: 'office',
      width: 210,
      render: (_value, record) => {
        if (record.office === null) return <Tag>未交回</Tag>;
        return (
          <Space direction="vertical" size={0}>
            <span>
              栽植 {record.office.totalPlanted.toLocaleString('zh-CN')} 株 · 缺株{' '}
              <Typography.Text type={record.office.missingCount > 0 ? 'warning' : 'secondary'}>
                {record.office.missingCount.toLocaleString('zh-CN')}
              </Typography.Text>{' '}
              株
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.office.date} 交回
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '成活率',
      key: 'rate',
      width: 200,
      render: (_value, record) => {
        if (record.field === null) return <Typography.Text type="secondary">—</Typography.Text>;
        const summary = summaryOf(record.plotId);
        const point = summary.points.find((item) => item.surveyId === record.field?.id);
        if (record.state === 'matched') {
          return (
            <Space direction="vertical" size={2}>
              <RateTag
                rate={record.survivalRate ?? point?.rate ?? record.field.survivalRate}
                level={point?.level ?? record.field.grade}
                manual={record.field.gradeManual}
                size="small"
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {record.field.gradeManual ? '人工复核' : '自动判定'}
              </Typography.Text>
            </Space>
          );
        }
        return (
          <Space direction="vertical" size={2}>
            <Typography.Text type="secondary">≈ {percentText(point?.rate ?? record.field.survivalRate)}（暂定）</Typography.Text>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              待复核后不以此发补植
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 300,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record, 'field')}>
            {record.field === null ? '补录外业' : '编辑外业'}
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record, 'office')}>
            {record.office === null ? '补录项目部' : '编辑项目部'}
          </Button>
          {record.state === 'suspended' && record.office !== null ? (
            <Button size="small" type="link" icon={<SyncOutlined />} onClick={() => void handleRetry(record)}>
              项目部重试
            </Button>
          ) : null}
          <Popconfirm
            title="确认删除该测次的两边记录？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleDeleteRound(record)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="验收测次" value={rounds.length} suffix="次" tone="primary" icon={<ExperimentOutlined />} />
        <StatBadge label="对平测次" value={stats.matched} suffix="次" tone="success" />
        <StatBadge
          label="挂起待复核"
          value={stats.suspended}
          suffix="次"
          tone={stats.suspended > 0 ? 'danger' : 'default'}
          hint="两边记录对不上的测次，挂起期间不生成补植计划"
        />
        <StatBadge label="平均成活率" value={percentText(stats.avgRate)} percent={stats.avgRate} tone="success" />
        <StatBadge
          label="告警地块"
          value={stats.warnCount}
          suffix="块"
          tone={stats.warnCount > 0 ? 'danger' : 'default'}
          hint={`最新成活率低于 ${SURVIVAL_WARN_RATE}% 的地块`}
        />
      </div>

      {suspendedRounds.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${suspendedRounds.length} 个测次两边记录对不上，已挂起待复核`}
          description={
            <Space direction="vertical" size={2}>
              {suspendedRounds.map((round) => (
                <span key={`${round.plotId}-${round.round}`}>
                  {plotName(round.plotId)} 第 {round.round} 测次：{round.problems.join('；')}
                </span>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                挂起期间不生成补植计划；项目部可修正自己那份后点「项目部重试」，外业测次照旧。
              </Typography.Text>
            </Space>
          }
        />
      ) : null}

      <Card
        title="成活率与株高验收台"
        extra={
          <Space wrap>
            <Button icon={<ToolOutlined />} onClick={() => void handleGenerateReplant()}>
              生成补植计划
            </Button>
            <Upload
              accept=".json"
              showUploadList={false}
              beforeUpload={(file) => {
                void handleOfflineFile(file as unknown as File);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>离线交回</Button>
            </Upload>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('field')} disabled={plots.length === 0}>
              录入测次
            </Button>
          </Space>
        }
      >
        <Space size={12} wrap style={{ marginBottom: 14 }}>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>地块</span>
            <Select
              style={{ minWidth: 200 }}
              value={filters.plotId}
              onChange={(value: string) => setFilters({ plotId: value })}
              options={[
                { value: 'all', label: '全部地块' },
                ...plots.map((plot) => ({ value: plot.id, label: plot.name })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>等级</span>
            <Select
              style={{ minWidth: 140 }}
              value={filters.level}
              onChange={(value: string) => setFilters({ level: value as RateLevel | 'all' })}
              options={[
                { value: 'all', label: '全部等级' },
                ...RATE_LEVEL_OPTIONS.map((level) => ({ value: level, label: RATE_LEVEL_LABEL[level] })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>对账状态</span>
            <Select
              style={{ minWidth: 140 }}
              value={filters.recon}
              onChange={(value: string) => setFilters({ recon: value as 'all' | 'matched' | 'suspended' })}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'matched', label: '对平' },
                { value: 'suspended', label: '挂起待复核' },
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>日期区间</span>
            <DatePicker
              value={filters.from === '' ? null : dayjs(filters.from)}
              onChange={(value) => setFilters({ from: value === null ? '' : value.format('YYYY-MM-DD') })}
              placeholder="开始日期"
            />
            <DatePicker
              value={filters.to === '' ? null : dayjs(filters.to)}
              onChange={(value) => setFilters({ to: value === null ? '' : value.format('YYYY-MM-DD') })}
              placeholder="结束日期"
            />
          </Space>
          <Button onClick={resetFilters}>重置筛选</Button>
          <Tag color="cyan">
            命中 {filtered.length} / {rounds.length} 个测次
          </Tag>
        </Space>

        <Space size={12} wrap style={{ marginBottom: 14 }}>
          <Tag color={selectedIds.length > 0 ? 'purple' : 'default'}>已选 {selectedIds.length} 条外业记录</Tag>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>批量调整为</span>
            <Select
              style={{ minWidth: 120 }}
              value={gradeDraft}
              onChange={(value: RateLevel) => setGradeDraft(value)}
              options={RATE_LEVEL_OPTIONS.map((level) => ({ value: level, label: RATE_LEVEL_LABEL[level] }))}
            />
          </Space>
          <Button type="primary" ghost disabled={selectedIds.length === 0} onClick={() => void handleBulkGrade()}>
            批量调整成活率等级
          </Button>
          <Button disabled={selectedIds.length === 0} onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </Space>

        {rounds.length === 0 && ready ? (
          <EmptyPanel
            title="还没有任何验收记录"
            description="外业验收队按测次录成活株数与株高，项目部交回栽植总株数，两边对平后才会生成补植计划。"
            actionText="录入第一个测次"
            onAction={() => openCreate('field')}
          />
        ) : (
          <Table<ReconRound>
            rowKey={(record) => `${record.plotId}#${record.round}`}
            size="middle"
            loading={!ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1420 }}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
              getCheckboxProps: (record) => ({ disabled: record.field === null }),
            }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel title="没有符合筛选条件的验收记录" actionText="重置筛选" onAction={resetFilters} />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title={`${editingId !== null ? '编辑' : '录入'}测次 · ${SURVEY_SOURCE_LABEL[watchSource ?? 'field']}`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" initialValues={{ source: 'field' }}>
          <Form.Item name="source" label="记录方（两边分开记，互不顶掉）">
            <Radio.Group
              disabled={lockSource}
              options={[
                { value: 'field', label: '外业验收队（成活株数 / 株高）' },
                { value: 'office', label: '项目部（栽植总株数 / 缺株数）' },
              ]}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="plotId" label="地块" style={{ flex: 2 }} rules={[{ required: true, message: '请选择地块' }]}>
              <Select
                options={plots.map((plot) => ({ value: plot.id, label: plot.name }))}
                onChange={(value: string) => {
                  if (editingId === null) form.setFieldsValue({ round: nextRoundOf(value) });
                }}
              />
            </Form.Item>
            <Form.Item name="round" label="测次" style={{ flex: 1 }} rules={[{ required: true, message: '请填写测次' }]}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="date" label="交回日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          {(watchSource ?? 'field') === 'field' ? (
            <Space size={12} style={{ display: 'flex' }}>
              <Form.Item
                name="aliveCount"
                label="成活株数"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '请填写成活株数' }]}
              >
                <InputNumber min={0} max={500000} step={10} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="avgHeightCm"
                label="平均株高（cm）"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '请填写平均株高' }]}
              >
                <InputNumber min={0} max={2000} step={1} style={{ width: '100%' }} />
              </Form.Item>
            </Space>
          ) : (
            <>
              <Form.Item
                name="totalPlanted"
                label="栽植总株数"
                rules={[{ required: true, message: '请填写栽植总株数' }]}
              >
                <InputNumber min={0} max={500000} step={100} style={{ width: '100%' }} />
              </Form.Item>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                缺株数按「栽植总株数 − 最新成活株数」自动算出
                {officeMissingPreview !== null ? `，当前为 ${officeMissingPreview.toLocaleString('zh-CN')} 株` : ''}
                ，保存后与外业测次对账。
              </Typography.Text>
            </>
          )}
          {(watchSource ?? 'field') === 'field' ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              成活率 = 成活株数 / 栽植总株数，保存时自动计算；同一地块同一测次重复交回只留一份。
            </Typography.Text>
          ) : null}
        </Form>
      </Modal>
    </div>
  );
}
