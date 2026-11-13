import { contextBridge, ipcRenderer } from 'electron'
import type { WorkEncouragerApi } from '@shared/api'
import type { AppState, Settings } from '@shared/types'

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
