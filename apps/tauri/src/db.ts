import type { AppDb, PauseInterval, Settings, SettingsEntry } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import { toDateKey } from '@shared/date'
import { validateSettings } from '@shared/validation'

function normalizeSettings(input: Partial<Settings> | undefined): Settings {
  const base = defaultSettings()
  if (!input || typeof input !== 'object') return base
  return {
    ...base,
    ...input,
    weekdays: Array.isArray(input.weekdays) ? [...input.weekdays] : base.weekdays,
    breaks: Array.isArray(input.breaks) ? input.breaks.map((item) => ({ ...item })) : base.breaks,
    specialDays: Array.isArray(input.specialDays)
      ? input.specialDays.map((item) => ({ ...item }))
      : base.specialDays,
    targets: Array.isArray(input.targets) ? input.targets.map((item) => ({ ...item })) : base.targets
  }
}

export function createInitialDb(now: number): AppDb {
  const dateKey = toDateKey(new Date(now))
  return {
    version: 1,
    createdAt: now,
    firstRunDate: dateKey,
    settingsTimeline: [{ effectiveFrom: dateKey, settings: defaultSettings(), createdAt: now }],
    timer: { on: true, changedAt: now },
    pauses: [],
    resets: {},
    reminders: {},
    records: []
  }
}

export function normalizeDb(raw: Partial<AppDb>, now: number): AppDb {
  if (!raw || typeof raw !== 'object') throw new Error('本地数据不是有效的 JSON 对象')
  if (!Array.isArray(raw.settingsTimeline) || raw.settingsTimeline.length === 0) {
    throw new Error('本地数据缺少设置时间线')
  }
  if (!Array.isArray(raw.pauses) || !Array.isArray(raw.records)) {
    throw new Error('本地数据缺少暂停或历史记录数组')
  }

  const timeline: SettingsEntry[] = raw.settingsTimeline
    .filter((entry) => entry && typeof entry.effectiveFrom === 'string')
    .map((entry) => ({
      effectiveFrom: entry.effectiveFrom,
      settings: normalizeSettings(entry.settings),
      createdAt: Number(entry.createdAt) || 0
    }))
  if (timeline.length !== raw.settingsTimeline.length) {
    throw new Error('设置时间线中存在缺少生效日期的条目')
  }
  for (const entry of timeline) {
    const issues = validateSettings(entry.settings)
    if (issues.length > 0) {
      throw new Error(`设置（${entry.effectiveFrom} 生效）无效：${issues[0].message}`)
    }
  }

  const rawPauses = raw.pauses
  if (
    rawPauses.some(
      (item) =>
        !item ||
        !Number.isFinite(item.start) ||
        (item.end !== null && item.end !== undefined && !Number.isFinite(item.end))
    )
  ) {
    throw new Error('暂停记录格式异常')
  }
  const pauses: PauseInterval[] = rawPauses.map((item) => ({
    start: Number(item.start),
    end: item.end === null || item.end === undefined ? null : Number(item.end)
  }))

  for (const record of raw.records) {
    if (
      !record ||
      typeof record.workDate !== 'string' ||
      !Number.isFinite(record.paidSeconds) ||
      !Number.isFinite(record.income) ||
      !Number.isFinite(record.dailyWage)
    ) {
      throw new Error('历史记录格式异常')
    }
  }

  return {
    version: 1,
    createdAt: Number(raw.createdAt) || now,
    firstRunDate: typeof raw.firstRunDate === 'string' ? raw.firstRunDate : toDateKey(new Date(now)),
    settingsTimeline: timeline.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
    timer: { on: raw.timer?.on !== false, changedAt: Number(raw.timer?.changedAt) || now },
    pauses,
    resets: raw.resets && typeof raw.resets === 'object' ? { ...raw.resets } : {},
    reminders: raw.reminders && typeof raw.reminders === 'object' ? { ...raw.reminders } : {},
    records: raw.records.map((item) => ({
      ...item,
      overtimeSeconds: Number(item.overtimeSeconds) || 0,
      overtimeIncome: Number(item.overtimeIncome) || 0,
      overtimePerSecond: Number(item.overtimePerSecond) || 0,
      source: item.source ?? 'auto'
    })),
    floatBounds:
      raw.floatBounds &&
      Number.isFinite(raw.floatBounds.x) &&
      Number.isFinite(raw.floatBounds.y)
        ? { x: Number(raw.floatBounds.x), y: Number(raw.floatBounds.y) }
        : null
  }
}

export function parseDb(json: string | null, now: number): AppDb {
  if (!json) return createInitialDb(now)
  let raw: Partial<AppDb>
  try {
    raw = JSON.parse(json) as Partial<AppDb>
  } catch (error) {
    throw new Error(`本地数据不是有效 JSON：${(error as Error).message}`)
  }
  return normalizeDb(raw, now)
}
