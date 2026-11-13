import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, screen, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AppService } from './service'
import { DataStoreError, openStore, type StoreHandle } from './store'
import { TrayController } from './tray'
import { ReminderService } from './reminders'
import { runDevSmoke } from './dev-smoke'
import type { SaveSettingsPayload } from '@shared/types'
import { latestSettingsEntry } from '@shared/engine'
import { toDateKey } from '@shared/date'

const APP_ID = 'com.workencourager.app'
const resourcesDir = app.isPackaged
  ? join(process.resourcesPath, 'resources')
  : join(__dirname, '../../resources')

let service: AppService | null = null
let storeHandle: StoreHandle | null = null
let mainWindow: BrowserWindow | null = null
let floatWindow: BrowserWindow | null = null
let floatMoveTimer: NodeJS.Timeout | null = null
let tray: TrayController | null = null
let reminders: ReminderService | null = null
let isQuitting = false
let lastSettleAt = 0
let lastSettleDay = ''
let lastErrorAt = 0
let ticking: NodeJS.Timeout | null = null

function reportError(error: unknown, title = '操作失败'): void {
  const now = Date.now()
  if (now - lastErrorAt < 3000) return
  lastErrorAt = now
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox(title, `${message}\n\n数据文件：${service?.dataPath ?? storeHandle?.path ?? '未知'}`)
}

function currentSettings() {
  if (!service) throw new Error('应用尚未初始化')
  return latestSettingsEntry(service.db.settingsTimeline).settings
}

function themeBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#121816' : '#F6F1EC'
}

function showWindow(): void {
  if (!mainWindow) return
  floatWindow?.hide()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.setSkipTaskbar(false)
  mainWindow.show()
  mainWindow.focus()
  updateTray()
}

function floatVisible(): boolean {
  return !!floatWindow && floatWindow.isVisible()
}

function updateTray(): void {
  if (!service || !tray) return
  const state = service.state(Date.now())
  const tooltip = state.privacyMode
    ? '上班鼓励器 · 计时进行中'
    : `上班鼓励器 · 今日已赚 ¥${state.earnTodayText}`
  tray.update(state.timerOn, tooltip, floatVisible())
}

function defaultFloatBounds(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - 280, y: area.y + area.height - 172 }
}

function createFloatWindow(): BrowserWindow {
  if (floatWindow) return floatWindow
  const saved = storeHandle?.db.floatBounds
  const fallback = defaultFloatBounds()
  const position = saved ?? fallback
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      position.x + 260 > area.x + 20 &&
      position.x < area.x + area.width - 20 &&
      position.y + 152 > area.y + 20 &&
      position.y < area.y + area.height - 20
    )
  })
  const initial = onScreen ? position : fallback
  const window = new BrowserWindow({
    width: 260,
    height: 152,
    x: initial.x,
    y: initial.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: '上班鼓励器浮窗',
    icon: join(resourcesDir, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })
  window.setSkipTaskbar(true)
  window.setAlwaysOnTop(true, 'floating')

  window.on('moved', () => {
    if (floatMoveTimer) clearTimeout(floatMoveTimer)
    floatMoveTimer = setTimeout(() => {
      if (!floatWindow || !storeHandle) return
      const bounds = floatWindow.getBounds()
      try {
        storeHandle.saveFloatBounds({ x: bounds.x, y: bounds.y })
      } catch (error) {
        reportError(error, '保存浮窗位置失败')
      }
    }, 400)
  })
  window.on('closed', () => {
    floatWindow = null
    updateTray()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/float.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/float.html'))
  }
  floatWindow = window
  return window
}

function showFloat(): void {
  const window = createFloatWindow()
  mainWindow?.hide()
  mainWindow?.setSkipTaskbar(true)
  window.show()
  window.focus()
  updateTray()
}

function hideFloat(): void {
  floatWindow?.hide()
  updateTray()
}

function toggleFloat(): void {
  if (floatVisible()) hideFloat()
  else showFloat()
}

function expandFloat(): void {
  floatWindow?.hide()
  if (!mainWindow) return
  mainWindow.setSkipTaskbar(false)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  updateTray()
}

function requestClose(): void {
  if (!service) {
    isQuitting = true
    app.quit()
    return
  }
  if (currentSettings().closeAction === 'tray') {
    mainWindow?.hide()
    return
  }
  isQuitting = true
  app.quit()
}

function createTray(): void {
  tray = new TrayController({
    iconPath: join(resourcesDir, 'tray.png'),
    onShow: () => showWindow(),
    onToggleFloat: () => toggleFloat(),
    onToggleTimer: () => {
      if (!service) return
      try {
        const state = service.toggleTimer(Date.now())
        mainWindow?.webContents.send('timer:changed', state)
        updateTray()
      } catch (error) {
        reportError(error)
      }
    },
    onSettings: () => {
      showWindow()
      mainWindow?.webContents.send('navigate', 'settings')
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    }
  })
  tray.create(service?.db.timer.on !== false, '上班鼓励器')
  updateTray()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 720,
    minWidth: 340,
    minHeight: 540,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: themeBackground(),
    title: '上班鼓励器',
    icon: join(resourcesDir, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (service) mainWindow?.setAlwaysOnTop(currentSettings().alwaysOnTop)
    mainWindow?.setSkipTaskbar(false)
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (isQuitting) return
    const settings = service ? currentSettings() : null
    if (settings?.closeAction === 'tray') {
      event.preventDefault()
      mainWindow?.hide()
      return
    }
    isQuitting = true
    app.quit()
  })
  mainWindow.on('minimize' as never, ((event: Electron.Event) => {
    if (!service) return
    if (currentSettings().minimizeToTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  }) as never)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const smokePhase = Number(process.env['WORK_ENC_SMOKE_PHASE'] ?? 0)
  if (!app.isPackaged && smokePhase > 0) {
    const window = mainWindow
    const dir = process.env['WORK_ENC_SMOKE_DIR'] ?? join(process.cwd(), '.smoke')
    mkdirSync(dir, { recursive: true })
    window.webContents.once('did-finish-load', () => {
      void runDevSmoke(window, {
        phase: smokePhase,
        dir,
        quit: () => {
          isQuitting = true
          app.quit()
        }
      })
    })
  }
}

function applyRuntimeSettings(): void {
  if (!service || !mainWindow) return
  const settings = currentSettings()
  nativeTheme.themeSource = settings.theme
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop)
  mainWindow.setBackgroundColor(themeBackground())
  mainWindow.webContents.send('settings:applied', settings)
}

