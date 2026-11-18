import { dirname, join } from 'node:path'
import type {
  AppDb,
  AppState,
  BootstrapPayload,
  DayRecord,
  HistoryRow,
  HistoryView,
  Live2dModelInfo,
  PauseInterval,
  PetStats,
  PetStyle,
  SaveSettingsPayload,
  SaveSettingsResult,
  Settings,
  SettingsEntry
} from '@shared/types'
import {
  computeAppState,
  latestSettingsEntry,
  pendingSettingsEntry,
  settingsForDate,
  type CalcInput
} from '@shared/engine'
import { toDateKey, weekdayText } from '@shared/date'
import { resolveShift } from '@shared/schedule'
import { validateSettings } from '@shared/validation'
import { settleRecords } from '@shared/settlement'
import { resolveEffectiveFrom } from '@shared/effective'
import { formatMoney, wageModeLabel } from '@shared/wage'
import { cloneSettings } from '@shared/defaults'
import type { StoreHandle } from './store'

export interface ServiceRuntime {
  now(): number
  version: string
}

export class AppService {
  private readonly store: StoreHandle
  private readonly runtime: ServiceRuntime

  constructor(store: StoreHandle, runtime: ServiceRuntime) {
    this.store = store
    this.runtime = runtime
    this.ensureOpenPause()
  }

  get db(): AppDb {
    return this.store.db
  }

  get dataPath(): string {
    return this.store.path
  }

  private ensureOpenPause(): void {
    if (this.db.timer.on) return
    if (this.db.pauses.some((item) => item.end === null)) return
    const start = this.db.timer.changedAt || this.runtime.now()
    this.store.savePauses([...this.db.pauses, { start, end: null }])
  }

  private settingsFor(key: string): Settings {
    return settingsForDate(this.db.settingsTimeline, key)
  }

  private calcInput(now: number): CalcInput {
    return {
      now,
      timerOn: this.db.timer.on,
      timeline: this.db.settingsTimeline,
      pauses: this.db.pauses,
      resets: this.db.resets,
      records: this.db.records
    }
  }

  state(now: number): AppState {
    return computeAppState(this.calcInput(now))
  }

  settle(now: number): DayRecord[] {
    const result = settleRecords({
      now,
      timeline: this.db.settingsTimeline,
      pauses: this.db.pauses,
      resets: this.db.resets,
      records: this.db.records,
      firstRunDate: this.db.firstRunDate
    })
    if (result.created.length > 0) this.store.replaceRecords(result.records)
    return result.created
  }

  bootstrap(now: number): BootstrapPayload {
    const latest = latestSettingsEntry(this.db.settingsTimeline)
    const pending = pendingSettingsEntry(this.db.settingsTimeline, toDateKey(new Date(now)))
    return {
      state: this.state(now),
      settings: cloneSettings(latest.settings),
      pendingSettings: pending ? cloneSettings(pending.settings) : null,
      pendingEffectiveFrom: pending?.effectiveFrom ?? null,
      dataPath: this.store.path,
      appVersion: this.runtime.version
    }
  }

  toggleTimer(now: number): AppState {
    const turningOff = this.db.timer.on
    let pauses: PauseInterval[] = this.db.pauses.map((item) => ({ ...item }))
    if (turningOff) {
      pauses = pauses.map((item) =>
        item.end === null ? { start: item.start, end: Math.max(item.start, now) } : item
      )
      pauses.push({ start: now, end: null })
    } else {
      pauses = pauses.map((item) =>
        item.end === null ? { start: item.start, end: Math.max(item.start, now) } : item
      )
    }
    this.store.saveTimer(!turningOff, now, pauses)
    return this.state(now)
  }

  resetCurrentShift(now: number): { ok: boolean; message?: string; state: AppState } {
    const resolved = resolveShift((key) => this.settingsFor(key), now)
    if (!resolved.activeShift) {
      return {
        ok: false,
        message: '当前不在班次时间内，无法重置本班次。',
        state: this.state(now)
      }
    }
    const dateKey = resolved.activeShift.workDate
    this.store.saveReset(dateKey, now)
    this.store.replaceRecords(this.db.records.filter((item) => item.workDate !== dateKey))
    return { ok: true, state: this.state(now) }
  }

