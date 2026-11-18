<script setup lang="ts">
/**
 * 鲸鱼娘：Coopanion 的分层骨骼小人（见 assets/whale）。
 *
 * 身体由上层 `body.js` 驱动（走、跳、被拎起、被扔出去、做表情），本组件只负责给它一个舞台、
 * 每帧推进一次、把指针事件翻译成它的语言。
 *
 * 拖动的分工是这里最容易出错的地方：**只动窗口，不动画布里的角色**。
 * `body.js` 自己的 drag 模式会让角色在画布里追着指针走（它原本跑在一个大画布上），
 * 我们的窗口只有 210×266，角色随便一偏就出画布、被窗口裁掉，看起来像"有个透明框把鱼切了"，
 * 而且抓起来的一瞬间角色会从原位跳到指针下，像"点一下就飘走了"。
 * 所以：按下只告诉 body 位置（用于点击判定），移动时只搬窗口，绝不喂 move；松手时用一个
 * 未来时间戳的 up 把 press 清掉（超过 400ms 的按压不触发 poke）。
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

const S = 0.854
const FLOOR = 0.92
const DRAG_THRESHOLD = 4

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

async function syncEnv(): Promise<void> {
  try {
    const next = await window.workEncourager?.getPetEnv?.()
    if (next) base = { x: Number(next.x) || 0, y: Number(next.y) || 0 }
  } catch {
    /* 拿不到位置就按 0 算，下一次移动会再校准 */
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
  frame = requestAnimationFrame(tick)
}

function toStage(e: PointerEvent) {
  const rect = stage.value?.getBoundingClientRect()
  return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0), t: e.timeStamp }
}

function onDown(e: PointerEvent) {
  if (!body) return
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  const point = toStage(e)
  pressing = true
  dragging = false
  downStage = { x: point.x, y: point.y }
  downScreen = { x: e.screenX, y: e.screenY }
  void syncEnv()
  body.pointer('down', point)
}

function onMove(e: PointerEvent) {
  if (!body || !pressing) return
  const dx = e.screenX - downScreen.x
  const dy = e.screenY - downScreen.y
  if (!dragging) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    dragging = true
    emit('grab')
  }
  void window.workEncourager
    ?.movePet?.(Math.round(base.x + dx), Math.round(base.y + dy))
    ?.then?.((applied: { x: number; y: number } | null | undefined) => {
      // 窗口被夹在屏幕工作区内时会和请求位置不一致，重新锚一次，避免手指和窗口逐渐错位
      if (applied && Number.isFinite(applied.x) && Number.isFinite(applied.y)) {
        base = { x: applied.x, y: applied.y }
        downScreen = { x: e.screenX, y: e.screenY }
      }
    })
    ?.catch?.(() => {})
}

function onUp(e: PointerEvent) {
  if (!body) return
  if (dragging) {
    // 用一个"已经按了很久"的时间戳收尾：body 只清 press，不会把拖动当成点击去 +1
    body.pointer('up', { x: downStage.x, y: downStage.y, t: performance.now() + 1000 })
    emit('drop')
  } else {
    body.pointer('up', toStage(e))
  }
  pressing = false
  dragging = false
}

onMounted(() => {
  void start()
  void syncEnv()
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
