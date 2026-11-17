<script setup lang="ts">
/**
 * 鲸鱼娘：Coopanion 的分层骨络小人（见 assets/whale）。
 *
 * 身体由上层 `body.js` 驱动（走、跳、被拎起、被扔出去、做表情），本组件只负责给它一个舞台、
 * 每帧推进一次、把指针事件翻译成它的语言，并在被拎起时让窗口跟着鼠标走。
 *
 * 拖动时的分工很关键：窗口跟着指针走，画布里的角色必须**冻在抓起的位置**。两边都动的话，
 * 指针相对窗口的坐标会持续变化，角色会被一层层推向画布边缘，最后被窗口裁掉（看起来就像
 * 有个看不见的框）。
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
let dragging = false
let dragOrigin = { sx: 0, sy: 0, wx: 0, wy: 0 }
let env = { x: 0, y: 0 }
/** 抓起时指针在画布里的位置：拖动期间冻在这里，位移全部交给窗口 */
let anchor = { x: 0, y: 0 }
/** 最近一次指针在画布里的位置 */
let lastStage = { x: 0, y: 0 }
let samples: Array<{ t: number; x: number; y: number }> = []

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const S = 0.854
const FLOOR = 0.92

function stageBounds() {
  const el = stage.value
  const W = el?.clientWidth || 300
  const H = el?.clientHeight || 360
  return { W, H, floorY: Math.round(H * FLOOR), S }
}

function onPetEvent(kind: string, detail: any) {
  if (kind !== 'touch') return
  if (detail?.kind === 'poke') emit('poke')
  else if (detail?.kind === 'grab') {
    // 抓起的那一刻指针在哪，就把角色冻在哪
    anchor = { ...lastStage }
    dragging = true
    emit('grab')
  } else if (detail?.kind === 'drop' || detail?.kind === 'throw' || detail?.kind === 'crash') {
    dragging = false
    emit('drop')
  }
}

async function start() {
  await document.fonts?.ready?.catch?.(() => {})
  const el = stage.value
  if (!el || disposed) return
  try {
    const base = new URL('whale/', document.baseURI)
    const figure = await createWhaleFigure(base, {})
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
    if (dragging) followPointer()
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err))
    return
  }
  frame = requestAnimationFrame(tick)
}

let lastPointer = { x: 0, y: 0, screenX: 0, screenY: 0 }

function followPointer() {
  const { screenX, screenY } = lastPointer
  void window.workEncourager?.movePet?.(
    Math.round(dragOrigin.wx + screenX - dragOrigin.sx),
    Math.round(dragOrigin.wy + screenY - dragOrigin.sy)
  )
}

/** 记几个屏幕坐标采样，松手时用来判断是“放下”还是“扔出去” */
function track(e: PointerEvent) {
  const now = e.timeStamp || performance.now()
  samples.push({ t: now, x: e.screenX, y: e.screenY })
  while (samples.length > 2 && now - samples[0].t > 120) samples.shift()
}

function screenVelocity() {
  if (samples.length < 2) return { x: 0, y: 0 }
  const first = samples[0]
  const lastSample = samples[samples.length - 1]
  const dt = Math.max(16, lastSample.t - first.t)
  return {
    x: ((lastSample.x - first.x) * 1000) / dt,
    y: ((lastSample.y - first.y) * 1000) / dt
  }
}

function toStage(e: PointerEvent) {
  const rect = stage.value?.getBoundingClientRect()
  return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0), t: e.timeStamp }
}

function onDown(e: PointerEvent) {
  if (!body) return
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  anchor = toStage(e)
  lastStage = { ...anchor }
  dragOrigin = { sx: e.screenX, sy: e.screenY, wx: env.x, wy: env.y }
  lastPointer = { x: e.clientX, y: e.clientY, screenX: e.screenX, screenY: e.screenY }
  samples = []
  track(e)
  body.pointer('down', anchor)
}

function onMove(e: PointerEvent) {
  lastPointer = { x: e.clientX, y: e.clientY, screenX: e.screenX, screenY: e.screenY }
  track(e)
  if (!body) return
  const stage = toStage(e)
  lastStage = { ...stage }
  // 拖动期间喂固定坐标：角色留在画布里原来的位置，位移交给窗口
  body.pointer('move', dragging ? anchor : stage)
}

function onUp(e: PointerEvent) {
  if (!body) return
  if (dragging) {
    const v = screenVelocity()
    // 把窗口速度折算成一次虚拟位移，body 据此决定是轻轻放下还是抛出去
    body.pointer('move', {
      x: anchor.x + clamp(v.x * 0.04, -48, 48),
      y: anchor.y + clamp(v.y * 0.04, -48, 48),
      t: e.timeStamp - 8
    })
  }
  body.pointer('up', anchor)
  dragging = false
}

onMounted(() => {
  void start()
  void window.workEncourager?.getPetEnv?.().then((next: any) => {
    env = { x: next?.x ?? 0, y: next?.y ?? 0 }
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
