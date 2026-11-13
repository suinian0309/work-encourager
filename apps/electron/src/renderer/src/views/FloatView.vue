<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AppState } from '@shared/types'
import AppIcon from '../components/AppIcon.vue'

const state = ref<AppState | null>(null)
let timer: number | undefined

async function refresh(): Promise<void> {
  try {
    state.value = await window.workEncourager.getState()
  } catch {
    // 主进程暂时不可用时保留上一帧
  }
}

const money = computed(() => {
  if (!state.value) return '—'
  if (state.value.privacyMode) return '••••'
  return state.value.earnTodayValue.toFixed(2)
})

const progressWidth = computed(
  () => `${Math.max(0, Math.min(100, state.value?.progressPercent ?? 0))}%`
)

const rateLabel = computed(() => {
  if (!state.value) return ''
  if (state.value.privacyMode) return '•••• 元/秒'
  return state.value.overtimeActive
    ? `加班 ${state.value.overtimeRateText} 元/秒`
    : `当前 ${state.value.rateText} 元/秒`
})

async function expand(): Promise<void> {
  await window.workEncourager.expandFloat()
}

async function close(): Promise<void> {
  await window.workEncourager.hideFloat()
}

onMounted(() => {
  void refresh()
  timer = window.setInterval(refresh, 500)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="float-card" @dblclick="expand">
    <div class="float-head">
      <span class="float-status">
        <i class="status-dot" :class="state ? `status-dot--${state.status}` : ''"></i>
        {{ state?.statusLabel ?? '读取中' }}
      </span>
      <span class="float-time num">{{ state?.timeText ?? '--:--:--' }}</span>
      <span class="float-actions">
        <button type="button" title="打开主窗口" @click.stop="expand">
          <AppIcon name="expand" :size="12" />
        </button>
        <button type="button" title="关闭浮窗" @click.stop="close">
          <AppIcon name="close" :size="12" />
        </button>
      </span>
    </div>

    <div class="float-main">
      <div class="float-left">
        <div class="float-label">今日已赚</div>
        <div class="float-money">
          <span class="float-currency">¥</span>
          <span class="num">{{ money }}</span>
        </div>
      </div>
      <div class="float-right">
        <div class="float-count-title">{{ state?.countdownTitle ?? '' }}</div>
        <div class="float-count-value num">{{ state?.countdownText ?? '--:--:--' }}</div>
      </div>
    </div>

    <div class="float-foot">
      <span class="float-rate">{{ rateLabel }}</span>
      <span v-if="state && state.overtimeSeconds > 0 && !state.privacyMode" class="float-ot">
        加班 +¥{{ state.overtimeIncomeText }}
      </span>
      <span class="float-progress-text num">{{ state?.progressText ?? '0.0' }}%</span>
    </div>
    <div class="float-progress">
      <div class="float-progress-fill" :style="{ width: progressWidth }"></div>
    </div>
  </div>
</template>

<style scoped>
.float-card {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 20px;
  padding: 11px 13px 10px;
  color: #eef7f1;
  background:
    radial-gradient(120% 120% at 100% 0%, rgba(52, 179, 136, 0.32), transparent 58%),
    rgba(15, 27, 21, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.3);
  -webkit-app-region: drag;
  overflow: hidden;
  user-select: none;
}

.float-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: rgba(238, 247, 241, 0.72);
}

.float-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  color: #dff5e9;
}

.float-time {
  margin-left: auto;
  font-size: 9.5px;
  color: rgba(238, 247, 241, 0.5);
  letter-spacing: 0.4px;
}

.float-actions {
  display: flex;
  gap: 1px;
  -webkit-app-region: no-drag;
}

.float-actions button {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: rgba(238, 247, 241, 0.55);
  display: grid;
  place-items: center;
  padding: 0;
}

.float-actions button:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.float-main {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  margin-top: 3px;
}

.float-left {
  min-width: 0;
}

.float-label {
  font-size: 9.5px;
  color: rgba(238, 247, 241, 0.55);
  letter-spacing: 0.4px;
}

.float-money {
  display: flex;
  align-items: baseline;
  gap: 2px;
  color: #7fe3b9;
  line-height: 1.1;
}

.float-currency {
  font-size: 12px;
  opacity: 0.85;
}

.float-money .num {
  font-size: 27px;
  font-weight: 700;
}

.float-right {
  text-align: right;
  padding-bottom: 2px;
}

.float-count-title {
  font-size: 9px;
  color: rgba(238, 247, 241, 0.5);
  white-space: nowrap;
}

.float-count-value {
  font-size: 14px;
  font-weight: 600;
  color: #f2fbf6;
  letter-spacing: 0.4px;
  white-space: nowrap;
}

.float-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 9px;
  color: rgba(238, 247, 241, 0.6);
}

.float-rate {
  white-space: nowrap;
}

.float-ot {
  color: #ffb59f;
  white-space: nowrap;
}

.float-progress-text {
  margin-left: auto;
  color: rgba(238, 247, 241, 0.7);
}

.float-progress {
  position: absolute;
  left: 13px;
  right: 13px;
  bottom: 5px;
  height: 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}

.float-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #7fe3b9, #34b388);
  transition: width 0.3s linear;
}

.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #7fe3b9;
  box-shadow: 0 0 0 2px rgba(127, 227, 185, 0.18);
  flex: none;
}

.status-dot--on-break {
  background: #f0bd63;
}

.status-dot--overtime {
  background: #ff9a7c;
}

.status-dot--paused,
.status-dot--rest-day,
.status-dot--after-work,
.status-dot--before-work {
  background: #9faeA6;
}
</style>
