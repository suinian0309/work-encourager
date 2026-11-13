export type WageMode = 'daily' | 'monthly' | 'hourly'
export type MonthlyBasis = 'actual' | 'fixed'
export type OvertimeRateMode = 'auto' | 'custom'
export type ThemeMode = 'system' | 'light' | 'dark'
export type CloseAction = 'quit' | 'tray'

export interface BreakPeriod {
  id: string
  /** HH:MM */
  start: string
  /** HH:MM */
  end: string
  /** 该段休息是否计薪 */
  paid: boolean
}

export interface SpecialDay {
  id: string
  /** YYYY-MM-DD */
  date: string
  type: 'work' | 'off'
  note?: string
}

export interface Target {
  id: string
  name: string
  price: number
}

export interface Settings {
  wageMode: WageMode
  dailyWage: number
  monthlyWage: number
  hourlyWage: number
  monthlyBasis: MonthlyBasis
  fixedDays: number
  workStart: string
  workEnd: string
  /** 1 = 周一 ... 7 = 周日 */
  weekdays: number[]
  breaksEnabled: boolean
  breaks: BreakPeriod[]
  specialDays: SpecialDay[]
  overtimeEnabled: boolean
  overtimeRateMode: OvertimeRateMode
  /** 自定义加班时薪（元/小时），仅 custom 模式使用 */
  overtimeHourlyRate: number
  /** 加班薪资倍数 */
  overtimeMultiplier: number
  /** 每日加班计薪上限（小时） */
  overtimeMaxHours: number
  targets: Target[]
  theme: ThemeMode
  alwaysOnTop: boolean
  minimizeToTray: boolean
  closeAction: CloseAction
  reminderEnabled: boolean
  reminderMinutes: number
  decimals: number
  privacyMode: boolean
}

export interface PauseInterval {
  /** epoch ms */
  start: number
  /** epoch ms，null 表示暂停中 */
  end: number | null
}

export interface SettingsEntry {
  /** 该设置从哪个工作日期起生效（YYYY-MM-DD） */
  effectiveFrom: string
  settings: Settings
  createdAt: number
}

export type DaySettleSource = 'manual' | 'auto'

export interface DayRecord {
  workDate: string
  paidSeconds: number
  income: number
  perSecond: number
  wageMode: WageMode
  basisText: string
  dailyWage: number
  hourlyWage: number
  scheduledPaidSeconds: number
  overtimeSeconds: number
  overtimeIncome: number
  overtimePerSecond: number
  settledAt: number
  source: DaySettleSource
}

export interface TimerState {
  on: boolean
  changedAt: number
}

export interface AppDb {
  version: 1
  createdAt: number
  firstRunDate: string
  settingsTimeline: SettingsEntry[]
  timer: TimerState
  pauses: PauseInterval[]
  resets: Record<string, number>
  reminders: Record<string, number>
  records: DayRecord[]
  floatBounds?: { x: number; y: number } | null
}

export type WorkStatus =
  | 'rest-day'
  | 'before-work'
  | 'working'
  | 'on-break'
  | 'overtime'
  | 'after-work'
  | 'paused'

export interface WageBreakdown {
  mode: WageMode
  dailyWage: number
  hourlyWage: number
  perSecond: number
  monthlyDays?: number
  basisText: string
}

export interface AppState {
  now: number
  dateText: string
  weekdayText: string
  timeText: string
  status: WorkStatus
  statusLabel: string
  shiftDate: string | null
  shiftNotice: string
  countdownTitle: string
  countdownText: string
  countdownHint: string
  earnTodayText: string
  earnTodayValue: number
  rateText: string
  wageMode: WageMode
  overtimeEnabled: boolean
  overtimeActive: boolean
  overtimeSeconds: number
  overtimeIncomeValue: number
  overtimeIncomeText: string
  overtimeRateText: string
  overtimeHourlyText: string
  overtimeHint: string
  progressPercent: number
  progressText: string
  workedHoursText: string
  plannedHoursText: string
  monthTotalText: string
  monthLabel: string
  monthWorkDays: number
  monthNotice: string
  encouragement: string
  timerOn: boolean
  decimals: number
  privacyMode: boolean
  dailyWageText: string
  hourlyWageText: string
  perSecondText: string
  basisText: string
  isWorkday: boolean
  pendingSettingsDate: string | null
  serverTimeOffsetMs: number
}

export interface ValidationIssue {
  field: string
  message: string
}

export interface SaveSettingsPayload {
  settings: Settings
  applyToCurrentShift: boolean
}

export interface SaveSettingsResult {
  ok: boolean
  issues: ValidationIssue[]
  effectiveFrom?: string
  state?: AppState
}

export interface HistoryRow {
  workDate: string
  weekdayText: string
  hoursText: string
  incomeText: string
  basisText: string
  wageModeText: string
  overtimeText: string
  isToday: boolean
  live: boolean
}

export interface HistoryView {
  rows: HistoryRow[]
  monthTotalText: string
  monthLabel: string
  allTotalText: string
  recordCount: number
  dataPath: string
}

export interface BootstrapPayload {
  state: AppState
  settings: Settings
  pendingSettings: Settings | null
  pendingEffectiveFrom: string | null
  dataPath: string
  appVersion: string
}
