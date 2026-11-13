<script setup lang="ts">
import { computed } from 'vue'
import type { AppState } from '@shared/types'
import AppIcon from '../components/AppIcon.vue'

const props = defineProps<{ state: AppState | null }>()

const emit = defineEmits<{
  (e: 'settings'): void
  (e: 'history'): void
  (e: 'toggle'): void
  (e: 'reset'): void
  (e: 'minimize'): void
  (e: 'close'): void
  (e: 'float'): void
}>()

const isNumericCountdown = computed(() => /^\d{2}:\d{2}:\d{2}$/.test(props.state?.countdownText ?? ''))
const progressWidth = computed(() => `${Math.max(0, Math.min(100, props.state?.progressPercent ?? 0))}%`)
const amountClass = computed(() => {
  const length = props.state?.earnTodayText.length ?? 0
  if (length >= 14) return 'amount--tiny'
  if (length >= 11) return 'amount--long'
  return ''
})
const footerText = computed(() => {
  if (!props.state) return ''
  const scope = props.state.privacyMode
    ? '隐私模式已开启'
    : `本月已计 ${props.state.monthWorkDays} 个工作日`
  return `${scope} · 数据只保存在本机`
})
</script>

<template>
  <div class="screen main-screen">
    <header class="titlebar">
      <div class="brand">
        <span class="brand-mark">¥</span>
        <span class="brand-name">上班鼓励器</span>
      </div>
      <div class="title-actions">
        <button class="icon-btn" type="button" title="桌面浮窗" @click="emit('float')">
          <AppIcon name="float" />
        </button>
        <button class="icon-btn" type="button" title="设置" @click="emit('settings')">
          <AppIcon name="settings" />
        </button>
        <button class="icon-btn" type="button" title="最小化" @click="emit('minimize')">
          <AppIcon name="minimize" />
        </button>
        <button class="icon-btn icon-btn--danger" type="button" title="关闭" @click="emit('close')">
          <AppIcon name="close" />
        </button>
      </div>
    </header>
    <p class="subtitle">把上班的每一秒，都换成看得见的收获</p>

    <div v-if="!state" class="loading">
      <div>
        <div class="spinner"></div>
        正在读取今天的工作进度…
      </div>
    </div>

    <template v-else>
      <section class="clock-block fade-in">
        <div class="clock-date">{{ state.dateText }} · {{ state.weekdayText }}</div>
        <div class="clock-time num">{{ state.timeText }}</div>
      </section>

      <section class="card status-card fade-in">
        <div class="status-row">
          <span class="pill" :class="`pill--${state.status}`">
            <span class="status-dot" :class="`status-dot--${state.status}`"></span>
            {{ state.statusLabel }}
          </span>
          <span v-if="state.shiftNotice" class="shift-note">{{ state.shiftNotice }}</span>
          <span v-else-if="!state.timerOn" class="shift-note">收入已暂停</span>
        </div>
        <div class="countdown">
          <div class="countdown-title">{{ state.countdownTitle }}</div>
          <div
            class="countdown-value"
            :class="isNumericCountdown ? 'num' : 'countdown-value--text'"
          >
            {{ state.countdownText }}
          </div>
          <div class="countdown-hint">{{ state.countdownHint }}</div>
        </div>
      </section>

      <section class="card earn-card fade-in">
        <div class="earn-head">
          <span class="earn-label">今日已赚</span>
          <span v-if="state.privacyMode" class="privacy-badge">隐私模式</span>
        </div>
        <div class="earn-value">
          <span class="currency">¥</span>
          <span class="num amount" :class="amountClass">{{ state.earnTodayText }}</span>
        </div>
        <div class="rate-line">
          当前赚钱速度
          <strong class="num">{{ state.rateText }}</strong>
          元/秒
          <span v-if="state.overtimeSeconds > 0 && !state.privacyMode" class="ot-chip">
            加班 +¥{{ state.overtimeIncomeText }}
          </span>
        </div>
        <div v-if="state.overtimeSeconds > 0" class="ot-line">
          <template v-if="!state.privacyMode">{{ state.overtimeHint }} · </template>
          已加班 {{ (state.overtimeSeconds / 3600).toFixed(2) }} 小时
        </div>
        <span class="coin-deco coin-deco--one"></span>
        <span class="coin-deco coin-deco--two"></span>
      </section>

      <section class="encourage fade-in">
        <div class="gift-box">
          <AppIcon name="gift" :size="18" />
        </div>
        <p class="encourage-text">{{ state.encouragement }}</p>
      </section>

      <div class="actions fade-in">
        <button class="btn btn-primary" type="button" @click="emit('toggle')">
          {{ state.timerOn ? '关闭计时器' : '开启计时器' }}
        </button>
        <button class="btn btn-ghost" type="button" @click="emit('reset')">重置计时</button>
      </div>

      <section class="card progress-card fade-in">
        <div class="progress-head">
          <div class="progress-copy">
            <div class="progress-title">今日工时进度</div>
            <div class="progress-sub">
              已工作 <b class="num">{{ state.workedHoursText }}</b> / 总工作
              <b class="num">{{ state.plannedHoursText }}</b> 小时
            </div>
          </div>
          <div class="progress-pct num">{{ state.progressText }}%</div>
        </div>
        <div class="progress-track" role="progressbar" :aria-valuenow="state.progressPercent" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-fill" :style="{ width: progressWidth }"></div>
        </div>
      </section>

      <section class="card month-card fade-in">
        <div class="month-main">
          <div class="month-label">本月累计 <span>{{ state.monthLabel }}</span></div>
          <div class="month-value num">¥{{ state.monthTotalText }}</div>
          <div class="month-note">{{ state.monthNotice }}</div>
        </div>
        <button class="month-link" type="button" @click="emit('history')">
          <AppIcon name="history" :size="14" />
          历史
        </button>
      </section>

      <footer class="main-foot">
        <span v-if="state.pendingSettingsDate">新设置将于 {{ state.pendingSettingsDate }} 生效</span>
        <span v-else>{{ footerText }}</span>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.main-screen {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.clock-block {
  padding: 6px 4px 0;
}

.clock-date {
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0.2px;
}

.clock-time {
  font-size: 30px;
  line-height: 1.15;
  color: var(--ink);
  font-weight: 600;
  letter-spacing: 1px;
  margin-top: 2px;
}

.status-card {
  padding: 13px 15px 14px;
  background:
    radial-gradient(120% 90% at 100% 0%, rgba(52, 179, 136, 0.16), transparent 60%),
    var(--card);
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pill--paused {
  background: rgba(140, 150, 143, 0.14);
  color: var(--muted);
}

.pill--rest-day,
.pill--after-work {
  background: rgba(140, 150, 143, 0.12);
  color: var(--text);
}

.pill--on-break {
  background: rgba(224, 163, 62, 0.14);
  color: #9a6a17;
}

.pill--overtime {
  background: rgba(224, 122, 95, 0.14);
  color: #b4543a;
}

[data-theme='dark'] .pill--overtime {
  color: #f0a58a;
}

[data-theme='dark'] .pill--on-break {
  color: #e8bb6a;
}

.pill--before-work {
  background: rgba(120, 140, 180, 0.14);
  color: #5a6f92;
}

.status-dot--working {
  background: var(--mint);
  box-shadow: 0 0 0 3px rgba(52, 179, 136, 0.16);
}

.status-dot--on-break {
  background: #e0a33e;
  box-shadow: 0 0 0 3px rgba(224, 163, 62, 0.16);
}

.status-dot--overtime {
  background: #e07a5f;
  box-shadow: 0 0 0 3px rgba(224, 122, 95, 0.16);
}

.status-dot--paused,
.status-dot--rest-day,
.status-dot--after-work,
.status-dot--before-work {
  background: #a2aba5;
  box-shadow: 0 0 0 3px rgba(162, 171, 165, 0.16);
}

.shift-note {
  font-size: 10.5px;
  color: var(--muted);
}

.countdown {
  margin-top: 8px;
}

.countdown-title {
  font-size: 12px;
  color: var(--text);
}

.countdown-value {
  font-size: 34px;
  line-height: 1.2;
  color: var(--green);
  font-weight: 700;
  letter-spacing: 0.5px;
  margin-top: 1px;
}

.countdown-value--text {
  font-size: 24px;
  letter-spacing: 2px;
}

.countdown-hint {
  font-size: 10.5px;
  color: var(--muted);
  margin-top: 1px;
}

.earn-card {
  position: relative;
  overflow: hidden;
  padding: 14px 16px 13px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.9), rgba(230, 246, 238, 0.66)),
    var(--card);
}

