import Decimal from 'decimal.js'
import type {
  AppState,
  DayRecord,
  DaySettleSource,
  PauseInterval,
  Settings,
  SettingsEntry,
  WorkStatus
} from './types'
import { defaultSettings, STATUS_LABELS } from './defaults'
import {
  formatCNDate,
  formatClock,
  formatCountdown,
  monthKeyOf,
  monthLabelOf,
  toDateKey,
  weekdayText
} from './date'
import { buildShift, buildShiftShape, resolveShift, type Shift } from './schedule'
import { resolveWage, formatMoney, formatPerSecond } from './wage'
import { clipIntervals, subtractIntervals, totalMs } from './intervals'
import { buildEncouragement } from './encouragement'

/** 某日期生效的设置 */
export function settingsForDate(timeline: SettingsEntry[], dateKey: string): Settings {
  if (!timeline.length) return defaultSettings()
  const sorted = [...timeline].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  let chosen = sorted[0]
  for (const entry of sorted) {
    if (entry.effectiveFrom <= dateKey) chosen = entry
    else break
  }
  return chosen.settings
}

export function latestSettingsEntry(timeline: SettingsEntry[]): SettingsEntry {
  if (!timeline.length) {
    return { effectiveFrom: '1970-01-01', settings: defaultSettings(), createdAt: 0 }
  }
  const sorted = [...timeline].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  return sorted[sorted.length - 1]
}

/** 已保存但尚未生效的设置 */
export function pendingSettingsEntry(timeline: SettingsEntry[], todayKey: string): SettingsEntry | null {
  const future = timeline
    .filter((entry) => entry.effectiveFrom > todayKey)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  return future[0] ?? null
}

/** 累计计薪毫秒：班次计薪区间 ∩ [重置时刻, now]，再扣除暂停区间 */
export function accruedPaidMs(
  shift: Shift,
  pauses: PauseInterval[],
  resetAt: number | undefined,
  now: number
): number {
  const until = Math.min(now, shift.endMs)
  const windowStart = resetAt && resetAt > shift.startMs ? resetAt : shift.startMs
  if (until <= windowStart) return 0

  const base = clipIntervals(shift.paid, windowStart, until)
  if (base.length === 0) return 0

  const holes = pauses
    .map((item) => ({
      start: Math.max(item.start, windowStart),
      end: Math.min(item.end ?? until, until)
    }))
    .filter((item) => item.end > item.start)

  return Math.max(0, totalMs(subtractIntervals(base, holes)))
}

/** 从现在到下班仍未发放的计薪毫秒（不含未来的休息安排扣除） */
export function paidRemainingMs(shift: Shift, now: number): number {
  if (now >= shift.endMs) return 0
  return totalMs(clipIntervals(shift.paid, Math.max(now, shift.startMs), shift.endMs))
}

export interface OvertimeDetail {
  enabled: boolean
  startMs: number
  endMs: number
  hourly: Decimal
  perSecondDecimal: Decimal
  perSecond: number
  accruedMs: number
  incomeDecimal: Decimal
  maxHours: number
}

/** 下班后的加班计薪区间与金额；与正常班次使用同一套暂停/重置交集规则 */
export function resolveOvertime(
  settings: Settings,
  shift: Shift,
  pauses: PauseInterval[],
  resetAt: number | undefined,
  now: number
): OvertimeDetail {
  const maxHours = Math.max(0, Number(settings.overtimeMaxHours) || 0)
  const enabled =
    !!settings.overtimeEnabled && maxHours > 0 && Number(settings.overtimeMultiplier) > 0
  const startMs = shift.endMs
  const endMs = startMs + (enabled ? maxHours * 3_600_000 : 0)
  let hourly = new Decimal(0)
  if (enabled) {
    const base =
      settings.overtimeRateMode === 'custom'
        ? new Decimal(settings.overtimeHourlyRate || 0)
        : new Decimal(resolveWage(settings, shift).hourlyWage)
    hourly = base.mul(settings.overtimeMultiplier)
  }
  const perSecondDecimal = hourly.div(3600)

  let accruedMs = 0
  if (enabled) {
    const until = Math.min(now, endMs)
    const windowStart = resetAt && resetAt > startMs ? resetAt : startMs
    if (until > windowStart) {
      const base = [{ start: windowStart, end: until }]
      const holes = pauses
        .map((item) => ({
          start: Math.max(item.start, windowStart),
          end: Math.min(item.end ?? until, until)
        }))
        .filter((item) => item.end > item.start)
      accruedMs = Math.max(0, totalMs(subtractIntervals(base, holes)))
    }
  }

  return {
    enabled,
    startMs,
    endMs,
    hourly,
    perSecondDecimal,
    perSecond: perSecondDecimal.toNumber(),
    accruedMs,
    incomeDecimal: perSecondDecimal.mul(accruedMs / 1000),
    maxHours
  }
}

