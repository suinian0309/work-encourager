import type { DayRecord, PauseInterval, SettingsEntry } from './types'
import { addDaysToKey, daysBetweenKeys, toDateKey } from './date'
import { buildShift } from './schedule'
import { computeDayRecord, settingsForDate } from './engine'

export interface SettleInput {
  now: number
  timeline: SettingsEntry[]
  pauses: PauseInterval[]
  resets: Record<string, number>
  records: DayRecord[]
  firstRunDate: string
}

export interface SettleResult {
  records: DayRecord[]
  created: DayRecord[]
}

/**
 * 把已经结束但尚未结算的班次写入历史记录。
 * 只从首次安装日开始，不虚构安装之前的收入。
 */
export function settleRecords(input: SettleInput): SettleResult {
  const todayKey = toDateKey(new Date(input.now))
  const earliest = input.firstRunDate > addDaysToKey(todayKey, -366)
    ? input.firstRunDate
    : addDaysToKey(todayKey, -366)
  const span = Math.max(0, daysBetweenKeys(earliest, todayKey))
  const known = new Set(input.records.map((item) => item.workDate))
  const created: DayRecord[] = []

  for (let offset = 0; offset <= span; offset += 1) {
    const dateKey = addDaysToKey(earliest, offset)
    if (known.has(dateKey)) continue
    const settings = settingsForDate(input.timeline, dateKey)
    const shift = buildShift(settings, dateKey)
    if (!shift) continue
    const overtimeMs = settings.overtimeEnabled
      ? Math.max(0, settings.overtimeMaxHours) * 3_600_000
      : 0
    if (input.now < shift.endMs + overtimeMs) continue
    const record = computeDayRecord(
      settings,
      dateKey,
      input.pauses,
      input.resets[dateKey],
      input.now,
      'auto'
    )
    if (record) {
      created.push(record)
      known.add(dateKey)
    }
  }

  if (created.length === 0) return { records: input.records, created }
  const merged = [...input.records, ...created].sort((a, b) => a.workDate.localeCompare(b.workDate))
  return { records: merged, created }
}
