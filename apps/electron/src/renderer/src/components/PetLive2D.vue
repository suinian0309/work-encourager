<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Live2D 渲染层。
 * - 模型来自自定义协议 live2d://<id>/model3.json（主进程把用户模型整理成 ASCII 文件名）
 * - 交互：单击 = 摸鱼 +1（播动作 + 换表情）；按住拖动 = 把角色拎起来并带着窗口走；松手 = 抛下并受重力落地
 * - 所有位移都走主进程 setPosition，渲染层只负责物理与动画，避免两套坐标打架
 */
const props = defineProps<{ modelId: string; modelBase?: string }>()
const emit = defineEmits<{ (e: 'tap'): void; (e: 'lift'): void; (e: 'drop'): void }>()

const host = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const failed = ref('')
const loading = ref(true)

type AnyModel = {
  scale: { set: (v: number) => void }
  anchor: { set: (x: number, y: number) => void }
  position: { set: (x: number, y: number) => void }
  motion: (group: string, index?: number, priority?: number) => Promise<boolean>
  internalModel: {
    originalWidth: number
    originalHeight: number
    motionManager: { groups: Record<string, string>; expressionManager?: { setExpression: (def: unknown) => void; definitions: Array<{ Name: string; File: string }> } }
  }
  destroy: () => void
}

let appRef: { destroy: (removeView?: boolean, stageOptions?: unknown) => void; renderer: { width: number; height: number; resize: (width: number, height: number) => void }; stage: { addChild: (c: unknown) => void }; ticker: { add: (fn: () => void) => void } } | null = null
let model: AnyModel | null = null
let destroyed = false

const EXPRESSIONS = ['blush', 'heart', 'sly', 'tooth', 'dizzy']

// ---- 拖动与抛掷 ----
type Env = { x: number; y: number; width: number; height: number; workArea: { x: number; y: number; width: number; height: number } }
let env: Env | null = null
let dragging = false
let pointerId = -1
let downAt = { x: 0, y: 0, t: 0 }
let last = { x: 0, y: 0, t: 0 }
let velocity = { x: 0, y: 0 }
let winPos = { x: 0, y: 0 }
let raf = 0
let moved = 0

async function loadEnv(): Promise<Env | null> {
  try {
    env = await window.workEncourager.getPetEnv()
    winPos = { x: env.x, y: env.y }
    return env
  } catch {
    return null
  }
}

function stopPhysics(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

/** 松手后按速度做抛掷：重力 + 地面反弹 + 摩擦，落到工作区底部后停下 */
function throwPet(): void {
  if (!env) return
  const floor = env.workArea.y + env.workArea.height - env.height
  const left = env.workArea.x
  const right = env.workArea.x + env.workArea.width - env.width
  let vx = velocity.x
  let vy = velocity.y
  let x = winPos.x
  let y = winPos.y
  let last = performance.now()
  let settled = 0

  const step = (now: number) => {
    const dt = Math.min(48, now - last) / 16.67
    last = now
    vy += 0.9 * dt
    x += vx * dt
    y += vy * dt

    if (x < left) {
      x = left
      vx = -vx * 0.4
    }
    if (x > right) {
      x = right
      vx = -vx * 0.4
    }
    if (y > floor) {
      y = floor
      if (Math.abs(vy) > 2.2) {
        vy = -vy * 0.42
      } else {
        vy = 0
        vx *= 0.86
      }
    }
    winPos = { x, y }
    void window.workEncourager.movePet(x, y)

    const still = Math.abs(vx) < 0.35 && Math.abs(vy) < 0.35 && y >= floor - 0.5
    settled = still ? settled + dt : 0
    if (settled > 6 || y > floor + 4) {
      raf = 0
      return
    }
    raf = requestAnimationFrame(step)
  }
  stopPhysics()
  raf = requestAnimationFrame(step)
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  dragging = true
  moved = 0
  pointerId = event.pointerId
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  stopPhysics()
  const now = performance.now()
  downAt = { x: event.screenX, y: event.screenY, t: now }
  last = { x: event.screenX, y: event.screenY, t: now }
  velocity = { x: 0, y: 0 }
  void loadEnv()
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging || event.pointerId !== pointerId || !env) return
  const now = performance.now()
  const dx = event.screenX - last.x
  const dy = event.screenY - last.y
  const dt = Math.max(1, now - last.t)
  moved += Math.abs(dx) + Math.abs(dy)
  velocity = { x: (dx / dt) * 16, y: (dy / dt) * 16 }
  last = { x: event.screenX, y: event.screenY, t: now }
  winPos = { x: winPos.x + dx, y: winPos.y + dy }
  void window.workEncourager.movePet(winPos.x, winPos.y)
  if (moved > 6 && !host.value?.classList.contains('is-lifted')) {
    host.value?.classList.add('is-lifted')
    emit('lift')
  }
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging || event.pointerId !== pointerId) return
  dragging = false
  const wasMoved = moved > 6
  const idle = performance.now() - last.t > 90
  host.value?.classList.remove('is-lifted')
  if (event.currentTarget instanceof HTMLElement) {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 指针已经释放，忽略
    }
  }
  if (!wasMoved) {
    handleTap()
    return
  }
  if (idle) velocity = { x: 0, y: 0 }
  emit('drop')
  throwPet()
}

