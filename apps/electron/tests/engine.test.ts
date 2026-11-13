import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/defaults'
import type { CalcInput } from '@shared/engine'
import { computeAppState, computeDayRecord, settingsForDate } from '@shared/engine'
import type { DayRecord, Settings, SettingsEntry } from '@shared/types'
import { buildShift } from '@shared/schedule'
import { resolveWage } from '@shared/wage'
import { validateSettings } from '@shared/validation'
import { settleRecords } from '@shared/settlement'
import { shouldFireShiftReminder } from '@shared/reminders'
import { resolveEffectiveFrom } from '@shared/effective'

const DAY = '2026-11-10' // 星期二

function at(dateKey: string, hour: number, minute = 0, second = 0): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

function timelineWith(settings: Settings, from = '2026-01-01'): SettingsEntry[] {
  return [{ effectiveFrom: from, settings, createdAt: 0 }]
}

function baseInput(now: number, overrides: Partial<CalcInput> = {}): CalcInput {
  return {
    now,
    timerOn: true,
    timeline: timelineWith(defaultSettings()),
    pauses: [],
    resets: {},
    records: [],
    ...overrides
  }
}

describe('工资折算与核心计算', () => {
  it('案例 1：日薪 120 / 09:00-17:00 / 午休不计薪 → 7 小时，每秒约 0.004762 元', () => {
    const settings = defaultSettings()
    const shift = buildShift(settings, DAY)!
    expect(shift.paidSeconds).toBe(7 * 3600)
    expect(shift.unpaid).toHaveLength(1)
    const wage = resolveWage(settings, shift)
    expect(wage.perSecond).toBeCloseTo(120 / 25200, 10)
    expect(wage.perSecondDecimal.toFixed(10)).toBe('0.0047619048')
    expect(wage.dailyWage).toBeCloseTo(120, 10)
    expect(wage.hourlyWage).toBeCloseTo(120 / 7, 10)
  })

  it('案例 2：10:00 收入约 17.1429，进度 14.3%', () => {
    const state = computeAppState(baseInput(at(DAY, 10, 0)))
    expect(state.status).toBe('working')
    expect(state.earnTodayText).toBe('17.1429')
    expect(state.progressText).toBe('14.3')
    expect(state.rateText).toBe('0.004762')
    expect(state.countdownText).toBe('07:00:00')
    expect(state.workedHoursText).toBe('1.00')
    expect(state.plannedHoursText).toBe('7')
  })

  it('案例 3：12:30 收入 51.4286，速度 0，状态休息中', () => {
    const state = computeAppState(baseInput(at(DAY, 12, 30)))
    expect(state.status).toBe('on-break')
    expect(state.statusLabel).toBe('休息中')
    expect(state.earnTodayText).toBe('51.4286')
    expect(state.rateText).toBe('0.000000')
    expect(state.progressText).toBe('42.9')
    expect(state.countdownText).toBe('04:30:00')
  })

  it('案例 4：17:00 收入 120，进度 100%，状态已下班', () => {
    const state = computeAppState(baseInput(at(DAY, 17, 0)))
    expect(state.status).toBe('after-work')
    expect(state.earnTodayText).toBe('120.0000')
    expect(state.progressText).toBe('100.0')
    expect(state.rateText).toBe('0.000000')
    expect(state.countdownTitle).toBe('今天已下班')
  })

  it('上班前显示距上班，且收入为 0', () => {
    const state = computeAppState(baseInput(at(DAY, 8, 0)))
    expect(state.status).toBe('before-work')
    expect(state.countdownTitle).toBe('距上班还有')
    expect(state.earnTodayText).toBe('0.0000')
  })

  it('月薪按实际工作日折算，并保留高精度', () => {
    const settings = defaultSettings()
    settings.wageMode = 'monthly'
    settings.monthlyWage = 8000
    const shift = buildShift(settings, DAY)!
    const wage = resolveWage(settings, shift)
    // 2026 年 11 月：周一至周五共 21 个工作日
    expect(wage.monthlyDays).toBe(21)
    expect(wage.dailyWage).toBeCloseTo(8000 / 21, 10)
    const state = computeAppState(
      baseInput(at(DAY, 17, 0), { timeline: timelineWith(settings) })
    )
    expect(state.earnTodayText).toBe('380.9524')
    expect(state.plannedHoursText).toBe('7')
  })

  it('月薪按固定 21.75 天折算', () => {
    const settings = defaultSettings()
    settings.wageMode = 'monthly'
    settings.monthlyWage = 8000
    settings.monthlyBasis = 'fixed'
    const shift = buildShift(settings, DAY)!
    const wage = resolveWage(settings, shift)
    expect(wage.monthlyDays).toBe(21.75)
    expect(wage.dailyWage).toBeCloseTo(8000 / 21.75, 10)
  })

  it('时薪模式只累计班次内计薪时间，不推断加班', () => {
    const settings = defaultSettings()
    settings.wageMode = 'hourly'
    settings.hourlyWage = 60
    const timeline = timelineWith(settings)
    const at10 = computeAppState(baseInput(at(DAY, 10, 0), { timeline }))
    expect(at10.earnTodayText).toBe('60.0000')
    const after = computeAppState(baseInput(at(DAY, 20, 0), { timeline }))
    expect(after.earnTodayText).toBe('420.0000')
    expect(after.progressText).toBe('100.0')
  })
})

