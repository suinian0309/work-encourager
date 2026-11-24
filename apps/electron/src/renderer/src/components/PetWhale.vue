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
 * 抛掷的物理搬到窗口层面（窗口只有基准 210×266，按比例缩放）：松手后带初速度飞，
 * 撞到工作区上/左/右三边**只停下、不反弹**，然后竖直落到底边（任务栏上沿）；
 * 一落地就调 body 的 dizzy 演三秒蝴蝶结眼 + 甩头，醒来再走回扔出去之前的位置。
 * 只是拖动挪位置的话，落点就是新的家，不会自己再跑回去。
 * 走回去时窗口负责位移，身体只播放步伐（body.js 的 walkInPlace 补丁），
 * 拖动时窗口负责位移，身体只播放歪斜（body.js 的 setTilt 补丁）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createBody } from '../whale/body.js'
import { createWhaleFigure } from '../whale/figure.js'

const props = defineProps<{ paused?: boolean; scale?: number }>()
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
/** 晕倒要持续到什么时候（performance.now 毫秒），0 表示没在晕 */
let dizzyUntil = 0

/**
 * 100% 比例下的基准缩放：实际 = 基准 × props.scale（设置页滑杆 60%–140%）。
 *
 * 0.854 是按墨迹实测的：鲸鱼墨迹约 187×247 模型单位，舞台 198×240 时留一成上下边距。
 * 1.4.7 之前滑杆"只缩外框"的真正原因是只调了 layout()、没让 body 重新读 bounds，
 * S 一直停在挂载时的值——见下面的 applyScale()。
 */
const BASE_S = 0.854
let S = BASE_S * (props.scale ?? 0.8)
const FLOOR = 0.92
const DRAG_THRESHOLD = 4
const GRAVITY = 2600
/** 走回去的速度（像素/秒） */
const WALK_SPEED = 150
/** 晕倒时长：body.js 的 dizzy 是 2.4s 晃 + 0.6s 甩头 */
const DIZZY_TIME = 3000
/** 松手速度超过这个值才算"扔"，否则只是挪了个位置 */
const THROW_SPEED = 520
/** 撞墙的弹性：0.62 差不多是"弹一下但明显变弱"，斜着扔能连着弹两三次 */
const WALL_BOUNCE = 0.62
/** 本班次内撞墙次数（调试用） */
let bounces = 0

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