function handleTap(): void {
  emit('tap')
  if (!model) return
  void model.motion('TapBody', Math.floor(Math.random() * 7), 3)
  const manager = model.internalModel.motionManager.expressionManager
  if (manager) {
    const name = EXPRESSIONS[Math.floor(Math.random() * EXPRESSIONS.length)]
    const definition = manager.definitions.find((item) => item.Name === name)
    if (definition) manager.setExpression(definition)
  }
}

let scaleFactor = 2.2
let anchorY = 0
let posYRatio = -0.12

/** 构图：把模型放大到只露出头肩，太小看不出表情，太大又会顶到气泡 */
function frame(): void {
  if (!model || !appRef) return
  const width = appRef.renderer.width
  const height = appRef.renderer.height
  const fit = Math.min(width / model.internalModel.originalWidth, height / model.internalModel.originalHeight)
  model.scale.set(fit * scaleFactor)
  model.anchor.set(0.5, anchorY)
  model.position.set(width / 2, height * posYRatio)
}

/** Core 通过 <script> 注入：打包成模块后 var 不会挂到 window，插件就找不到运行时 */
function loadCore(): Promise<void> {
  const scope = window as unknown as { Live2DCubismCore?: unknown }
  if (scope.Live2DCubismCore) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = './live2dcubismcore.js'
    script.async = false
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('无法加载 live2dcubismcore.js'))
    document.head.appendChild(script)
  })
}

let observer: ResizeObserver | null = null

async function boot(): Promise<void> {
  const element = canvas.value
  if (!element) return
  try {
    // Core 是经典脚本，必须在全局作用域执行（被打包成模块时 var 不会挂到 window）
    await loadCore()
    const PIXI = await import('pixi.js')
    // Pixi 6 生成着色器时默认走 eval，页面 CSP 不允许；这个垫片改成函数式拼装
    const { install } = await import('@pixi/unsafe-eval')
    ;(install as (module: unknown) => void)(PIXI)
    const { Live2DModel } = await import('pixi-live2d-display/cubism4')

    const app = new PIXI.Application({
      view: element,
      width: host.value?.clientWidth ?? 300,
      height: host.value?.clientHeight ?? 300,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1)
    })
    appRef = app as unknown as typeof appRef

    // 首次布局可能还没稳定，跟随容器尺寸实时重排
    if (host.value && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (!appRef || !host.value) return
        const width = host.value.clientWidth
        const height = host.value.clientHeight
        if (width > 0 && height > 0) {
          appRef.renderer.resize(width, height)
          frame()
        }
      })
      observer.observe(host.value)
    }

    const base = props.modelBase ?? `live2d://${props.modelId}/`
    const instance = (await Live2DModel.from(`${base}model3.json`, {
      autoInteract: false,
      autoUpdate: true
    })) as unknown as AnyModel
    if (destroyed) {
      instance.destroy()
      return
    }
    model = instance
    app.stage.addChild(instance as unknown as never)
    instance.internalModel.motionManager.groups.idle = 'Idle'
    frame()
    loading.value = false
    void instance.motion('Idle', 0, 1)
    window.addEventListener('resize', frame)
    // 探针用调试句柄，便于从 CDP 读模型包围盒、调构图参数
    ;(window as unknown as { __live2d?: unknown }).__live2d = {
      app,
      model: instance,
      tune: (scale: number, y: number, posY?: number) => {
        scaleFactor = scale
        anchorY = y
        if (typeof posY === 'number') posYRatio = posY
        frame()
      }
    }
  } catch (error) {
    failed.value = error instanceof Error ? error.message : String(error)
    loading.value = false
  }
}

onMounted(() => {
  void boot()
})

onBeforeUnmount(() => {
  destroyed = true
  stopPhysics()
  observer?.disconnect()
  observer = null
  window.removeEventListener('resize', frame)
  try {
    appRef?.destroy(true, { children: true })
  } catch {
    // 销毁失败不影响窗口关闭
  }
  appRef = null
  model = null
})
</script>

<template>
  <div
    ref="host"
    class="live2d-host"
    :class="{ 'is-loading': loading, 'is-failed': !!failed }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <canvas ref="canvas" class="live2d-canvas"></canvas>
    <div v-if="failed" class="live2d-error">
      <b>模型加载失败</b>
      <span>{{ failed }}</span>
    </div>
  </div>
</template>

<style scoped>
.live2d-host {
  position: relative;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
  -webkit-app-region: no-drag;
  transition: transform 0.18s ease;
}

.live2d-host:active {
  cursor: grabbing;
}

/* 被拎起来：整体上提 + 轻微倾斜，配合物理位移制造“悬空”感 */
.live2d-host.is-lifted {
  transform: translateY(-10px) rotate(-2.5deg) scale(1.02);
}

.live2d-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.live2d-error {
  position: absolute;
  inset: 20% 12px auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid rgba(214, 122, 122, 0.5);
  color: #8a4a4a;
  font-size: 11px;
  line-height: 1.4;
}
</style>
