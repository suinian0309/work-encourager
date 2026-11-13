import { Notification } from 'electron'
import { resolveShift } from '@shared/schedule'
import { shouldFireShiftReminder } from '@shared/reminders'
import type { AppService } from './service'

export class ReminderService {
  private readonly service: AppService
  private readonly showWindow: () => void

  constructor(service: AppService, showWindow: () => void) {
    this.service = service
    this.showWindow = showWindow
  }

  /** 每个班次最多提醒一次，提醒状态持久化在 workDate 键上 */
  check(now: number): void {
    const service = this.service
    const resolved = resolveShift((key) => service.effectiveSettingsFor(key), now)
    const shift =
      resolved.activeShift ??
      (resolved.todayShift && now < resolved.todayShift.endMs ? resolved.todayShift : null)
    if (!shift) return

    const last = service.db.reminders[shift.workDate]
    if (!shouldFireShiftReminder(shift.settings, shift, now, last)) return

    service.markReminder(shift.workDate, now)
    if (!Notification.isSupported()) return

    const state = service.state(now)
    const minutesToEnd = Math.max(0, Math.round((shift.endMs - now) / 60_000))
    const body = state.privacyMode
      ? minutesToEnd > 0
        ? `距离下班还有 ${minutesToEnd} 分钟，准备收工啦。`
        : '下班时间到，今天辛苦了。'
      : minutesToEnd > 0
        ? `距离下班还有 ${minutesToEnd} 分钟，今天已赚 ¥${state.earnTodayText}。`
        : `下班啦，今天已赚 ¥${state.earnTodayText}。`

    const notification = new Notification({
      title: '上班鼓励器',
      body,
      silent: false
    })
    notification.on('click', () => this.showWindow())
    notification.show()
  }
}
