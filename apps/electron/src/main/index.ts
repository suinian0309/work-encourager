import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  Notification,
  protocol,
  screen,
  shell
} from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppService } from './service'
import { DataStoreError, openStore, type StoreHandle } from './store'
import { TrayController } from './tray'
import { ReminderService } from './reminders'
import { runDevSmoke } from './dev-smoke'
import { importLive2dModel, removeLive2dModel } from './live2d-import'
import type { PetStyle, SaveSettingsPayload } from '@shared/types'
import { latestSettingsEntry } from '@shared/engine'
import { toDateKey } from '@shared/date'
import { registerUpdateIpc } from './update'

// Live2D 模型走自定义协议加载：文件名是 ASCII，避免 file:// 与中文路径在打包后失效
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'live2d',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

const APP_ID = 'com.workencourager.app'
const resourcesDir = app.isPackaged
  ? join(process.resourcesPath, 'resources')
  : join(__dirname, '../../resources')

let service: AppService | null = null
let storeHandle: StoreHandle | null = null
let mainWindow: BrowserWindow | null = null
let floatWindow: BrowserWindow | null = null
let floatMoveTimer: NodeJS.Timeout | null = null
let petWindow: BrowserWindow | null = null
let petMoveTimer: NodeJS.Timeout | null = null
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

function petVisible(): boolean {
  return !!petWindow && petWindow.isVisible()
}

function updateTray(): void {
  if (!service || !tray) return
  const state = service.state(Date.now())
  const tooltip = state.privacyMode
    ? '上班鼓励器 · 计时进行中'
    : `上班鼓励器 · 今日已赚 ¥${state.earnTodayText}`
  tray.update(state.timerOn, tooltip, floatVisible(), petVisible(), service.petStats(Date.now()).today)
}

const FLOAT_WIDTH = 268
const FLOAT_HEIGHT = 111

function defaultFloatBounds(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - FLOAT_WIDTH - 20, y: area.y + area.height - FLOAT_HEIGHT - 20 }
}

function createFloatWindow(): BrowserWindow {
  if (floatWindow) return floatWindow
  const saved = storeHandle?.db.floatBounds
  const fallback = defaultFloatBounds()
  const position = saved ?? fallback
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      position.x + FLOAT_WIDTH > area.x + 20 &&
      position.x < area.x + area.width - 20 &&
      position.y + FLOAT_HEIGHT > area.y + 20 &&
      position.y < area.y + area.height - 20
    )
  })
  const initial = onScreen ? position : fallback
  const window = new BrowserWindow({
    width: FLOAT_WIDTH,
    height: FLOAT_HEIGHT,
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

/** 100% 时的窗口尺寸；实际尺寸 = 基准 × petScale（比例可在设置里调） */
const PET_BASE = { width: 210, height: 266 }
const PET_SCALE_MIN = 0.6
const PET_SCALE_MAX = 1.4
const PET_SCALE_DEFAULT = 0.8

function petScale(): number {
  const raw = Number(service?.petScale)
  if (!Number.isFinite(raw)) return PET_SCALE_DEFAULT
  return Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, raw))
}

function petSize(scale = petScale()): { width: number; height: number } {
  return {
    width: Math.round(PET_BASE.width * scale),
    height: Math.round(PET_BASE.height * scale)
  }
}

/** 默认落点：贴着任务栏上沿，距右边缘 5% 屏宽 */
function defaultPetBounds(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  const size = petSize()
  return {
    x: Math.round(area.x + area.width - size.width - area.width * 0.05),
    y: Math.round(area.y + area.height - size.height - 8)
  }
}

/**
 * live2d://<modelId>/model3.json → <userData>/live2d/<modelId>/model3.json
 * 只允许访问已导入模型目录内的文件，id 与相对路径都做白名单校验。
 */
