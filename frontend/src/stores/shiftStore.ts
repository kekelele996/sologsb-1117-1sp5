import { create } from 'zustand'
import type { ShiftTask } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'

export interface ShiftState {
  rows: ShiftTask[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: ShiftTask) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const shiftStore = create<ShiftState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<ShiftTask>(db.shifts)
    rows.sort((a, b) => `${a.date} ${a.name}`.localeCompare(`${b.date} ${b.name}`, 'zh-Hans-CN'))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    await putRow<ShiftTask>(db.shifts, row)
    await get().hydrate()
  },
  remove: async (id) => {
    await deleteRow<ShiftTask>(db.shifts, id)
    await get().hydrate()
  }
}))
