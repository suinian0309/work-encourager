import type { AppDb, Live2dModelInfo, PauseInterval, PetStyle, Settings, SettingsEntry } from '@shared/types'
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
    records: [],
    floatBounds: null,
    petDaily: {},
    petTotal: 0,
    petBounds: null,
    petStyle: 'mochi',
    petScale: 0.8,
    live2d: null
  }
}

function normalizeLive2d(input: unknown): Live2dModelInfo | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<Live2dModelInfo>
  if (typeof raw.id !== 'string' || !/^[a-f0-9]{8,40}$/.test(raw.id)) return null
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null
  return {
    id: raw.id,
    name: raw.name.slice(0, 120),
    importedAt: Number(raw.importedAt) || 0,
    textures: Math.max(0, Math.floor(Number(raw.textures) || 0)),
    source: typeof raw.source === 'string' ? raw.source.slice(0, 260) : ''
  }
}

function normalizePetDaily(input: unknown): Record<string, number> {  const out: Record<string, number> = {}
  if (!input || typeof input !== 'object') return out
  const entries = Object.entries(input as Record<string, unknown>)
    .filter(
      ([key, value]) =>
        /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(Number(value)) && Number(value) > 0
    )
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-400)
  for (const [key, value] of entries) out[key] = Math.floor(Number(value))
  return out
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

  const normalizedLive2d = normalizeLive2d(raw.live2d)
  const normalizedStyle: PetStyle = raw.petStyle === 'live2d' && normalizedLive2d ? 'live2d' : 'mochi'

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
        : null,
    petDaily: normalizePetDaily(raw.petDaily),
    petTotal: Math.max(0, Math.floor(Number(raw.petTotal) || 0)),
    petBounds:
      raw.petBounds &&
      Number.isFinite(raw.petBounds.x) &&
      Number.isFinite(raw.petBounds.y)
        ? { x: Number(raw.petBounds.x), y: Number(raw.petBounds.y) }
        : null,
    petStyle: normalizedStyle,
    petScale: normalizePetScale(raw.petScale),
    live2d: normalizedLive2d
  }
}

/** 宠物比例：0.6–1.4，默认 0.8，越界或非数字都落回默认 */
function normalizePetScale(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0.8
  return Math.min(1.4, Math.max(0.6, value))
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