describe('暂停、重置与重叠', () => {
  it('案例 5：手动关闭 10 分钟不补算', () => {
    const pauses = [{ start: at(DAY, 10, 0), end: at(DAY, 10, 10) }]
    const at1010 = computeAppState(baseInput(at(DAY, 10, 10), { pauses }))
    expect(at1010.earnTodayText).toBe('17.1429')
    const at1020 = computeAppState(baseInput(at(DAY, 10, 20), { pauses }))
    expect(at1020.earnTodayText).toBe('20.0000')
  })

  it('暂停中状态为计时已关闭，速度为 0，恢复后只累计后续时间', () => {
    const pauses = [{ start: at(DAY, 10, 0), end: null }]
    const paused = computeAppState(baseInput(at(DAY, 11, 0), { pauses, timerOn: false }))
    expect(paused.status).toBe('paused')
    expect(paused.rateText).toBe('0.000000')
    expect(paused.earnTodayText).toBe('17.1429')
    const resumed = computeAppState(
      baseInput(at(DAY, 11, 10), {
        pauses: [{ start: at(DAY, 10, 0), end: at(DAY, 11, 0) }]
      })
    )
    expect(resumed.earnTodayText).toBe('20.0000')
  })

  it('案例 6：暂停与午休重叠不重复扣除', () => {
    const pauses = [{ start: at(DAY, 11, 30), end: at(DAY, 13, 30) }]
    const state = computeAppState(baseInput(at(DAY, 14, 0), { pauses }))
    expect(state.earnTodayText).toBe('51.4286')
    const insideLunch = computeAppState(baseInput(at(DAY, 12, 30), { pauses }))
    expect(insideLunch.earnTodayText).toBe('42.8571')
  })

  it('案例 7：关闭再打开（持久化暂停）后按真实时间计算', () => {
    const pauses = [
      { start: at(DAY, 9, 30), end: at(DAY, 9, 40) },
      { start: at(DAY, 11, 0), end: at(DAY, 11, 30) }
    ]
    const state = computeAppState(baseInput(at(DAY, 13, 30), { pauses }))
    // 9:00-13:30 = 4.5h，午休 1h，两次暂停共 40 分钟 → 2h50m = 10200s
    expect(state.earnTodayText).toBe('48.5714')
    expect(state.workedHoursText).toBe('2.83')
  })

  it('案例 10：重置只影响本班次，进度与月累计同步', () => {
    const prior: DayRecord = {
      workDate: '2026-11-09',
      paidSeconds: 25200,
      income: 120,
      perSecond: 120 / 25200,
      wageMode: 'daily',
      basisText: '日薪 ¥120.00 ÷ 7.00 小时',
      dailyWage: 120,
      hourlyWage: 120 / 7,
      scheduledPaidSeconds: 25200,
      overtimeSeconds: 0,
      overtimeIncome: 0,
      overtimePerSecond: 0,
      settledAt: at('2026-11-10', 0, 5),
      source: 'auto'
    }
    const state = computeAppState(
      baseInput(at(DAY, 16, 30), { resets: { [DAY]: at(DAY, 15, 0) }, records: [prior] })
    )
    expect(state.earnTodayText).toBe('25.7143')
    expect(state.progressText).toBe('21.4')
    expect(state.monthTotalText).toBe('145.71')
  })

  it('重置后即使下班也不会强行补满 100%', () => {
    const state = computeAppState(
      baseInput(at(DAY, 17, 30), { resets: { [DAY]: at(DAY, 15, 0) } })
    )
    expect(state.status).toBe('after-work')
    expect(state.progressText).toBe('28.6')
    expect(state.earnTodayText).toBe('34.2857')
  })
})

