import { useMemo, useState } from 'react'
import { Button, Card, Col, DatePicker, Empty, Form, Input, Row, Select, Space, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { DropPoint, TransitRoute } from '@/types'
import { VEHICLE_TYPES } from '@/types'
import RouteMap from '@/components/common/RouteMap'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { droppointStore } from '@/stores/droppointStore'
import { routeStore } from '@/stores/routeStore'
import { distanceKm, estimateDurationH, routeLegs } from '@/utils/geo'

/** 转场路线规划：地图上依次选点生成顺序与里程，支持拖动调整顺序并重算 */
export default function RoutesPage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const routes = usePersistentStore(routeStore, (state) => state.rows)

  const [orderedIds, setOrderedIds] = useState<string[]>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [vehicleType, setVehicleType] = useState<TransitRoute['vehicleType']>('厢式货车')
  const [departAt, setDepartAt] = useState(dayjs())
  const [riskNote, setRiskNote] = useState('')

  const ordered = useMemo(
    () => orderedIds.map((id) => dropPoints.find((item) => item.id === id)).filter((item): item is DropPoint => Boolean(item)),
    [orderedIds, dropPoints]
  )

  const legs = useMemo(() => routeLegs(ordered.map((item) => ({ longitude: item.longitude, latitude: item.latitude }))), [ordered])

  /** 各站预计到达时刻：首站 = 首段出发时刻，之后逐段累加耗时 */
  const arrivals = useMemo(() => {
    const start = departAt.valueOf()
    let cursor = start
    return ordered.map((_, index) => {
      if (index > 0) cursor += Math.round(estimateDurationH(legs.legs[index - 1]) * 3600000)
      return dayjs(cursor)
    })
  }, [ordered, legs.legs, departAt])

  function orchardName(orchardId: string): string {
    return orchards.find((item) => item.id === orchardId)?.name ?? '未知地块'
  }

  function addPoint(id: string): void {
    if (orderedIds.includes(id)) {
      message.info('该投放点已在顺序中')
      return
    }
    setOrderedIds((prev) => [...prev, id])
  }

  function removePoint(id: string): void {
    setOrderedIds((prev) => prev.filter((item) => item !== id))
  }

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction
    if (target < 0 || target >= orderedIds.length) return
    const next = [...orderedIds]
    const temp = next[index]
    next[index] = next[target]
    next[target] = temp
    setOrderedIds(next)
  }

  function handleDrop(targetId: string): void {
    if (!draggingId || draggingId === targetId) return
    setOrderedIds((prev) => {
      const next = prev.filter((item) => item !== draggingId)
      const index = next.indexOf(targetId)
      next.splice(index < 0 ? next.length : index, 0, draggingId)
      return next
    })
    setDraggingId(null)
  }

  async function generate(): Promise<void> {
    if (orderedIds.length < 2) {
      message.warning('至少选择 2 个投放点才能生成转场路线')
      return
    }
    await routeStore.getState().rebuildFromOrder(orderedIds, {
      vehicleType,
      departAt: departAt.format('YYYY-MM-DDTHH:mm'),
      riskNote: riskNote.trim()
    })
    message.success(`已生成 ${orderedIds.length - 1} 段转场路线，累计 ${legs.total} km`)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">转场路线规划</h2>
          <p className="page-sub">
            在投放点列表中依次选点生成转场顺序与里程；可拖动条目或上下移动调整顺序，里程与耗时实时重算，确认后写回路线表。
          </p>
        </div>
        <Space>
          <Button onClick={() => setOrderedIds([])}>清空顺序</Button>
          <Button type="primary" onClick={() => void generate()}>
            生成并保存路线
          </Button>
        </Space>
      </div>

      <Row gutter={16}>
        <Col xs={24} xl={15}>
          <Card size="small" title="地图（投放点与转场折线）">
            <RouteMap
              orchards={orchards}
              dropPoints={dropPoints}
              routes={routes}
              orderedDropIds={orderedIds}
              height={420}
              title="转场顺序预览"
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card size="small" title="投放点（点击加入转场顺序）" style={{ marginBottom: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              {dropPoints.map((point) => (
                <Space key={point.id} style={{ width: '100%', justifyContent: 'space-between' }}>
                  <span>
                    <Tag color="blue">{point.code}</Tag>
                    {orchardName(point.orchardId)} · 可容纳 {point.capacityBoxes} 箱 · 水源 {point.waterDistance} m
                  </span>
                  <Button size="small" onClick={() => addPoint(point.id)}>
                    加入顺序
                  </Button>
                </Space>
              ))}
              {dropPoints.length === 0 ? <Empty description="暂无投放点，请先在果园地块管理中添加" /> : null}
            </Space>
          </Card>

          <Card size="small" title={`转场顺序（${ordered.length} 点 · 累计 ${legs.total} km）`}>
            {ordered.length === 0 ? (
              <Typography.Text type="secondary">尚未选择投放点</Typography.Text>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                {ordered.map((point, index) => (
                  <div
                    key={point.id}
                    draggable
                    onDragStart={() => setDraggingId(point.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => handleDrop(point.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      border: '1px dashed #cfd9e2',
                      borderRadius: 8,
                      background: draggingId === point.id ? '#fff7e6' : '#fff',
                      cursor: 'grab'
                    }}
                  >
                    <Tag color="gold">第 {index + 1} 站</Tag>
                    <span style={{ flex: 1 }}>
                      {point.code} · {orchardName(point.orchardId)}
                      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                        预计到 {arrivals[index].format('MM-DD HH:mm')}
                      </Typography.Text>
                      {index > 0 ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                          上一段 {distanceKm(ordered[index - 1], point)} km / 约 {estimateDurationH(distanceKm(ordered[index - 1], point))} h
                        </Typography.Text>
                      ) : null}
                    </span>
                    <Button size="small" disabled={index === 0} onClick={() => move(index, -1)}>
                      上移
                    </Button>
                    <Button size="small" disabled={index === ordered.length - 1} onClick={() => move(index, 1)}>
                      下移
                    </Button>
                    <Button size="small" danger type="link" onClick={() => removePoint(point.id)}>
                      移除
                    </Button>
                  </div>
                ))}
              </Space>
            )}
            <Form layout="vertical" style={{ marginTop: 12 }}>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="车辆类型" style={{ marginBottom: 8 }}>
                    <Select value={vehicleType} onChange={(value) => setVehicleType(value)} options={VEHICLE_TYPES.map((item) => ({ value: item, label: item }))} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="首段出发时刻" style={{ marginBottom: 8 }}>
                    <DatePicker showTime value={departAt} onChange={(value) => setDepartAt(value ?? dayjs())} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="途中风险备注" style={{ marginBottom: 0 }}>
                    <Input value={riskNote} onChange={(event) => setRiskNote(event.target.value)} placeholder="如 西沟坡道窄，雨天泥泞" />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Card>
        </Col>
      </Row>

      <Card size="small" title={`已保存的转场路线（${routes.length} 段 · 合计 ${Math.round(routes.reduce((sum, item) => sum + item.distanceKm, 0) * 100) / 100} km）`}>
        <Table<TransitRoute>
          dataSource={routes}
          rowKey="id"
          pagination={false}
          columns={[
            {
              title: '出发',
              key: 'from',
              render: (_, record: TransitRoute) => {
                const point = dropPoints.find((item) => item.id === record.fromDropId)
                return point ? `${point.code}（${orchardName(point.orchardId)}）` : '—'
              }
            },
            {
              title: '到达',
              key: 'to',
              render: (_, record: TransitRoute) => {
                const point = dropPoints.find((item) => item.id === record.toDropId)
                return point ? `${point.code}（${orchardName(point.orchardId)}）` : '—'
              }
            },
            { title: '里程（km）', dataIndex: 'distanceKm', key: 'km', width: 110 },
            { title: '预计耗时（h）', dataIndex: 'durationH', key: 'hour', width: 120 },
            {
              title: '预计到达',
              key: 'eta',
              width: 130,
              render: (_, record: TransitRoute) => {
                const arrive = dayjs(record.departAt).add(record.durationH, 'hour')
                return arrive.isValid() ? arrive.format('MM-DD HH:mm') : '—'
              }
            },
            { title: '车辆', dataIndex: 'vehicleType', key: 'vehicle', width: 100 },
            { title: '出发时刻', dataIndex: 'departAt', key: 'depart', width: 150, render: (value: string) => value.replace('T', ' ') },
            {
              title: '来源',
              key: 'source',
              width: 100,
              render: (_, record: TransitRoute) => (record.shiftId ? <Tag color="blue">授粉班次</Tag> : <Tag>人工规划</Tag>)
            },
            { title: '风险备注', dataIndex: 'riskNote', key: 'risk', render: (value: string) => value || '—' },
            { title: '实际记录', dataIndex: 'actualNote', key: 'actual', width: 120 },
            {
              title: '操作',
              key: 'action',
              width: 80,
              render: (_, record: TransitRoute) => (
                <Button
                  size="small"
                  danger
                  type="link"
                  onClick={() => {
                    if (record.shiftId) {
                      message.info('该段由授粉班次生成，请在总表拖动站点顺序来重算')
                      return
                    }
                    void routeStore.getState().remove(record.id)
                  }}
                >
                  删除
                </Button>
              )
            }
          ]}
        />
      </Card>
    </div>
  )
}
