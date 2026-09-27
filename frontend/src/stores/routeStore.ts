import { create } from 'zustand'
import type { TransitRoute } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { distanceKm, estimateDurationH } from '@/utils/geo'

export interface RouteState {
  rows: TransitRoute[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: TransitRoute) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 按选点顺序重排并重算里程 / 耗时，生成连续转场段 */
  rebuildFromOrder: (
    orderedDropIds: string[],
    meta: { vehicleType: TransitRoute['vehicleType']; departAt: string; riskNote: string }
  ) => Promise<void>
  /** 用班次生成的转场段整体替换该班次的旧段（拖动站点 / 改出发时刻后重算） */
  replaceShiftLegs: (shiftId: string, legs: TransitRoute[]) => Promise<void>
  /** 删除某班次生成的全部转场段 */
  removeByShift: (shiftId: string) => Promise<void>
}

export const routeStore = create<RouteState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<TransitRoute>(db.routes)
    rows.sort((a, b) => a.departAt.localeCompare(b.departAt))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    await putRow<TransitRoute>(db.routes, row)
    await get().hydrate()
  },
  remove: async (id) => {
    await deleteRow<TransitRoute>(db.routes, id)
    await get().hydrate()
  },
  rebuildFromOrder: async (orderedDropIds, meta) => {
    // 仅清理手动规划的路段，保留授粉班次生成的路段（shiftId 非空）
    const existing = await loadAll<TransitRoute>(db.routes)
    await Promise.all(existing.filter((row) => !row.shiftId).map((row) => deleteRow<TransitRoute>(db.routes, row.id)))
    const points = await loadAll<{ id: string; longitude: number; latitude: number }>(db.dropPoints)
    const lookup = new Map(points.map((item) => [item.id, item]))
    for (let i = 1; i < orderedDropIds.length; i += 1) {
      const from = lookup.get(orderedDropIds[i - 1])
      const to = lookup.get(orderedDropIds[i])
      if (!from || !to) continue
      const km = distanceKm(from, to)
      await putRow<TransitRoute>(db.routes, {
        id: `rt_${Date.now().toString(36)}_${i}`,
        fromDropId: from.id,
        toDropId: to.id,
        distanceKm: km,
        durationH: estimateDurationH(km),
        vehicleType: meta.vehicleType,
        departAt: meta.departAt,
        riskNote: meta.riskNote,
        actualNote: '待执行'
      })
    }
    await get().hydrate()
  },
  replaceShiftLegs: async (shiftId, legs) => {
    const existing = await loadAll<TransitRoute>(db.routes)
    await Promise.all(existing.filter((row) => row.shiftId === shiftId).map((row) => deleteRow<TransitRoute>(db.routes, row.id)))
    await Promise.all(legs.map((leg) => putRow<TransitRoute>(db.routes, leg)))
    await get().hydrate()
  },
  removeByShift: async (shiftId) => {
    const existing = await loadAll<TransitRoute>(db.routes)
    await Promise.all(existing.filter((row) => row.shiftId === shiftId).map((row) => deleteRow<TransitRoute>(db.routes, row.id)))
    await get().hydrate()
  }
}))