describe('跨午夜与日期归属', () => {
  const night = defaultSettings()
  night.workStart = '22:00'
  night.workEnd = '06:00'
  night.breaks = []
  const timeline = timelineWith(night)

  it('案例 8：跨午夜班次正确计薪并归属开始日期', () => {
    const state = computeAppState(baseInput(at('2026-11-11', 1, 0), { timeline }))
    expect(state.status).toBe('working')
    expect(state.shiftDate).toBe('2026-11-10')
    expect(state.shiftNotice).toContain('归属 11-10')
    expect(state.earnTodayText).toBe('45.0000')
    expect(state.progressText).toBe('37.5')
    expect(state.countdownText).toBe('05:00:00')
    expect(state.countdownHint).toContain('次日')
  })

  it('跨午夜下班后展示夜班结果，并生成归属开始日期的记录', () => {
    const state = computeAppState(baseInput(at('2026-11-11', 6, 30), { timeline }))
    expect(state.status).toBe('after-work')
    expect(state.shiftDate).toBe('2026-11-10')
    expect(state.earnTodayText).toBe('120.0000')
    expect(state.progressText).toBe('100.0')
    const record = computeDayRecord(night, '2026-11-10', [], undefined, at('2026-11-11', 6, 30), 'auto')
    expect(record!.workDate).toBe('2026-11-10')
    expect(record!.income).toBe(120)
  })

  it('案例 11：跨月时本月累计只统计归属本月的记录', () => {
    const state = computeAppState(baseInput(at('2027-01-01', 1, 0), { timeline }))
    expect(state.shiftDate).toBe('2026-12-31')
    expect(state.monthLabel).toContain('2027')
    expect(state.monthTotalText).toBe('0.00')
    expect(state.monthNotice).toContain('2026 年 12 月')
  })
})