  saveSettings(payload: SaveSettingsPayload, now: number): SaveSettingsResult {
    const issues = validateSettings(payload.settings)
    if (issues.length > 0) return { ok: false, issues }

    const todayKey = toDateKey(new Date(now))
    const resolved = resolveShift((key) => this.settingsFor(key), now)
    const effectiveFrom = resolveEffectiveFrom({
      todayKey,
      now,
      applyToCurrentShift: payload.applyToCurrentShift,
      activeShiftDate: resolved.activeShift?.workDate ?? null,
      todayShiftStartMs: resolved.todayShift?.startMs ?? null
    })

    if (payload.applyToCurrentShift) {
      const settled = this.db.records.find((item) => item.workDate === effectiveFrom)
      if (settled) {
        this.store.replaceRecords(this.db.records.filter((item) => item.workDate !== effectiveFrom))
      }
    }

    const kept = this.db.settingsTimeline.filter((entry) => entry.effectiveFrom < effectiveFrom)
    const entry: SettingsEntry = {
      effectiveFrom,
      settings: cloneSettings(payload.settings),
      createdAt: now
    }
    this.store.saveTimeline([...kept, entry].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)))
    return { ok: true, issues: [], effectiveFrom, state: this.state(now) }
  }

  markReminder(dateKey: string, at: number): void {
    this.store.saveReminder(dateKey, at)
  }

  /** 摸鱼小宠物的今日/累计点击次数，按本地日期归属 */
  petStats(now: number): PetStats {
    const dateKey = toDateKey(new Date(now))
    return {
      dateKey,
      today: this.db.petDaily?.[dateKey] ?? 0,
      total: this.db.petTotal ?? 0
    }
  }

  /** 点一下加 1，立即落盘，跨重启保留 */
  tapPet(now: number): PetStats {
    const dateKey = toDateKey(new Date(now))
    const daily = { ...(this.db.petDaily ?? {}) }
    const next = Math.max(0, Math.round(daily[dateKey] ?? 0)) + 1
    daily[dateKey] = next
    this.store.savePetCounts(daily, (this.db.petTotal ?? 0) + 1)
    return { dateKey, today: next, total: this.db.petTotal ?? 0 }
  }

  get petBounds(): { x: number; y: number } | null {
    return this.db.petBounds ?? null
  }

  savePetBounds(bounds: { x: number; y: number }): void {
    this.store.savePetBounds(bounds)
  }

  /** 桌面形象：团子猫或 Live2D，切换后立即可用（与工资设置无关，不进设置时间线） */
  get petScale(): number {
    return this.db.petScale ?? 0.8
  }

  setPetScale(scale: number): void {
    this.store.savePetScale(scale)
    this.db.petScale = this.store.petScale
  }

  get petStyle(): PetStyle {
    return this.db.petStyle === 'live2d' ? 'live2d' : 'mochi'
  }

  setPetStyle(style: PetStyle): void {
    this.store.savePetStyle(style)
  }

  get live2dModel(): Live2dModelInfo | null {
    return this.db.live2d ?? null
  }

  saveLive2dModel(info: Live2dModelInfo | null): void {
    this.store.saveLive2d(info)
  }

  /** Live2D 模型文件根目录：<userData>/live2d */
  live2dRoot(): string {
    return join(dirname(this.store.path), 'live2d')
  }

  effectiveSettingsFor(dateKey: string): Settings {
    return this.settingsFor(dateKey)
  }

  history(now: number): HistoryView {
    const state = this.state(now)
    const todayKey = toDateKey(new Date(now))
    const rows: HistoryRow[] = []
    const liveShiftDate = state.shiftDate
    const hasShiftRecord = liveShiftDate
      ? this.db.records.some((item) => item.workDate === liveShiftDate)
      : true
    const liveRows: HistoryRow[] = []
    if (liveShiftDate && state.isWorkday && !hasShiftRecord) {
      liveRows.push({
        workDate: liveShiftDate,
        weekdayText: weekdayText(liveShiftDate),
        hoursText: state.workedHoursText,
        incomeText: state.earnTodayText,
        basisText: state.basisText,
        wageModeText: `${wageModeLabel(state.wageMode)}（进行中）`,
        overtimeText:
          state.overtimeSeconds > 0
            ? `加班 ${(state.overtimeSeconds / 3600).toFixed(2)} 小时`
            : '',
        isToday: liveShiftDate === todayKey,
        live: true
      })
    }
    const sorted = [...this.db.records].sort((a, b) => b.workDate.localeCompare(a.workDate))
    for (const record of sorted) {
      rows.push({
        workDate: record.workDate,
        weekdayText: weekdayText(record.workDate),
        hoursText: (record.paidSeconds / 3600).toFixed(2),
        incomeText: formatMoney(record.income, 2),
        basisText: record.basisText,
        wageModeText: wageModeLabel(record.wageMode),
        overtimeText:
          record.overtimeSeconds > 0
            ? `加班 ${(record.overtimeSeconds / 3600).toFixed(2)} 小时`
            : '',
        isToday: record.workDate === todayKey,
        live: false
      })
    }
    const allTotal =
      sorted.reduce((sum, item) => sum + item.income, 0) +
      (liveRows.length > 0 ? state.earnTodayValue : 0)
    const privacy = this.effectiveSettingsFor(todayKey).privacyMode
    return {
      rows: privacy
        ? [...liveRows, ...rows].map((row) => ({
            ...row,
            incomeText: '••••'
          }))
        : [...liveRows, ...rows],
      monthTotalText: privacy ? '••••' : state.monthTotalText,
      monthLabel: state.monthLabel,
      allTotalText: privacy ? '••••' : formatMoney(allTotal, 2),
      recordCount: sorted.length,
      dataPath: this.store.path
    }
  }
}
