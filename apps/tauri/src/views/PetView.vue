<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PetStats } from '@shared/types'
import PetLive2D from '../components/PetLive2D.vue'

const stats = ref<PetStats>({ dateKey: '', today: 0, total: 0 })
const tapping = ref(false)
const happy = ref(false)
const sleeping = ref(false)
const bubble = ref('')
const floaters = ref<Array<{ id: number; left: number }>>([])
const style = ref<'mochi' | 'live2d'>('mochi')
const modelId = ref('')

/** Tauri 的自定义协议在 Windows 上映射成 http://live2d.localhost/<id>/<file> */
const modelBase = computed(() => (modelId.value ? `http://live2d.localhost/${modelId.value}/` : ''))

let tapTimer: number | undefined
let happyTimer: number | undefined
let bubbleTimer: number | undefined
let idleTimer: number | undefined
let floaterSeed = 0
let lastTapAt = Date.now()

const PHRASES = [
  '摸鱼 +1，老板没看见 👀',
  '再摸一会儿，就一会儿',
  '鱼摸得好，班也上得香',
  '这几分钟，是我赚的',
  '摸鱼是打工人的合法权益',
  '稳住，我们能摸到下班'
]

function pulse(): void {
  tapping.value = false
  requestAnimationFrame(() => {
    tapping.value = true
    if (tapTimer) window.clearTimeout(tapTimer)
    tapTimer = window.setTimeout(() => {
      tapping.value = false
    }, 340)
  })
}

function spawnFloater(): void {
  const id = ++floaterSeed
  const left = 78 + Math.round(Math.random() * 64)
  floaters.value = [...floaters.value, { id, left }]
  window.setTimeout(() => {
    floaters.value = floaters.value.filter((item) => item.id !== id)
  }, 950)
}

function showBubble(text: string): void {
  bubble.value = text
  if (bubbleTimer) window.clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => {
    bubble.value = ''
  }, 1900)
}

async function tap(): Promise<void> {
  lastTapAt = Date.now()
  sleeping.value = false
  pulse()
  spawnFloater()

  happy.value = true
  if (happyTimer) window.clearTimeout(happyTimer)
  happyTimer = window.setTimeout(() => {
    happy.value = false
  }, 620)

  // 先本地 +1 保证手感，再用主进程返回的真实计数校准
  const optimistic = stats.value.today + 1
  stats.value = { ...stats.value, today: optimistic, total: stats.value.total + 1 }
  if (optimistic % 5 === 0) {
    showBubble(PHRASES[Math.floor(optimistic / 5 - 1) % PHRASES.length])
  }

  try {
    stats.value = await window.workEncourager.tapPet()
  } catch {
    // 主进程写入失败时保留乐观数值，不打断点击体验
  }
}

function close(): void {
  void window.workEncourager.hidePet()
}

const LIFT_PHRASES = ['放我下来啦～', '喂喂，别拎我', '这样看你好高啊', '轻一点，会晕的']
const DROP_PHRASES = ['哎哟，屁股疼', '下次接住我嘛', '落地成功！']

function onLift(): void {
  showBubble(LIFT_PHRASES[Math.floor(Math.random() * LIFT_PHRASES.length)])
}

function onDrop(): void {
  showBubble(DROP_PHRASES[Math.floor(Math.random() * DROP_PHRASES.length)])
}

onMounted(async () => {
  try {
    const current = await window.workEncourager.getPet()
    stats.value = { dateKey: current.dateKey, today: current.today, total: current.total }
    if (current.today > 0) showBubble(`今天已经摸鱼 ${current.today} 次了`)
  } catch {
    // 读取失败时从 0 开始显示，不影响点击
  }
  try {
    const petStyle = await window.workEncourager.getPetStyle()
    style.value = petStyle.style
    modelId.value = petStyle.model?.id ?? ''
    if (petStyle.style === 'live2d' && !petStyle.model) style.value = 'mochi'
  } catch {
    style.value = 'mochi'
  }
  idleTimer = window.setInterval(() => {
    if (Date.now() - lastTapAt > 5 * 60 * 1000) sleeping.value = true
  }, 20_000)
})

onBeforeUnmount(() => {
  if (tapTimer) window.clearTimeout(tapTimer)
  if (happyTimer) window.clearTimeout(happyTimer)
  if (bubbleTimer) window.clearTimeout(bubbleTimer)
  if (idleTimer) window.clearInterval(idleTimer)
})
</script>

