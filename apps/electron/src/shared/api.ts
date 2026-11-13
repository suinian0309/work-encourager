import type {
  AppState,
  BootstrapPayload,
  HistoryView,
  SaveSettingsPayload,
  SaveSettingsResult,
  Settings
} from './types'

export interface WorkEncouragerApi {
  bootstrap(): Promise<BootstrapPayload>
  getState(): Promise<AppState>
  toggleTimer(): Promise<{ ok: boolean; state: AppState }>
  resetTimer(): Promise<{ ok: boolean; message?: string; state: AppState }>
  saveSettings(payload: SaveSettingsPayload): Promise<SaveSettingsResult>
  getHistory(): Promise<HistoryView>
  minimize(): Promise<boolean>
  close(): Promise<boolean>
  openDataFolder(): Promise<string>
  quit(): Promise<boolean>
  showFloat(): Promise<boolean>
  hideFloat(): Promise<boolean>
  expandFloat(): Promise<boolean>
  onNavigate(callback: (target: 'settings' | 'history' | 'main') => void): () => void
  onTimerChanged(callback: (state: AppState) => void): () => void
  onSettingsApplied(callback: (settings: Settings) => void): () => void
  onHistoryUpdated(callback: () => void): () => void
}
