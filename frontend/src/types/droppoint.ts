/** DropPoint 投放点 */
export interface DropPoint {
  id: string
  orchardId: string
  longitude: number
  latitude: number
  /** 编号，如 A-03 */
  code: string
  /** 可容纳箱数 */
  capacityBoxes: number
  /** 遮阴条件 */
  shade: string
  /** 水源距离（米） */
  waterDistance: number
  /** 投放时间窗（起） */
  dropWindow: string
  /** 撤场时间 */
  withdrawTime: string
  /** 责任人 */
  owner: string
  /** 该投放点安排的群号（用于冲突判定） */
  colonyCodes: string[]
  /** 由哪个授粉班次写入群号（班次重排时据此回退） */
  managedByShift?: string
}
