/**
 * /ledgers 项目部地块台账与对账台
 * 项目部只录「栽植总株数」（缺株数由系统按 栽植总株数 − 最新外业成活株数 算出），
 * 按地块编号 + 测次与外业验收对账；对不上先挂起等复核，挂起期间不生成补植计划。
 * 离线交回 / 重试都只动项目部自己这一份，外业测次照旧。
 * 消费模型：PlotLedger、Plot、Survey；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
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
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RedoOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import { useLedgerStore } from '../stores/ledgerStore';
import type { PlotLedger, PlotLedgerDraft, ReconcileState } from '../types/plotLedger';
import { RECONCILE_STATE_LABEL } from '../types/plotLedger';
import type { ReconciledLedger } from '../utils/reconcile';

interface LedgerFormValues {
  plotId: string;
  round: number;
  plantedTotal: number;
  date: Dayjs;
}

const STATE_COLOR: Record<ReconcileState, string> = {
  pending: 'default',
  matched: 'green',
  suspended: 'red',
};

export default function LedgerBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const ready = usePlotStore((state) => state.ready);
  const ledgersOf = usePlotStore((state) => state.ledgersOf);

  const filters = useLedgerStore((state) => state.filters);
  const setFilters = useLedgerStore((state) => state.setFilters);
  const resetFilters = useLedgerStore((state) => state.resetFilters);
  const lastMessage = useLedgerStore((state) => state.lastMessage);
  const submitLedger = useLedgerStore((state) => state.submitLedger);
  const retryLedger = useLedgerStore((state) => state.retryLedger);
  const recheckLedger = useLedgerStore((state) => state.recheckLedger);
  const correctAndSubmit = useLedgerStore((state) => state.correctAndSubmit);
  const deleteLedger = useLedgerStore((state) => state.deleteLedger);
  const revision = useLedgerStore((state) => state.revision);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PlotLedger | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<LedgerFormValues>();

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  // 全量对账视图（每个地块各自按测次升序），再拼接成一张表
  const allRows = useMemo<ReconciledLedger[]>(() => {
    void revision;
    return plots
      .flatMap((plot) => ledgersOf(plot.id))
      .sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
  }, [plots, ledgersOf, revision]);

  const filtered = useMemo(() => {
    const key = filters.keyword.trim().toLowerCase();
    return allRows.filter((row) => {
      if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
      if (filters.reconcileState !== 'all' && row.reconcileState !== filters.reconcileState) return false;
      if (key === '') return true;
      return plotName(row.plotId).toLowerCase().includes(key) || `第${row.round}`.includes(key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, filters, plots]);

  const stats = useMemo(() => {
    const matched = allRows.filter((row) => row.reconcileState === 'matched');
    const suspended = allRows.filter((row) => row.reconcileState === 'suspended');
    const missing = matched.reduce((acc, row) => acc + row.missingCount, 0);
    return {
      total: allRows.length,
      matched: matched.length,
      suspended: suspended.length,
      missing,
    };
  }, [allRows]);

  const openCreate = (): void => {
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    const nextRound = allRows.filter((row) => row.plotId === plotId).length + 1;
    setEditing(null);
    form.setFieldsValue({
      plotId,
      round: nextRound,
      plantedTotal: 0,
      date: dayjs(),
    });
    setOpen(true);
  };

  const openEdit = (row: PlotLedger): void => {
    setEditing(row);
    form.setFieldsValue({
      plotId: row.plotId,
      round: row.round,
      plantedTotal: row.plantedTotal,
      date: dayjs(row.date),
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const draft: PlotLedgerDraft = {
        plotId: values.plotId,
        round: values.round,
        plantedTotal: values.plantedTotal,
        date: values.date.format('YYYY-MM-DD'),
      };
      if (editing === null) {
        const saved = await submitLedger(draft);
        message.success(
          saved.reconcileState === 'suspended'
            ? `已交回但对账挂起：${saved.reconcileNote}`
            : `已交回并对账一致：缺株 ${saved.missingCount} 株`,
          6,
        );
      } else {
        const saved = await correctAndSubmit(editing.id, {
          plantedTotal: draft.plantedTotal,
          date: draft.date,
        });
        if (saved !== null) {
          message.success(
            saved.reconcileState === 'suspended'
              ? `已保存但仍挂起：${saved.reconcileNote}`
              : `已保存并对账一致：缺株 ${saved.missingCount} 株`,
            6,
          );
        }
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<ReconciledLedger> = [
    {
      title: '地块编号 / 名称',
      key: 'plot',
      width: 210,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.plotId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '测次',
      dataIndex: 'round',
      key: 'round',
      width: 90,
      align: 'center',
      render: (value: number) => <Tag color="blue">第 {value} 次</Tag>,
    },
    { title: '登记日期', dataIndex: 'date', key: 'date', width: 120 },
    {
      title: '栽植总株数',
      dataIndex: 'plantedTotal',
      key: 'plantedTotal',
      width: 120,
      align: 'right',
      render: (value: number) => `${value.toLocaleString('zh-CN')} 株`,
    },
    {
      title: '最新成活株数',
      dataIndex: 'latestAliveCount',
      key: 'latestAliveCount',
      width: 130,
      align: 'right',
      render: (value: number | null) => (value === null ? '—' : `${value.toLocaleString('zh-CN')} 株`),
    },
    {
      title: '缺株数（算出）',
      dataIndex: 'missingCount',
      key: 'missingCount',
      width: 120,
      align: 'right',
      render: (value: number, record) =>
        record.reconcileState === 'matched' ? (
          <Typography.Text strong type={value > 0 ? 'warning' : 'secondary'}>
            {value.toLocaleString('zh-CN')} 株
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">挂起不计</Typography.Text>
        ),
    },
    {
      title: '对账状态',
      dataIndex: 'reconcileState',
      key: 'reconcileState',
      width: 120,
      render: (value: ReconcileState) => <Tag color={STATE_COLOR[value]}>{RECONCILE_STATE_LABEL[value]}</Tag>,
    },
    {
      title: '对账说明',
      dataIndex: 'reconcileNote',
      key: 'reconcileNote',
      render: (value: string, record) => (
        <Typography.Text type={record.reconcileState === 'suspended' ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
          {value || '—'}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.reconcileState === 'suspended' ? (
            <>
              <Tooltip title="项目部只重试自己这一份：按最新外业成活株数重新对账，外业测次不动">
                <Button size="small" type="link" icon={<RedoOutlined />} onClick={() => void handleRetry(record.id)}>
                  重试对账
                </Button>
              </Tooltip>
              <Button size="small" type="link" icon={<SafetyCertificateOutlined />} onClick={() => void handleRecheck(record.id)}>
                复核
              </Button>
            </>
          ) : null}
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            改栽植总数
          </Button>
          <Popconfirm
            title="确认删除该项目部台账？"
            description="只删除项目部这一份，外业验收测次保留不变。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteLedger(record.id);
              message.success('项目部台账已删除，外业测次未受影响');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const handleRetry = async (id: string): Promise<void> => {
    const saved = await retryLedger(id);
    if (saved === null) return;
    if (saved.reconcileState === 'suspended') {
      message.warning(`重试后仍挂起：${saved.reconcileNote}`, 6);
    } else {
      message.success(`重试成功，第 ${saved.round} 测次已对账一致`);
    }
  };

  const handleRecheck = async (id: string): Promise<void> => {
    const saved = await recheckLedger(id);
    if (saved === null) return;
    if (saved.reconcileState === 'suspended') {
      message.warning(`复核后仍对不上，继续挂起：${saved.reconcileNote}`, 6);
    } else {
      message.success(`复核通过，第 ${saved.round} 测次已对账一致`);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="项目部台账" value={stats.total} suffix="份" tone="primary" icon={<AuditOutlined />} />
        <StatBadge label="对账一致" value={stats.matched} suffix="份" tone="success" />
        <StatBadge
          label="挂起待复核"
          value={stats.suspended}
          suffix="份"
          tone={stats.suspended > 0 ? 'danger' : 'default'}
          hint="挂起期间不为该地块生成补植计划"
        />
        <StatBadge label="缺株合计（一致）" value={stats.missing.toLocaleString('zh-CN')} suffix="株" tone="warning" />
      </div>

      {stats.suspended > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${stats.suspended} 份台账挂起待复核`}
          description="外业测次缺失或成活株数多于栽植总株数时先挂起；项目部可只重试自己这一份，或修正栽植总株数后重新交回。挂起地块不会生成补植计划。"
        />
      ) : null}
      {lastMessage !== '' ? <Alert type="info" showIcon style={{ marginBottom: 14 }} message={lastMessage} /> : null}

      <Card
        title="项目部地块台账 · 对账台"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={plots.length === 0}>
            离线交回台账
          </Button>
        }
      >
        <FilterBar
          keyword={filters.keyword}
          onKeywordChange={(value: string) => setFilters({ keyword: value })}
          fields={[
            {
              key: 'plotId',
              label: '地块',
              options: plots.map((plot) => plot.id),
              optionLabels: Object.fromEntries(plots.map((plot) => [plot.id, plot.name])),
            },
            {
              key: 'reconcileState',
              label: '对账状态',
              options: ['pending', 'matched', 'suspended'],
              optionLabels: RECONCILE_STATE_LABEL,
            },
          ]}
          values={{ plotId: filters.plotId, reconcileState: filters.reconcileState }}
          onChange={(key: string, value: string) => {
            if (key === 'plotId') setFilters({ plotId: value });
            if (key === 'reconcileState') setFilters({ reconcileState: value as ReconcileState | 'all' });
          }}
          onReset={resetFilters}
          resultText={`命中 ${filtered.length} / ${allRows.length} 份`}
        />

        {allRows.length === 0 && !ready ? null : allRows.length === 0 ? (
          <EmptyPanel
            title="还没有项目部台账"
            description="项目部按地块与测次交回栽植总株数；系统按「栽植总株数 − 最新外业成活株数」算缺株数，并与外业验收对账。对不上会挂起，挂起期间不生成补植计划。"
            actionText="离线交回第一份台账"
            onAction={openCreate}
          />
        ) : (
          <Table<ReconciledLedger>
            rowKey="id"
            size="middle"
            loading={!ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1460 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            rowClassName={(record) => (record.reconcileState === 'suspended' ? 'ledger-row-suspended' : '')}
            locale={{
              emptyText: <EmptyPanel title="没有符合筛选条件的台账" actionText="重置筛选" onAction={resetFilters} />,
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '项目部离线交回台账' : `修正台账 · 第 ${editing.round} 测次`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText={editing === null ? '交回并对账' : '保存并重新对账'}
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="plotId"
              label="地块编号"
              style={{ flex: 2 }}
              rules={[{ required: true, message: '请选择地块' }]}
            >
              <Select
                disabled={editing !== null}
                options={plots.map((plot) => ({ value: plot.id, label: plot.name }))}
              />
            </Form.Item>
            <Form.Item name="round" label="测次" style={{ flex: 1 }} rules={[{ required: true, message: '请填写测次' }]}>
              <InputNumber min={1} max={99} disabled={editing !== null} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="plantedTotal"
              label="栽植总株数（项目部口径）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写栽植总株数' }]}
            >
              <InputNumber min={0} max={1000000} step={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="date" label="登记日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            缺株数不由人工填写：交回后按「栽植总株数 − 同地块同测次最新外业成活株数」自动算出并对账。
            同一地块同一测次重复交回或重试都只更新项目部这一份，外业测次保持不变。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
