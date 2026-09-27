import { create } from 'zustand'
import type { BeeColony, DropPoint, PollinationShift, TransitRoute } from '@/types'
import { db, loadAll, putRow } from '@/hooks/usePersistentStore'
import { routeStore } from '@/stores/routeStore'
import { buildLegs, computeTimings, type ShiftDraft } from '@/utils/planning'

export interface ShiftState {
  rows: PollinationShift[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 保存整版班次草稿，同步投放点群号 / 蜂群状态 / 转场路线 */
  savePlan: (drafts: ShiftDraft[]) => Promise<void>
  /** 单个班次内重排经停顺序（里程与到达时刻重算并写回路线表） */
  reorderStops: (shiftId: string, orderedDropIds: string[]) => Promise<void>
  /** 删除单个班次并回退其同步结果 */
  remove: (shiftId: string) => Promise<void>
}

function formatLegDepart(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 由经停顺序与首站时刻生成该班次对应的转场段（每段出发时刻 = 上一站预计到达） */
function routesOfShift(shift: PollinationShift): TransitRoute[] {
  const timings = computeTimings(shift)
  return shift.legs.map((leg, index) => ({
    id: `rt_shift_${shift.id}_${leg.fromDropId}_${leg.toDropId}`,
    fromDropId: leg.fromDropId,
    toDropId: leg.toDropId,
    distanceKm: leg.distanceKm,
    durationH: leg.durationH,
    vehicleType: shift.vehicleType,
    departAt: formatLegDepart(timings.arrivals[index]),
    riskNote: shift.riskNote,
    actualNote: '待执行',
    shiftId: shift.id
  }))
}

/** 把某群从班次占用状态回退到首次接管前的快照 */
function restoreColony(colony: BeeColony): BeeColony {
  const { snapStatus, snapOrchardId, ...rest } = colony
  return {
    ...rest,
    status: snapStatus ?? colony.status,
    currentOrchardId: snapOrchardId ?? colony.currentOrchardId,
    lastShiftId: undefined,
    snapStatus: undefined,
    snapOrchardId: undefined
  }
}

export const shiftStore = create<ShiftState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<PollinationShift>(db.shifts)
    rows.sort((a, b) => a.workDate.localeCompare(b.workDate))
    set({ rows, loaded: true })
  },

  savePlan: async (drafts) => {
    await db.transaction('rw', db.shifts, db.routes, db.dropPoints, db.colonies, async () => {
      const [oldShifts, allPoints, allColonies, allRoutes] = await Promise.all([
        loadAll<PollinationShift>(db.shifts),
        loadAll<DropPoint>(db.dropPoints),
        loadAll<BeeColony>(db.colonies),
        loadAll<TransitRoute>(db.routes)
      ])
      const oldShiftIds = new Set(oldShifts.map((item) => item.id))

      // 1) 回退旧班次对投放点 / 蜂群的写入
      const pointMap = new Map(allPoints.map((item) => [item.id, { ...item }]))
      oldShifts.forEach((shift) => {
        shift.tasks.forEach((task) => {
          if (!task.dropId) return
          const point = pointMap.get(task.dropId)
          if (!point || point.managedByShift !== shift.id) return
          // 回退为投放点原有群号（被班次锁定的任务保留其既有群号，自动投放群撤空）
          point.colonyCodes = task.locked ? task.colonyCodes : []
          delete point.managedByShift
        })
      })

      const colonyMap = new Map<string, BeeColony>()
      allColonies.forEach((colony) => {
        colonyMap.set(colony.id, colony.lastShiftId && oldShiftIds.has(colony.lastShiftId) ? restoreColony(colony) : { ...colony })
      })

      // 2) 应用新版班次
      drafts.forEach((shift) => {
        shift.tasks
          .filter((task) => task.blocked.length === 0 && task.dropId)
          .forEach((task) => {
            const point = pointMap.get(task.dropId)
            if (!point) return
            point.colonyCodes = Array.from(new Set(task.colonyCodes))
            point.managedByShift = shift.id
          })

        shift.tasks
          .filter((task) => task.blocked.length === 0)
          .flatMap((task) => task.colonyCodes.map((code) => ({ code, orchardId: task.orchardId })))
          .forEach(({ code, orchardId }) => {
            const colony = Array.from(colonyMap.values()).find((item) => item.code === code)
            if (!colony) return
            // 尚未被任何班次接管过 → 先存快照
            if (!colony.lastShiftId) {
              colony.snapStatus = colony.status
              colony.snapOrchardId = colony.currentOrchardId
            }
            colony.status = '在园'
            colony.currentOrchardId = orchardId
            colony.lastShiftId = shift.id
          })
      })

      // 3) 路线：旧班次产生的段整体重建，人工段（无 shiftId）保留
      const manualRoutes = allRoutes.filter((route) => !route.shiftId || !oldShiftIds.has(route.shiftId))
      const nextRoutes: TransitRoute[] = [...manualRoutes]
      drafts.forEach((shift) => {
        nextRoutes.push(...routesOfShift(shift))
      })

      // 4) 落库
      await db.shifts.clear()
      await Promise.all(drafts.map((draft) => putRow<PollinationShift>(db.shifts, draft)))
      await db.routes.clear()
      await Promise.all(nextRoutes.map((route) => putRow<TransitRoute>(db.routes, route)))
      await Promise.all(Array.from(pointMap.values()).map((point) => putRow<DropPoint>(db.dropPoints, point)))
      await Promise.all(Array.from(colonyMap.values()).map((colony) => putRow<BeeColony>(db.colonies, colony)))
    })
    await get().hydrate()
    await routeStore.getState().hydrate()
  },

  reorderStops: async (shiftId, orderedDropIds) => {
    const shift = get().rows.find((item) => item.id === shiftId)
    if (!shift) return
    const points = await loadAll<DropPoint>(db.dropPoints)
    const reordered = orderedDropIds
      .map((id) => shift.stops.find((stop) => stop.dropId === id))
      .filter((stop): stop is PollinationShift['stops'][number] => Boolean(stop))
    const next: PollinationShift = { ...shift, stops: reordered, legs: buildLegs(reordered, points) }
    await putRow<PollinationShift>(db.shifts, next)

    const routes = await loadAll<TransitRoute>(db.routes)
    const kept = routes.filter((route) => route.shiftId !== shiftId)
    await db.routes.clear()
    await Promise.all([...kept, ...routesOfShift(next)].map((route) => putRow<TransitRoute>(db.routes, route)))
    await get().hydrate()
    await routeStore.getState().hydrate()
  },

  remove: async (shiftId) => {
    await get().savePlan(get().rows.filter((item) => item.id !== shiftId))
  }
}))
