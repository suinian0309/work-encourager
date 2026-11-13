export interface Interval {
  start: number
  end: number
}

/** 合并重叠或相邻区间，返回升序结果 */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start)
  const merged: Interval[] = []
  for (const item of sorted) {
    const last = merged[merged.length - 1]
    if (last && item.start <= last.end) {
      last.end = Math.max(last.end, item.end)
    } else {
      merged.push({ start: item.start, end: item.end })
    }
  }
  return merged
}

/** 用 holes 从 base 中扣除时间段（holes 会自动合并） */
export function subtractIntervals(base: Interval[], holes: Interval[]): Interval[] {
  const mergedHoles = mergeIntervals(holes)
  if (mergedHoles.length === 0) return mergeIntervals(base)
  const result: Interval[] = []
  for (const piece of mergeIntervals(base)) {
    let cursor = piece.start
    for (const hole of mergedHoles) {
      if (hole.end <= cursor) continue
      if (hole.start >= piece.end) break
      if (hole.start > cursor) result.push({ start: cursor, end: Math.min(hole.start, piece.end) })
      cursor = Math.max(cursor, hole.end)
      if (cursor >= piece.end) break
    }
    if (cursor < piece.end) result.push({ start: cursor, end: piece.end })
  }
  return result.filter((item) => item.end > item.start)
}

/** 求多个区间与窗口的交集 */
export function clipIntervals(base: Interval[], windowStart: number, windowEnd: number): Interval[] {
  if (windowEnd <= windowStart) return []
  return base
    .map((item) => ({ start: Math.max(item.start, windowStart), end: Math.min(item.end, windowEnd) }))
    .filter((item) => item.end > item.start)
}

export function totalMs(list: Interval[]): number {
  return list.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0)
}

export function containsInstant(list: Interval[], instant: number): boolean {
  return list.some((item) => instant >= item.start && instant < item.end)
}
