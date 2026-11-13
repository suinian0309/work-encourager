import { Menu, Tray, nativeImage } from 'electron'

export interface TrayOptions {
  iconPath: string
  onShow: () => void
  onToggleTimer: () => void
  onToggleFloat: () => void
  onSettings: () => void
  onQuit: () => void
}

export class TrayController {
  private tray: Tray | null = null
  private readonly options: TrayOptions

  constructor(options: TrayOptions) {
    this.options = options
  }

  create(timerOn: boolean, tooltip: string): void {
    if (this.tray) return
    let image = nativeImage.createFromPath(this.options.iconPath)
    if (image.isEmpty()) {
      image = nativeImage.createEmpty()
    } else {
      image = image.resize({ width: 16, height: 16 })
    }
    this.tray = new Tray(image)
    this.tray.setToolTip(tooltip)
    this.tray.on('click', () => this.options.onShow())
    this.tray.on('double-click', () => this.options.onShow())
    this.update(timerOn, tooltip, false)
  }

  update(timerOn: boolean, tooltip: string, floatVisible = false): void {
    if (!this.tray) return
    this.tray.setToolTip(tooltip)
    const menu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => this.options.onShow()
      },
      {
        label: floatVisible ? '隐藏桌面浮窗' : '打开桌面浮窗',
        click: () => this.options.onToggleFloat()
      },
      { type: 'separator' },
      {
        label: timerOn ? '关闭计时器' : '开启计时器',
        click: () => this.options.onToggleTimer()
      },
      {
        label: '设置',
        click: () => this.options.onSettings()
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => this.options.onQuit()
      }
    ])
    this.tray.setContextMenu(menu)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
