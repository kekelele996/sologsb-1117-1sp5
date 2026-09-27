import type {
  BeeColony,
  DropPoint,
  Orchard,
  PollinationShift,
  ShiftLeg,
  ShiftStop,
  ShiftTask,
  TaskBlock,
  TaskWarning,
  VehicleType
} from '@/types'
import { distanceKm, estimateDurationH, flowerWindowOverlap, toDateValue } from '@/utils/geo'

/** 班次生成参数 */
export interface PlanOptions {
  vehicleType: VehicleType
  /** 首站出发时刻（YYYY-MM-DDTHH:mm，时间部分作为各班次默认出发时刻） */
  departAt: string
  riskNote: string
}

/** 班次草稿（保存前预览用，结构与 PollinationShift 一致） */
export type ShiftDraft = PollinationShift

/** 某群在某地块的一次花期占用（用于重叠判定，跨班次累计） */
interface Occupancy {
  colonyCode: string
  orchardId: string
  start: string
  end: string
}

interface Allocation {
  point: DropPoint
  boxes: number
  lockedCodes: string[]
}

/**
 * 投放点分箱：
 * 1) 已有群号安排的投放点按已安排群数保底（保证既有安排生成任务、冲突可被拦下）；
 * 2) 剩余建议箱数按容量降序轮询铺箱，尽量让多个投放点都成任务；
 * 3) 总容量不足时溢出箱落在最大投放点 → 由「投放点超容」规则拦下。
 */
function allocateBoxes(points: DropPoint[], suggested: number): Allocation[] {
  const allocations: Allocation[] = points.map((point) => ({
    point,
    boxes: point.colonyCodes.length,
    lockedCodes: [...point.colonyCodes]
  }))
  let remaining = Math.max(0, suggested - allocations.reduce((sum, item) => sum + item.boxes, 0))
  const order = [...allocations].sort((a, b) => b.point.capacityBoxes - a.point.capacityBoxes)
  // 轮询铺箱：每轮按容量降序给还有空余的投放点各加 1 箱
  while (remaining > 0) {
    let progressed = false
    for (const allocation of order) {
      if (remaining <= 0) break
      if (allocation.boxes < allocation.point.capacityBoxes) {
        allocation.boxes += 1
        remaining -= 1
        progressed = true
      }
    }
    if (!progressed) break
  }
  if (remaining > 0 && order[0]) {
    order[0].boxes += remaining
  }
  return allocations
}

let seq = 0
function nextTaskId(): string {
  seq += 1
  return `task_${Date.now().toString(36)}_${seq}`
}

/**
 * 生成授粉班次草稿：
 * - 按地块盛花期起归并班次；
 * - 每个投放点按建议箱数分箱并指派蜂群（先锁定投放点既有安排，再从全局未占用池补足）；
 * - 同一群被分到花期重叠地块、投放点超容、撤场晚于花期结束 → 写进任务 blocked 拦下；
 * - 蜂群转场中 / 箱数缺口只作为 warning 提示，不硬拦。
 */
