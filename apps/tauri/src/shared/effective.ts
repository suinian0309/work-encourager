import { addDaysToKey } from './date'

export interface EffectiveFromInput {
  todayKey: string
  now: number
  applyToCurrentShift: boolean
  activeShiftDate: string | null
  todayShiftStartMs: number | null
}

/**
 * 设置生效日期：
 * - 勾选“应用到当前班次”：当前班次归属日期（跨午夜为开始日期），否则今天
 * - 未勾选：今天班次已开始则从明天起生效，否则今天立即生效
 */
export function resolveEffectiveFrom(input: EffectiveFromInput): string {
  if (input.applyToCurrentShift) {
    return input.activeShiftDate ?? input.todayKey
  }
  if (input.todayShiftStartMs !== null && input.now >= input.todayShiftStartMs) {
    return addDaysToKey(input.todayKey, 1)
  }
  return input.todayKey
}