describe('工作日、特殊日期与无效设置', () => {
  it('非工作日显示今日休息，收入为 0', () => {
    const saturday = at('2026-11-14', 10, 0)
    const state = computeAppState(baseInput(saturday))
    expect(state.status).toBe('rest-day')
    expect(state.statusLabel).toBe('今日休息')
    expect(state.countdownTitle).toBe('今天休息')
    expect(state.earnTodayText).toBe('0.0000')
  })

  it('特殊上班日覆盖每周工作日', () => {
    const settings = defaultSettings()
    settings.specialDays = [{ id: 's1', date: '2026-11-14', type: 'work' }]
    const state = computeAppState(
      baseInput(at('2026-11-14', 10, 0), { timeline: timelineWith(settings) })
    )
    expect(state.status).toBe('working')
    expect(state.earnTodayText).toBe('17.1429')
  })

  it('特殊休息日覆盖每周工作日', () => {
    const settings = defaultSettings()
    settings.specialDays = [{ id: 's1', date: DAY, type: 'off' }]
    const state = computeAppState(baseInput(at(DAY, 10, 0), { timeline: timelineWith(settings) }))
    expect(state.status).toBe('rest-day')
    expect(state.earnTodayText).toBe('0.0000')
  })

  it('案例 11：无效设置逐项报错且不产生金额', () => {
    const invalid = defaultSettings()
    invalid.workStart = '09:00'
    invalid.workEnd = '09:00'
    invalid.decimals = 7
    invalid.targets = [{ id: 't', name: '', price: 0 }]
    const issues = validateSettings(invalid)
    const fields = issues.map((item) => item.field)
    expect(fields).toContain('workEnd')
    expect(fields).toContain('decimals')
    expect(fields).toContain('targets.0.name')
    expect(fields).toContain('targets.0.price')
  })

  it('休息时段越界、重叠、扣光计薪时长均被拒绝', () => {
    const outside = defaultSettings()
    outside.breaks = [{ id: 'b', start: '07:00', end: '08:00', paid: false }]
    expect(validateSettings(outside).some((item) => item.message.includes('本班次内'))).toBe(true)

    const overlap = defaultSettings()
    overlap.breaks = [
      { id: 'a', start: '12:00', end: '13:00', paid: false },
      { id: 'b', start: '12:30', end: '13:30', paid: false }
    ]
    expect(validateSettings(overlap).some((item) => item.message.includes('不能重叠'))).toBe(true)

    const zeroPaid = defaultSettings()
    zeroPaid.breaks = [{ id: 'a', start: '09:00', end: '17:00', paid: false }]
    expect(validateSettings(zeroPaid).some((item) => item.message.includes('有效计薪时长'))).toBe(true)
  })

  it('计薪休息不扣减有效时长', () => {
    const settings = defaultSettings()
    settings.breaks = [{ id: 'paid', start: '12:00', end: '13:00', paid: true }]
    const shift = buildShift(settings, DAY)!
    expect(shift.paidSeconds).toBe(8 * 3600)
    const wage = resolveWage(settings, shift)
    expect(wage.perSecond).toBeCloseTo(120 / 28800, 10)
  })
})

describe('历史结算与设置变更', () => {
  it('案例 9：设置变更不改变已日结的历史收入', () => {
    const first = defaultSettings()
    const now = at('2026-11-10', 18, 0)
    const settled = settleRecords({
      now,
      timeline: timelineWith(first),
      pauses: [],
      resets: {},
      records: [],
      firstRunDate: '2026-11-10'
    })
    expect(settled.created).toHaveLength(1)
    expect(settled.created[0].income).toBe(120)

    const changed = defaultSettings()
    changed.dailyWage = 500
    const timeline = [
      ...timelineWith(first),
      { effectiveFrom: '2026-11-11', settings: changed, createdAt: now }
    ]
    const after = computeAppState(baseInput(at('2026-11-11', 18, 0), { timeline, records: settled.records }))
    expect(settled.records[0].income).toBe(120)
    expect(settled.records[0].dailyWage).toBe(120)
    expect(after.earnTodayText).toBe('500.0000')
    expect(after.monthTotalText).toBe('620.00')
    expect(settingsForDate(timeline, '2026-11-10').dailyWage).toBe(120)
    expect(settingsForDate(timeline, '2026-11-11').dailyWage).toBe(500)
  })

  it('补算已结束的日期，但首次安装之前不虚构收入', () => {
    const result = settleRecords({
      now: at('2026-11-13', 12, 0),
      timeline: timelineWith(defaultSettings()),
      pauses: [],
      resets: {},
      records: [],
      firstRunDate: '2026-11-11'
    })
    expect(result.created.map((item) => item.workDate)).toEqual(['2026-11-11', '2026-11-12'])
    expect(result.created.every((item) => item.income === 120)).toBe(true)
  })

  it('结算包含已持久化的暂停区间', () => {
    const result = settleRecords({
      now: at('2026-11-10', 18, 0),
      timeline: timelineWith(defaultSettings()),
      pauses: [{ start: at(DAY, 10, 0), end: at(DAY, 10, 10) }],
      resets: {},
      records: [],
      firstRunDate: '2026-11-10'
    })
    expect(result.created[0].income).toBeCloseTo(117.142857, 5)
    expect(result.created[0].paidSeconds).toBeCloseTo(24600, 3)
  })
})

