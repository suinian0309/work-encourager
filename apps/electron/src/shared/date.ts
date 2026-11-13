const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

export function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 本地日期键 YYYY-MM-DD */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function dateKeyOf(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

export interface DateParts {
  year: number
  month: number
  day: number
}

export function parseDateKey(key: string): DateParts {
  const [y, m, d] = key.split('-').map((part) => Number(part))
  return { year: y, month: m, day: d }
}

export function dateAtMidnight(key: string): Date {
  const { year, month, day } = parseDateKey(key)
  return new Date(year, month - 1, day, 0, 0, 0, 0)
}

export function addDaysToKey(key: string, days: number): string {
  const base = dateAtMidnight(key)
  base.setDate(base.getDate() + days)
  return toDateKey(base)
}

export function weekdayOfKey(key: string): number {
  const day = dateAtMidnight(key).getDay()
  return day === 0 ? 7 : day
}

export function weekdayText(key: string): string {
  return WEEKDAY_CN[dateAtMidnight(key).getDay()]
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

export function monthKeyOf(dateKey: string): string {
  return dateKey.slice(0, 7)
}

export function monthLabelOf(dateKey: string): string {
  const { year, month } = parseDateKey(dateKey)
  return `${year} 年 ${month} 月`
}

/** HH:MM -> 当天分钟数 */
export function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

export function minutesToHHMM(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`
}

export function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

export function formatCNDate(key: string): string {
  const { year, month, day } = parseDateKey(key)
  return `${year}年${month}月${day}日`
}

/** 将毫秒格式化为 HH:MM:SS（向上取整到秒，保证 00:00:00 才归零） */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
}

export function formatHours(ms: number, digits = 2): string {
  return (Math.max(0, ms) / 3_600_000).toFixed(digits)
}

export function formatDurationCN(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000))
  if (totalMinutes < 1) return '不到 1 分钟'
  if (totalMinutes < 60) return `${totalMinutes} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`
}

export function daysBetweenKeys(from: string, to: string): number {
  const a = dateAtMidnight(from).getTime()
  const b = dateAtMidnight(to).getTime()
  return Math.round((b - a) / 86_400_000)
}
