<script setup lang="ts">
/**
 * 鲸鱼娘：Coopanion 的分层骨骼小人（见 assets/whale）。
 *
 * 身体由上层 `body.js` 驱动（走、跳、被拎起、被扔出去、做表情），本组件只负责给它一个舞台、
 * 每帧推进一次、把指针事件翻译成它的语言。
 *
 * 拖动的分工是这里最容易出错的地方：**只动窗口，不动画布里的角色**。
 * `body.js` 自己的 drag 模式会让角色在画布里追着指针走（它原本跑在一个铺满屏幕的大画布里），
 * 我们的窗口只有 210×266，角色随便一偏就出画布、被窗口裁掉，看起来像"有个透明框把鱼切了"。
 * 所以：按下只告诉 body 位置（用于点击判定），移动时只搬窗口，绝不喂 move；松手时用一个
 * 未来时间戳的 up 把 press 清掉（超过 400ms 的按压不触发 poke）。
 *
 * 抛掷照抄 Coopanion 的思路：它的宠物窗口铺满整个屏幕，所以"扔出屏幕"时是靠画布里的
 * 撞墙反弹（`body.js` 的 air 分支：`if (pet.x < minX()) pet.vx = Math.abs(pet.vx) * .55`）
 * 让角色弹回来。我们的窗口只有 210×266，于是把这套物理搬到窗口层面：松手后带初速度飞、
 * 撞到工作区上/左/右三边按 0.55 反弹、落到底边（任务栏之上）后：
 *   - 摔得狠（冲击 > DIZZY_IMPACT）→ 调 body 的 dizzy 演三秒蝴蝶结眼 + 甩头，醒来再走回去；
 *   - 轻轻放下 → 直接走回去。
 * 走回去时窗口负责位移，身体只播放步伐（body.js 的 walkInPlace 补丁），
 * 拖动时窗口负责位移，身体只播放歪斜（body.js 的 setTilt 补丁）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createBody } from '../whale/body.js'
import { createWhaleFigure } from '../whale/figure.js'

const props = defineProps<{ paused?: boolean }>()
const emit = defineEmits<{
  (e: 'ready'): void
  (e: 'poke'): void
  (e: 'grab'): void
  (e: 'drop'): void
  (e: 'error', message: string): void
}>()

const stage = ref<HTMLDivElement | null>(null)
let body: any = null
let frame = 0
let last = 0
let disposed = false

/** 按下过、还没松开 */
let pressing = false
/** 已经拖出阈值：从现在起只搬窗口 */
let dragging = false
let downStage = { x: 0, y: 0 }
let downScreen = { x: 0, y: 0 }
/** 按下时窗口位置；每次真正移动后同步成实际位置，避免和夹紧逻辑互相拉扯 */
let base = { x: 0, y: 0 }
/** 最近 120ms 的屏幕坐标采样，用来算抛掷初速度 */
let samples: Array<{ t: number; x: number; y: number }> = []

/** 工作区与窗口尺寸（来自主进程，逻辑像素） */
let area = { x: 0, y: 0, width: 0, height: 0 }
let win = { width: 210, height: 266 }
/** 窗口当前逻辑位置 */
let pos = { x: 0, y: 0 }
/** 抛掷中 */
let flying = false
let vx = 0
let vy = 0
/** 落地后自己走回原位 */
let walking = false
/** 本次飞行的最大落地冲击速度（像素/秒） */
let impact = 0
/** 晕倒要持续到什么时候（performance.now 毫秒），0 表示没在晕 */
let dizzyUntil = 0

const S = 0.854
const FLOOR = 0.92
const DRAG_THRESHOLD = 4
const GRAVITY = 2600
/** 撞墙损耗，和 body.js 的 air 分支保持一致 */
const BOUNCE = 0.55
/** 低于这个速度算落地 */
const LAND_VY = 180
const LAND_VX = 90
/** 贴地滑行的摩擦系数（越大停得越快） */
const FRICTION = 3.2
/** 走回去的速度（像素/秒） */
const WALK_SPEED = 150
/** 落地冲击超过这个值就晕（body.js 里 land() 用 1000 作为 throw 的阈值） */
const DIZZY_IMPACT = 900
/** 晕倒时长：body.js 的 dizzy 是 2.4s 晃 + 0.6s 甩头 */
const DIZZY_TIME = 3000

function stageBounds() {
  const el = stage.value
  const W = el?.clientWidth || 300
  const H = el?.clientHeight || 360
  return { W, H, floorY: Math.round(H * FLOOR), S }
}

function onPetEvent(kind: string, detail: any) {
  if (kind !== 'touch') return
  if (detail?.kind === 'poke') emit('poke')
}

/** 默认的家：屏幕右下角 */
function home() {
  return {
    x: Math.round(area.x + area.width - win.width - 40),
    y: Math.round(area.y + area.height - win.height - 80)
  }
}

/** 被抓之前待的位置：扔出去之后回到这里，而不是硬回右下角 */
let rest: { x: number; y: number } | null = null

function placeToReturn() {
  return rest ?? home()
}

