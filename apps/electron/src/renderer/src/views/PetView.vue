<script setup lang="ts">
/**
 * 宠物窗：鲸鱼娘 + 摸鱼计数。
 *
 * 点她 = 摸鱼 +1（由 PetWhale 报上来的 poke 事件驱动），按住可以拎起来，
 * 甩出去会飞一段、落地晕一下再自己走回原位。
 * 脚下的「今日摸鱼 N 次」只在鼠标移到宠物上时淡入，平时透明，不挡壁纸。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { PetStats } from '@shared/types'
import PetWhale from '../components/PetWhale.vue'

const stats = ref<PetStats>({ dateKey: '', today: 0, total: 0 })
const bubble = ref('')
const error = ref('')
const floaters = ref<Array<{ id: number; left: number }>>([])
/** 显示比例：只有尺寸变了才重新排版，所以放在这里当 prop 传下去 */
const petScale = ref(0.8)

let bubbleTimer: number | undefined
let floaterSeed = 0
let offScale: (() => void) | null = null

const PHRASES = [
  '摸鱼 +1，老板没看见 👀',
  '再摸一会儿，就一会儿',
  '鱼摸得好，班也上得香',
  '这几分钟，是我赚的',
  '摸鱼是打工人的合法权益',
  '稳住，我们能摸到下班'
]
const LIFT_PHRASES = ['放我下来啦～', '喂喂，别拎我', '这样看你好高啊', '轻一点，会晕的']
const DROP_PHRASES = ['哎哟，屁股疼', '下次接住我嘛', '落地成功！']

function showBubble(text: string): void {
  bubble.value = text
  if (bubbleTimer) window.clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => {
    bubble.value = ''
  }, 1900)
}

function spawnFloater(): void {
  const id = ++floaterSeed
  floaters.value = [...floaters.value, { id, left: 76 + Math.round(Math.random() * 48) }]
  window.setTimeout(() => {
    floaters.value = floaters.value.filter((item) => item.id !== id)
  }, 950)
}

async function tap(): Promise<void> {
  spawnFloater()
  const optimistic = stats.value.today + 1
  stats.value = { ...stats.value, today: optimistic, total: stats.value.total + 1 }
  if (optimistic % 5 === 0) showBubble(PHRASES[Math.floor(optimistic / 5 - 1) % PHRASES.length])
  try {
    stats.value = await window.workEncourager.tapPet()
  } catch {
    // 写入失败时保留乐观数值，不打断点击
  }
}

function onLift(): void {
  showBubble(LIFT_PHRASES[Math.floor(Math.random() * LIFT_PHRASES.length)])
}

function onDrop(): void {
  showBubble(DROP_PHRASES[Math.floor(Math.random() * DROP_PHRASES.length)])
}

function close(): void {
  void window.workEncourager.hidePet()
}

onMounted(async () => {
  try {
    const current = await window.workEncourager.getPet()
    stats.value = { dateKey: current.dateKey, today: current.today, total: current.total }
  } catch {
    // 读取失败就从 0 开始，不影响点击
  }
  try {
    const env = await window.workEncourager.getPetEnv()
    if (Number.isFinite(env?.scale)) petScale.value = env.scale
  } catch {
    // 拿不到比例就按默认 0.8 渲染
  }
  offScale = window.workEncourager.onPetScaleChanged?.((next) => {
    if (Number.isFinite(next)) petScale.value = next
  })
})

onBeforeUnmount(() => {
  if (bubbleTimer) window.clearTimeout(bubbleTimer)
  offScale?.()
})
</script>

<template>
  <div class="pet-shell">
    <button class="pet-close" type="button" title="收起小宠物" @click.stop="close">×</button>

    <div class="pet-stage" title="点一下摸鱼 +1 · 拖住可以拎起来">
      <div class="pet-bubble" :class="{ show: !!bubble }">{{ bubble }}</div>

      <div class="pet-figure" :class="{ down: !!bubble }">
        <PetWhale
          :scale="petScale"
          @poke="tap"
          @grab="onLift"
          @drop="onDrop"
          @error="(message) => (error = message)"
        />
      </div>

      <span v-for="item in floaters" :key="item.id" class="floater" :style="{ left: `${item.left}px` }">+1</span>
      <p v-if="error" class="pet-error">{{ error }}</p>
    </div>

    <div class="pet-pill">
      <span>今日 <b class="num">{{ stats.today }}</b> 次</span>
      <span class="pet-pill-total">，累计 <b class="num">{{ stats.total }}</b> 次</span>
    </div>
  </div>
</template>

<style scoped>
.pet-shell {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 6px 6px;
  user-select: none;
}

.pet-close {
  position: absolute;
  top: 4px;
  right: 6px;
  z-index: 3;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.8);
  color: #7f978d;
  font-size: 14px;
  line-height: 1;
  display: grid;
  place-items: center;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.pet-shell:hover .pet-close {
  opacity: 1;
}

.pet-close:hover {
  background: #fff;
  color: #2e5a47;
}

.pet-stage {
  position: relative;
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  -webkit-app-region: no-drag;
}

.pet-figure {
  position: absolute;
  inset: 0;
  transition: transform 0.2s ease;
}

/* 说话时把角色整体下移一点，气泡就能待在头顶上方而不是盖在脸上 */
.pet-figure.down {
  transform: translateY(22px);
}

.pet-bubble {
  position: absolute;
  top: 0;
  left: 50%;
  z-index: 2;
  max-width: 152px;
  padding: 5px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 2px 8px rgba(46, 86, 68, 0.12);
  color: #2e5a47;
  font-size: 10px;
  line-height: 1.35;
  text-align: center;
  transform: translate(-50%, -4px) scale(0.94);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.pet-bubble.show {
  opacity: 1;
  transform: translate(-50%, 0) scale(1);
}

.floater {
  position: absolute;
  top: 34%;
  color: #2e5a47;
  font-size: 12px;
  font-weight: 700;
  pointer-events: none;
  animation: rise 0.95s ease-out forwards;
}

@keyframes rise {
  from {
    opacity: 0.85;
    transform: translateY(0) scale(0.9);
  }
  to {
    opacity: 0;
    transform: translateY(-42px) scale(1.15);
  }
}

/* 平时完全透明，鼠标落到宠物上才淡入；去掉胶囊底框，只用深灰字 + 淡白投影保证深色壁纸也看得清 */
.pet-pill {
  flex: none;
  margin-top: 2px;
  display: flex;
  align-items: baseline;
  gap: 3px;
  padding: 0;
  background: none;
  box-shadow: none;
  color: #4a4a4a;
  font-size: 9px;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.55);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}

.pet-shell:hover .pet-pill {
  opacity: 1;
}

.pet-pill .num {
  color: #3a3a3a;
  font-size: 12px;
}

.pet-pill-total {
  color: #5c5c5c;
}

.pet-error {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  margin: 0;
  color: #c0564f;
  font-size: 10px;
  text-align: center;
}
</style>
