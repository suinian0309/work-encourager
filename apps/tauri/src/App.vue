<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { AppState, BootstrapPayload, SaveSettingsResult, Settings, ThemeMode } from '@shared/types'
import MainView from './views/MainView.vue'
import SettingsView from './views/SettingsView.vue'
import HistoryView from './views/HistoryView.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import Toast from './components/Toast.vue'

const ready = ref(false)
const bootError = ref('')
const bootstrapped = ref<BootstrapPayload | null>(null)
const state = ref<AppState | null>(null)
const view = ref<'main' | 'settings' | 'history'>('main')
const settingsKey = ref(0)
const toastMessage = ref('')
const confirmReset = ref(false)

let pollTimer: number | undefined
let toastTimer: number | undefined
let mediaQuery: MediaQueryList | null = null
const disposeCallbacks: Array<() => void> = []

function showToast(message: string): void {
  toastMessage.value = message
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastMessage.value = ''
  }, 2600)
}

function applyTheme(mode: ThemeMode): void {
  const dark = mode === 'dark' || (mode === 'system' && !!mediaQuery?.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

async function refreshState(): Promise<void> {
  if (!ready.value || document.hidden) return
  try {
    state.value = await window.workEncourager.getState()
  } catch {
    // 主进程写入/读取失败时会弹原生错误框，这里保留上一帧数据，避免界面闪空
  }
}

async function loadBootstrap(): Promise<void> {
  try {
    const data = await window.workEncourager.bootstrap()
    bootstrapped.value = data
    state.value = data.state
    applyTheme(data.settings.theme)
    ready.value = true
    pollTimer = window.setInterval(refreshState, 250)
  } catch (error) {
    bootError.value = (error as Error).message || '无法读取本地数据'
  }
}

async function toggleTimer(): Promise<void> {
  try {
    const result = await window.workEncourager.toggleTimer()
    state.value = result.state
    showToast(result.state.timerOn ? '计时器已开启，继续累计' : '计时器已关闭，收入暂停累计')
  } catch (error) {
    showToast(`操作失败：${(error as Error).message}`)
  }
}

async function confirmResetTimer(): Promise<void> {
  confirmReset.value = false
  try {
    const result = await window.workEncourager.resetTimer()
    state.value = result.state
    showToast(result.ok ? '本班次已重置，从现在重新计时' : result.message ?? '无法重置')
  } catch (error) {
    showToast(`重置失败：${(error as Error).message}`)
  }
}

function openSettings(): void {
  settingsKey.value += 1
  view.value = 'settings'
}

function minimizeWindow(): void {
  void window.workEncourager.minimize()
}

function closeWindow(): void {
  void window.workEncourager.close()
}

function quitApp(): void {
  void window.workEncourager.quit()
}

function retryApp(): void {
  window.location.reload()
}

async function openDataDir(): Promise<void> {
  try {
    await window.workEncourager.openDataFolder()
  } catch (error) {
    showToast(`无法打开数据目录：${String(error)}`)
  }
}

async function openFloat(): Promise<void> {
  try {
    await window.workEncourager.showFloat()
  } catch (error) {
    showToast(`无法打开浮窗：${(error as Error).message}`)
  }
}

async function handleSaved(result: SaveSettingsResult): Promise<void> {
  view.value = 'main'
  try {
    const data = await window.workEncourager.bootstrap()
    bootstrapped.value = data
    state.value = data.state
    applyTheme(data.settings.theme)
    const today = new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    if (result.effectiveFrom && result.effectiveFrom > todayKey) {
      showToast(`设置已保存，${result.effectiveFrom} 起生效；今天的记录保持原值`)
    } else {
      showToast('设置已保存，并已应用到今天')
    }
  } catch {
    showToast('设置已保存')
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (confirmReset.value) {
    confirmReset.value = false
    return
  }
  if (view.value !== 'main') view.value = 'main'
}

onMounted(async () => {
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const onSchemeChange = (): void => {
    const mode = bootstrapped.value?.settings.theme ?? 'system'
    if (mode === 'system') applyTheme(mode)
  }
  mediaQuery.addEventListener('change', onSchemeChange)
  disposeCallbacks.push(() => mediaQuery?.removeEventListener('change', onSchemeChange))

  disposeCallbacks.push(
    window.workEncourager.onNavigate((target) => {
      if (target === 'settings') openSettings()
      else if (target === 'history') view.value = 'history'
      else view.value = 'main'
    })
  )
  disposeCallbacks.push(
    window.workEncourager.onTimerChanged((next) => {
      state.value = next
    })
  )
  disposeCallbacks.push(
    window.workEncourager.onSettingsApplied((settings: Settings) => {
      if (bootstrapped.value) bootstrapped.value.settings = settings
      applyTheme(settings.theme)
    })
  )

  window.addEventListener('keydown', handleKeydown)
  await loadBootstrap()
})

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer)
  if (toastTimer) window.clearTimeout(toastTimer)
  disposeCallbacks.forEach((dispose) => dispose())
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="app-shell">
    <div class="bg-blob bg-blob--mint"></div>
    <div class="bg-blob bg-blob--pink"></div>
    <div class="bg-blob bg-blob--mint-2"></div>

    <div v-if="bootError" class="screen error-screen">
      <div class="card error-card">
        <h2>无法读取本地数据</h2>
        <p>{{ bootError }}</p>
        <p class="hint">程序不会自动清空或覆盖你的数据，请备份后修复数据文件再启动。</p>
        <div class="error-actions">
          <button class="btn btn-ghost" type="button" @click="retryApp">重试</button>
          <button class="btn btn-ghost" type="button" @click="openDataDir">打开数据目录</button>
          <button class="btn btn-danger" type="button" @click="quitApp">退出程序</button>
        </div>
      </div>
    </div>

    <div v-else-if="!ready" class="loading">
      <div>
        <div class="spinner"></div>
        正在打开上班鼓励器…
      </div>
    </div>

    <template v-else>
      <MainView
        v-if="view === 'main'"
        :state="state"
        @settings="openSettings"
        @history="view = 'history'"
        @toggle="toggleTimer"
        @reset="confirmReset = true"
        @minimize="minimizeWindow"
        @close="closeWindow"
        @float="openFloat"
      />
      <SettingsView
        v-else-if="view === 'settings' && bootstrapped"
        :key="settingsKey"
        :initial="bootstrapped.settings"
        :pending-from="bootstrapped.pendingEffectiveFrom"
        :data-path="bootstrapped.dataPath"
        @close="view = 'main'"
        @saved="handleSaved"
        @toast="showToast"
      />
      <HistoryView
        v-else
        :data-path="bootstrapped?.dataPath ?? ''"
        @close="view = 'main'"
        @toast="showToast"
      />
    </template>

    <ConfirmDialog
      :open="confirmReset"
      title="重置本班次计时？"
      message="将清零本班次已赚金额和已累计工作时长，并从现在重新计时，历史日期记录不受影响。是否继续？"
      confirm-text="重置计时"
      danger
      @confirm="confirmResetTimer"
      @cancel="confirmReset = false"
    />

    <Toast :message="toastMessage" />
  </div>
</template>

<style scoped>
.error-screen {
  display: grid;
  place-items: center;
}

.error-card {
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.error-card h2 {
  margin: 0;
  font-size: 16px;
  color: var(--ink);
}

.error-card p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text);
}

.error-card .hint {
  color: var(--muted);
}

.error-card .btn {
  margin-top: 6px;
}

.error-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.error-actions .btn {
  flex: 1;
  min-width: 88px;
  margin-top: 6px;
}
</style>