function registerLive2dProtocol(): void {
  protocol.handle('live2d', async (request) => {
    try {
      const url = new URL(request.url)
      const id = url.hostname
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      if (!service || !/^[a-f0-9]{8,40}$/.test(id) || !relative || relative.includes('..')) {
        return new Response('not found', { status: 404 })
      }
      const file = join(service.live2dRoot(), id, relative)
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

function createPetWindow(): BrowserWindow {
  if (petWindow) return petWindow
  const size = petSize()
  const fallback = defaultPetBounds()
  const saved = service?.petBounds
  const position = saved ?? fallback
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      position.x + size.width > area.x + 40 &&
      position.x < area.x + area.width - 40 &&
      position.y + size.height > area.y + 40 &&
      position.y < area.y + area.height - 40
    )
  })
  const initial = onScreen ? position : fallback
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
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
    title: '上班鼓励器 · 摸鱼小宠物',
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
    if (petMoveTimer) clearTimeout(petMoveTimer)
    petMoveTimer = setTimeout(() => {
      if (!petWindow || !service) return
      const bounds = petWindow.getBounds()
      try {
        service.savePetBounds({ x: bounds.x, y: bounds.y })
      } catch (error) {
        reportError(error, '保存小宠物位置失败')
      }
    }, 400)
  })
  window.on('closed', () => {
    petWindow = null
    updateTray()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/pet.html'))
  }
  petWindow = window
  return window
}

/** 窗口被拖到已拔掉的显示器、或分辨率变了之后，重新摆回主屏可见区域 */
function ensurePetOnScreen(window: BrowserWindow): void {
  const bounds = window.getBounds()
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      bounds.x + bounds.width > area.x + 40 &&
      bounds.x < area.x + area.width - 40 &&
      bounds.y + bounds.height > area.y + 40 &&
      bounds.y < area.y + area.height - 40
    )
  })
  if (visible) return
  const fallback = defaultPetBounds()
  window.setPosition(fallback.x, fallback.y, false)
}

function showPet(): boolean {
  const window = createPetWindow()
  ensurePetOnScreen(window)
  window.showInactive()
  updateTray()
  return true
}

function hidePet(): boolean {
  petWindow?.hide()
  updateTray()
  return false
}

function togglePet(): boolean {
  if (petVisible()) return hidePet()
  return showPet()
}