/** 默认的家：贴着任务栏上沿、距右边缘 5% 屏宽（和主进程的 defaultPetBounds 一致） */
function home() {
  return {
    x: Math.round(area.x + area.width - win.width - area.width * 0.05),
    y: Math.round(area.y + area.height - win.height - 8)
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

/**
 * 比例变了：必须让 body 重新读一次 bounds（S/W/H 都在 bounds 里），再排版。
 * 只调 layout() 是不会更新 S 的——1.4.7 之前滑杆只改了窗口、角色一直按首次的 S 画，看着就是"只缩了透明框"。
 */
function applyScale() {
  if (!body) return
  try {
    body.resize?.()
    body.layout?.()
  } catch {
    /* 旧版 body 没有这些方法时忽略 */
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
    applyScale()
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

/**
 * 抛掷：重力 + 上/左/右三边弹性反弹，底边落地即晕。
 * 弹一下损失 38% 的能量，所以斜着甩出去会像台球那样连着撞几下；
 * 只有在撞到任务栏上沿（底边）时才落地——落地立刻眩晕（body.js 的 dizzy），晕完再走回原位。
 */
function stepFlight(dt: number) {
  const maxX = area.x + area.width - win.width
  const maxY = area.y + area.height - win.height
  vy += GRAVITY * dt
  let x = pos.x + vx * dt
  let y = pos.y + vy * dt

  if (x <= area.x) {
    // 撞左边：横向速度反向并按弹性衰减，竖直分量保持（所以还能继续往上飞）
    x = area.x
    if (vx < 0) {
      vx = -vx * WALL_BOUNCE
      bounces += 1
    }
  } else if (x >= maxX) {
    x = maxX
    if (vx > 0) {
      vx = -vx * WALL_BOUNCE
      bounces += 1
    }
  }
  if (y <= area.y) {
    // 撞顶：竖直分量反向衰减，横向照旧（斜着扔会从顶上再弹回来）
    y = area.y
    if (vy < 0) {
      vy = -vy * WALL_BOUNCE
      bounces += 1
    }
  }
  if (y >= maxY) {
    // 底边不弹：碰到任务栏就落地
    y = maxY
    flying = false
    place(x, y)
    land()
    return
  }
  place(x, y)
}

/** 落地：先晕三秒（蝴蝶结眼 + 甩头），醒来再慢慢走回原位 */
function land() {
  vx = 0
  vy = 0
  dizzyUntil = performance.now() + DIZZY_TIME
  try {
    body?.do?.('dizzy')
  } catch {
    /* 没有这个词就只是没有晕倒动作，三秒后照样走回去 */
  }
}

function startWalkHome() {
  const target = placeToReturn()
  if (Math.hypot(target.x - pos.x, target.y - pos.y) < 12) return
  walking = true
  try {
    // 先转身再迈步，免得第一步迈在反方向
    if (Math.abs(target.x - pos.x) > 1) body?.setFacing?.(target.x > pos.x ? 1 : -1)
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
  // 走在窗口层上，body 自己不知道往哪走：把方向告诉她，否则"走回原位"看着是倒着走
  try {
    if (Math.abs(dx) > 1) body?.setFacing?.(dx > 0 ? 1 : -1)
  } catch {
    /* 旧版 body 没有这个补丁时忽略 */
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
    if (Math.hypot(v.x, v.y) > THROW_SPEED) {
      // 甩出去：给窗口一个初速度，剩下的交给重力（撞边只停不弹）
      vx = Math.max(-1800, Math.min(1800, v.x * 0.9))
      vy = Math.max(-2400, Math.min(600, v.y * 0.9))
      flying = true
      bounces = 0
      try {
        // 飞出去时朝行进方向，落地后按回家的方向再转一次（见 stepWalk）
        if (Math.abs(vx) > 20) body.setFacing?.(vx > 0 ? 1 : -1)
      } catch {
        /* 旧版 body 没有这个补丁时忽略 */
      }
      try {
        // 空中扑腾两下鳍（body 的 flap 是个短动作，够覆盖下落这段）
        body.do?.('flap')
      } catch {
        /* 忽略 */
      }
    } else {
      // 只是拖到别处：落点就是新家，不再自己跑回去
      rest = { ...pos }
    }
  } else {
    body.pointer('up', toStage(e))
  }
  pressing = false
  dragging = false
}

/** 窗口自身尺寸变了（比例滑杆之外的情况）：重新读 bounds，别让角色停在旧尺度上 */
function onWindowResize() {
  applyScale()
  void syncEnv()
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  void start()
  void syncEnv()
  // 调试用：探针通过 CDP 读这里的内部状态（不影响正常运行）
  ;(window as unknown as Record<string, unknown>).__petState = () => ({
    flying,
    walking,
    bounces,
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
    scale: S,
    stride: (() => {
      try {
        return body?.state?.stride ?? null
      } catch {
        return null
      }
    })(),
    phase: (() => {
      try {
        return body?.state?.phase ?? null
      } catch {
        return null
      }
    })(),
    facing: (() => {
      try {
        return body?.state?.faceVis ?? null
      } catch {
        return null
      }
    })(),
    feet: (() => {
      try {
        const f = body?.state?.feet
        return f ? f.map((p: number[]) => [Math.round(p[0]), Math.round(p[1])]) : null
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

watch(
  () => props.scale,
  (value) => {
    const next = Number(value)
    S = BASE_S * (Number.isFinite(next) && next > 0 ? next : 0.8)
    applyScale()
    // 窗口尺寸跟着比例变了：把 pos/area/win 重新同步，免得下一次抛掷用旧边界算碰撞
    void syncEnv()
  }
)

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
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
