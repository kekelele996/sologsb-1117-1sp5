import type { VehicleType } from './route'

/** 班次经停站：在某个投放点卸下的箱数与群号 */
export interface ShiftStop {
  dropId: string
  /** 该站卸下的箱数 */
  boxes: number
  /** 该站卸下的群号 */
  colonyCodes: string[]
}

/** ShiftTask 授粉班次任务 */
export interface ShiftTask {
  id: string
  /** 班次名称 */
  name: string
  /** 执行日期（YYYY-MM-DD） */
  date: string
  /** 首站出发时刻（HH:mm） */
  departTime: string
  vehicleType: VehicleType
  /** 经停投放点（按顺序） */
  stops: ShiftStop[]
  /** 备注（如生成时的拦截摘要） */
  note: string
  /** 创建时间 */
  createdAt: string
}
