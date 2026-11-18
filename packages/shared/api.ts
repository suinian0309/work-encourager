import type {
  AppState,
  BootstrapPayload,
  HistoryView,
  Live2dModelInfo,
  PetStats,
  PetStyle,
  SaveSettingsPayload,
  SaveSettingsResult,
  Settings
} from './types'

export interface PetStyleState {
  style: PetStyle
  model: Live2dModelInfo | null
}

export interface Live2dImportResult {
  canceled: boolean
  info?: Live2dModelInfo
  stats?: { textures: number; motions: number; expressions: number; bytes: number; resized: string[] }
}

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
  getPet(): Promise<PetStats>
  tapPet(): Promise<PetStats>
  showPet(): Promise<boolean>
  hidePet(): Promise<boolean>
  togglePet(): Promise<boolean>
  onPetTapped(callback: (stats: PetStats) => void): () => void
  /** 当前桌面形象：团子猫或 Live2D 模型 */
  getPetStyle(): Promise<PetStyleState>
  setPetStyle(style: PetStyle): Promise<PetStyleState>
  /** 选择 .model3.json 导入模型，取消时 canceled=true */
  importLive2d(): Promise<Live2dImportResult>
  /** 删除已导入模型并退回团子猫 */
  removeLive2d(): Promise<PetStyleState>
  openLive2dFolder(): Promise<boolean>
  /** 宠物窗口自身位置与所在显示器工作区，用于拖动/抛掷物理 */
  getPetEnv(): Promise<{ x: number; y: number; width: number; height: number; workArea: { x: number; y: number; width: number; height: number } }>
  /** 直接移动宠物窗口（坐标是屏幕逻辑像素），返回真正生效的位置（可能被工作区夹住） */
  movePet(x: number, y: number): Promise<{ x: number; y: number } | null>
  onNavigate(callback: (target: 'settings' | 'history' | 'main') => void): () => void
  onTimerChanged(callback: (state: AppState) => void): () => void
  onSettingsApplied(callback: (settings: Settings) => void): () => void
  onHistoryUpdated(callback: () => void): () => void
}
