import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppState, BootstrapPayload, HistoryView, PetStats, PetStyle, SaveSettingsPayload, SaveSettingsResult, Settings } from '@shared/types'
import type { Live2dImportResult, PetStyleState, WorkEncouragerApi } from '@shared/api'
import type { UpdateDownloadResult, UpdateInfo, UpdateProgress } from '@shared/update'
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
  private readonly petListeners = new Set<(stats: PetStats) => void>()
  private readonly petScaleListeners = new Set<(scale: number) => void>()
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

  async getPet(): Promise<PetStats> {
    return this.service.petStats(Date.now())
  }

  async tapPet(): Promise<PetStats> {
    const stats = await this.service.tapPet(Date.now())
    this.petListeners.forEach((callback) => callback(stats))
    await this.syncTray()
    return stats
  }

  async showPet(): Promise<boolean> {
    await invoke('show_pet_window')
    return true
  }

  async hidePet(): Promise<boolean> {
    await invoke('hide_pet_window')
    return true
  }

  async togglePet(): Promise<boolean> {
    return invoke<boolean>('toggle_pet_window')
  }

  /** 宠物页收到 Rust 的 pet-scale 事件后调这里，转发给订阅者 */
  emitPetScale(scale: number): void {
    this.petScaleListeners.forEach((callback) => callback(scale))
  }

  onPetTapped(callback: (stats: PetStats) => void): () => void {
    this.petListeners.add(callback)
    return () => this.petListeners.delete(callback)
  }

  async getPetStyle(): Promise<PetStyleState> {
    return { style: this.service.petStyle, model: this.service.live2dModel ?? null }
  }

  async setPetStyle(style: PetStyle): Promise<PetStyleState> {
    await this.service.setPetStyle(style)
    await invoke('pet_apply_style', { style })
    return { style: this.service.petStyle, model: this.service.live2dModel ?? null }
  }

  /** Tauri 端用渲染层的文件夹选择器导入，这里保持接口形状一致 */
  async importLive2d(): Promise<Live2dImportResult> {
    return { canceled: true }
  }

  async removeLive2d(): Promise<PetStyleState> {
    const model = this.service.live2dModel
    if (model) {
      await invoke('live2d_remove', { id: model.id })
      await this.service.saveLive2dModel(null)
    }
    await this.service.setPetStyle('mochi')
    await invoke('pet_apply_style', { style: 'mochi' })
    return { style: this.service.petStyle, model: null }
  }

  async openLive2dFolder(): Promise<boolean> {
    await invoke('live2d_open_folder')
    return true
  }

  async getPetEnv() {
    const env = await invoke<{
      x: number
      y: number
      width: number
      height: number
      scale: number
      work_area: { x: number; y: number; width: number; height: number }
    }>('pet_env')
    return {
      x: env.x,
      y: env.y,
      width: env.width,
      height: env.height,
      scale: Number(env.scale) || 0.8,
      workArea: env.work_area
    }
  }

  async getPetScale(): Promise<number> {
    return this.service.petScale
  }

  async setPetScale(scale: number): Promise<number> {
    const next = await this.service.setPetScale(scale)
    // 立刻把宠物窗改成等比尺寸，并把新的比例广播给宠物页去重新排版角色
    await invoke('pet_apply_scale', { scale: next })
    return next
  }

  onPetScaleChanged(callback: (scale: number) => void): () => void {
    this.petScaleListeners.add(callback)
    return () => this.petScaleListeners.delete(callback)
  }

  async movePet(x: number, y: number): Promise<{ x: number; y: number } | null> {
    try {
      const position = await invoke<{ x: number; y: number }>('move_pet_window', { x, y })
      return position ?? null
    } catch {
      return null
    }
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

  private pendingInstaller: string | null = null

  async getAppVersion(): Promise<string> {
    return invoke<string>('app_version')
  }

  async checkUpdate(): Promise<UpdateInfo> {
    return invoke<UpdateInfo>('check_update')
  }

  async downloadUpdate(): Promise<UpdateDownloadResult> {
    const info = await this.checkUpdate()
    if (!info.hasUpdate) return { ok: false, message: '已经是最新版本' }
    if (!info.asset) return { ok: false, message: '这个版本没有 Windows 安装包' }
    const path = await invoke<string>('download_update', {
      url: info.asset.url,
      name: info.asset.name
    })
    return { ok: true, message: '下载完成', path }
  }

  async installUpdate(): Promise<boolean> {
    const path = this.pendingInstaller
    if (!path) return false
    await invoke('install_update', { path })
    return true
  }

  async openReleasePage(url: string): Promise<boolean> {
    await invoke('open_release', { url })
    return true
  }

  onUpdateProgress(callback: (progress: UpdateProgress) => void): () => void {
    let disposed = false
    const stop = listen<UpdateProgress>('update-progress', (event) => {
      if (!disposed) callback(event.payload)
    })
    return () => {
      disposed = true
      void stop.then((unlisten) => unlisten())
    }
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
