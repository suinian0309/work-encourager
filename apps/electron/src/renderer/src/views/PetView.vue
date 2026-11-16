<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { PetStats } from '@shared/types'

const stats = ref<PetStats>({ dateKey: '', today: 0, total: 0 })
const tapping = ref(false)
const happy = ref(false)
const sleeping = ref(false)
const bubble = ref('')
const floaters = ref<Array<{ id: number; left: number }>>([])

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

onMounted(async () => {
  try {
    const current = await window.workEncourager.getPet()
    stats.value = { dateKey: current.dateKey, today: current.today, total: current.total }
    if (current.today > 0) showBubble(`今天已经摸鱼 ${current.today} 次了`)
  } catch {
    // 读取失败时从 0 开始显示，不影响点击
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
      :class="{ 'is-tapped': tapping, 'is-happy': happy, 'is-sleeping': sleeping }"
      title="点一下，摸鱼 +1"
      @click="tap"
    >
      <div class="pet-bubble" :class="{ show: !!bubble }">{{ bubble }}</div>

      <svg class="pet-svg" viewBox="0 0 220 210" aria-label="摸鱼小宠物">
        <ellipse cx="110" cy="194" rx="60" ry="8" fill="rgba(46,86,68,0.10)" />

        <path
          class="tail"
          d="M164 152 C 190 152 202 128 192 106"
          fill="none"
          stroke="#9BE0C4"
          stroke-width="12"
          stroke-linecap="round"
        />

        <g class="pet-body-group">
          <path
            d="M64 62 L56 26 L92 48 Z"
            fill="#A9E3C9"
            stroke="#A9E3C9"
            stroke-width="6"
            stroke-linejoin="round"
          />
          <path d="M66 56 L61 33 L84 48 Z" fill="#F7C9D3" />
          <path
            d="M156 62 L164 26 L128 48 Z"
            fill="#A9E3C9"
            stroke="#A9E3C9"
            stroke-width="6"
            stroke-linejoin="round"
          />
          <path d="M154 56 L159 33 L136 48 Z" fill="#F7C9D3" />

          <path
            d="M110 40 C 150 40 174 70 174 110 C 174 152 147 176 110 176 C 73 176 46 152 46 110 C 46 70 70 40 110 40 Z"
            fill="#FBF6EC"
            stroke="#EDE1CE"
            stroke-width="2"
          />
          <ellipse cx="110" cy="158" rx="30" ry="15" fill="#F3FBF7" />

          <path
            d="M110 42 C 107 32 109 24 113 16"
            fill="none"
            stroke="#7FCBAA"
            stroke-width="3"
            stroke-linecap="round"
          />
          <path d="M112 24 C 100 18 94 24 96 30 C 103 33 110 30 112 24 Z" fill="#8FD8B8" />
          <path d="M113 20 C 124 12 131 18 129 25 C 122 29 115 26 113 20 Z" fill="#A9E3C9" />

          <g class="eye-open">
            <ellipse cx="88" cy="106" rx="6" ry="8.4" fill="#2E5A47" />
            <circle cx="90" cy="102.6" r="2.1" fill="#FFFFFF" />
            <ellipse cx="132" cy="106" rx="6" ry="8.4" fill="#2E5A47" />
            <circle cx="134" cy="102.6" r="2.1" fill="#FFFFFF" />
          </g>

          <g class="eye-happy">
            <path
              d="M80 107 Q88 98 96 107"
              fill="none"
              stroke="#2E5A47"
              stroke-width="3.2"
              stroke-linecap="round"
            />
            <path
              d="M124 107 Q132 98 140 107"
              fill="none"
              stroke="#2E5A47"
              stroke-width="3.2"
              stroke-linecap="round"
            />
          </g>

          <g class="eye-sleepy">
            <path
              d="M80 104 Q88 111 96 104"
              fill="none"
              stroke="#2E5A47"
              stroke-width="3"
              stroke-linecap="round"
            />
            <path
              d="M124 104 Q132 111 140 104"
              fill="none"
              stroke="#2E5A47"
              stroke-width="3"
              stroke-linecap="round"
            />
          </g>

          <ellipse cx="66" cy="124" rx="9.5" ry="5.2" fill="#F7BFCB" opacity="0.72" />
          <ellipse cx="154" cy="124" rx="9.5" ry="5.2" fill="#F7BFCB" opacity="0.72" />

          <path d="M106 117.4 L114 117.4 L110 121.2 Z" fill="#EFA8B8" />
          <path
            d="M102 124 Q106 129 110 124 Q114 129 118 124"
            fill="none"
            stroke="#2E5A47"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <g class="paw">
            <ellipse cx="84" cy="174" rx="16" ry="9.5" fill="#FBF6EC" stroke="#EDE1CE" stroke-width="1.6" />
            <ellipse cx="84" cy="174.5" rx="6" ry="4" fill="#F7C9D3" opacity="0.75" />
            <ellipse cx="136" cy="174" rx="16" ry="9.5" fill="#FBF6EC" stroke="#EDE1CE" stroke-width="1.6" />
            <ellipse cx="136" cy="174.5" rx="6" ry="4" fill="#F7C9D3" opacity="0.75" />
          </g>

          <g stroke="#E2D5BF" stroke-width="1.6" stroke-linecap="round">
            <path d="M58 108 L44 104" />
            <path d="M58 118 L44 122" />
            <path d="M162 108 L176 104" />
            <path d="M162 118 L176 122" />
          </g>
        </g>

        <g class="twinkle" fill="#F7D8A6">
          <path d="M32 64 l2.4 6.4 6.4 2.4 -6.4 2.4 -2.4 6.4 -2.4 -6.4 -6.4 -2.4 6.4 -2.4 z" />
        </g>
        <g class="twinkle twinkle--late" fill="#A9E3C9">
          <path d="M188 148 l2 5.2 5.2 2 -5.2 2 -2 5.2 -2 -5.2 -5.2 -2 5.2 -2 z" />
        </g>

        <g class="pet-zzz" fill="#7FB6A0">
          <text x="168" y="74" font-size="12" font-weight="700">z</text>
          <text x="178" y="62" font-size="9" font-weight="700">z</text>
          <text x="186" y="52" font-size="7" font-weight="700">z</text>
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
