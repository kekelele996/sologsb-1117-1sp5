import type { VehicleType } from './route'

/** 任务拦截原因码 */
export const SHIFT_BLOCK_REASONS = ['花期重叠占用', '投放点超容', '撤场晚于花期结束'] as const
export type ShiftBlockReason = (typeof SHIFT_BLOCK_REASONS)[number]

/** 排班阶段拦截（非阻断性提示，如蜂群不可用） */
export const SHIFT_WARNING_REASONS = ['无可用蜂群', '蜂群转场中', '蜂群箱数缺口'] as const
export type ShiftWarningReason = (typeof SHIFT_WARNING_REASONS)[number]

/** 任务拦截记录：命中后该任务不可执行、不参与同步 */
export interface TaskBlock {
  reason: ShiftBlockReason
  detail: string
}

/** 排班阶段非阻断性提示 */
export interface TaskWarning {
  reason: ShiftWarningReason
  detail: string
}

/** 班次中的单条授粉任务 */
export interface ShiftTask {
  id: string
  shiftId: string
  orchardId: string
  dropId: string
  dropCode: string
  /** 本任务投箱数 */
  boxes: number
  /** 投入群号（无可用蜂群时为空） */
  colonyCodes: string[]
  /** 投放 / 撤场（YYYY-MM-DD） */
  start: string
  end: string
  /** 蜂群是否来自投放点既有安排 */
  locked: boolean
  blocked: TaskBlock[]
  warnings: TaskWarning[]
}

/** 班次经停投放点（仅含可执行任务的站点） */
export interface ShiftStop {
  dropId: string
  code: string
  orchardId: string
  /** 该站点经停时投放总箱数（可执行任务合计） */
  boxes: number
}

/** 班次转场段（由经停顺序与里程算出，保存后写入 routes 表） */
export interface ShiftLeg {
  fromDropId: string
  toDropId: string
  distanceKm: number
  durationH: number
}

/** PollinationShift 授粉班次 */
export interface PollinationShift {
  id: string
  /** 班次名称，如 04-08 授粉班次 */
  name: string
  /** 班次作业日（取组内最早盛花期起，YYYY-MM-DD） */
  workDate: string
  vehicleType: VehicleType
  /** 首站出发时刻 YYYY-MM-DDTHH:mm */
  departAt: string
  riskNote: string
  /** 经停投放点顺序（拖动后重算里程与到达时刻） */
  stops: ShiftStop[]
  /** 由经停顺序生成的转场段 */
  legs: ShiftLeg[]
  /** 班内全部任务（含被拦截任务） */
  tasks: ShiftTask[]
  createdAt: string
}