function limitX(x: number) {
  return Math.max(area.x, Math.min(area.x + area.width - win.width, x))
}
function limitY(y: number) {
  return Math.max(area.y, Math.min(area.y + area.height - win.height, y))
}

/** 真正下发一次窗口移动，并把生效位置记下来（被工作区夹住时以主进程返回值为准） */
function place(x: number, y: number) {
  const nx = Math.round(limitX(x))
  const ny = Math.round(limitY(y))
  if (nx === pos.x && ny === pos.y) return
  pos = { x: nx, y: ny }
  void window.workEncourager
    ?.movePet?.(nx, ny)
    ?.then?.((applied: { x: number; y: number } | null | undefined) => {
      if (applied && Number.isFinite(applied.x) && Number.isFinite(applied.y)) {
        pos = { x: applied.x, y: applied.y }
      }
    })
    ?.catch?.(() => {})
}

async function syncEnv(): Promise<void> {
  try {
    const next = await window.workEncourager?.getPetEnv?.()
    if (!next) return
    win = { width: Number(next.width) || win.width, height: Number(next.height) || win.height }
    const wa = next.workArea
    if (wa && Number.isFinite(wa.width)) area = { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
    pos = { x: Number(next.x) || 0, y: Number(next.y) || 0 }
    base = { ...pos }
  } catch {
    /* 拿不到就按 0 算，下一次移动会再校准 */
  }
}

async function start() {
  await document.fonts?.ready?.catch?.(() => {})
  const el = stage.value
  if (!el || disposed) return
  try {
    const baseUrl = new URL('whale/', document.baseURI)
    const figure = await createWhaleFigure(baseUrl, {})
    if (disposed) {
      figure.dispose?.()
      return
    }
    const host = {
      root: el,
      bounds: stageBounds,
      emit: onPetEvent,
      sound: () => {},
      start: { enter: 'drop' }
    }
    body = await createBody(host, { figure })
    emit('ready')
    last = performance.now()
    frame = requestAnimationFrame(tick)
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err))
  }
}

function tick(now: number) {
  if (disposed || !body) return
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
  last = now
  try {
    body.step(dt, !props.paused)
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err))
    return
  }
  if (flying) stepFlight(dt)
  else if (dizzyUntil && now >= dizzyUntil) {
    dizzyUntil = 0
    startWalkHome()
  } else if (walking) stepWalk(dt)
  frame = requestAnimationFrame(tick)
}

/** 抛掷：重力 + 撞工作区边缘反弹 + 地面摩擦。扔不出屏幕，只会弹回来然后自己走回原位。 */
function stepFlight(dt: number) {
  const maxX = area.x + area.width - win.width
  const maxY = area.y + area.height - win.height
  vy += GRAVITY * dt
  let x = pos.x + vx * dt
  let y = pos.y + vy * dt

  if (x < area.x) {
    x = area.x
    vx = Math.abs(vx) * BOUNCE
  } else if (x > maxX) {
    x = maxX
    vx = -Math.abs(vx) * BOUNCE
  }
  if (y < area.y) {
    y = area.y
    vy = Math.abs(vy) * BOUNCE
  } else if (y > maxY) {
    y = maxY
    // 记下落地的冲击速度：够狠就会晕
    impact = Math.max(impact, Math.abs(vy))
    vy = -Math.abs(vy) * BOUNCE
    if (Math.abs(vy) < LAND_VY) vy = 0
  }

  // 贴地滑行时给横向速度加摩擦，否则它会在地板上一直弹来弹去，永远落不下来
  if (Math.abs(y - maxY) < 0.5 && Math.abs(vy) < 1) {
    vy = 0
    vx *= Math.max(0, 1 - dt * FRICTION)
    if (Math.abs(vx) < LAND_VX) {
      vx = 0
      flying = false
      place(x, y)
      land(impact)
      return
    }
  }
  place(x, y)
}

/** 落地：甩得狠先晕三秒（蝴蝶结眼 + 甩头），不然直接走回原位 */
function land(impactSpeed: number) {
  const hard = impactSpeed > DIZZY_IMPACT
  impact = 0
  if (hard) {
    dizzyUntil = performance.now() + DIZZY_TIME
    try {
      body?.do?.('dizzy')
    } catch {
      /* 没有这个词就只是没有晕倒动作，三秒后照样走回去 */
    }
    return
  }
  startWalkHome()
}

function startWalkHome() {
  const target = placeToReturn()
  if (Math.hypot(target.x - pos.x, target.y - pos.y) < 12) return
  walking = true
  try {
    // 窗口负责位移，身体只播放步伐（见 whale/body.js 的 walkInPlace 补丁）
    body?.walkInPlace?.(true, WALK_SPEED)
  } catch {
    /* 旧版 body 没有这个补丁时窗口照样回家，只是没有走路动作 */
  }
}