export interface CalcInput {
  now: number
  timerOn: boolean
  timeline: SettingsEntry[]
  pauses: PauseInterval[]
  resets: Record<string, number>
  records: DayRecord[]
}

function roundIncome(value: Decimal, decimals: number): number {
  return value.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber()
}

function isInUnpaidBreak(shift: Shift, now: number): boolean {
  return shift.unpaid.some((item) => now >= item.start && now < item.end)
}

function moneyOrMask(value: string, privacy: boolean): string {
  return privacy ? '••••' : value
}

/** 唯一的状态与金额计算入口，界面与历史结算共用 */
export function computeAppState(input: CalcInput): AppState {
  const nowDate = new Date(input.now)
  const todayKey = toDateKey(nowDate)
  const resolved = resolveShift((key) => settingsForDate(input.timeline, key), input.now)
  const todayShift = resolved.todayShift
  const activeShift = resolved.activeShift
  const yesterdaySettings = resolved.yesterdayShift?.settings
  const graceMs = yesterdaySettings?.overtimeEnabled
    ? Math.max(2 * 3_600_000, (Number(yesterdaySettings.overtimeMaxHours) || 0) * 3_600_000 + 30 * 60_000)
    : 2 * 3_600_000
  const graceShift =
    !activeShift &&
    resolved.yesterdayShift &&
    resolved.yesterdayShift.crossesMidnight &&
    input.now >= resolved.yesterdayShift.endMs &&
    input.now < resolved.yesterdayShift.endMs + graceMs
      ? resolved.yesterdayShift
      : null
  const displayShift = activeShift ?? graceShift ?? todayShift
  const settings = displayShift ? displayShift.settings : settingsForDate(input.timeline, todayKey)
  const overtime = displayShift
    ? resolveOvertime(
        settings,
        displayShift,
        input.pauses,
        input.resets[displayShift.workDate],
        input.now
      )
    : null
  const overtimeActive =
    !!overtime &&
    overtime.enabled &&
    input.timerOn &&
    input.now > displayShift!.endMs &&
    input.now < overtime.endMs &&
    overtime.accruedMs > 0

  let status: WorkStatus
  if (!input.timerOn) status = 'paused'
  else if (activeShift) status = isInUnpaidBreak(activeShift, input.now) ? 'on-break' : 'working'
  else if (overtimeActive) status = 'overtime'
  else if (graceShift) status = 'after-work'
  else if (todayShift) status = input.now < todayShift.startMs ? 'before-work' : 'after-work'
  else status = 'rest-day'

  const working = status === 'working'
  const record = displayShift
    ? input.records.find((item) => item.workDate === displayShift.workDate)
    : undefined

  let accruedMs = 0
  if (displayShift) {
    const resetAt = input.resets[displayShift.workDate]
    accruedMs = accruedPaidMs(displayShift, input.pauses, resetAt, input.now)
  }

  let wage = displayShift
    ? resolveWage(settings, displayShift)
    : resolveWage(
        settingsForDate(input.timeline, todayKey),
        buildShiftShape(settingsForDate(input.timeline, todayKey), todayKey) ?? {
          workDate: todayKey,
          startMs: 0,
          endMs: 0,
          totalSeconds: 0,
          paidSeconds: 1,
          paid: [],
          unpaid: [],
          crossesMidnight: false,
          startMinutes: 0,
          endMinutes: 0,
          shiftLengthMinutes: 0,
          settings
        }
      )

  let plannedPaidSeconds = displayShift?.paidSeconds ?? 0
  let earnedDecimal = new Decimal(0)
  let accruedSeconds = accruedMs / 1000
  let overtimeSeconds = overtime ? overtime.accruedMs / 1000 : 0
  let overtimeIncomeDecimal = overtime ? overtime.incomeDecimal : new Decimal(0)
  let overtimePerSecond = overtime?.perSecond ?? 0
  let overtimeHourly = overtime?.hourly ?? new Decimal(0)
  let overtimeEnabled = !!overtime?.enabled

  if (record) {
    earnedDecimal = new Decimal(record.income)
    accruedSeconds = record.paidSeconds
    plannedPaidSeconds = record.scheduledPaidSeconds
    overtimeSeconds = record.overtimeSeconds ?? 0
    overtimeIncomeDecimal = new Decimal(record.overtimeIncome ?? 0)
    overtimePerSecond = record.overtimePerSecond ?? 0
    overtimeHourly =
      overtimeSeconds > 0 ? overtimeIncomeDecimal.div(overtimeSeconds / 3600) : overtimeHourly
    overtimeEnabled = settings.overtimeEnabled
    wage = {
      ...wage,
      mode: record.wageMode,
      basisText: record.basisText,
      dailyWage: record.dailyWage,
      hourlyWage: record.hourlyWage,
      perSecond: record.perSecond
    }
  } else if (displayShift) {
    let regularIncome = wage.perSecondDecimal.mul(accruedSeconds)
    if (wage.dailyWageDecimal.gt(0) && regularIncome.gt(wage.dailyWageDecimal)) {
      regularIncome = wage.dailyWageDecimal
    }
    earnedDecimal = regularIncome.plus(overtimeIncomeDecimal)
  }

  const income = earnedDecimal.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber()
  const overtimeIncome = overtimeIncomeDecimal.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber()
  const progress =
    plannedPaidSeconds > 0 ? Math.max(0, Math.min(1, accruedSeconds / plannedPaidSeconds)) : 0
  const rateValue =
    status === 'overtime' ? overtimePerSecond : working ? wage.perSecond : 0
  const remainingPaid = displayShift ? paidRemainingMs(displayShift, input.now) : 0

  let countdownTitle = ''
  let countdownText = ''
  let countdownHint = ''
  let countdownMs = 0

  if (status === 'rest-day' || (!displayShift && status !== 'paused')) {
    countdownTitle = '今天休息'
    countdownText = '休息日'
    countdownHint = '不用上班，好好放松一下'
  } else if (status === 'paused' && !displayShift) {
    countdownTitle = '今日休息'
    countdownText = '计时已关闭'
    countdownHint = '开启计时器后恢复累计'
  } else if (
    status === 'paused' &&
    displayShift &&
    input.now > displayShift.endMs &&
    overtime?.enabled
  ) {
    countdownTitle = '加班已暂停'
    countdownText = formatCountdown(overtime.accruedMs)
    countdownHint = '开启计时器后继续累计加班'
  } else if (activeShift) {
    countdownMs = Math.max(0, activeShift.endMs - input.now)
    countdownTitle = '距下班还有'
    countdownText = formatCountdown(countdownMs)
    countdownHint = `下班时间 ${activeShift.settings.workEnd}${
      activeShift.crossesMidnight ? '（次日）' : ''
    }`
  } else if (status === 'overtime' && overtime) {
    countdownTitle = '已加班'
    countdownText = formatCountdown(overtime.accruedMs)
    countdownHint = settings.privacyMode
      ? `加班计薪中 · 今日上限 ${overtime.maxHours} 小时`
      : `加班 ${formatMoney(overtime.hourly, 2)} 元/小时 · 上限 ${overtime.maxHours} 小时`
  } else if (graceShift) {
    countdownTitle = '今天已下班'
    countdownText = '辛苦啦'
    countdownHint =
      overtimeSeconds > 0
        ? `夜班已结束，含加班 ${(overtimeSeconds / 3600).toFixed(2)} 小时`
        : '夜班已结束，收入已入账'
  } else if (todayShift && input.now < todayShift.startMs) {
    countdownMs = todayShift.startMs - input.now
    countdownTitle = '距上班还有'
    countdownText = formatCountdown(countdownMs)
    countdownHint = `上班时间 ${todayShift.settings.workStart}`
  } else if (todayShift) {
    countdownTitle = '今天已下班'
    countdownText = '辛苦啦'
    countdownHint =
      overtimeSeconds > 0
        ? `今天的努力已经到账（含加班 ${(overtimeSeconds / 3600).toFixed(2)} 小时）`
        : '今天的努力已经到账'
  }

  if (status === 'paused' && activeShift) {
    countdownHint = '计时已关闭，收入暂停累计'
  }

  const monthKey = monthKeyOf(todayKey)
  const monthRecords = input.records.filter((item) => monthKeyOf(item.workDate) === monthKey)
  let monthTotal = monthRecords.reduce((sum, item) => sum.plus(item.income), new Decimal(0))
  const currentShiftInMonth = displayShift && monthKeyOf(displayShift.workDate) === monthKey
  const hasRecord = !!record
  if (currentShiftInMonth && !hasRecord) monthTotal = monthTotal.plus(income)

  const monthWorkDays =
    monthRecords.length + (currentShiftInMonth && !hasRecord && displayShift ? 1 : 0)
  const shiftMonthNotice =
    displayShift && monthKeyOf(displayShift.workDate) !== monthKey
      ? `当前夜班计入 ${monthLabelOf(displayShift.workDate)}`
      : `本月已计 ${monthWorkDays} 个工作日`

  const shiftNotice =
    displayShift && displayShift.workDate !== todayKey
      ? `夜班 · 归属 ${displayShift.workDate.slice(5)}`
      : ''

  const decimals = settings.decimals
  const privacy = settings.privacyMode
  const encouragement = buildEncouragement({
    status,
    income,
    perSecond: rateValue,
    progress,
    paidRemainingMs: remainingPaid,
    targets: settings.targets,
    privacy,
    overtimeIncome,
    overtimeSeconds
  })

  const plannedHours = plannedPaidSeconds / 3600
  const plannedHoursText =
    Math.abs(plannedHours - Math.round(plannedHours)) < 0.005
      ? String(Math.round(plannedHours))
      : plannedHours.toFixed(2)
  const workedHoursText = (accruedSeconds / 3600).toFixed(2)

  return {
    now: input.now,
    dateText: formatCNDate(todayKey),
    weekdayText: weekdayText(todayKey),
    timeText: formatClock(nowDate),
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    shiftDate: displayShift?.workDate ?? null,
    shiftNotice,
    countdownTitle,
    countdownText,
    countdownHint,
    earnTodayText: moneyOrMask(formatMoney(income, decimals), privacy),
    earnTodayValue: income,
    rateText: privacy ? '••••' : formatPerSecond(rateValue),
    wageMode: wage.mode,
    overtimeEnabled,
    overtimeActive: status === 'overtime',
    overtimeSeconds,
    overtimeIncomeValue: overtimeIncome,
    overtimeIncomeText: moneyOrMask(formatMoney(overtimeIncome, 2), privacy),
    overtimeRateText: privacy ? '••••' : formatPerSecond(overtimePerSecond),
    overtimeHourlyText: formatMoney(overtimeHourly, 2),
    overtimeHint:
      overtime && overtime.enabled && !privacy
        ? `加班 ${formatMoney(overtime.hourly, 2)} 元/小时 · 倍数 ${settings.overtimeMultiplier}×`
        : '',
    progressPercent: Number((progress * 100).toFixed(1)),
    progressText: (progress * 100).toFixed(1),
    workedHoursText,
    plannedHoursText,
    monthTotalText: moneyOrMask(formatMoney(monthTotal, 2), privacy),
    monthLabel: monthLabelOf(todayKey),
    monthWorkDays,
    monthNotice: shiftMonthNotice,
    encouragement,
    timerOn: input.timerOn,
    decimals,
    privacyMode: privacy,
    dailyWageText: formatMoney(wage.dailyWage, 2),
    hourlyWageText: formatMoney(wage.hourlyWage, 2),
    perSecondText: formatPerSecond(wage.perSecond),
    basisText: wage.basisText,
    isWorkday: !!displayShift,
    pendingSettingsDate: pendingSettingsEntry(input.timeline, todayKey)?.effectiveFrom ?? null,
    serverTimeOffsetMs: 0
  }
}

