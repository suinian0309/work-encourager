import { existsSync } from 'node:fs'
import Store from 'electron-store'
import type {
  AppDb,
  Live2dModelInfo,
  PauseInterval,
  PetStyle,
  Settings,
  SettingsEntry
} from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import { toDateKey } from '@shared/date'
import { mergeIntervals } from '@shared/intervals'
import { validateSettings } from '@shared/validation'

export class DataStoreError extends Error {
  readonly dataPath: string
  constructor(message: string, dataPath: string) {
    super(message)
    this.name = 'DataStoreError'
    this.dataPath = dataPath
  }
}

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
    settingsTimeline: [
      { effectiveFrom: dateKey, settings: defaultSettings(), createdAt: now }
    ],
    timer: { on: true, changedAt: now },
    pauses: [],
    resets: {},
    reminders: {},
    records: [],
    petDaily: {},
    petTotal: 0,
    petBounds: null
  }
}

/** 校验并补全从磁盘读到的数据，结构不可用时抛出错误而不是静默重置 */
export function normalizeDb(raw: Partial<AppDb>, now: number): AppDb {
  if (!raw || typeof raw !== 'object') throw new Error('本地数据不是有效的 JSON 对象')
  if (!Array.isArray(raw.settingsTimeline) || raw.settingsTimeline.length === 0) {
    throw new Error('本地数据缺少设置时间线（settingsTimeline）')
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
  if (timeline.length === 0) throw new Error('本地设置时间线为空')
  for (const entry of timeline) {
    const issues = validateSettings(entry.settings)
    if (issues.length > 0) {
      throw new Error(`设置（${entry.effectiveFrom} 生效）无效：${issues[0].message}`)
    }
  }

  const defaultDate = toDateKey(new Date(now))
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
    firstRunDate: typeof raw.firstRunDate === 'string' ? raw.firstRunDate : defaultDate,
    settingsTimeline: timeline.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
    timer: {
      on: raw.timer?.on !== false,
      changedAt: Number(raw.timer?.changedAt) || now
    },
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
    petTotal: Number.isFinite(Number(raw.petTotal)) ? Math.max(0, Math.round(Number(raw.petTotal))) : 0,
    petBounds:
      raw.petBounds &&
      Number.isFinite(raw.petBounds.x) &&
      Number.isFinite(raw.petBounds.y)
        ? { x: Number(raw.petBounds.x), y: Number(raw.petBounds.y) }
        : null,
    petStyle: raw.petStyle === 'live2d' ? 'live2d' : 'mochi',
    live2d: normalizeLive2d(raw.live2d)
  }
}

/** Live2D 模型元信息：只接受我们自己写入的字段，id 用于拼自定义协议与磁盘目录 */
function normalizeLive2d(raw: unknown): Live2dModelInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<Live2dModelInfo>
  if (typeof item.id !== 'string' || !/^[a-f0-9]{8,40}$/.test(item.id)) return null
  return {
    id: item.id,
    name: typeof item.name === 'string' && item.name ? item.name : 'Live2D 模型',
    importedAt: Number(item.importedAt) || 0,
    textures: Number(item.textures) || 0,
    source: typeof item.source === 'string' ? item.source : ''
  }
}

/** 摸鱼计数按日期保存，丢弃非法数值与过旧日期（保留最近 400 天） */
function normalizePetDaily(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([key, value]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(Number(value)))
    .map(([key, value]) => [key, Math.max(0, Math.round(Number(value)))] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-400)
  return Object.fromEntries(entries)
}

export interface StoreHandle {
  db: AppDb
  path: string
  saveTimer(on: boolean, changedAt: number, pauses: PauseInterval[]): void
  savePauses(pauses: PauseInterval[]): void
  saveReset(dateKey: string, at: number): void
  saveRecord(record: AppDb['records'][number]): void
  replaceRecords(records: AppDb['records']): void
  saveTimeline(timeline: SettingsEntry[]): void
  saveReminder(dateKey: string, at: number): void
  saveFloatBounds(bounds: { x: number; y: number }): void
  savePetCounts(daily: Record<string, number>, total: number): void
  savePetBounds(bounds: { x: number; y: number }): void
  savePetStyle(style: PetStyle): void
  saveLive2d(info: Live2dModelInfo | null): void
}