describe('加班计薪', () => {
  function overtimeSettings(overrides: Partial<Settings> = {}): Settings {
    const settings = defaultSettings()
    settings.overtimeEnabled = true
    settings.overtimeRateMode = 'auto'
    settings.overtimeMultiplier = 1.5
    settings.overtimeMaxHours = 3
    Object.assign(settings, overrides)
    return settings
  }

  it('下班后自动按正常时薪 × 倍数累计加班', () => {
    const timeline = timelineWith(overtimeSettings())
    const at1730 = computeAppState(baseInput(at(DAY, 17, 30), { timeline }))
    expect(at1730.status).toBe('overtime')
    expect(at1730.overtimeActive).toBe(true)
    expect(at1730.overtimeSeconds).toBe(1800)
    expect(at1730.overtimeIncomeValue).toBeCloseTo(12.857143, 5)
    expect(at1730.earnTodayText).toBe('132.8571')
    expect(at1730.overtimeRateText).toBe('0.007143')
    expect(at1730.countdownTitle).toBe('已加班')
    expect(at1730.countdownText).toBe('00:30:00')
    expect(at1730.progressText).toBe('100.0')
  })

  it('自定义加班时薪与倍数', () => {
    const settings = overtimeSettings({
      overtimeRateMode: 'custom',
      overtimeHourlyRate: 30,
      overtimeMultiplier: 2,
      overtimeMaxHours: 2
    })
    const state = computeAppState(
      baseInput(at(DAY, 18, 0), { timeline: timelineWith(settings) })
    )
    expect(state.earnTodayText).toBe('180.0000')
    expect(state.overtimeIncomeValue).toBeCloseTo(60, 5)
    expect(state.overtimeHourlyText).toBe('60.00')
    expect(state.status).toBe('overtime')
  })

  it('达到每日加班上限后停止计薪并回到已下班', () => {
    const timeline = timelineWith(overtimeSettings())
    const capped = computeAppState(baseInput(at(DAY, 20, 0), { timeline }))
    expect(capped.status).toBe('after-work')
    expect(capped.overtimeSeconds).toBe(3 * 3600)
    expect(capped.earnTodayText).toBe('197.1429')
    expect(capped.rateText).toBe('0.000000')
    expect(capped.countdownTitle).toBe('今天已下班')
    expect(capped.countdownHint).toContain('含加班 3.00 小时')
  })

  it('加班期间的暂停不补算，且与正常班次共用重置点', () => {
    const timeline = timelineWith(overtimeSettings())
    const paused = computeAppState(
      baseInput(at(DAY, 19, 0), {
        timeline,
        pauses: [{ start: at(DAY, 18, 0), end: at(DAY, 18, 30) }]
      })
    )
    expect(paused.overtimeSeconds).toBe(5400)
    expect(paused.earnTodayText).toBe('158.5714')

    const reset = computeAppState(
      baseInput(at(DAY, 18, 30), {
        timeline,
        resets: { [DAY]: at(DAY, 16, 30) }
      })
    )
    expect(reset.overtimeSeconds).toBe(5400)
    expect(reset.earnTodayText).toBe('47.1429')
  })

  it('默认关闭加班时，下班后仍是已下班且不加钱', () => {
    const state = computeAppState(baseInput(at(DAY, 18, 0)))
    expect(state.status).toBe('after-work')
    expect(state.earnTodayText).toBe('120.0000')
    expect(state.overtimeActive).toBe(false)
  })

  it('加班结束后才日结，历史记录包含加班金额', () => {
    const settings = overtimeSettings()
    const timeline = timelineWith(settings)
    const early = settleRecords({
      now: at(DAY, 19, 0),
      timeline,
      pauses: [],
      resets: {},
      records: [],
      firstRunDate: DAY
    })
    expect(early.created).toHaveLength(0)

    const after = settleRecords({
      now: at(DAY, 20, 0),
      timeline,
      pauses: [],
      resets: {},
      records: [],
      firstRunDate: DAY
    })
    expect(after.created).toHaveLength(1)
    expect(after.created[0].overtimeSeconds).toBe(10800)
    expect(after.created[0].overtimeIncome).toBeCloseTo(77.142857, 5)
    expect(after.created[0].income).toBeCloseTo(197.142857, 5)
  })

  it('非法加班参数被拒绝', () => {
    const invalid = overtimeSettings({
      overtimeMultiplier: 0,
      overtimeMaxHours: 0,
      overtimeRateMode: 'custom',
      overtimeHourlyRate: 0
    })
    const fields = validateSettings(invalid).map((item) => item.field)
    expect(fields).toContain('overtimeMultiplier')
    expect(fields).toContain('overtimeMaxHours')
    expect(fields).toContain('overtimeHourlyRate')
  })
})