[data-theme='dark'] .earn-card {
  background:
    linear-gradient(135deg, rgba(52, 179, 136, 0.14), rgba(27, 37, 32, 0.7)),
    var(--card);
}

.earn-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.earn-label {
  font-size: 12px;
  color: var(--text);
  letter-spacing: 0.3px;
}

.privacy-badge {
  font-size: 10px;
  color: var(--mint-deep);
  background: rgba(52, 179, 136, 0.12);
  border-radius: 999px;
  padding: 2px 8px;
}

.earn-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-top: 3px;
  color: var(--green);
}

.currency {
  font-size: 19px;
  font-weight: 600;
  opacity: 0.8;
}

.amount {
  font-size: 42px;
  line-height: 1.08;
  font-weight: 700;
  letter-spacing: 0.4px;
  transition: font-size 0.2s ease;
}

.amount--long {
  font-size: 32px;
}

.amount--tiny {
  font-size: 25px;
}

.rate-line {
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
}

.rate-line strong {
  color: var(--mint-deep);
  font-weight: 600;
  font-size: 12px;
  margin: 0 1px;
}

.ot-chip {
  display: inline-block;
  margin-left: 6px;
  font-size: 10px;
  color: #b4543a;
  background: rgba(224, 122, 95, 0.12);
  border-radius: 999px;
  padding: 1px 7px;
}

