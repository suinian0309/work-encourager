import type { Settings } from './types'
import { addDaysToKey, dateAtMidnight, daysInMonth, parseDateKey, parseHHMM, weekdayOfKey } from './date'
import { mergeIntervals, subtractIntervals, type Interval } from './intervals'

export interface Shift {
  workDate: string
  startMs: number
  endMs: number
  totalSeconds: number
  paidSeconds: number
  paid: Interval[]
  unpaid: Interval[]
  /** 是否跨午夜（下班在次日） */
  crossesMidnight: boolean
  startMinutes: number
  endMinutes: number
  shiftLengthMinutes: number
  settings: Settings
}

export interface BreakWindow {
  id: string
  startMinutes: number
  endMinutes: number
  durationMinutes: number
  startMs: number
  endMs: number
  paid: boolean
}

export function isWorkday(settings: Settings, dateKey: string): boolean {
  const weekday = weekdayOfKey(dateKey)
  const special = [...settings.specialDays].reverse().find((item) => item.date === dateKey)
  if (special) return special.type === 'work'
  return settings.weekdays.includes(weekday)
}

export function resolveBreakWindows(settings: Settings, workDate: string): BreakWindow[] {
  if (!settings.breaksEnabled) return []
  const startMinutes = parseHHMM(settings.workStart)
  const endMinutes = parseHHMM(settings.workEnd)
  if (startMinutes === null || endMinutes === null) return []
  const shiftLength = (endMinutes - startMinutes + 1440) % 1440
  if (shiftLength === 0) return []
  const base = dateAtMidnight(workDate).getTime()

  const windows: BreakWindow[] = []
  for (const item of settings.breaks) {
    const bStart = parseHHMM(item.start)
    const bEnd = parseHHMM(item.end)
    if (bStart === null || bEnd === null) continue
    const duration = (bEnd - bStart + 1440) % 1440
    if (duration === 0) continue
    const offset = (bStart - startMinutes + 1440) % 1440
    if (offset >= shiftLength || offset + duration > shiftLength) continue
    windows.push({
      id: item.id,
      startMinutes: bStart,
      endMinutes: bEnd,
      durationMinutes: duration,
      startMs: base + (startMinutes + offset) * 60_000,
      endMs: base + (startMinutes + offset + duration) * 60_000,
      paid: item.paid
    })
  }
  return windows
}

/** 根据工作日期构建班次；非工作日或时间非法返回 null */
export function buildShift(settings: Settings, workDate: string): Shift | null {
  if (!isWorkday(settings, workDate)) return null
  return buildShiftShape(settings, workDate)
}

/** 只按时间形状构建班次（忽略是否为工作日），用于设置预览与休息日展示 */
export function buildShiftShape(settings: Settings, workDate: string): Shift | null {
  const startMinutes = parseHHMM(settings.workStart)
  const endMinutes = parseHHMM(settings.workEnd)
  if (startMinutes === null || endMinutes === null) return null
  const shiftLength = (endMinutes - startMinutes + 1440) % 1440
  if (shiftLength === 0) return null

  const base = dateAtMidnight(workDate).getTime()
  const startMs = base + startMinutes * 60_000
  const endMs = startMs + shiftLength * 60_000
  const breakWindows = resolveBreakWindows(settings, workDate)
  const unpaid = mergeIntervals(
    breakWindows
      .filter((item) => !item.paid)
      .map((item) => ({ start: item.startMs, end: item.endMs }))
  )
  const paid = subtractIntervals([{ start: startMs, end: endMs }], unpaid)
  const paidMs = paid.reduce((sum, item) => sum + (item.end - item.start), 0)

  return {
    workDate,
    startMs,
    endMs,
    totalSeconds: shiftLength * 60,
    paidSeconds: paidMs / 1000,
    paid,
    unpaid,
    crossesMidnight: startMs + shiftLength * 60_000 > dateAtMidnight(addDaysToKey(workDate, 1)).getTime(),
    startMinutes,
    endMinutes,
    shiftLengthMinutes: shiftLength,
    settings
  }
}

export interface ResolvedShift {
  activeShift: Shift | null
  todayShift: Shift | null
  yesterdayShift: Shift | null
  displayShift: Shift | null
  settings: Settings
}

/** 找出 now 时刻正在进行的班次（优先当天班次，其次昨日的跨午夜班次） */
export function resolveShift(settingsForDate: (dateKey: string) => Settings, now: number): ResolvedShift {
  const nowDate = new Date(now)
  const todayKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(
    nowDate.getDate()
  ).padStart(2, '0')}`
  const yesterdayKey = addDaysToKey(todayKey, -1)
  const todaySettings = settingsForDate(todayKey)
  const todayShift = buildShift(todaySettings, todayKey)
  const yesterdaySettings = settingsForDate(yesterdayKey)
  const yesterdayShift = buildShift(yesterdaySettings, yesterdayKey)

  const isActive = (shift: Shift | null): shift is Shift =>
    !!shift && now >= shift.startMs && now < shift.endMs

  let activeShift: Shift | null = null
  if (isActive(todayShift)) activeShift = todayShift
  else if (isActive(yesterdayShift)) activeShift = yesterdayShift

  const displayShift = activeShift ?? todayShift
  const settings = activeShift ? activeShift.settings : todaySettings

  return { activeShift, todayShift, yesterdayShift, displayShift, settings }
}

/** 某月按计划应上班的日期（用于月薪按实际工作日折算） */
export function countWorkdaysInMonth(settings: Settings, dateKey: string): number {
  const { year, month } = parseDateKey(dateKey)
  const total = daysInMonth(year, month)
  let count = 0
  for (let day = 1; day <= total; day += 1) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (isWorkday(settings, key)) count += 1
  }
  return count
}

/** 下一个工作日（含 minDaysOffset 起点） */
export function nextWorkdayKey(settings: Settings, fromKey: string, minOffset = 0): string | null {
  for (let offset = minOffset; offset < 400; offset += 1) {
    const key = addDaysToKey(fromKey, offset)
    if (isWorkday(settings, key)) return key
  }
  return null
}
