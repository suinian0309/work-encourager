import Decimal from 'decimal.js'
import type { Settings, WageBreakdown, WageMode } from './types'
import type { Shift } from './schedule'
import { countWorkdaysInMonth } from './schedule'

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

export interface WageDetail extends WageBreakdown {
  perSecondDecimal: Decimal
  dailyWageDecimal: Decimal
  plannedPaidSeconds: number
}

export function wageModeLabel(mode: WageMode): string {
  if (mode === 'daily') return '日薪'
  if (mode === 'monthly') return '月薪'
  return '时薪'
}

/** 计算某个班次的工资折算；保留完整 Decimal 精度，仅在展示时取整 */
export function resolveWage(settings: Settings, shift: Shift): WageDetail {
  const plannedSeconds = shift.paidSeconds
  const safeSeconds = plannedSeconds > 0 ? plannedSeconds : 1
  let perSecond: Decimal
  let daily: Decimal
  let basisText: string
  let monthlyDays: number | undefined

  if (settings.wageMode === 'daily') {
    daily = new Decimal(settings.dailyWage)
    perSecond = daily.div(safeSeconds)
    basisText = `日薪 ${formatMoney(daily, 2)} ÷ ${(safeSeconds / 3600).toFixed(2)} 小时`
  } else if (settings.wageMode === 'monthly') {
    monthlyDays =
      settings.monthlyBasis === 'fixed'
        ? settings.fixedDays
        : Math.max(1, countWorkdaysInMonth(settings, shift.workDate))
    daily = new Decimal(settings.monthlyWage).div(Math.max(0.01, monthlyDays))
    perSecond = daily.div(safeSeconds)
    basisText =
      settings.monthlyBasis === 'fixed'
        ? `月薪 ${formatMoney(settings.monthlyWage, 2)} ÷ 固定 ${monthlyDays} 天`
        : `月薪 ${formatMoney(settings.monthlyWage, 2)} ÷ 本月 ${monthlyDays} 个工作日`
  } else {
    perSecond = new Decimal(settings.hourlyWage).div(3600)
    daily = perSecond.mul(safeSeconds)
    basisText = `时薪 ${formatMoney(settings.hourlyWage, 2)}`
  }

  const hourly = plannedSeconds > 0 ? daily.div(plannedSeconds / 3600) : new Decimal(0)

  return {
    mode: settings.wageMode,
    dailyWage: daily.toNumber(),
    hourlyWage: hourly.toNumber(),
    perSecond: perSecond.toNumber(),
    monthlyDays,
    basisText,
    perSecondDecimal: perSecond,
    dailyWageDecimal: daily,
    plannedPaidSeconds: plannedSeconds
  }
}

export function formatMoney(value: Decimal.Value, decimals = 2, grouping = true): string {
  const fixed = new Decimal(value).toFixed(decimals, Decimal.ROUND_HALF_UP)
  if (!grouping) return fixed
  const [integer, fraction] = fixed.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

/** 每秒工资较小，默认保留 6 位小数，足够看清增长速度 */
export function formatPerSecond(value: Decimal.Value): string {
  const decimal = new Decimal(value)
  const decimals = decimal.lt(1) ? 6 : 4
  return decimal.toFixed(decimals, Decimal.ROUND_HALF_UP)
}

export function roundMoney(value: Decimal.Value, decimals = 2): number {
  return new Decimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber()
}
