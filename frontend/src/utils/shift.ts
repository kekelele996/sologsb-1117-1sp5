import dayjs from 'dayjs'
import type { BeeColony, DropPoint, Orchard, ShiftStop, ShiftTask, TransitRoute, VehicleType } from '@/types'
import { suggestColonyBoxes } from '@/types'
import { distanceKm, estimateDurationH, flowerWindowOverlap, toDateValue } from '@/utils/geo'
import { uid } from '@/utils/id'

/** 可参与自动排班的蜂群状态 */
export const AVAILABLE_STATUSES: BeeColony['status'][] = ['待投放', '回场']

/** 拦截类型：投放点超容 / 撤场晚于花期结束 / 花期重叠 / 可用蜂群不足 */
export type BlockedKind = '容量' | '撤场' | '重叠' | '蜂群不足'

export interface BlockedItem {
  kind: BlockedKind
  text: string
}

/** 生成阶段的班次草稿（保存后才写入 ShiftTask） */
export interface DraftShift {
  key: string
  name: string
  /** 执行日期（YYYY-MM-DD） */
  date: string
  /** 首站出发时刻（HH:mm） */
  departTime: string
  vehicleType: VehicleType
  orchardId: string
  stops: ShiftStop[]
  /** 被拦下的安排（不随班次保存） */
  blocked: BlockedItem[]
}

interface ColonyWindow {
  orchardId: string
  start: string
  end: string
}

function maxDate(a: string, b: string): string {
  return toDateValue(a) >= toDateValue(b) ? a : b
}

/** 汇总蜂群已被占用的时间窗（投放点安排 + 当前所在地块），用于花期重叠判定 */
function colonyWindows(colonies: BeeColony[], dropPoints: DropPoint[], orchards: Orchard[]): Map<string, ColonyWindow[]> {
  const map = new Map<string, ColonyWindow[]>()
  const push = (code: string, win: ColonyWindow): void => {
    const list = map.get(code) ?? []
    list.push(win)
    map.set(code, list)
  }
  dropPoints.forEach((point) => {
    point.colonyCodes.forEach((code) => push(code, { orchardId: point.orchardId, start: point.dropWindow, end: point.withdrawTime }))
  })
  colonies.forEach((colony) => {
    if (!colony.currentOrchardId) return
    const orchard = orchards.find((item) => item.id === colony.currentOrchardId)
    if (!orchard) return
    push(colony.code, { orchardId: orchard.id, start: orchard.bloomStart, end: orchard.bloomEnd })
  })
  return map
}

/**
 * 生成授粉班次草稿：
 * 1) 按地块建议箱数逐地块排班，每块地一个班次，站点箱数不超过投放点剩余容量；
 * 2) 只用「待投放 / 回场」的蜂群，按群势从强到弱分配；
 * 3) 同一群被分到花期重叠地块、投放点超容、撤场晚于花期结束 → 拦下并写明原因，不进入可保存任务。
 */
