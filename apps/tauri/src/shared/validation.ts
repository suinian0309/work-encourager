import type { Settings, ValidationIssue } from './types'
import { daysInMonth, parseDateKey, parseHHMM, toDateKey, dateAtMidnight } from './date'

const MAX_MONEY = 100_000_000

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_MONEY
}

export function validateSettings(settings: Settings): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (settings.wageMode === 'daily' && !isPositiveNumber(settings.dailyWage)) {
    issues.push({ field: 'dailyWage', message: '每日工资必须大于 0' })
  }
  if (settings.wageMode === 'monthly') {
    if (!isPositiveNumber(settings.monthlyWage)) {
      issues.push({ field: 'monthlyWage', message: '月工资必须大于 0' })
    }
    if (settings.monthlyBasis === 'fixed') {
      if (!isPositiveNumber(settings.fixedDays) || settings.fixedDays > 31) {
        issues.push({ field: 'fixedDays', message: '固定计薪天数必须大于 0 且不超过 31' })
      }
    }
  }
  if (settings.wageMode === 'hourly' && !isPositiveNumber(settings.hourlyWage)) {
    issues.push({ field: 'hourlyWage', message: '每小时工资必须大于 0' })
  }

  if (settings.overtimeEnabled) {
    if (settings.overtimeRateMode === 'custom' && !isPositiveNumber(settings.overtimeHourlyRate)) {
      issues.push({ field: 'overtimeHourlyRate', message: '加班时薪必须大于 0' })
    }
    if (!isPositiveNumber(settings.overtimeMultiplier) || settings.overtimeMultiplier > 10) {
      issues.push({ field: 'overtimeMultiplier', message: '加班倍数必须大于 0 且不超过 10' })
    }
    if (!isPositiveNumber(settings.overtimeMaxHours) || settings.overtimeMaxHours > 12) {
      issues.push({ field: 'overtimeMaxHours', message: '每日加班上限必须大于 0 且不超过 12 小时' })
    }
  }

  const startMinutes = parseHHMM(settings.workStart)
  const endMinutes = parseHHMM(settings.workEnd)
  if (startMinutes === null) issues.push({ field: 'workStart', message: '上班时间格式应为 HH:MM' })
  if (endMinutes === null) issues.push({ field: 'workEnd', message: '下班时间格式应为 HH:MM' })
  if (startMinutes !== null && endMinutes !== null && startMinutes === endMinutes) {
    issues.push({ field: 'workEnd', message: '上班时间与下班时间不能相同' })
  }

  if (!Array.isArray(settings.weekdays) || settings.weekdays.length === 0) {
    issues.push({ field: 'weekdays', message: '至少选择一个工作日' })
  } else if (settings.weekdays.some((day) => day < 1 || day > 7 || !Number.isInteger(day))) {
    issues.push({ field: 'weekdays', message: '工作日取值必须为周一至周日' })
  }

  let shiftLength = 0
  if (startMinutes !== null && endMinutes !== null && startMinutes !== endMinutes) {
    shiftLength = (endMinutes - startMinutes + 1440) % 1440
  }

  const breakRanges: Array<{ start: number; end: number; index: number }> = []
  if (settings.breaksEnabled) {
    settings.breaks.forEach((item, index) => {
      const bStart = parseHHMM(item.start)
      const bEnd = parseHHMM(item.end)
      const prefix = `breaks.${index}`
      if (bStart === null) {
        issues.push({ field: `${prefix}.start`, message: '休息开始时间格式应为 HH:MM' })
        return
      }
      if (bEnd === null) {
        issues.push({ field: `${prefix}.end`, message: '休息结束时间格式应为 HH:MM' })
        return
      }
      const duration = (bEnd - bStart + 1440) % 1440
      if (duration === 0) {
        issues.push({ field: `${prefix}.end`, message: '休息开始与结束时间不能相同' })
        return
      }
      if (shiftLength > 0) {
        const offset = (bStart - startMinutes! + 1440) % 1440
        if (offset + duration > shiftLength) {
          issues.push({
            field: `${prefix}.start`,
            message: `休息时段必须落在本班次内（${settings.workStart}—${settings.workEnd}）`
          })
          return
        }
        breakRanges.push({ start: offset, end: offset + duration, index })
      }
    })

    const sorted = [...breakRanges].sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].start < sorted[i - 1].end) {
        issues.push({ field: `breaks.${sorted[i].index}.start`, message: '休息时段之间不能重叠' })
      }
    }

    if (shiftLength > 0) {
      const unpaidMinutes = settings.breaks.reduce((sum, item) => {
        if (item.paid) return sum
        const bStart = parseHHMM(item.start)
        const bEnd = parseHHMM(item.end)
        if (bStart === null || bEnd === null) return sum
        return sum + ((bEnd - bStart + 1440) % 1440)
      }, 0)
      const paidMinutes = shiftLength - unpaidMinutes
      if (paidMinutes <= 0) {
        issues.push({
          field: 'breaks',
          message: '扣除不计薪休息后，有效计薪时长必须大于 0'
        })
      }
    }
  }

  settings.specialDays.forEach((item, index) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.date)
    if (!match) {
      issues.push({ field: `specialDays.${index}.date`, message: '特殊日期格式应为 YYYY-MM-DD' })
      return
    }
    const { year, month, day } = parseDateKey(item.date)
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      issues.push({ field: `specialDays.${index}.date`, message: '特殊日期不是有效日期' })
      return
    }
    if (toDateKey(dateAtMidnight(item.date)) !== item.date) {
      issues.push({ field: `specialDays.${index}.date`, message: '特殊日期不是有效日期' })
    }
    const duplicate = settings.specialDays.findIndex((other) => other.date === item.date)
    if (duplicate !== index) {
      issues.push({ field: `specialDays.${index}.date`, message: '同一天只能设置一次特殊日期' })
    }
  })

  settings.targets.forEach((item, index) => {
    if (!item.name || !item.name.trim()) {
      issues.push({ field: `targets.${index}.name`, message: '目标名称不能为空' })
    } else if (item.name.trim().length > 20) {
      issues.push({ field: `targets.${index}.name`, message: '目标名称不超过 20 个字符' })
    }
    if (!isPositiveNumber(item.price)) {
      issues.push({ field: `targets.${index}.price`, message: '目标价格必须大于 0' })
    }
  })

  if (!Number.isInteger(settings.decimals) || settings.decimals < 2 || settings.decimals > 6) {
    issues.push({ field: 'decimals', message: '金额小数位数应为 2 到 6 位' })
  }

  if (
    !Number.isInteger(settings.reminderMinutes) ||
    settings.reminderMinutes < 0 ||
    settings.reminderMinutes > 720
  ) {
    issues.push({ field: 'reminderMinutes', message: '提前提醒分钟数应为 0 到 720 的整数' })
  }

  return issues
}

export function firstIssueMap(issues: ValidationIssue[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const issue of issues) {
    if (!map[issue.field]) map[issue.field] = issue.message
  }
  return map
}
