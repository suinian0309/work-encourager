import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppState, BootstrapPayload, HistoryView, SaveSettingsPayload, SaveSettingsResult, Settings } from '@shared/types'
import type { WorkEncouragerApi } from '@shared/api'
import { LocalService } from './service'
import { parseDb } from './db'
import { latestSettingsEntry } from '@shared/engine'

function unsubscribe(promise: Promise<() => void>): () => void {
  return () => {
    void promise.then((fn) => fn()).catch(() => undefined)
  }
}

export class TauriApi implements WorkEncouragerApi {
  private readonly service: LocalService
  private readonly timerListeners = new Set<(state: AppState) => void>()
  private readonly settingsListeners = new Set<(settings: Settings) => void>()
  private readonly historyListeners = new Set<() => void>()
  private lastSettleAt = 0

  constructor(service: LocalService) {
    this.service = service

    void listen('tray-toggle-timer', async () => {
      try {
        const state = await this.service.toggleTimer(Date.now())
        await this.syncTray()
        this.timerListeners.forEach((callback) => callback(state))
      } catch (error) {
        console.error('tray toggle failed', error)
      }
    })
  }

  async syncTray(): Promise<void> {
    const state = this.service.state(Date.now())
    const tooltip = state.privacyMode
      ? '上班鼓励器 · 计时进行中'
      : `上班鼓励器 · 今日已赚 ¥${state.earnTodayText}`
    await invoke('update_tray', { timerOn: state.timerOn, tooltip })
  }

  async showFloat(): Promise<boolean> {
    await invoke('show_float_window')
    return true
  }

  async hideFloat(): Promise<boolean> {
    await invoke('hide_float_window')
    return true
  }

  async expandFloat(): Promise<boolean> {
    await invoke('expand_float_window')
    return true
  }

  private async maybeSettle(now: number): Promise<void> {
    if (now - this.lastSettleAt < 30_000) return
    this.lastSettleAt = now
    const created = await this.service.settle(now)
    if (created.length > 0) this.historyListeners.forEach((callback) => callback())
  }

  async bootstrap(): Promise<BootstrapPayload> {
    await this.service.settle(Date.now())
    return this.service.bootstrap(Date.now())
  }

  async getState(): Promise<AppState> {
    const now = Date.now()
    await this.maybeSettle(now)
    return this.service.state(now)
  }

  async toggleTimer(): Promise<{ ok: boolean; state: AppState }> {
    const state = await this.service.toggleTimer(Date.now())
    await this.syncTray()
    return { ok: true, state }
  }

  async resetTimer(): Promise<{ ok: boolean; message?: string; state: AppState }> {
    const result = await this.service.resetCurrentShift(Date.now())
    await this.syncTray()
    return result
  }

  async saveSettings(payload: SaveSettingsPayload): Promise<SaveSettingsResult> {
    const result = await this.service.saveSettings(payload, Date.now())
    if (result.ok) {
      await invoke('set_always_on_top', { value: payload.settings.alwaysOnTop })
      await this.syncTray()
      this.settingsListeners.forEach((callback) => callback(payload.settings))
    }
    return result
  }

  async getHistory(): Promise<HistoryView> {
    return this.service.history(Date.now())
  }

  async minimize(): Promise<boolean> {
    await invoke('minimize_or_hide')
    return true
  }

  async close(): Promise<boolean> {
    await invoke('request_close')
    return true
  }

  async openDataFolder(): Promise<string> {
    return invoke<string>('open_data_folder')
  }

  async quit(): Promise<boolean> {
    await invoke('quit_app')
    return true
  }

  onNavigate(callback: (target: 'settings' | 'history' | 'main') => void): () => void {
    return unsubscribe(
      listen<string>('navigate', (event) => {
        callback(event.payload as 'settings' | 'history' | 'main')
      })
    )
  }

  onTimerChanged(callback: (state: AppState) => void): () => void {
    this.timerListeners.add(callback)
    return () => this.timerListeners.delete(callback)
  }

  onSettingsApplied(callback: (settings: Settings) => void): () => void {
    this.settingsListeners.add(callback)
    return () => this.settingsListeners.delete(callback)
  }

  onHistoryUpdated(callback: () => void): () => void {
    this.historyListeners.add(callback)
    return () => this.historyListeners.delete(callback)
  }
}

export async function createTauriApi(): Promise<TauriApi> {
  const now = Date.now()
  const existing = await invoke<string | null>('load_db')
  const dataPath = await invoke<string>('data_path')
  const db = parseDb(existing, now)
  if (!existing) await invoke('save_db', { json: JSON.stringify(db) })

  const service = new LocalService(db, dataPath)
  const api = new TauriApi(service)
  await service.settle(now)
  await invoke('set_always_on_top', {
    value: latestSettingsEntry(db.settingsTimeline).settings.alwaysOnTop
  })
  await api.syncTray()
  return api
}