export function buildShiftPlan(
  orchards: Orchard[],
  dropPoints: DropPoint[],
  colonies: BeeColony[],
  options: PlanOptions
): ShiftDraft[] {
  // 外部占用：投放点既有群号安排 + 在园/转场中蜂群的当前地块
  const externalOccupancies: Occupancy[] = []
  dropPoints.forEach((point) => {
    point.colonyCodes.forEach((code) => {
      externalOccupancies.push({ colonyCode: code, orchardId: point.orchardId, start: point.dropWindow, end: point.withdrawTime })
    })
  })
  colonies.forEach((colony) => {
    if (!colony.currentOrchardId || (colony.status !== '在园' && colony.status !== '转场中')) return
    const orchard = orchards.find((item) => item.id === colony.currentOrchardId)
    if (!orchard) return
    const exists = externalOccupancies.some((item) => item.colonyCode === colony.code && item.orchardId === colony.currentOrchardId)
    if (!exists) {
      externalOccupancies.push({ colonyCode: colony.code, orchardId: colony.currentOrchardId, start: orchard.bloomStart, end: orchard.bloomEnd })
    }
  })

  // 跨班次累计：已被可执行任务占用的群与其花期占用
  const committedCodes: string[] = []
  const committedOccupancies: Occupancy[] = []
  // 投放点人工既有安排的群号：只允许留在原投放点（冲突照拦），自动分配不得再选
  const lockedCodesAll = Array.from(new Set(dropPoints.flatMap((point) => point.colonyCodes)))

  /** 判断群号在指定地块花期窗内是否与任何占用（外部安排 + 班内已落地任务）冲突 */
  function findOverlap(code: string, orchardId: string, start: string, end: string): Occupancy | null {
    for (const occ of [...externalOccupancies, ...committedOccupancies]) {
      if (occ.colonyCode !== code || occ.orchardId === orchardId) continue
      if (flowerWindowOverlap(start, end, occ.start, occ.end).overlap) return occ
    }
    return null
  }

  const shifts: ShiftDraft[] = []
  const timePart = options.departAt.slice(11) || '06:30'

  // 按盛花期起分组（同日盛花期归入同一班次）
  const groups = new Map<string, Orchard[]>()
  orchards
    .slice()
    .sort((a, b) => a.bloomStart.localeCompare(b.bloomStart))
    .forEach((orchard) => {
      const list = groups.get(orchard.bloomStart) ?? []
      list.push(orchard)
      groups.set(orchard.bloomStart, list)
    })

  groups.forEach((groupOrchards, bloomStart) => {
    const shiftId = `shift_${bloomStart.replace(/-/g, '')}`
    const tasks: ShiftTask[] = []

    groupOrchards.forEach((orchard) => {
      const points = dropPoints
        .filter((item) => item.orchardId === orchard.id)
        .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
      if (points.length === 0) {
        tasks.push({
          id: nextTaskId(),
          shiftId,
          orchardId: orchard.id,
          dropId: '',
          dropCode: '（无投放点）',
          boxes: 0,
          colonyCodes: [],
          start: orchard.bloomStart,
          end: orchard.bloomEnd,
          locked: false,
          blocked: [{ reason: '投放点超容', detail: '地块下尚未登记投放点，无法排班' }],
          warnings: []
        })
        return
      }

      const suggested = Math.max(1, Math.ceil((orchard.areaMu || 0) * (orchard.colonyIntensity || 0)))
      const allocations = allocateBoxes(points, suggested)

      allocations.forEach((allocation) => {
        if (allocation.boxes <= 0) return
        const point = allocation.point
        const blocks: TaskBlock[] = []
        const warnings: TaskWarning[] = []

        // 规则二：投放点超容
        if (allocation.boxes > point.capacityBoxes) {
          blocks.push({ reason: '投放点超容', detail: `需投 ${allocation.boxes} 箱，超过 ${point.code} 可容纳 ${point.capacityBoxes} 箱` })
        }

        // 规则三：撤场晚于花期结束
        if (toDateValue(point.withdrawTime) > toDateValue(orchard.bloomEnd)) {
          blocks.push({ reason: '撤场晚于花期结束', detail: `撤场 ${point.withdrawTime} 晚于盛花期结束 ${orchard.bloomEnd}` })
        }

        const start = point.dropWindow || orchard.bloomStart
        const end = point.withdrawTime || orchard.bloomEnd

        // 指派蜂群：先锁定投放点既有安排，再从全局未占用池自动补足
        const codes = allocation.lockedCodes
          .map((code) => colonies.find((colony) => colony.code === code)?.code)
          .filter((code): code is string => Boolean(code))
        const need = allocation.boxes - codes.length
        if (need > 0) {
          const freePool = colonies.filter(
            (colony) => !committedCodes.includes(colony.code) && !codes.includes(colony.code) && !lockedCodesAll.includes(colony.code)
          )
          if (freePool.length < need) {
            warnings.push({
              reason: '蜂群箱数缺口',
              detail: `还需 ${need} 群，仅剩 ${freePool.length} 群可调用，缺口 ${Math.max(0, need - freePool.length)} 群`
            })
          }
          for (let i = 0; i < need; i += 1) {
            const colony = freePool[i]
            if (!colony) break
            if (colony.status === '转场中') {
              warnings.push({ reason: '蜂群转场中', detail: `蜂群 ${colony.code} 当前转场中，作业前需确认到位` })
            }
            codes.push(colony.code)
          }
          if (codes.length === 0) warnings.push({ reason: '无可用蜂群', detail: `${point.code} 暂无可调用蜂群` })
        }

        // 规则一：同一群被分到花期重叠地块
        const overlapCodes = new Set<string>()
        codes.forEach((code) => {
          const occ = findOverlap(code, orchard.id, start, end)
          if (occ) {
            overlapCodes.add(code)
            blocks.push({ reason: '花期重叠占用', detail: `蜂群 ${code} 同时被排入花期重叠地块（对方占用 ${occ.start} ~ ${occ.end}）` })
          }
        })

        const task: ShiftTask = {
          id: nextTaskId(),
          shiftId,
          orchardId: orchard.id,
          dropId: point.id,
          dropCode: point.code,
          boxes: allocation.boxes,
          colonyCodes: Array.from(new Set(codes)),
          start,
          end,
          locked: allocation.lockedCodes.length > 0,
          blocked: blocks,
          warnings
        }
        tasks.push(task)

        // 仅可执行任务占用蜂群（被拦任务不落地、不抢占蜂群）
        if (blocks.length === 0) {
          codes.forEach((code) => {
            if (!committedCodes.includes(code)) committedCodes.push(code)
            committedOccupancies.push({ colonyCode: code, orchardId: orchard.id, start, end })
          })
        }
      })
    })

    // 经停点：只收可执行任务的站点，箱数按站点合计
    const stopMap = new Map<string, ShiftStop>()
    tasks
      .filter((task) => task.blocked.length === 0 && task.dropId)
      .forEach((task) => {
        const prev = stopMap.get(task.dropId)
        if (prev) prev.boxes += task.boxes
        else stopMap.set(task.dropId, { dropId: task.dropId, code: task.dropCode, orchardId: task.orchardId, boxes: task.boxes })
      })
    const stops = sortStopsNearestNeighbor(Array.from(stopMap.values()), dropPoints)

    shifts.push({
      id: shiftId,
      name: `${bloomStart.slice(5)} 授粉班次`,
      workDate: bloomStart,
      vehicleType: options.vehicleType,
      departAt: `${bloomStart}T${timePart}`,
      riskNote: options.riskNote,
      stops,
      legs: buildLegs(stops, dropPoints),
      tasks,
      createdAt: new Date().toISOString()
    })
  })

  return shifts
}