/** 生成某天的结算记录（用于下班后与补算） */
export function computeDayRecord(
  settings: Settings,
  workDate: string,
  pauses: PauseInterval[],
  resetAt: number | undefined,
  settledAt: number,
  source: DaySettleSource
): DayRecord | null {
  const shift = buildShift(settings, workDate)
  if (!shift) return null
  const wage = resolveWage(settings, shift)
  const accruedMs = accruedPaidMs(shift, pauses, resetAt, shift.endMs)
  const overtime = resolveOvertime(
    settings,
    shift,
    pauses,
    resetAt,
    shift.endMs + Math.max(0, settings.overtimeMaxHours) * 3_600_000
  )
  let income = wage.perSecondDecimal.mul(accruedMs / 1000)
  if (wage.dailyWageDecimal.gt(0) && income.gt(wage.dailyWageDecimal)) income = wage.dailyWageDecimal
  income = income.plus(overtime.incomeDecimal)
  return {
    workDate,
    paidSeconds: Math.round((accruedMs / 1000) * 1000) / 1000,
    income: roundIncome(income, 6),
    perSecond: wage.perSecond,
    wageMode: settings.wageMode,
    basisText: wage.basisText,
    dailyWage: roundIncome(wage.dailyWageDecimal, 2),
    hourlyWage: roundIncome(new Decimal(wage.hourlyWage), 2),
    scheduledPaidSeconds: shift.paidSeconds,
    overtimeSeconds: Math.round((overtime.accruedMs / 1000) * 1000) / 1000,
    overtimeIncome: roundIncome(overtime.incomeDecimal, 6),
    overtimePerSecond: overtime.perSecond,
    settledAt,
    source
  }
}