<template>
  <div class="pet-shell">
    <button class="pet-close" type="button" title="收起小宠物" @click.stop="close">×</button>

    <div
      class="pet-stage"
      :class="{ 'is-tapped': tapping, 'is-happy': happy, 'is-sleeping': sleeping, 'is-live2d': style === 'live2d' }"
      :title="style === 'mochi' ? '点一下，摸鱼 +1' : '点一下摸鱼 +1 · 拖住可以拎起来'"
    >
      <div class="pet-bubble" :class="{ show: !!bubble }">{{ bubble }}</div>

      <PetLive2D
        v-if="style === 'live2d' && modelId"
        :model-id="modelId"
        :model-base="modelBase"
        @tap="tap"
        @lift="onLift"
        @drop="onDrop"
      />

      <svg v-else class="pet-svg" viewBox="0 0 220 210" aria-label="摸鱼小鱼" @click="tap">
        <ellipse cx="112" cy="186" rx="58" ry="8" fill="rgba(46,86,68,0.10)" />

        <g class="tail">
          <path
            d="M58 112 C 34 96 16 84 14 70 C 30 74 46 88 56 98 C 58 78 54 62 44 50 C 64 56 76 80 78 104 Z"
            fill="#A9E3C9"
            stroke="#8FD8B8"
            stroke-width="2"
            stroke-linejoin="round"
          />
          <path
            d="M58 116 C 34 132 16 144 14 158 C 30 154 46 140 56 130 C 58 150 54 166 44 178 C 64 172 76 148 78 124 Z"
            fill="#C6EDDC"
            stroke="#8FD8B8"
            stroke-width="2"
            stroke-linejoin="round"
          />
        </g>

        <g class="pet-body-group">
          <path
            d="M104 58 Q118 30 138 56 Q124 66 104 58 Z"
            fill="#A9E3C9"
            stroke="#8FD8B8"
            stroke-width="2"
            stroke-linejoin="round"
          />

          <path
            d="M112 62 C 158 62 186 84 186 112 C 186 142 158 162 112 162 C 74 162 52 142 52 112 C 52 84 74 62 112 62 Z"
            fill="#FBF6EC"
            stroke="#EDE1CE"
            stroke-width="2"
          />
          <path
            d="M112 132 C 140 132 162 142 168 152 C 156 160 136 162 112 162 C 88 162 68 160 56 152 C 62 142 84 132 112 132 Z"
            fill="#F1FAF5"
          />

          <path
            d="M150 62 C 148 50 150 40 156 32"
            fill="none"
            stroke="#7FCBAA"
            stroke-width="3"
            stroke-linecap="round"
          />
          <path d="M155 40 C 143 34 137 40 139 46 C 146 49 153 46 155 40 Z" fill="#8FD8B8" />
          <path d="M156 36 C 167 28 174 34 172 41 C 165 45 158 42 156 36 Z" fill="#A9E3C9" />

          <g stroke="#DCEFE6" stroke-width="2" fill="none" stroke-linecap="round">
            <path d="M92 88 Q104 96 92 104" />
            <path d="M78 104 Q90 112 78 120" />
            <path d="M94 120 Q106 128 94 136" />
          </g>

          <g class="paw">
            <path
              d="M126 118 C 138 112 152 116 154 126 C 146 134 132 132 126 118 Z"
              fill="#E8F7F0"
              stroke="#CBEADE"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
          </g>

          <g class="eye-open">
            <ellipse cx="140" cy="98" rx="8.4" ry="10.4" fill="#2E5A47" />
            <circle cx="143" cy="93.6" r="2.8" fill="#FFFFFF" />
            <ellipse cx="168" cy="98" rx="8.4" ry="10.4" fill="#2E5A47" />
            <circle cx="171" cy="93.6" r="2.8" fill="#FFFFFF" />
          </g>

          <g class="eye-happy">
            <path
              d="M131 99 Q140 88 149 99"
              fill="none"
              stroke="#2E5A47"
              stroke-width="3.4"
              stroke-linecap="round"
            />
            <path
              d="M159 99 Q168 88 177 99"
              fill="none"
              stroke="#2E5A47"
              stroke-width="3.4"
              stroke-linecap="round"
            />
          </g>

          <g class="eye-sleepy">
            <path
              d="M131 96 Q140 105 149 96"
              fill="none"
              stroke="#2E5A47"
              stroke-width="3"
              stroke-linecap="round"
            />
            <path
              d="M159 96 Q168 105 177 96"
              fill="none"
              stroke="#2E5A47"
              stroke-width="3"
              stroke-linecap="round"
            />
          </g>

          <ellipse cx="128" cy="120" rx="9" ry="5" fill="#F7BFCB" opacity="0.7" />
          <ellipse cx="180" cy="120" rx="9" ry="5" fill="#F7BFCB" opacity="0.7" />

          <path
            d="M146 124 Q154 132 162 124"
            fill="none"
            stroke="#2E5A47"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </g>

        <g class="twinkle" fill="#A9E3C9">
          <circle cx="196" cy="66" r="4.2" />
          <circle cx="204" cy="48" r="2.8" />
          <circle cx="190" cy="44" r="2" />
        </g>
        <g class="twinkle twinkle--late" fill="#F7D8A6">
          <path d="M36 40 l2.2 5.8 5.8 2.2 -5.8 2.2 -2.2 5.8 -2.2 -5.8 -5.8 -2.2 5.8 -2.2 z" />
        </g>

        <g class="pet-zzz" fill="#7FB6A0">
          <text x="186" y="90" font-size="12" font-weight="700">z</text>
          <text x="194" y="76" font-size="9" font-weight="700">z</text>
          <text x="200" y="64" font-size="7" font-weight="700">z</text>
        </g>
      </svg>

      <span
        v-for="item in floaters"
        :key="item.id"
        class="floater"
        :style="{ left: `${item.left}px` }"
        >+1</span
      >
    </div>

    <div class="pet-pill">
      <span>今日摸鱼</span>
      <b class="num">{{ stats.today }}</b>
      <span>次</span>
      <span class="pet-pill-total">累计 {{ stats.total }}</span>
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
  padding: 32px 10px 8px;
  -webkit-app-region: drag;
  user-select: none;
}

