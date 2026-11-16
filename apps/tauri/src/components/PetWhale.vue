<script setup lang="ts">
/**
 * 鲸鱼娘：Coopanion 的分层骨络小人（见 assets/whale）。
 *
 * 身体由上层 `body.js` 驱动（走、跳、被拎起、被扔出去、做表情），本组件只负责给它一个舞台、
 * 每帧推进一次、把指针事件翻译成它的语言，并在被拎起时让窗口跟着鼠标走。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { createBody } from '../whale/body.js';
import { createWhaleFigure } from '../whale/figure.js';

const props = defineProps<{ paused?: boolean }>();
const emit = defineEmits<{
  (e: 'ready'): void;
  (e: 'poke'): void;
  (e: 'grab'): void;
  (e: 'drop'): void;
  (e: 'error', message: string): void;
}>();

const stage = ref<HTMLDivElement | null>(null);
let body: any = null;
let frame = 0;
let last = 0;
let disposed = false;
let dragging = false;
let dragOrigin = { sx: 0, sy: 0, wx: 0, wy: 0 };
let env = { x: 0, y: 0 };

const S = 1.22;
const FLOOR = 0.92;

function stageBounds() {
  const el = stage.value;
  const W = el?.clientWidth || 300;
  const H = el?.clientHeight || 360;
  return { W, H, floorY: Math.round(H * FLOOR), S };
}

function onPetEvent(kind: string, detail: any) {
  if (kind !== 'touch') return;
  if (detail?.kind === 'poke') emit('poke');
  else if (detail?.kind === 'grab') {
    dragging = true;
    emit('grab');
  } else if (detail?.kind === 'drop' || detail?.kind === 'throw' || detail?.kind === 'crash') {
    dragging = false;
    emit('drop');
  }
}

async function start() {
  await document.fonts?.ready?.catch?.(() => {});
  const el = stage.value;
  if (!el || disposed) return;
  try {
    const base = new URL('whale/', document.baseURI);
    const figure = await createWhaleFigure(base, {});
    if (disposed) {
      figure.dispose?.();
      return;
    }
    const host = {
      root: el,
      bounds: stageBounds,
      emit: onPetEvent,
      sound: () => {},
      start: { enter: 'drop' },
    };
    body = await createBody(host, { figure });
    emit('ready');
    last = performance.now();
    frame = requestAnimationFrame(tick);
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  }
}

function tick(now: number) {
  if (disposed || !body) return;
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  try {
    body.step(dt, !props.paused);
    if (dragging) followPointer();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
    return;
  }
  frame = requestAnimationFrame(tick);
}

function followPointer() {
  const { screenX, screenY } = lastPointer;
  void window.workEncourager?.movePet?.(
    Math.round(dragOrigin.wx + screenX - dragOrigin.sx),
    Math.round(dragOrigin.wy + screenY - dragOrigin.sy),
  );
}

let lastPointer = { x: 0, y: 0, screenX: 0, screenY: 0 };

function toStage(e: PointerEvent) {
  const rect = stage.value?.getBoundingClientRect();
  return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0), t: e.timeStamp };
}

function onDown(e: PointerEvent) {
  if (!body) return;
  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  dragOrigin = { sx: e.screenX, sy: e.screenY, wx: env.x, wy: env.y };
  lastPointer = { x: e.clientX, y: e.clientY, screenX: e.screenX, screenY: e.screenY };
  body.pointer('down', toStage(e));
}

function onMove(e: PointerEvent) {
  lastPointer = { x: e.clientX, y: e.clientY, screenX: e.screenX, screenY: e.screenY };
  body?.pointer('move', toStage(e));
}

function onUp(e: PointerEvent) {
  body?.pointer('up', toStage(e));
  dragging = false;
}

onMounted(() => {
  void start();
  void window.workEncourager?.getPetEnv?.().then((next: any) => {
    env = { x: next?.x ?? 0, y: next?.y ?? 0 };
  });
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(frame);
  body?.dispose?.();
  body = null;
});

defineExpose({
  tap() {
    body?.pointer('down', { x: 150, y: 200 });
    body?.pointer('up', { x: 150, y: 200 });
  },
});
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
