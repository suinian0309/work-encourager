import type { Target, WorkStatus } from './types'
import { formatMoney } from './wage'

export interface EncouragementContext {
  status: WorkStatus
  income: number
  perSecond: number
  progress: number
  paidRemainingMs: number
  targets: Target[]
  privacy: boolean
  overtimeIncome: number
  overtimeSeconds: number
}

function pickEtaText(ms: number): string {
  if (ms < 60_000) return '不到 1 分钟'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

/** 根据真实收入与目标价格生成鼓励文案，只使用已实现的数据 */
export function buildEncouragement(ctx: EncouragementContext): string {
  const targets = [...ctx.targets].filter((item) => item.price > 0).sort((a, b) => a.price - b.price)
  const primary = targets[0]

  if (ctx.status === 'paused') {
    return ctx.privacy
      ? '计时已关闭，收入暂停累计，随时可以继续。'
      : `计时已关闭，收入停在 ¥${formatMoney(ctx.income, 2)}，随时可以继续。`
  }
  if (ctx.status === 'rest-day') return '今天休息，好好充电，明天继续。'
  if (ctx.status === 'before-work') return '还没到上班时间，先给自己泡杯热茶吧。'
  if (ctx.status === 'overtime') {
    const minutes = Math.max(1, Math.round(ctx.overtimeSeconds / 60))
    return ctx.privacy
      ? `加班 ${minutes} 分钟了，辛苦了，记得早点休息。`
      : `加班 ${minutes} 分钟，已多赚 ¥${formatMoney(ctx.overtimeIncome, 2)}，记得早点休息。`
  }
  if (ctx.status === 'after-work') {
    return ctx.overtimeSeconds > 0
      ? ctx.privacy
        ? '下班啦，今天还加了班，辛苦了！'
        : `下班啦，今天含加班共入账 ¥${formatMoney(ctx.income, 2)}，辛苦了！`
      : '下班啦，今天的努力已经到账！'
  }

  const earnedLine =
    primary && ctx.income >= primary.price
      ? `今天已经赚到 ${Math.min(99, Math.floor(ctx.income / primary.price))} 份${primary.name}了。`
      : ''

  if (ctx.status === 'on-break') {
    return earnedLine ? `${earnedLine}休息一下，回来接着赚。` : '休息中，吃饱喝足再继续。'
  }

  if (primary && ctx.perSecond > 0) {
    const earnedUnits = Math.floor(ctx.income / primary.price)
    const remainder = ctx.income - earnedUnits * primary.price
    const need = primary.price - remainder
    const etaMs = (need / ctx.perSecond) * 1000
    if (etaMs > 0 && etaMs <= ctx.paidRemainingMs && etaMs <= 12 * 3_600_000) {
      return `再过 ${pickEtaText(etaMs)}，一份${primary.name}就赚回来了。`
    }
    if (earnedLine) {
      return ctx.progress >= 0.5 ? `${earnedLine}今日进度已过半，坚持一下！` : earnedLine
    }
  }

  if (ctx.progress >= 0.8) return '已完成大部分工时，最后冲刺一下！'
  if (ctx.progress >= 0.5) return '今日进度已过半，坚持一下！'
  return '稳住节奏，今天的每一分钟都在入账。'
}
