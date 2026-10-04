/**
 * <ReconcileTag> 对账状态标签
 * 渲染测次对账结果（对平 / 挂起待复核），挂起时浮层展示对不上的原因；
 * 被验收台、地块台账与补植计划页消费。
 */
import { Tag, Tooltip } from 'antd';
import { CheckCircleOutlined, PauseCircleOutlined } from '@ant-design/icons';
import type { ReconcileState } from '../../types/survey';

export interface ReconcileTagProps {
  /** 对账状态；null 表示尚无测次 */
  state: ReconcileState | null;
  /** 挂起原因列表 */
  problems?: string[];
  size?: 'default' | 'small';
}

export default function ReconcileTag({ state, problems = [], size = 'default' }: ReconcileTagProps) {
  if (state === null) {
    return <Tag color="default">未验收</Tag>;
  }
  const style = size === 'small' ? { fontSize: 12, lineHeight: '18px', margin: 0 } : undefined;
  if (state === 'matched') {
    return (
      <Tag icon={<CheckCircleOutlined />} color="success" style={style}>
        对平
      </Tag>
    );
  }
  const tip = problems.length > 0 ? problems.join('；') : '两边记录对不上，待复核';
  return (
    <Tooltip title={`${tip}；挂起期间不生成补植计划`}>
      <Tag icon={<PauseCircleOutlined />} color="warning" style={style}>
        挂起待复核
      </Tag>
    </Tooltip>
  );
}