export function generateShifts(input: { orchards: Orchard[]; colonies: BeeColony[]; dropPoints: DropPoint[] }): DraftShift[] {
  const { orchards, colonies, dropPoints } = input
  const orchardName = (id: string): string => orchards.find((item) => item.id === id)?.name ?? '未知地块'
  const windows = colonyWindows(colonies, dropPoints, orchards)
  const pool = colonies
    .filter((item) => AVAILABLE_STATUSES.includes(item.status))
    .sort((a, b) => b.strengthFrames - a.strengthFrames)
  const assigned = new Set<string>()
  const roomLeft = new Map<string, number>(dropPoints.map((point) => [point.id, point.capacityBoxes - point.colonyCodes.length]))

  const drafts: DraftShift[] = []
  const sorted = [...orchards].sort((a, b) => a.bloomStart.localeCompare(b.bloomStart))

  sorted.forEach((orchard) => {
    const drops = dropPoints
      .filter((point) => point.orchardId === orchard.id)
      .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    const placed = new Set<string>()
    drops.forEach((point) => point.colonyCodes.forEach((code) => placed.add(code)))
    colonies.filter((item) => item.currentOrchardId === orchard.id).forEach((item) => placed.add(item.code))
    const suggest = suggestColonyBoxes(orchard)
    let need = suggest - placed.size
    if (need <= 0) return

    const stops: ShiftStop[] = []
    const blocked: BlockedItem[] = []
    const overlapBlocked = new Set<string>()
    let firstDate = ''

    if (drops.length === 0) {
      blocked.push({ kind: '容量', text: `${orchard.name}：尚无投放点，请先在果园地块管理中维护投放点` })
    }

    drops.forEach((drop) => {
      if (need <= 0) return
      if (toDateValue(drop.withdrawTime) > toDateValue(orchard.bloomEnd)) {
        blocked.push({
          kind: '撤场',
          text: `投放点 ${drop.code}：撤场 ${drop.withdrawTime} 晚于花期结束 ${orchard.bloomEnd}，整站拦下（请先调整撤场时间）`
        })
        return
      }
      if (drop.dropWindow && toDateValue(drop.dropWindow) > toDateValue(orchard.bloomEnd)) {
        blocked.push({ kind: '撤场', text: `投放点 ${drop.code}：投放窗起始 ${drop.dropWindow} 晚于花期结束 ${orchard.bloomEnd}，整站拦下` })
        return
      }
      const room = Math.max(0, roomLeft.get(drop.id) ?? 0)
      if (room <= 0) {
        blocked.push({ kind: '容量', text: `投放点 ${drop.code}：可容纳 ${drop.capacityBoxes} 箱已排满，超容部分拦下` })
        return
      }
      const wanted = Math.min(room, need)
      const picked: BeeColony[] = []
      for (const colony of pool) {
        if (picked.length >= wanted) break
        if (assigned.has(colony.id) || overlapBlocked.has(colony.id)) continue
        const hit = (windows.get(colony.code) ?? []).find(
          (win) => win.orchardId !== orchard.id && flowerWindowOverlap(win.start, win.end, orchard.bloomStart, orchard.bloomEnd).overlap
        )
        if (hit) {
          const detail = flowerWindowOverlap(hit.start, hit.end, orchard.bloomStart, orchard.bloomEnd)
          blocked.push({
            kind: '重叠',
            text: `蜂群 ${colony.code}：${hit.start} ~ ${hit.end} 已排在「${orchardName(hit.orchardId)}」，与本地块花期重叠 ${detail.days} 天（${detail.range}），拦下该群`
          })
          overlapBlocked.add(colony.id)
          continue
        }
        picked.push(colony)
        assigned.add(colony.id)
      }
      if (picked.length === 0) {
        blocked.push({ kind: '蜂群不足', text: `投放点 ${drop.code}：需 ${wanted} 箱，无可用蜂群，拦下` })
        return
      }
      const start = drop.dropWindow ? maxDate(orchard.bloomStart, drop.dropWindow) : orchard.bloomStart
      if (!firstDate || toDateValue(start) < toDateValue(firstDate)) firstDate = start
      stops.push({ dropId: drop.id, boxes: picked.length, colonyCodes: picked.map((item) => item.code) })
      roomLeft.set(drop.id, room - picked.length)
      need -= picked.length
      picked.forEach((colony) => {
        const list = windows.get(colony.code) ?? []
        list.push({ orchardId: orchard.id, start: orchard.bloomStart, end: orchard.bloomEnd })
        windows.set(colony.code, list)
      })
      if (picked.length < wanted) {
        blocked.push({
          kind: '蜂群不足',
          text: `投放点 ${drop.code}：需 ${wanted} 箱，仅排入 ${picked.length} 箱，缺口 ${wanted - picked.length} 箱拦下`
        })
      }
    })

    if (need > 0) {
      blocked.push({
        kind: '蜂群不足',
        text: `${orchard.name}：建议 ${suggest} 箱，已落实 ${suggest - need} 箱，剩余缺口 ${need} 箱拦下（可用蜂群或投放点容量不足）`
      })
    }
    if (stops.length === 0 && blocked.length === 0) return

    drafts.push({
      key: uid('draft'),
      name: `授粉班次 ${(firstDate || orchard.bloomStart).slice(5).replace('-', '')} · ${orchard.name}`,
      date: firstDate || orchard.bloomStart,
      departTime: '06:30',
      vehicleType: orchard.accessibility === '大车可达' ? '厢式货车' : orchard.accessibility === '仅小车' ? '皮卡' : '人工搬运',
      orchardId: orchard.id,
      stops,
      blocked
    })
  })

  return drafts
}

/** 每站预计到达时刻（首站为出发时刻），格式 MM-DD HH:mm */
export function stopArrivals(stops: ShiftStop[], dropPoints: DropPoint[], date: string, departTime: string): string[] {
  const result: string[] = []
  let moment = dayjs(`${date}T${departTime || '06:30'}`)
  stops.forEach((stop, index) => {
    if (index > 0) {
      const from = dropPoints.find((item) => item.id === stops[index - 1].dropId)
      const to = dropPoints.find((item) => item.id === stop.dropId)
      if (from && to) {
        moment = moment.add(Math.round(estimateDurationH(distanceKm(from, to)) * 60), 'minute')
      }
    }
    result.push(moment.format('MM-DD HH:mm'))
  })
  return result
}

/** 班次相邻经停站之间的转场段（里程 / 耗时 / 出发时刻链，写回路线表） */
export function buildShiftRoutes(shift: ShiftTask, dropPoints: DropPoint[]): TransitRoute[] {
  const routes: TransitRoute[] = []
  let moment = dayjs(`${shift.date}T${shift.departTime || '06:30'}`)
  for (let i = 1; i < shift.stops.length; i += 1) {
    const from = dropPoints.find((item) => item.id === shift.stops[i - 1].dropId)
    const to = dropPoints.find((item) => item.id === shift.stops[i].dropId)
    if (!from || !to) continue
    const km = distanceKm(from, to)
    const durationH = estimateDurationH(km)
    routes.push({
      id: uid('rt'),
      fromDropId: from.id,
      toDropId: to.id,
      distanceKm: km,
      durationH,
      vehicleType: shift.vehicleType,
      departAt: moment.format('YYYY-MM-DDTHH:mm'),
      riskNote: '',
      actualNote: '待执行',
      shiftId: shift.id
    })
    moment = moment.add(Math.round(durationH * 60), 'minute')
  }
  return routes
}