.ot-line {
  margin-top: 3px;
  font-size: 10px;
  color: var(--muted);
}

.coin-deco {
  position: absolute;
  border-radius: 50%;
  border: 1.5px dashed rgba(52, 179, 136, 0.28);
  pointer-events: none;
}

.coin-deco--one {
  width: 74px;
  height: 74px;
  right: -22px;
  bottom: -26px;
}

.coin-deco--two {
  width: 42px;
  height: 42px;
  right: 18px;
  bottom: 10px;
  opacity: 0.6;
}

.encourage {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 18px;
  background: linear-gradient(120deg, rgba(255, 248, 240, 0.92), rgba(250, 235, 231, 0.75));
  border: 1px solid rgba(255, 255, 255, 0.8);
  box-shadow: var(--shadow-soft);
}

[data-theme='dark'] .encourage {
  background: linear-gradient(120deg, rgba(56, 43, 43, 0.7), rgba(27, 37, 32, 0.6));
  border-color: rgba(255, 255, 255, 0.05);
}

.gift-box {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 11px;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.85);
  color: var(--mint-deep);
  box-shadow: 0 4px 10px rgba(151, 106, 92, 0.1);
}

[data-theme='dark'] .gift-box {
  background: rgba(255, 255, 255, 0.08);
  color: var(--mint);
}

.encourage-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #6c5b52;
}

[data-theme='dark'] .encourage-text {
  color: var(--text);
}

.actions {
  display: flex;
  gap: 8px;
}

.actions .btn-primary {
  flex: 1.25;
}

.actions .btn-ghost {
  flex: 1;
}

.progress-card {
  padding: 13px 15px 14px;
}

.progress-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
}

.progress-title {
  font-size: 12px;
  color: var(--text);
}

.progress-sub {
  font-size: 10.5px;
  color: var(--muted);
  margin-top: 3px;
}

.progress-sub b {
  color: var(--green);
  font-weight: 600;
}

.progress-pct {
  font-size: 24px;
  color: var(--green);
  font-weight: 700;
  line-height: 1;
}

.progress-track {
  height: 9px;
  border-radius: 999px;
  background: var(--track);
  margin-top: 11px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #7fd9b6, #34b388 60%, #2a9a74);
  box-shadow: 0 0 12px rgba(52, 179, 136, 0.4);
  transition: width 0.28s linear;
  position: relative;
}

.progress-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
  transform: translateX(-100%);
  animation: shine 3.2s ease-in-out infinite;
}

@keyframes shine {
  60%,
  100% {
    transform: translateX(100%);
  }
}

.month-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 15px;
}

.month-label {
  font-size: 10.5px;
  color: var(--muted);
}

.month-label span {
  opacity: 0.8;
}

.month-value {
  font-size: 22px;
  color: var(--ink);
  font-weight: 700;
  line-height: 1.3;
}

.month-note {
  font-size: 10px;
  color: var(--muted);
}

.month-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text);
  border-radius: 10px;
  height: 28px;
  padding: 0 9px;
  font-size: 11px;
  flex: none;
}

.month-link:hover {
  color: var(--mint-deep);
  border-color: rgba(52, 179, 136, 0.3);
}

.main-foot {
  margin-top: auto;
  padding: 2px 4px 4px;
  text-align: center;
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 0.2px;
}

.loading {
  min-height: 320px;
}
</style>