describe('设置生效日期', () => {
  const shift = buildShift(defaultSettings(), DAY)!

  it('上班前保存立即生效', () => {
    const result = resolveEffectiveFrom({
      todayKey: DAY,
      now: at(DAY, 8, 0),
      applyToCurrentShift: false,
      activeShiftDate: null,
      todayShiftStartMs: shift.startMs
    })
    expect(result).toBe(DAY)
  })

  it('班次开始后默认从下一个班次生效', () => {
    const during = resolveEffectiveFrom({
      todayKey: DAY,
      now: at(DAY, 10, 0),
      applyToCurrentShift: false,
      activeShiftDate: DAY,
      todayShiftStartMs: shift.startMs
    })
    const after = resolveEffectiveFrom({
      todayKey: DAY,
      now: at(DAY, 18, 0),
      applyToCurrentShift: false,
      activeShiftDate: null,
      todayShiftStartMs: shift.startMs
    })
    expect(during).toBe('2026-11-11')
    expect(after).toBe('2026-11-11')
  })

  it('休息日保存立即生效', () => {
    const result = resolveEffectiveFrom({
      todayKey: '2026-11-14',
      now: at('2026-11-14', 10, 0),
      applyToCurrentShift: false,
      activeShiftDate: null,
      todayShiftStartMs: null
    })
    expect(result).toBe('2026-11-14')
  })

  it('勾选应用当前班次时使用班次归属日期', () => {
    const normal = resolveEffectiveFrom({
      todayKey: DAY,
      now: at(DAY, 10, 0),
      applyToCurrentShift: true,
      activeShiftDate: DAY,
      todayShiftStartMs: shift.startMs
    })
    const night = resolveEffectiveFrom({
      todayKey: '2026-11-11',
      now: at('2026-11-11', 1, 0),
      applyToCurrentShift: true,
      activeShiftDate: '2026-11-10',
      todayShiftStartMs: null
    })
    expect(normal).toBe(DAY)
    expect(night).toBe('2026-11-10')
  })
})

describe('下班提醒', () => {  const settings = defaultSettings()
  const shift = buildShift(settings, DAY)!

  it('案例 12：同一班次只触发一次', () => {
    expect(shouldFireShiftReminder(settings, shift, at(DAY, 16, 49), undefined)).toBe(false)
    expect(shouldFireShiftReminder(settings, shift, at(DAY, 16, 50), undefined)).toBe(true)
    expect(shouldFireShiftReminder(settings, shift, at(DAY, 16, 55), at(DAY, 16, 50))).toBe(false)
  })

  it('关闭提醒开关或错过窗口后不触发', () => {
    const off = { ...settings, reminderEnabled: false }
    expect(shouldFireShiftReminder(off, shift, at(DAY, 16, 55), undefined)).toBe(false)
    expect(shouldFireShiftReminder(settings, shift, at(DAY, 18, 0), undefined)).toBe(false)
    const zero = { ...settings, reminderMinutes: 0 }
    expect(shouldFireShiftReminder(zero, shift, at(DAY, 17, 2), undefined)).toBe(true)
  })
})