export function openStore(cwd?: string): StoreHandle {
  let store: Store<AppDb>
  const fallbackPath = cwd ?? ''
  try {
    store = new Store<AppDb>({
      name: 'work-encourager',
      cwd,
      defaults: createInitialDb(Date.now())
    })
  } catch (error) {
    throw new DataStoreError(
      `读取本地数据失败：${(error as Error).message}`,
      fallbackPath || '未知路径'
    )
  }

  let db: AppDb
  try {
    const existed = existsSync(store.path)
    db = normalizeDb(store.store as Partial<AppDb>, Date.now())
    if (!existed) {
      // 首次启动就落盘，确保 firstRunDate 不会在下次启动时被重新计算
      store.store = db
    }
  } catch (error) {
    throw new DataStoreError(`本地数据格式异常：${(error as Error).message}`, store.path)
  }

  const persist = <K extends keyof AppDb>(key: K, value: AppDb[K]): void => {
    try {
      store.set(key, value)
    } catch (error) {
      throw new DataStoreError(`写入本地数据失败：${(error as Error).message}`, store.path)
    }
  }

  return {
    db,
    path: store.path,
    saveTimer(on, changedAt, pauses) {
      db.timer = { on, changedAt }
      db.pauses = normalizePauses(pauses)
      persist('timer', db.timer)
      persist('pauses', db.pauses)
    },
    savePauses(pauses) {
      db.pauses = pauses
      persist('pauses', db.pauses)
    },
    saveReset(dateKey, at) {
      db.resets = { ...db.resets, [dateKey]: at }
      persist('resets', db.resets)
    },
    saveRecord(record) {
      db.records = [...db.records.filter((item) => item.workDate !== record.workDate), record].sort(
        (a, b) => a.workDate.localeCompare(b.workDate)
      )
      persist('records', db.records)
    },
    replaceRecords(records) {
      db.records = records
      persist('records', db.records)
    },
    saveTimeline(timeline) {
      db.settingsTimeline = timeline
      persist('settingsTimeline', db.settingsTimeline)
    },
    saveReminder(dateKey, at) {
      db.reminders = { ...db.reminders, [dateKey]: at }
      persist('reminders', db.reminders)
    },
    saveFloatBounds(bounds) {
      db.floatBounds = { x: Math.round(bounds.x), y: Math.round(bounds.y) }
      persist('floatBounds', db.floatBounds)
    },
    savePetCounts(daily, total) {
      db.petDaily = normalizePetDaily(daily)
      db.petTotal = Math.max(0, Math.round(total))
      persist('petDaily', db.petDaily)
      persist('petTotal', db.petTotal)
    },
    savePetBounds(bounds) {
      db.petBounds = { x: Math.round(bounds.x), y: Math.round(bounds.y) }
      persist('petBounds', db.petBounds)
    },
    savePetStyle(style) {
      db.petStyle = style === 'live2d' ? 'live2d' : 'mochi'
      persist('petStyle', db.petStyle)
    },
    saveLive2d(info) {
      db.live2d = info
      persist('live2d', db.live2d)
    }
  }
}

/** 合并相邻暂停区间，避免多次开关产生碎片 */
export function normalizePauses(pauses: PauseInterval[]): PauseInterval[] {
  const closed = pauses.filter((item) => item.end !== null) as Array<{ start: number; end: number }>
  const open = pauses.filter((item) => item.end === null)
  const merged = mergeIntervals(closed)
  const result: PauseInterval[] = merged.map((item) => ({ start: item.start, end: item.end }))
  for (const item of open) result.push({ start: item.start, end: null })
  return result
}
