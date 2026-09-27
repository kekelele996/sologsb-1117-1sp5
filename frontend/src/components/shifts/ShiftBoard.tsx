import { useMemo, useState } from 'react'
import { Alert, Button, Card, DatePicker, Empty, Popconfirm, Select, Space, Tag, TimePicker, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { DropPoint, ShiftStop, ShiftTask, VehicleType } from '@/types'
import { VEHICLE_TYPES, suggestColonyBoxes } from '@/types'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { routeStore } from '@/stores/routeStore'
import { shiftStore } from '@/stores/shiftStore'
import {
  AVAILABLE_STATUSES,
  buildShiftRoutes,
  generateShifts,
  stopArrivals,
  type BlockedKind,
  type DraftShift
} from '@/utils/shift'
import { distanceKm, estimateDurationH } from '@/utils/geo'
import { uid } from '@/utils/id'

const BLOCK_COLORS: Record<BlockedKind, string> = {
  容量: 'orange',
  撤场: 'red',
  重叠: 'red',
  蜂群不足: 'gold'
}

/**
 * 授粉班次面板：把地块建议箱数、投放点可容纳箱数与蜂群可用状态放到一起生成班次草稿；
 * 保存后总表按班次显示经停投放点与箱数，蜂群状态与转场路线同步变化；
 * 拖动站点顺序时里程与预计到达时刻实时重算。
 */
export default function ShiftBoard(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const shifts = usePersistentStore(shiftStore, (state) => state.rows)
  const [drafts, setDrafts] = useState<DraftShift[]>([])

  const orchardName = (id: string): string => orchards.find((item) => item.id === id)?.name ?? '未知地块'

  /** 生成面板统计：建议箱数 / 已落实 / 可用蜂群 / 投放点剩余容量 */
  const stats = useMemo(() => {
    const placed = new Set<string>()
    dropPoints.forEach((point) => point.colonyCodes.forEach((code) => placed.add(code)))
    colonies.forEach((colony) => {
      if (colony.currentOrchardId) placed.add(colony.code)
    })
    return {
      suggest: orchards.reduce((sum, item) => sum + suggestColonyBoxes(item), 0),
      placed: placed.size,
      room: dropPoints.reduce((sum, point) => sum + Math.max(0, point.capacityBoxes - point.colonyCodes.length), 0),
      available: colonies.filter((item) => AVAILABLE_STATUSES.includes(item.status)).length
    }
  }, [orchards, colonies, dropPoints])

  function runGenerate(): void {
    const result = generateShifts({ orchards, colonies, dropPoints })
    setDrafts(result)
    const blocked = result.reduce((sum, item) => sum + item.blocked.length, 0)
    if (result.length === 0) {
      message.info('没有需要排班的地块：各地块建议箱数均已落实')
    } else {
      message.success(`已生成 ${result.length} 个班次草稿${blocked > 0 ? `，${blocked} 项安排被拦下` : ''}`)
    }
  }

  function updateDraft(key: string, patch: Partial<DraftShift>): void {
    setDrafts((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  /** 保存班次：投放点写群号 → 蜂群状态同步 → 班次入库 → 生成转场段 */
  async function saveDraft(draft: DraftShift): Promise<void> {
    const stops = draft.stops.filter((stop) => stop.boxes > 0 && stop.colonyCodes.length > 0)
    if (stops.length === 0) {
      message.warning('该班次的站点均被拦下，没有可保存的任务')
      return
    }
    const shift: ShiftTask = {
      id: uid('shift'),
      name: draft.name,
      date: draft.date,
      departTime: draft.departTime,
      vehicleType: draft.vehicleType,
      stops,
      note: draft.blocked.length > 0 ? `生成时拦下 ${draft.blocked.length} 项` : '',
      createdAt: dayjs().format('YYYY-MM-DDTHH:mm')
    }
    for (const stop of stops) {
      const drop = droppointStore.getState().rows.find((item) => item.id === stop.dropId)
      if (!drop) continue
      await droppointStore.getState().save({ ...drop, colonyCodes: Array.from(new Set([...drop.colonyCodes, ...stop.colonyCodes])) })
    }
    for (const stop of stops) {
      const drop = droppointStore.getState().rows.find((item) => item.id === stop.dropId)
      if (!drop) continue
      for (const code of stop.colonyCodes) {
        const colony = colonyStore.getState().rows.find((item) => item.code === code)
        if (!colony) continue
        await colonyStore.getState().save({ ...colony, status: '在园', currentOrchardId: drop.orchardId })
      }
    }
    await shiftStore.getState().save(shift)
    await routeStore.getState().replaceShiftLegs(shift.id, buildShiftRoutes(shift, droppointStore.getState().rows))
    setDrafts((prev) => prev.filter((item) => item.key !== draft.key))
    const boxes = stops.reduce((sum, stop) => sum + stop.boxes, 0)
    message.success(`班次「${shift.name}」已保存：${stops.length} 站 ${boxes} 箱，蜂群状态与转场路线已同步`)
  }

  /** 已保存班次的站点顺序 / 日期 / 出发时刻 / 车辆变化 → 重算里程与到达时刻并写回 */
  async function updateSaved(shift: ShiftTask, patch: Partial<ShiftTask>): Promise<void> {
    const next = { ...shift, ...patch }
    await shiftStore.getState().save(next)
    await routeStore.getState().replaceShiftLegs(next.id, buildShiftRoutes(next, droppointStore.getState().rows))
  }

  /** 删除班次：回滚投放点群号与蜂群状态，清除该班次的转场段 */
  async function removeSaved(shift: ShiftTask): Promise<void> {
    for (const stop of shift.stops) {
      const drop = droppointStore.getState().rows.find((item) => item.id === stop.dropId)
      if (drop) {
        await droppointStore.getState().save({ ...drop, colonyCodes: drop.colonyCodes.filter((code) => !stop.colonyCodes.includes(code)) })
      }
      for (const code of stop.colonyCodes) {
        const colony = colonyStore.getState().rows.find((item) => item.code === code)
        if (colony) await colonyStore.getState().save({ ...colony, status: '待投放', currentOrchardId: '' })
      }
    }
    await routeStore.getState().removeByShift(shift.id)
    await shiftStore.getState().remove(shift.id)
    message.success('班次已删除，投放点群号、蜂群状态与转场段已回滚')
  }

  return (
    <>
      <Card
        size="small"
        title="生成授粉班次"
        extra={
          <Button type="primary" onClick={runGenerate}>
            生成授粉班次
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Space wrap size={6}>
            <Tag>建议箱数合计 {stats.suggest} 箱</Tag>
            <Tag color="blue">已落实 {stats.placed} 箱</Tag>
            <Tag color="green">
              可用蜂群 {stats.available} 群（{AVAILABLE_STATUSES.join(' / ')}）
            </Tag>
            <Tag color="orange">投放点剩余容量 {stats.room} 箱</Tag>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            按地块建议箱数逐地块排班，蜂群按群势从强到弱分配；同一群被分到花期重叠地块、投放点超容、撤场晚于花期结束的安排会被拦下，不随班次保存。
          </Typography.Text>
          {drafts.map((draft) => (
            <Card
              key={draft.key}
              size="small"
              type="inner"
              title={
                <Space wrap size={6}>
                  <span>{draft.name}</span>
                  <Tag color="blue">{draft.stops.length} 站</Tag>
                  {draft.blocked.length > 0 ? <Tag color="red">拦下 {draft.blocked.length} 项</Tag> : null}
                </Space>
              }
              extra={
                <Space>
                  <Button size="small" type="primary" disabled={draft.stops.length === 0} onClick={() => void saveDraft(draft)}>
                    保存班次
                  </Button>
                  <Button size="small" onClick={() => setDrafts((prev) => prev.filter((item) => item.key !== draft.key))}>
                    丢弃
                  </Button>
                </Space>
              }
            >
              <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <ShiftMetaEditor
                  date={draft.date}
                  departTime={draft.departTime}
                  vehicleType={draft.vehicleType}
                  onChange={(patch) => updateDraft(draft.key, patch)}
                />
                {draft.stops.length > 0 ? (
                  <StopListView
                    stops={draft.stops}
                    dropPoints={dropPoints}
                    date={draft.date}
                    departTime={draft.departTime}
                    orchardName={orchardName}
                    onReorder={(next) => updateDraft(draft.key, { stops: next })}
                  />
                ) : (
                  <Alert type="warning" showIcon message="该班次的站点均被拦下，没有可执行的任务" />
                )}
                {draft.blocked.length > 0 ? (
                  <Alert
                    type="error"
                    showIcon
                    message={`已拦下 ${draft.blocked.length} 项（被拦下的站点与蜂群不会写入班次）`}
                    description={
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {draft.blocked.map((item, index) => (
                          <li key={`${item.kind}-${index}`}>
                            <Tag color={BLOCK_COLORS[item.kind]}>{item.kind}</Tag>
                            {item.text}
                          </li>
                        ))}
                      </ul>
                    }
                  />
                ) : null}
              </Space>
            </Card>
          ))}
        </Space>
      </Card>

      <Card size="small" title={`授粉班次任务（已保存 ${shifts.length} 个）`}>
        {shifts.length === 0 ? (
          <Empty description="尚未保存班次：点上方「生成授粉班次」排出任务后保存" />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            {shifts.map((shift) => (
              <Card
                key={shift.id}
                size="small"
                type="inner"
                title={
                  <Space wrap size={6}>
                    <span>{shift.name}</span>
                    <Tag>{shift.date}</Tag>
                    {shift.note ? <Tag color="gold">{shift.note}</Tag> : null}
                  </Space>
                }
                extra={
                  <Popconfirm
                    title="删除班次并回滚投放点群号、蜂群状态与转场段？"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void removeSaved(shift)}
                  >
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                }
              >
                <Space direction="vertical" style={{ width: '100%' }} size={10}>
                  <ShiftMetaEditor
                    date={shift.date}
                    departTime={shift.departTime}
                    vehicleType={shift.vehicleType}
                    onChange={(patch) => void updateSaved(shift, patch)}
                  />
                  <StopListView
                    stops={shift.stops}
                    dropPoints={dropPoints}
                    date={shift.date}
                    departTime={shift.departTime}
                    orchardName={orchardName}
                    onReorder={(next) => void updateSaved(shift, { stops: next })}
                  />
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Card>
    </>
  )
}

interface ShiftMetaEditorProps {
  date: string
  departTime: string
  vehicleType: VehicleType
  onChange: (patch: { date?: string; departTime?: string; vehicleType?: VehicleType }) => void
}

/** 班次执行日期 / 出发时刻 / 车辆编辑（改动即触发里程与到达时刻重算） */
function ShiftMetaEditor({ date, departTime, vehicleType, onChange }: ShiftMetaEditorProps): JSX.Element {
  return (
    <Space wrap size={12}>
      <span>
        执行日期{' '}
        <DatePicker
          size="small"
          allowClear={false}
          value={dayjs(date)}
          onChange={(value) => {
            if (value) onChange({ date: value.format('YYYY-MM-DD') })
          }}
        />
      </span>
      <span>
        出发时刻{' '}
        <TimePicker
          size="small"
          allowClear={false}
          format="HH:mm"
          minuteStep={5}
          value={dayjs(departTime, 'HH:mm')}
          onChange={(value) => {
            if (value) onChange({ departTime: value.format('HH:mm') })
          }}
        />
      </span>
      <span>
        车辆{' '}
        <Select
          size="small"
          style={{ width: 120 }}
          value={vehicleType}
          onChange={(value) => onChange({ vehicleType: value })}
          options={VEHICLE_TYPES.map((item) => ({ value: item, label: item }))}
        />
      </span>
    </Space>
  )
}

interface StopListViewProps {
  stops: ShiftStop[]
  dropPoints: DropPoint[]
  date: string
  departTime: string
  orchardName: (id: string) => string
  onReorder: (next: ShiftStop[]) => void
}

/** 班次经停站列表：显示箱数与群号，支持拖动 / 上下移动调整顺序，里程与预计到达时刻实时重算 */
function StopListView({ stops, dropPoints, date, departTime, orchardName, onReorder }: StopListViewProps): JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const arrivals = stopArrivals(stops, dropPoints, date, departTime)

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction
    if (target < 0 || target >= stops.length) return
    const next = [...stops]
    const temp = next[index]
    next[index] = next[target]
    next[target] = temp
    onReorder(next)
  }

  function handleDrop(targetId: string): void {
    if (!draggingId || draggingId === targetId) return
    const item = stops.find((stop) => stop.dropId === draggingId)
    const next = stops.filter((stop) => stop.dropId !== draggingId)
    const index = next.findIndex((stop) => stop.dropId === targetId)
    if (item) next.splice(index < 0 ? next.length : index, 0, item)
    onReorder(next)
    setDraggingId(null)
  }

  let totalKm = 0
  for (let i = 1; i < stops.length; i += 1) {
    const from = dropPoints.find((item) => item.id === stops[i - 1].dropId)
    const to = dropPoints.find((item) => item.id === stops[i].dropId)
    if (from && to) totalKm += distanceKm(from, to)
  }
  totalKm = Math.round(totalKm * 100) / 100
  const totalBoxes = stops.reduce((sum, stop) => sum + stop.boxes, 0)

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={6}>
      {stops.map((stop, index) => {
        const drop = dropPoints.find((item) => item.id === stop.dropId)
        const prev = index > 0 ? dropPoints.find((item) => item.id === stops[index - 1].dropId) : undefined
        const legKm = drop && prev ? distanceKm(prev, drop) : 0
        return (
          <div
            key={stop.dropId}
            draggable
            onDragStart={() => setDraggingId(stop.dropId)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => handleDrop(stop.dropId)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              border: '1px dashed #cfd9e2',
              borderRadius: 8,
              background: draggingId === stop.dropId ? '#fff7e6' : '#fff',
              cursor: 'grab'
            }}
          >
            <Tag color="gold">第 {index + 1} 站</Tag>
            <span style={{ flex: 1 }}>
              {drop ? (
                <>
                  <b>{drop.code}</b>（{orchardName(drop.orchardId)}）· 卸下 {stop.boxes} 箱
                </>
              ) : (
                '投放点已删除'
              )}
              {stop.colonyCodes.map((code) => (
                <Tag key={code} color="cyan" style={{ marginInlineStart: 4 }}>
                  {code}
                </Tag>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                {index === 0 ? `出发 ${arrivals[index]}` : `上一段 ${legKm} km · 约 ${estimateDurationH(legKm)} h · 预计到达 ${arrivals[index]}`}
                {drop ? ` · 投放窗 ${drop.dropWindow || '—'} → 撤场 ${drop.withdrawTime || '—'}` : ''}
              </Typography.Text>
            </span>
            <Button size="small" disabled={index === 0} onClick={() => move(index, -1)}>
              上移
            </Button>
            <Button size="small" disabled={index === stops.length - 1} onClick={() => move(index, 1)}>
              下移
            </Button>
          </div>
        )
      })}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        合计 {stops.length} 站 · {totalBoxes} 箱 · 转场 {totalKm} km（拖动站点可调整顺序，里程与预计到达时刻自动重算）
      </Typography.Text>
    </Space>
  )
}
