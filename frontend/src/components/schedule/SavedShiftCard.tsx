import { useState } from 'react'
import { Button, Popconfirm, Space, Tag, Typography, message } from 'antd'
import type { DropPoint, Orchard, PollinationShift } from '@/types'
import { computeTimings, formatArrival, summarizeShift } from '@/utils/planning'
import { shiftStore } from '@/stores/shiftStore'

export interface SavedShiftCardProps {
  shift: PollinationShift
  orchards: Orchard[]
  dropPoints: DropPoint[]
}

const BLOCK_LABEL: Record<string, string> = {
  花期重叠占用: '花期重叠',
  投放点超容: '超容',
  撤场晚于花期结束: '撤场超时'
}

/** 已保存班次：按经停顺序展示站点与箱数，拖动站点实时重算里程与预计到达时刻 */
export default function SavedShiftCard({ shift, orchards, dropPoints }: SavedShiftCardProps): JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const summary = summarizeShift(shift)
  const timings = computeTimings(shift)

  const orchardName = (id: string): string => orchards.find((item) => item.id === id)?.name ?? '未知地块'

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction
    if (target < 0 || target >= shift.stops.length) return
    const next = shift.stops.map((stop) => stop.dropId)
    const temp = next[index]
    next[index] = next[target]
    next[target] = temp
    void persist(next)
  }

  function handleDrop(targetId: string): void {
    if (!draggingId || draggingId === targetId) return
    const next = shift.stops.map((stop) => stop.dropId).filter((id) => id !== draggingId)
    const index = next.indexOf(targetId)
    next.splice(index < 0 ? next.length : index, 0, draggingId)
    setDraggingId(null)
    void persist(next)
  }

  async function persist(orderedDropIds: string[]): Promise<void> {
    setSaving(true)
    try {
      await shiftStore.getState().reorderStops(shift.id, orderedDropIds)
      message.success(`${shift.name} 经停顺序已更新，里程与预计到达时刻已重算`)
    } finally {
      setSaving(false)
    }
  }

  async function remove(): Promise<void> {
    await shiftStore.getState().remove(shift.id)
    message.success(`${shift.name} 已删除，蜂群状态与转场路线已回退`)
  }

  return (
    <div className="saved-shift-card" data-testid="saved-shift-card">
      <div className="shift-draft-head">
        <Space wrap>
          <Typography.Text strong>{shift.name}</Typography.Text>
          <Tag color="blue">{shift.workDate}</Tag>
          <Tag>{shift.vehicleType}</Tag>
          <Tag color="gold">经停 {shift.stops.length} 点 · {summary.totalKm} km</Tag>
          <Tag color="green">可投 {summary.executableBoxes} 箱</Tag>
          {summary.blockedCount > 0 ? <Tag color="red">待整改 {summary.blockedCount} 条</Tag> : null}
        </Space>
        <Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            首站出发 {shift.departAt.replace('T', ' ')}
          </Typography.Text>
          <Popconfirm title="删除该班次？其投放点群号、蜂群状态与转场路线将一并回退" onConfirm={() => void remove()}>
            <Button size="small" danger type="link">
              删除班次
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {shift.stops.length > 1 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          拖动站点或用上移 / 下移调整顺序，里程与预计到达时刻自动重算并写回路线表。
        </Typography.Text>
      ) : null}

      <div className="shift-stop-list">
        {shift.stops.map((stop, index) => {
          const point = dropPoints.find((item) => item.id === stop.dropId)
          const leg = index > 0 ? shift.legs[index - 1] : null
          return (
            <div
              key={stop.dropId}
              draggable={shift.stops.length > 1}
              onDragStart={() => setDraggingId(stop.dropId)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => handleDrop(stop.dropId)}
              className="shift-stop-item"
              style={{ background: draggingId === stop.dropId ? '#fff7e6' : '#fff', cursor: shift.stops.length > 1 ? 'grab' : 'default' }}
            >
              <Tag color="gold">第 {index + 1} 站</Tag>
              <span style={{ flex: 1 }}>
                <b>{stop.code}</b> · {orchardName(stop.orchardId)} · 投 {stop.boxes} 箱
                {point ? <span className="shift-stop-meta">（{point.owner || '责任人未填'}）</span> : null}
              </span>
              <Tag color="green" className="mono">
                预计到 {formatArrival(timings.arrivals[index])}
              </Tag>
              {leg ? (
                <Tag color="orange" className="mono">
                  上一段 {leg.distanceKm} km / {leg.durationH} h
                </Tag>
              ) : null}
              <Button size="small" disabled={index === 0 || saving} onClick={() => move(index, -1)}>
                上移
              </Button>
              <Button size="small" disabled={index === shift.stops.length - 1 || saving} onClick={() => move(index, 1)}>
                下移
              </Button>
            </div>
          )
        })}
        {shift.stops.length === 0 ? <Typography.Text type="warning">本班次经停点为空（任务全部被拦截），整改后重新生成即可。</Typography.Text> : null}
      </div>

      {summary.blockedCount > 0 ? (
        <div className="shift-block-list">
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            被拦下的任务（未投放、不转场）：
          </Typography.Text>
          <Space wrap size={4}>
            {shift.tasks
              .filter((task) => task.blocked.length > 0)
              .map((task) => (
                <Tag key={task.id} color="red">
                  {task.dropCode} · {task.boxes} 箱
                  {task.colonyCodes.length > 0 ? ` · ${task.colonyCodes.join('/')}` : ''} ·{' '}
                  {task.blocked.map((block) => BLOCK_LABEL[block.reason] ?? block.reason).join('、')}
                </Tag>
              ))}
          </Space>
        </div>
      ) : null}
    </div>
  )
}
