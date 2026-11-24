import type { UpdateDownloadResult, UpdateInfo, UpdateProgress } from './update'
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
  getPetEnv(): Promise<{
    x: number
    y: number
    width: number
    height: number
    /** 宠物显示比例，渲染层据此缩放角色 */
    scale: number
    workArea: { x: number; y: number; width: number; height: number }
  }>
  /** 直接移动宠物窗口（坐标是屏幕逻辑像素），返回真正生效的位置（可能被工作区夹住） */
  movePet(x: number, y: number): Promise<{ x: number; y: number } | null>
  getPetScale(): Promise<number>
  setPetScale(scale: number): Promise<number>
  /** 设置页改了比例后，宠物窗靠这个回调实时缩放，不用重启 */
  onPetScaleChanged(callback: (scale: number) => void): () => void
  /** 当前安装的版本号（1.4.9 这种） */
  getAppVersion(): Promise<string>
  /** 向 GitHub Releases 查最新版本；网络失败会抛错，由界面提示 */
  checkUpdate(): Promise<UpdateInfo>
  /** 下载上一步查到的安装包，进度走 onUpdateProgress */
  downloadUpdate(): Promise<UpdateDownloadResult>
  /** 静默安装下载好的包，随后应用会退出 */
  installUpdate(): Promise<boolean>
  /** 下载进度：下载与安装两个阶段共用 */
  onUpdateProgress(callback: (progress: UpdateProgress) => void): () => void
  /** 在浏览器里打开 Release 页面 */
  openReleasePage(url: string): Promise<boolean>
  onNavigate(callback: (target: 'settings' | 'history' | 'main') => void): () => void
  onTimerChanged(callback: (state: AppState) => void): () => void
  onSettingsApplied(callback: (settings: Settings) => void): () => void
  onHistoryUpdated(callback: () => void): () => void
}