/** 形象（团子猫 ↔ Live2D）切换后窗口尺寸不同，直接重建窗口并保留可见性 */
function recreatePetWindow(keepVisible: boolean): void {
  const visible = keepVisible || petVisible()
  if (petWindow) {
    petWindow.destroy()
    petWindow = null
  }
  if (visible) createPetWindow().showInactive()
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
    onTogglePet: () => togglePet(),
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
    height: 736,
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

  ipcMain.handle('pet:get', () => {
    const stats = getService().petStats(Date.now())
    return { ...stats, visible: petVisible() }
  })

  ipcMain.handle('pet:tap', () => {
    const stats = getService().tapPet(Date.now())
    mainWindow?.webContents.send('pet:tapped', stats)
    updateTray()
    return { ...stats, visible: petVisible() }
  })

  ipcMain.handle('pet:show', () => showPet())

  ipcMain.handle('pet:hide', () => hidePet())

  ipcMain.handle('pet:toggle', () => togglePet())

  ipcMain.handle('pet:style', () => ({
    style: getService().petStyle,
    model: getService().live2dModel
  }))

  ipcMain.handle('pet:style:set', (_event, style: PetStyle) => {
    const serviceRef = getService()
    serviceRef.setPetStyle(style === 'live2d' ? 'live2d' : 'mochi')
    recreatePetWindow(false)
    return { style: serviceRef.petStyle, model: serviceRef.live2dModel }
  })

  ipcMain.handle('live2d:import', async () => {
    const serviceRef = getService()
    const options: Electron.OpenDialogOptions = {
      title: '选择 Live2D 模型文件夹（里面含 .model3.json）',
      properties: ['openDirectory'],
      buttonLabel: '导入这个模型'
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true as const }
    const imported = await importLive2dModel(result.filePaths[0], serviceRef.live2dRoot())
    serviceRef.saveLive2dModel(imported.info)
    serviceRef.setPetStyle('live2d')
    recreatePetWindow(true)
    return { canceled: false as const, info: imported.info, stats: imported.stats }
  })

  ipcMain.handle('live2d:remove', async () => {
    const serviceRef = getService()
    const model = serviceRef.live2dModel
    if (model) await removeLive2dModel(serviceRef.live2dRoot(), model.id)
    serviceRef.saveLive2dModel(null)
    serviceRef.setPetStyle('mochi')
    recreatePetWindow(false)
    return { style: serviceRef.petStyle }
  })

  ipcMain.handle('live2d:open-folder', () => {
    const root = getService().live2dRoot()
    mkdirSync(root, { recursive: true })
    void shell.openPath(root)
    return true
  })

  ipcMain.handle('pet:env', () => {
    const window = createPetWindow()
    const bounds = window.getBounds()
    const display = screen.getDisplayMatching(bounds)
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      scale: petScale(),
      workArea: {
        x: display.workArea.x,
        y: display.workArea.y,
        width: display.workArea.width,
        height: display.workArea.height
      }
    }
  })

  ipcMain.handle('pet:scale', () => petScale())

  ipcMain.handle('pet:scale:set', (_event, value: number) => {
    const serviceRef = getService()
    const raw = Number(value)
    const next = Number.isFinite(raw) ? Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, raw)) : PET_SCALE_DEFAULT
    serviceRef.setPetScale(next)
    const window = petWindow
    if (window) {
      const bounds = window.getBounds()
      const size = petSize(next)
      // 以中心为锚点缩放：不然一放大就往下掉出屏幕
      const centerX = bounds.x + bounds.width / 2
      const centerY = bounds.y + bounds.height / 2
      const x = Math.round(centerX - size.width / 2)
      const y = Math.round(centerY - size.height / 2)
      window.setBounds({ x, y, width: size.width, height: size.height })
      window.webContents.send('pet:scale', { scale: next })
    }
    return next
  })

  ipcMain.handle('pet:move', (_event, x: number, y: number) => {
    const window = petWindow
    if (!window) return false
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    const bounds = window.getBounds()
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
    const nextX = Math.min(Math.max(Math.round(x), workArea.x), workArea.x + workArea.width - bounds.width)
    const nextY = Math.min(Math.max(Math.round(y), workArea.y), workArea.y + workArea.height - bounds.height)
    window.setPosition(nextX, nextY, false)
    // 把真正生效的位置回给渲染层：被屏幕边缘夹住时，前端据此重新锚定，手指和窗口才不会越拖越错位
    return { x: nextX, y: nextY }
  })
}

function bootstrap(): void {
  app.setAppUserModelId(APP_ID)

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
    petWindow?.destroy()
  })

  app.on('window-all-closed', () => {
    if (isQuitting) app.quit()
  })

  void app.whenReady().then(async () => {
    try {
      storeHandle = openStore(process.env['WORK_ENC_DATA_DIR'] || undefined)
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
    registerLive2dProtocol()
    registerUpdateIpc()

    // 无界面导入自检：WORK_ENC_IMPORT_TEST=<model3.json 或目录>，把结果写到 WORK_ENC_IMPORT_OUT
    const importTest = process.env['WORK_ENC_IMPORT_TEST']
    if (importTest) {
      const out = process.env['WORK_ENC_IMPORT_OUT'] || join(process.cwd(), 'import-test.json')
      try {
        const result = await importLive2dModel(importTest, service.live2dRoot())
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, JSON.stringify({ ok: true, ...result }, null, 2), 'utf8')
      } catch (error) {
        writeFileSync(out, JSON.stringify({ ok: false, error: String((error as Error).message || error) }, null, 2), 'utf8')
      }
      app.quit()
      return
    }

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
