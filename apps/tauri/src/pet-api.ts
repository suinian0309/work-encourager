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
 * 宠物窗是独立 WebView：每次操作都重新读取持久化数据，
 * 避免用自己内存里的旧快照覆盖主窗口的计时与暂停记录。
 */
export function createPetApi(): WorkEncouragerApi {
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
      await invoke('hide_pet_window')
      return true
    },
    openDataFolder: fail,
    quit: async () => true,
    showFloat: async () => true,
    hideFloat: async () => true,
    expandFloat: async () => {
      await invoke('show_float_window')
      return true
    },
    getPet: async () => {
      const service = await loadService()
      return service.petStats(Date.now())
    },
    tapPet: async () => {
      const service = await loadService()
      return service.tapPet(Date.now())
    },
    showPet: async () => true,
    hidePet: async () => {
      await invoke('hide_pet_window')
      return true
    },
    togglePet: async () => {
      await invoke('hide_pet_window')
      return false
    },
    onNavigate: () => () => undefined,
    onTimerChanged: () => () => undefined,
    onSettingsApplied: () => () => undefined,
    onHistoryUpdated: () => () => undefined,
    onPetTapped: () => () => undefined,
    getPetStyle: async () => {
      const service = await loadService()
      return { style: service.petStyle, model: service.live2dModel }
    },
    setPetStyle: fail,
    importLive2d: async () => ({ canceled: true }),
    removeLive2d: fail,
    openLive2dFolder: fail,
    getPetEnv: async () => {
      const env = await invoke<{
        x: number
        y: number
        width: number
        height: number
        work_area: { x: number; y: number; width: number; height: number }
      }>('pet_env')
      return { x: env.x, y: env.y, width: env.width, height: env.height, workArea: env.work_area }
    },
    movePet: async (x: number, y: number) => {
      await invoke('move_pet_window', { x, y })
      return true
    }
  }
}
