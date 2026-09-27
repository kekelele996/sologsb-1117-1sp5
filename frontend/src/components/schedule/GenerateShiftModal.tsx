import { useMemo } from 'react'
import { Alert, Empty, Modal, Space, Table, Tag, Typography } from 'antd'
import type { BeeColony, Orchard, ShiftTask } from '@/types'
import { computeTimings, formatArrival, summarizeShift, type ShiftDraft } from '@/utils/planning'

export interface GenerateShiftModalProps {
  open: boolean
  drafts: ShiftDraft[]
  orchards: Orchard[]
  colonies: BeeColony[]
  onCancel: () => void
  onConfirm: () => void
  confirmLoading?: boolean
}

const BLOCK_COLOR = {
  花期重叠占用: 'red',
  投放点超容: 'volcano',
  撤场晚于花期结束: 'orange'
} as const

/** 生成授粉班次前的预览：按班次列出可执行 / 被拦截任务，确认后才保存并同步 */
export default function GenerateShiftModal({
  open,
  drafts,
  orchards,
  colonies,
  onCancel,
  onConfirm,
  confirmLoading = false
}: GenerateShiftModalProps): JSX.Element {
  const orchardName = (id: string): string => orchards.find((item) => item.id === id)?.name ?? '未知地块'

  const totals = useMemo(() => {
    const blocked = drafts.reduce((sum, shift) => sum + summarizeShift(shift).blockedCount, 0)
    const executable = drafts.reduce(
      (sum, shift) => sum + shift.tasks.filter((task) => task.blocked.length === 0).length,
      0
    )
    return { blocked, executable }
  }, [drafts])

  const colonyCount = colonies.length

  return (
    <Modal
      title="生成授粉班次 · 排班预览"
      open={open}
      onCancel={onCancel}
      onOk={onConfirm}
      width={960}
      okText="确认保存并同步"
      cancelText="取消"
      confirmLoading={confirmLoading}
      styles={{ body: { maxHeight: '62vh', overflowY: 'auto' } }}
    >
      <Alert
        style={{ marginBottom: 12 }}
        type={totals.blocked > 0 ? 'warning' : 'success'}
        showIcon
        message={`共 ${drafts.length} 个班次：可执行任务 ${totals.executable} 条，被拦截任务 ${totals.blocked} 条；在册蜂群 ${colonyCount} 群`}
        description="被拦截任务会随班次留存待整改，但不会投放蜂群、不写投放点群号，也不产生转场路线；保存后蜂群状态、投放点群号与转场路线同步更新。"
      />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {drafts.map((shift) => {
          const summary = summarizeShift(shift)
          const timings = computeTimings(shift)
          return (
            <div key={shift.id} className="shift-draft-card">
              <div className="shift-draft-head">
                <Space wrap>
                  <Typography.Text strong>{shift.name}</Typography.Text>
                  <Tag color="blue">经停 {shift.stops.length} 点</Tag>
                  <Tag color="gold">里程 {summary.totalKm} km</Tag>
                  <Tag color="green">可投 {summary.executableBoxes} 箱</Tag>
                  {summary.blockedCount > 0 ? <Tag color="red">拦截 {summary.blockedCount} 条</Tag> : null}
                  {summary.warningCount > 0 ? <Tag color="orange">提示 {summary.warningCount} 条</Tag> : null}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {shift.vehicleType} · 首站出发 {shift.departAt.replace('T', ' ')}
                </Typography.Text>
              </div>

              {shift.stops.length > 0 ? (
                <Space wrap size={4} style={{ marginBottom: 8 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    经停：
                  </Typography.Text>
                  {shift.stops.map((stop, index) => (
                    <Tag key={stop.dropId} style={{ marginInlineEnd: 2 }}>
                      {index + 1}. {stop.code}（{stop.boxes} 箱）
                      <span className="mono" style={{ color: '#a4640f', marginLeft: 6 }}>
                        到 {formatArrival(timings.arrivals[index])}
                      </span>
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
                  本班次无经停点（任务全部被拦截），不产生转场路线。
                </Typography.Text>
              )}

              <Table<ShiftTask>
                size="small"
                pagination={false}
                dataSource={shift.tasks}
                rowKey="id"
                rowClassName={(record) => (record.blocked.length > 0 ? 'conflict-row' : '')}
                columns={[
                  {
                    title: '地块',
                    key: 'orchard',
                    render: (_, record) => orchardName(record.orchardId)
                  },
                  { title: '投放点', dataIndex: 'dropCode', key: 'drop', width: 100 },
                  { title: '箱数', dataIndex: 'boxes', key: 'boxes', width: 70 },
                  {
                    title: '投入群号',
                    key: 'codes',
                    render: (_, record) =>
                      record.colonyCodes.length > 0 ? (
                        <Space wrap size={2}>
                          {record.colonyCodes.map((code) => (
                            <Tag key={code} color="cyan" style={{ marginInlineEnd: 0 }}>
                              {code}
                            </Tag>
                          ))}
                        </Space>
                      ) : (
                        <span>—</span>
                      )
                  },
                  {
                    title: '投放 / 撤场',
                    key: 'window',
                    width: 190,
                    render: (_, record) => `${record.start} ~ ${record.end}`
                  },
                  {
                    title: '校验结果',
                    key: 'check',
                    render: (_, record) =>
                      record.blocked.length > 0 ? (
                        <Space direction="vertical" size={2}>
                          {record.blocked.map((block, index) => (
                            <Tag key={`${block.reason}-${index}`} color={BLOCK_COLOR[block.reason]} style={{ marginInlineEnd: 0 }}>
                              拦下 · {block.detail}
                            </Tag>
                          ))}
                          {record.warnings.map((warning, index) => (
                            <Tag key={`${warning.reason}-${index}`} color="orange" style={{ marginInlineEnd: 0 }}>
                              {warning.detail}
                            </Tag>
                          ))}
                        </Space>
                      ) : record.warnings.length > 0 ? (
                        <Space direction="vertical" size={2}>
                          <Tag color="green" style={{ marginInlineEnd: 0 }}>
                            可执行
                          </Tag>
                          {record.warnings.map((warning, index) => (
                            <Tag key={`${warning.reason}-${index}`} color="orange" style={{ marginInlineEnd: 0 }}>
                              {warning.detail}
                            </Tag>
                          ))}
                        </Space>
                      ) : (
                        <Tag color="green">可执行</Tag>
                      )
                  }
                ]}
              />
            </div>
          )
        })}
        {drafts.length === 0 ? <Empty description="暂无可排班的地块，请先在果园地块管理中录入地块与投放点" /> : null}
      </Space>
    </Modal>
  )
}
