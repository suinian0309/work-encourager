import { createApp } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import App from './App.vue'
import './styles/base.css'
import type { WorkEncouragerApi } from '@shared/api'
import { createTauriApi } from './tauri-api'

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error ?? '')
}

function brokenApi(message: string): WorkEncouragerApi {
  const fail = (): Promise<never> => Promise.reject(new Error(message))
  return {
    bootstrap: fail,
    getState: fail,
    toggleTimer: fail,
    resetTimer: fail,
    saveSettings: fail,
    getHistory: fail,
    minimize: async () => {
      await invoke('minimize_or_hide')
      return true
    },
    close: async () => {
      await invoke('request_close')
      return true
    },
    openDataFolder: () => invoke<string>('open_data_folder'),
    quit: async () => {
      await invoke('quit_app')
      return true
    },
    showFloat: fail,
    hideFloat: fail,
    expandFloat: fail,
    onNavigate: () => () => undefined,
    onTimerChanged: () => () => undefined,
    onSettingsApplied: () => () => undefined,
    onHistoryUpdated: () => () => undefined
  }
}

async function start(): Promise<void> {
  let api: WorkEncouragerApi
  try {
    api = await createTauriApi()
  } catch (error) {
    const message = errorMessage(error) || '无法读取本地数据'
    api = brokenApi(message)
    void getCurrentWindow()
      .setTitle(`错误：${message}`.slice(0, 200))
      .catch(() => undefined)
  }
  window.workEncourager = api
  createApp(App).mount('#app')
}

void start()