function startTick(): void {
  if (!service || !reminders) return
  const tick = (): void => {
    if (!service || !reminders) return
    const now = Date.now()
    try {
      const today = toDateKey(new Date(now))
      if (today !== lastSettleDay || now - lastSettleAt > 60_000) {
        const created = service.settle(now)
        lastSettleAt = now
        lastSettleDay = today
        if (created.length > 0) {
          updateTray()
          mainWindow?.webContents.send('history:updated')
        }
      }
      reminders.check(now)
    } catch (error) {
      reportError(error, '计时或提醒失败')
    }
  }
  tick()
  ticking = setInterval(tick, 1000)
}

function registerIpc(): void {
  const getService = (): AppService => {
    if (!service) throw new Error('应用尚未初始化')
    return service
  }

  ipcMain.handle('app:bootstrap', () => getService().bootstrap(Date.now()))
  ipcMain.handle('app:state', () => getService().state(Date.now()))

  ipcMain.handle('timer:toggle', () => {
    const state = getService().toggleTimer(Date.now())
    updateTray()
    return { ok: true, state }
  })

  ipcMain.handle('timer:reset', () => {
    const result = getService().resetCurrentShift(Date.now())
    updateTray()
    return result
  })

  ipcMain.handle('settings:save', (_event, payload: SaveSettingsPayload) => {
    const result = getService().saveSettings(payload, Date.now())
    if (result.ok) {
      applyRuntimeSettings()
      updateTray()
    }
    return result
  })

  ipcMain.handle('history:get', () => getService().history(Date.now()))

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
    return true
  })

  ipcMain.handle('window:close', () => {
    requestClose()
    return true
  })

  ipcMain.handle('window:hide', () => {
    mainWindow?.hide()
    return true
  })

  ipcMain.handle('app:open-data-folder', () => {
    const path = getService().dataPath
    shell.showItemInFolder(path)
    return path
  })

  ipcMain.handle('app:quit', () => {
    isQuitting = true
    app.quit()
    return true
  })

  ipcMain.handle('float:show', () => {
    showFloat()
    return true
  })

  ipcMain.handle('float:hide', () => {
    hideFloat()
    return true
  })

  ipcMain.handle('float:expand', () => {
    expandFloat()
    return true
  })
}

function bootstrap(): void {
  app.setAppUserModelId(APP_ID)
  app.disableHardwareAcceleration()

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    showWindow()
  })

  app.on('before-quit', () => {
    isQuitting = true
    if (ticking) clearInterval(ticking)
    tray?.destroy()
    floatWindow?.destroy()
  })

  app.on('window-all-closed', () => {
    if (isQuitting) app.quit()
  })

  void app.whenReady().then(() => {
    try {
      storeHandle = openStore()
      service = new AppService(storeHandle, { now: () => Date.now(), version: app.getVersion() })
      service.settle(Date.now())
    } catch (error) {
      const dataPath = error instanceof DataStoreError ? error.dataPath : ''
      dialog.showErrorBox(
        '无法启动上班鼓励器',
        `${(error as Error).message}\n\n数据文件位置：${dataPath}\n请备份后修复该文件，程序不会自动清空你的数据。`
      )
      app.quit()
      return
    }

    if (!Notification.isSupported()) {
      // 系统不支持通知时仍可正常使用，仅静默跳过提醒
    }

    nativeTheme.themeSource = currentSettings().theme
    createWindow()
    createTray()
    reminders = new ReminderService(service, () => showWindow())
    registerIpc()
    startTick()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    showWindow()
  })
}

bootstrap()
