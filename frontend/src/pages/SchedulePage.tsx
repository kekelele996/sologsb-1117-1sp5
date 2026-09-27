import { useMemo, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Form, Input, Modal, Row, Segmented, Select, Space, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { BeeColony, DropPoint, Orchard, VehicleType } from '@/types'
import { VEHICLE_TYPES } from '@/types'
import FlowerWindowBar from '@/components/common/FlowerWindowBar'
import RouteMap from '@/components/common/RouteMap'
import StatusTag from '@/components/common/StatusTag'
import GenerateShiftModal from '@/components/schedule/GenerateShiftModal'
import SavedShiftCard from '@/components/schedule/SavedShiftCard'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { routeStore } from '@/stores/routeStore'
import { shiftStore } from '@/stores/shiftStore'
import { bloomDays, flowerWindowOverlap } from '@/utils/geo'
import { buildShiftPlan, type ShiftDraft } from '@/utils/planning'
import { suggestColonyBoxes } from '@/types'

interface Placement {
  colonyCode: string
  orchardId: string
  dropCode: string
  start: string
  end: string
}

interface ConflictItem {
  colonyCode: string
  a: Placement
  b: Placement
  days: number
  range: string
}

interface ScheduleRow {
  key: string
  orchard: Orchard
  days: number
  suggest: number
  capacity: number
  placedCodes: string[]
  dropCodes: string[]
  conflicted: boolean
}

/** 季内授粉安排总表：生成可执行授粉班次，按班次展示经停投放点与箱数；冲突处标红 */
export default function SchedulePage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const routes = usePersistentStore(routeStore, (state) => state.rows)
  const shifts = usePersistentStore(shiftStore, (state) => state.rows)
  const [scope, setScope] = useState<'all' | 'conflict'>('all')

  const [optionOpen, setOptionOpen] = useState(false)
  const [vehicleType, setVehicleType] = useState<VehicleType>('厢式货车')
  const [departAt, setDepartAt] = useState(dayjs().hour(6).minute(30).second(0))
  const [riskNote, setRiskNote] = useState('')
  const [drafts, setDrafts] = useState<ShiftDraft[]>([])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  /** 由投放点的群号安排 + 蜂群当前所在地块，汇总出「某群在某地块」的时间占用 */
  const placements = useMemo<Placement[]>(() => {
    const list: Placement[] = []
    dropPoints.forEach((point: DropPoint) => {
      point.colonyCodes.forEach((code) => {
        list.push({ colonyCode: code, orchardId: point.orchardId, dropCode: point.code, start: point.dropWindow, end: point.withdrawTime })
      })
    })
    colonies.forEach((colony: BeeColony) => {
      if (!colony.currentOrchardId) return
      const orchard = orchards.find((item) => item.id === colony.currentOrchardId)
      if (!orchard) return
      const already = list.some((item) => item.colonyCode === colony.code && item.orchardId === colony.currentOrchardId)
      if (already) return
      list.push({ colonyCode: colony.code, orchardId: colony.currentOrchardId, dropCode: '（当前所在）', start: orchard.bloomStart, end: orchard.bloomEnd })
    })
    return list
  }, [dropPoints, colonies, orchards])

  /** 同一蜂群同一天被排入两个地块 → 冲突列表 */
  const conflicts = useMemo<ConflictItem[]>(() => {
    const result: ConflictItem[] = []
    const codes = Array.from(new Set(placements.map((item) => item.colonyCode)))
    codes.forEach((code) => {
      const list = placements.filter((item) => item.colonyCode === code)
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          if (list[i].orchardId === list[j].orchardId) continue
          const overlap = flowerWindowOverlap(list[i].start, list[i].end, list[j].start, list[j].end)
          if (overlap.overlap) {
            result.push({ colonyCode: code, a: list[i], b: list[j], days: overlap.days, range: overlap.range })
          }
        }
      }
    })
    return result
  }, [placements])

  const rows = useMemo<ScheduleRow[]>(
    () =>
      orchards.map((orchard) => {
        const related = placements.filter((item) => item.orchardId === orchard.id)
        const orchardDrops = dropPoints.filter((item) => item.orchardId === orchard.id)
        return {
          key: orchard.id,
          orchard,
          days: bloomDays(orchard),
          suggest: suggestColonyBoxes(orchard),
          capacity: orchardDrops.reduce((sum, item) => sum + item.capacityBoxes, 0),
          placedCodes: Array.from(new Set(related.map((item) => item.colonyCode))),
          dropCodes: Array.from(new Set(related.map((item) => item.dropCode))),
          conflicted: conflicts.some((item) => item.a.orchardId === orchard.id || item.b.orchardId === orchard.id)
        }
      }),
    [orchards, placements, conflicts, dropPoints]
  )

  const visibleRows = scope === 'conflict' ? rows.filter((row) => row.conflicted) : rows
  const totalSuggest = rows.reduce((sum, row) => sum + row.suggest, 0)
  const totalCapacity = rows.reduce((sum, row) => sum + row.capacity, 0)

  function orchardName(id: string): string {
    return orchards.find((item) => item.id === id)?.name ?? '未知地块'
  }

  function openOptions(): void {
    if (orchards.length === 0) {
      message.warning('请先在果园地块管理中录入地块')
      return
    }
    setOptionOpen(true)
  }

  function generatePlan(): void {
    const plan = buildShiftPlan(orchards, dropPoints, colonies, {
      vehicleType,
      departAt: departAt.format('YYYY-MM-DDTHH:mm'),
      riskNote: riskNote.trim()
    })
    setDrafts(plan)
    setOptionOpen(false)
    setPreviewOpen(true)
  }

  async function confirmPlan(): Promise<void> {
    setSaving(true)
    try {
      await shiftStore.getState().savePlan(drafts)
      setPreviewOpen(false)
      message.success(`已保存 ${drafts.length} 个授粉班次，蜂群状态、投放点群号与转场路线已同步`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">季内授粉安排总表</h2>
          <p className="page-sub">
            汇总地块建议箱数、投放点可容纳箱数与蜂群可用状态，一键生成可执行授粉班次；花期重叠占用、投放点超容、撤场晚于花期结束的任务会在班次里明确拦下。
          </p>
        </div>
        <Space>
          <Segmented
            value={scope}
            onChange={(value) => setScope(value as 'all' | 'conflict')}
            options={[
              { label: `全部地块（${rows.length}）`, value: 'all' },
              { label: `仅冲突地块（${rows.filter((row) => row.conflicted).length}）`, value: 'conflict' }
            ]}
          />
          <Button type="primary" onClick={openOptions}>
            生成授粉班次
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        message={
          <Space wrap size={8}>
            <Tag color="blue">地块 {orchards.length}</Tag>
            <Tag color="cyan">蜂群 {colonies.length} 群</Tag>
            <Tag>投放点 {dropPoints.length} 个</Tag>
            <Tag color="orange">建议箱数合计 {totalSuggest}</Tag>
            <Tag color={totalCapacity >= totalSuggest ? 'green' : 'red'}>投放点容量合计 {totalCapacity}</Tag>
            <Tag>已存班次 {shifts.length}</Tag>
          </Space>
        }
      />

      {conflicts.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={`发现 ${conflicts.length} 处蜂群排程冲突：同一群体被排入花期重叠的不同地块`}
          description={
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {conflicts.map((item) => (
                <li key={`${item.colonyCode}-${item.a.dropCode}-${item.b.dropCode}`}>
                  蜂群 <b>{item.colonyCode}</b>：{orchardName(item.a.orchardId)}（{item.a.dropCode} {item.a.start}~{item.a.end}）与{' '}
                  {orchardName(item.b.orchardId)}（{item.b.dropCode} {item.b.start}~{item.b.end}）重叠 {item.days} 天（{item.range}）
                </li>
              ))}
            </ul>
          }
        />
      ) : (
        <Alert type="success" showIcon message="当前投放点群号安排无花期重叠冲突" />
      )}

      {shifts.length > 0 ? (
        <Card size="small" title={`授粉班次（${shifts.length}）· 按班次显示经停投放点与箱数`}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {shifts.map((shift) => (
              <SavedShiftCard key={shift.id} shift={shift} orchards={orchards} dropPoints={dropPoints} />
            ))}
          </Space>
        </Card>
      ) : null}

      <Row gutter={16}>
        <Col xs={24} xl={14}>
          <Card size="small" title="花期条带与已投放群体" styles={{ body: { display: 'flex', flexDirection: 'column', gap: 12 } }}>
            {visibleRows.map((row) => (
              <div key={row.key} className={row.conflicted ? 'conflict-row' : ''} style={{ padding: 8, borderRadius: 8 }}>
                <FlowerWindowBar orchard={row.orchard} others={orchards.filter((item) => item.id !== row.orchard.id)} width={420} />
                <Space wrap size={4} style={{ marginTop: 6 }}>
                  <Tag>建议 {row.suggest} 箱</Tag>
                  <Tag color={row.capacity >= row.suggest ? 'green' : 'red'}>容量 {row.capacity} 箱</Tag>
                  <Tag color="blue">花期 {row.days} 天</Tag>
                  <Tag color={row.orchard.accessibility === '大车可达' ? 'green' : row.orchard.accessibility === '仅小车' ? 'gold' : 'red'}>
                    {row.orchard.accessibility}
                  </Tag>
                  {row.placedCodes.length > 0 ? (
                    row.placedCodes.map((code) => <Tag key={code} color="cyan">已投放 {code}</Tag>)
                  ) : (
                    <Tag>尚未安排群体</Tag>
                  )}
                  {row.conflicted ? <Tag color="red">存在冲突</Tag> : null}
                </Space>
              </div>
            ))}
            {visibleRows.length === 0 ? <Typography.Text type="secondary">没有符合条件的地块</Typography.Text> : null}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card size="small" title="地图总览（地块 / 投放点 / 转场折线）">
            <RouteMap orchards={orchards} dropPoints={dropPoints} routes={routes} height={360} title="季内投放分布" />
          </Card>
        </Col>
      </Row>

      <Card size="small" title={`各地块排程明细（建议箱数合计 ${totalSuggest} 箱 / 容量 ${totalCapacity} 箱）`}>
        <Table<ScheduleRow>
          dataSource={rows}
          rowKey="key"
          pagination={false}
          rowClassName={(record) => (record.conflicted ? 'conflict-row' : '')}
          columns={[
            { title: '地块', dataIndex: ['orchard', 'name'], key: 'name' },
            { title: '作物', dataIndex: ['orchard', 'crop'], key: 'crop', width: 90 },
            { title: '面积（亩）', dataIndex: ['orchard', 'areaMu'], key: 'area', width: 100 },
            {
              title: '盛花期',
              key: 'bloom',
              render: (_, record: ScheduleRow) => `${record.orchard.bloomStart} ~ ${record.orchard.bloomEnd}`
            },
            { title: '花期天数', dataIndex: 'days', key: 'days', width: 90 },
            { title: '建议箱数', dataIndex: 'suggest', key: 'suggest', width: 90 },
            {
              title: '投放点容量',
              dataIndex: 'capacity',
              key: 'capacity',
              width: 100,
              render: (value: number, record) => <Tag color={value >= record.suggest ? 'green' : 'red'}>{value} 箱</Tag>
            },
            {
              title: '投放点',
              key: 'drops',
              render: (_, record: ScheduleRow) => (record.dropCodes.length > 0 ? record.dropCodes.join('、') : '—')
            },
            {
              title: '已投放群体',
              key: 'colonies',
              render: (_, record: ScheduleRow) => (
                <Space wrap size={4}>
                  {record.placedCodes.length > 0 ? record.placedCodes.map((code) => <Tag key={code}>{code}</Tag>) : <span>—</span>}
                </Space>
              )
            },
            {
              title: '状态',
              key: 'status',
              width: 120,
              render: (_, record: ScheduleRow) => (record.conflicted ? <Tag color="red">冲突</Tag> : <Tag color="green">正常</Tag>)
            }
          ]}
        />
      </Card>

      <Card size="small" title={`蜂群当前状态（${colonies.length} 群，状态随班次保存同步变化）`}>
        <Space wrap>
          {colonies.map((colony) => (
            <StatusTag key={colony.id} status={colony.status} hint={colony.currentOrchardId ? orchardName(colony.currentOrchardId) : '未分配地块'} />
          ))}
        </Space>
      </Card>

      <Modal
        title="生成授粉班次 · 作业参数"
        open={optionOpen}
        onCancel={() => setOptionOpen(false)}
        onOk={generatePlan}
        okText="开始排班"
        cancelText="取消"
      >
        <Form layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label="车辆类型">
            <Select value={vehicleType} onChange={(value) => setVehicleType(value)} options={VEHICLE_TYPES.map((item) => ({ value: item, label: item }))} />
          </Form.Item>
          <Form.Item label="首站出发时刻（各花期班次均按此时刻从首站发车）">
            <DatePicker showTime value={departAt} onChange={(value) => setDepartAt(value ?? dayjs().hour(6).minute(30))} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="途中风险备注（写入各班次转场段）">
            <Input value={riskNote} onChange={(event) => setRiskNote(event.target.value)} placeholder="如 西沟坡道窄，雨天泥泞" />
          </Form.Item>
        </Form>
      </Modal>

      <GenerateShiftModal
        open={previewOpen}
        drafts={drafts}
        orchards={orchards}
        colonies={colonies}
        onCancel={() => setPreviewOpen(false)}
        onConfirm={() => void confirmPlan()}
        confirmLoading={saving}
      />
    </div>
  )
}