/** 最近邻排序经停点：先取距站点重心最近者为首站，之后逐段取最近 */
function sortStopsNearestNeighbor(stops: ShiftStop[], dropPoints: DropPoint[]): ShiftStop[] {
  if (stops.length <= 1) return stops
  const coords = new Map(dropPoints.map((point) => [point.id, { longitude: point.longitude, latitude: point.latitude }]))
  const center = {
    longitude: stops.reduce((sum, item) => sum + (coords.get(item.dropId)?.longitude ?? 0), 0) / stops.length,
    latitude: stops.reduce((sum, item) => sum + (coords.get(item.dropId)?.latitude ?? 0), 0) / stops.length
  }
  const remaining = [...stops]
  const first = remaining.reduce((best, stop) => {
    const a = coords.get(stop.dropId)
    const b = coords.get(best.dropId)
    if (!a || !b) return best
    return distanceKm(a, center) < distanceKm(b, center) ? stop : best
  }, remaining[0])
  const ordered = [first]
  remaining.splice(remaining.indexOf(first), 1)
  while (remaining.length > 0) {
    const from = coords.get(ordered[ordered.length - 1].dropId)
    let nearest = remaining[0]
    let nearestKm = Number.POSITIVE_INFINITY
    remaining.forEach((stop) => {
      const to = coords.get(stop.dropId)
      if (!from || !to) return
      const km = distanceKm(from, to)
      if (km < nearestKm) {
        nearestKm = km
        nearest = stop
      }
    })
    ordered.push(nearest)
    remaining.splice(remaining.indexOf(nearest), 1)
  }
  return ordered
}

/** 由经停顺序生成转场段并重算里程 / 耗时（拖动站点顺序后调用） */
export function buildLegs(stops: ShiftStop[], dropPoints: DropPoint[]): ShiftLeg[] {
  const legs: ShiftLeg[] = []
  for (let i = 1; i < stops.length; i += 1) {
    const from = dropPoints.find((item) => item.id === stops[i - 1].dropId)
    const to = dropPoints.find((item) => item.id === stops[i].dropId)
    if (!from || !to) continue
    const km = distanceKm(from, to)
    legs.push({ fromDropId: from.id, toDropId: to.id, distanceKm: km, durationH: estimateDurationH(km) })
  }
  return legs
}

export interface StopTiming {
  departAt: Date
  /** 每一站预计到达时刻（首站 = departAt） */
  arrivals: Date[]
}

/** 按首站出发时刻 + 各段耗时推算各站预计到达时刻（跨天自动进位） */
export function computeTimings(shift: PollinationShift): StopTiming {
  const parsed = new Date(shift.departAt)
  const base = Number.isNaN(parsed.getTime()) ? new Date(`${shift.workDate}T06:30`) : parsed
  const arrivals: Date[] = [new Date(base.getTime())]
  let cursor = base.getTime()
  shift.legs.forEach((leg) => {
    cursor += Math.round(leg.durationH * 3600000)
    arrivals.push(new Date(cursor))
  })
  return { departAt: new Date(base.getTime()), arrivals }
}

/** 跨日时刻格式化：MM-DD HH:mm */
export function formatArrival(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 班次汇总信息 */
export interface ShiftSummary {
  totalBoxes: number
  executableBoxes: number
  blockedCount: number
  warningCount: number
  totalKm: number
  executable: boolean
}

export function summarizeShift(shift: PollinationShift): ShiftSummary {
  return {
    totalBoxes: shift.tasks.reduce((sum, task) => sum + task.boxes, 0),
    executableBoxes: shift.tasks.filter((task) => task.blocked.length === 0).reduce((sum, task) => sum + task.boxes, 0),
    blockedCount: shift.tasks.filter((task) => task.blocked.length > 0).length,
    warningCount: shift.tasks.reduce((sum, task) => sum + task.warnings.length, 0),
    totalKm: Math.round(shift.legs.reduce((sum, leg) => sum + leg.distanceKm, 0) * 100) / 100,
    executable: shift.tasks.some((task) => task.blocked.length === 0)
  }
}