.pet-close {
  position: absolute;
  top: 6px;
  right: 8px;
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
  -webkit-app-region: no-drag;
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
  width: 216px;
  height: 204px;
  flex: none;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.pet-stage.is-live2d {
  width: 100%;
  height: 100%;
  flex: 1 1 auto;
  min-height: 0;
  cursor: default;
}

.pet-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
  filter: drop-shadow(0 8px 10px rgba(46, 86, 68, 0.1));
}

.pet-body-group {
  transform-box: view-box;
  transform-origin: 110px 176px;
  animation: breathe 3.6s ease-in-out infinite;
}

.is-tapped .pet-body-group {
  animation: squash 0.34s ease-out;
}

.tail {
  transform-box: view-box;
  transform-origin: 164px 152px;
  animation: sway 2.6s ease-in-out infinite;
}

.eye-open {
  transform-box: fill-box;
  transform-origin: center;
  animation: blink 4.8s infinite;
  transition: opacity 0.12s ease;
}

.eye-happy,
.eye-sleepy {
  opacity: 0;
  transition: opacity 0.12s ease;
}

.is-happy .eye-open {
  opacity: 0;
}

.is-happy .eye-happy {
  opacity: 1;
}

.is-sleeping .eye-open {
  opacity: 0;
}

.is-sleeping .eye-sleepy {
  opacity: 1;
}

.is-sleeping .pet-body-group {
  animation: breathe 5.6s ease-in-out infinite;
}

.pet-zzz {
  opacity: 0;
  transition: opacity 0.3s ease;
}

.is-sleeping .pet-zzz {
  opacity: 1;
  animation: zfloat 3.2s ease-in-out infinite;
}

.twinkle {
  transform-box: fill-box;
  transform-origin: center;
  animation: twinkle 2.8s ease-in-out infinite;
}

.twinkle--late {
  animation-delay: 1.4s;
}

.pet-bubble {
  position: absolute;
  left: 50%;
  top: -28px;
  z-index: 2;
  transform: translate(-50%, -4px);
  padding: 7px 12px;
  border-radius: 14px;
  background: #fff;
  color: #3d6b57;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
  box-shadow: 0 6px 18px rgba(46, 86, 68, 0.14);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.pet-bubble.show {
  opacity: 1;
  transform: translate(-50%, 0);
}

.pet-bubble::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -4px;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: #fff;
  transform: translateX(-50%) rotate(45deg);
}

.floater {
  position: absolute;
  top: 74px;
  font-size: 15px;
  font-weight: 800;
  color: #34b388;
  text-shadow: 0 1px 0 #fff;
  pointer-events: none;
  animation: float-up 0.9s ease-out forwards;
}

.pet-pill {
  margin-top: 4px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.88);
  border: 1px solid rgba(126, 196, 168, 0.34);
  box-shadow: 0 3px 10px rgba(46, 86, 68, 0.1);
  font-size: 11.5px;
  color: #4a7361;
  -webkit-app-region: no-drag;
}

.pet-pill b {
  font-size: 13.5px;
  color: #2c6b52;
}

.pet-pill-total {
  margin-left: 2px;
  font-size: 10.5px;
  color: #8aa79a;
}

@keyframes breathe {
  0%,
  100% {
    transform: scale(1, 1);
  }
  50% {
    transform: scale(1.015, 1.025);
  }
}

@keyframes squash {
  0% {
    transform: scale(1, 1);
  }
  35% {
    transform: scale(1.07, 0.9);
  }
  70% {
    transform: scale(0.97, 1.04);
  }
  100% {
    transform: scale(1, 1);
  }
}

@keyframes blink {
  0%,
  92%,
  100% {
    transform: scaleY(1);
  }
  95% {
    transform: scaleY(0.1);
  }
  97% {
    transform: scaleY(1);
  }
}

@keyframes sway {
  0%,
  100% {
    transform: rotate(0deg);
  }
  50% {
    transform: rotate(-9deg);
  }
}

@keyframes twinkle {
  0%,
  100% {
    opacity: 0.25;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1.05);
  }
}

@keyframes zfloat {
  0%,
  100% {
    opacity: 0.15;
    transform: translateY(0);
  }
  50% {
    opacity: 0.75;
    transform: translateY(-4px);
  }
}

@keyframes float-up {
  0% {
    opacity: 0;
    transform: translateY(0) scale(0.7);
  }
  20% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateY(-48px) scale(1.05);
  }
}
</style>