/** 自己走回原位：窗口平移，身体同时走起来 */
function stepWalk(dt: number) {
  const target = placeToReturn()
  const dx = target.x - pos.x
  const dy = target.y - pos.y
  const dist = Math.hypot(dx, dy)
  if (dist < 6) {
    walking = false
    try {
      body?.walkInPlace?.(false)
      body?.do?.('stand')
    } catch {
      /* 同上 */
    }
    place(target.x, target.y)
    return
  }
  const step = Math.min(dist, WALK_SPEED * dt)
  place(pos.x + (dx / dist) * step, pos.y + (dy / dist) * step)
}

function toStage(e: PointerEvent) {
  const rect = stage.value?.getBoundingClientRect()
  return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0), t: e.timeStamp }
}

function track(e: PointerEvent) {
  const now = e.timeStamp || performance.now()
  samples.push({ t: now, x: e.screenX, y: e.screenY })
  const cut = now - 120
  while (samples.length > 2 && samples[0].t < cut) samples.shift()
}

function throwVelocity() {
  if (samples.length < 2) return { x: 0, y: 0 }
  const a = samples[0]
  const b = samples[samples.length - 1]
  const dt = Math.max(16, b.t - a.t)
  return { x: ((b.x - a.x) * 1000) / dt, y: ((b.y - a.y) * 1000) / dt }
}

/** 最近两点的瞬时速度，用来驱动身体的歪斜 */
function instantVelocity() {
  if (samples.length < 2) return { x: 0, y: 0 }
  const a = samples[samples.length - 2]
  const b = samples[samples.length - 1]
  const dt = Math.max(8, b.t - a.t)
  return { x: ((b.x - a.x) * 1000) / dt, y: ((b.y - a.y) * 1000) / dt }
}

function onDown(e: PointerEvent) {
  if (!body) return
  try {
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  } catch {
    /* 合成事件没有真实指针，抓不住就算了，不影响后面的位置计算 */
  }
  // 抓的时候把飞行/回家/晕倒打断，不然手一按窗口还在自己跑
  flying = false
  walking = false
  dizzyUntil = 0
  impact = 0
  vx = 0
  vy = 0
  try {
    body.setTilt?.(null)
  } catch {
    /* 忽略 */
  }
  const point = toStage(e)
  pressing = true
  dragging = false
  rest = { ...pos }
  samples = []
  downStage = { x: point.x, y: point.y }
  downScreen = { x: e.screenX, y: e.screenY }
  base = { ...pos }
  void syncEnv()
  body.pointer('down', point)
}

function onMove(e: PointerEvent) {
  if (!body || !pressing) return
  track(e)
  const dx = e.screenX - downScreen.x
  const dy = e.screenY - downScreen.y
  if (!dragging) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    dragging = true
    emit('grab')
  }
  place(base.x + dx, base.y + dy)
  // 身体跟着甩动歪斜：窗口自己搬，指针速度只喂给 body 的倾斜角（见 whale/body.js 的 setTilt 补丁）
  const v = instantVelocity()
  try {
    body.setTilt?.(v.x * 0.035)
  } catch {
    /* 旧版 body 没有这个补丁时忽略 */
  }
}

function onUp(e: PointerEvent) {
  if (!body) return
  if (dragging) {
    // 用一个"已经按了很久"的时间戳收尾：body 只清 press，不会把拖动当成点击去 +1
    body.pointer('up', { x: downStage.x, y: downStage.y, t: performance.now() + 1000 })
    const v = throwVelocity()
    emit('drop')
    samples = []
    try {
      body.setTilt?.(null)
    } catch {
      /* 忽略 */
    }
    if (Math.hypot(v.x, v.y) > 520) {
      // 甩出去：给窗口一个初速度，剩下的交给重力与反弹
      vx = Math.max(-1800, Math.min(1800, v.x * 0.9))
      vy = Math.max(-2400, Math.min(600, v.y * 0.9))
      impact = 0
      flying = true
      try {
        // 空中扑腾两下鳍（body 的 flap 是个短动作，够覆盖下落这段）
        body.do?.('flap')
      } catch {
        /* 忽略 */
      }
    } else {
      // 慢慢放下：原地落地，然后自己走回原位
      land(0)
    }
  } else {
    body.pointer('up', toStage(e))
  }
  pressing = false
  dragging = false
}

onMounted(() => {
  void start()
  void syncEnv()
  // 调试用：探针通过 CDP 读这里的内部状态（不影响正常运行）
  ;(window as unknown as Record<string, unknown>).__petState = () => ({
    flying,
    walking,
    dizzy: dizzyUntil > 0,
    mode: (() => {
      try {
        return body?.state?.mode ?? null
      } catch {
        return null
      }
    })(),
    tilt: (() => {
      try {
        return body?.state?.tilt ?? null
      } catch {
        return null
      }
    })(),
    pos: { ...pos },
    area: { ...area },
    win: { ...win },
    home: home()
  })
})

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(frame)
  body?.dispose?.()
  body = null
})

defineExpose({
  tap() {
    body?.pointer('down', { x: 150, y: 200 })
    body?.pointer('up', { x: 150, y: 200 })
  }
})
</script>

<template>
  <div
    ref="stage"
    class="whale-stage"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
  ></div>
</template>

<style scoped>
.whale-stage {
  position: relative;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}
.whale-stage:active {
  cursor: grabbing;
}
</style>
