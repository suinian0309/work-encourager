import type { Settings } from './types'
import type { Shift } from './schedule'

/** 下班提醒应触发的墙上时间 */
export function reminderDueAt(settings: Settings, shift: Shift): number {
  const offset = Math.max(0, settings.reminderMinutes) * 60_000
  return Math.max(shift.startMs, shift.endMs - offset)
}

/**
 * 同一班次只提醒一次：lastFiredAt 由持久化记录传入。
 * 应用在提醒窗口之后才启动时（超过下班 5 分钟）不补发过期提醒。
 */
export function shouldFireShiftReminder(
  settings: Settings,
  shift: Shift,
  now: number,
  lastFiredAt: number | undefined
): boolean {
  if (!settings.reminderEnabled) return false
  if (lastFiredAt && lastFiredAt >= shift.startMs) return false
  if (now > shift.endMs + 5 * 60_000) return false
  return now >= reminderDueAt(settings, shift)
}
