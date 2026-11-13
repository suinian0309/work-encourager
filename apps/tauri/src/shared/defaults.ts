import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  wageMode: 'daily',
  dailyWage: 120,
  monthlyWage: 8000,
  hourlyWage: 60,
  monthlyBasis: 'actual',
  fixedDays: 21.75,
  workStart: '09:00',
  workEnd: '17:00',
  weekdays: [1, 2, 3, 4, 5],
  breaksEnabled: true,
  breaks: [{ id: 'lunch', start: '12:00', end: '13:00', paid: false }],
  specialDays: [],
  overtimeEnabled: false,
  overtimeRateMode: 'auto',
  overtimeHourlyRate: 30,
  overtimeMultiplier: 1.5,
  overtimeMaxHours: 3,
  targets: [
    { id: 'milk-tea', name: '奶茶', price: 18 },
    { id: 'coffee', name: '咖啡', price: 20 },
    { id: 'lunch', name: '午饭', price: 25 },
    { id: 'dinner', name: '晚饭', price: 35 }
  ],
  theme: 'system',
  alwaysOnTop: false,
  minimizeToTray: true,
  closeAction: 'tray',
  reminderEnabled: true,
  reminderMinutes: 10,
  decimals: 4,
  privacyMode: false
}

export function cloneSettings(input: Settings): Settings {
  return JSON.parse(JSON.stringify(input)) as Settings
}

export function defaultSettings(): Settings {
  return cloneSettings(DEFAULT_SETTINGS)
}

export const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日']

export const STATUS_LABELS: Record<string, string> = {
  'rest-day': '今日休息',
  'before-work': '未上班',
  working: '上班中',
  'on-break': '休息中',
  overtime: '加班中',
  'after-work': '已下班',
  paused: '计时已关闭'
}
