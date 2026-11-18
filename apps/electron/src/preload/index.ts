import { contextBridge, ipcRenderer } from 'electron'
import type { WorkEncouragerApi } from '@shared/api'
import type { AppState, PetStats, Settings } from '@shared/types'

const api: WorkEncouragerApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  getState: () => ipcRenderer.invoke('app:state'),
  toggleTimer: () => ipcRenderer.invoke('timer:toggle'),
  resetTimer: () => ipcRenderer.invoke('timer:reset'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  getHistory: () => ipcRenderer.invoke('history:get'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  quit: () => ipcRenderer.invoke('app:quit'),
  showFloat: () => ipcRenderer.invoke('float:show'),
  hideFloat: () => ipcRenderer.invoke('float:hide'),
  expandFloat: () => ipcRenderer.invoke('float:expand'),
  getPet: () => ipcRenderer.invoke('pet:get'),
  tapPet: () => ipcRenderer.invoke('pet:tap'),
  showPet: () => ipcRenderer.invoke('pet:show'),
  hidePet: () => ipcRenderer.invoke('pet:hide'),
  togglePet: () => ipcRenderer.invoke('pet:toggle'),
  getPetStyle: () => ipcRenderer.invoke('pet:style'),
  setPetStyle: (style) => ipcRenderer.invoke('pet:style:set', style),
  importLive2d: () => ipcRenderer.invoke('live2d:import'),
  removeLive2d: () => ipcRenderer.invoke('live2d:remove'),
  openLive2dFolder: () => ipcRenderer.invoke('live2d:open-folder'),
  getPetEnv: () => ipcRenderer.invoke('pet:env'),
  movePet: async (x, y) => {
    const applied = await ipcRenderer.invoke('pet:move', x, y)
    // 主进程会把真正生效的位置回过来（被工作区夹住时和请求值不同），渲染层据此重新锚定
    return applied && typeof applied === 'object' ? applied : null
  },
  onPetTapped(callback) {
    const listener = (_event: unknown, stats: PetStats) => callback(stats)
    ipcRenderer.on('pet:tapped', listener)
    return () => ipcRenderer.removeListener('pet:tapped', listener)
  },
  onNavigate(callback) {
    const listener = (_event: unknown, target: 'settings' | 'history' | 'main') => callback(target)
    ipcRenderer.on('navigate', listener)
    return () => ipcRenderer.removeListener('navigate', listener)
  },
  onTimerChanged(callback) {
    const listener = (_event: unknown, state: AppState) => callback(state)
    ipcRenderer.on('timer:changed', listener)
    return () => ipcRenderer.removeListener('timer:changed', listener)
  },
  onSettingsApplied(callback) {
    const listener = (_event: unknown, settings: Settings) => callback(settings)
    ipcRenderer.on('settings:applied', listener)
    return () => ipcRenderer.removeListener('settings:applied', listener)
  },
  onHistoryUpdated(callback) {
    const listener = () => callback()
    ipcRenderer.on('history:updated', listener)
    return () => ipcRenderer.removeListener('history:updated', listener)
  }
}

contextBridge.exposeInMainWorld('workEncourager', api)
