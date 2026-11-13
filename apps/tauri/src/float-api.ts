import { invoke } from '@tauri-apps/api/core'
import type { WorkEncouragerApi } from '@shared/api'
import { LocalService } from './service'
import { parseDb } from './db'

async function loadService(): Promise<LocalService> {
  const [json, path] = await Promise.all([
    invoke<string | null>('load_db'),
    invoke<string>('data_path')
  ])
  return new LocalService(parseDb(json, Date.now()), path)
}

const fail = (): Promise<never> => Promise.reject(new Error('此操作仅在主窗口可用'))

/**
 * 浮窗是独立 WebView，读取持久化数据并自行计算，
 * 避免与主窗口内存状态不同步。
 */
export function createFloatApi(): WorkEncouragerApi {
  return {
    bootstrap: fail,
    getState: async () => {
      const service = await loadService()
      return service.state(Date.now())
    },
    toggleTimer: fail,
    resetTimer: fail,
    saveSettings: fail,
    getHistory: fail,
    minimize: async () => true,
    close: async () => {
      await invoke('request_close')
      return true
    },
    openDataFolder: fail,
    quit: async () => true,
    showFloat: async () => true,
    hideFloat: async () => {
      await invoke('hide_float_window')
      return true
    },
    expandFloat: async () => {
      await invoke('expand_float_window')
      return true
    },
    onNavigate: () => () => undefined,
    onTimerChanged: () => () => undefined,
    onSettingsApplied: () => () => undefined,
    onHistoryUpdated: () => () => undefined
  }
}
