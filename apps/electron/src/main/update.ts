/**
 * 版本检查与更新（Electron 主进程侧）。
 *
 * 为什么放在主进程：renderer 有 CSP、也不该直接写磁盘；
 * 下载一个 100 MB 的 MSI 更不该塞进渲染进程的内存里。
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  UPDATE_REPO,
  compareVersions,
  pickInstaller,
  type UpdateAssetInfo,
  type UpdateDownloadResult,
  type UpdateInfo,
  type UpdateProgress
} from '@shared/update'

const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`
const USER_AGENT = 'work-encourager-updater'

interface GithubAsset {
  name?: string
  size?: number
  browser_download_url?: string
}

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: GithubAsset[]
}

let latest: UpdateInfo | null = null
let downloadedPath: string | null = null
let downloading = false

function updateDir(): string {
  const dir = join(app.getPath('temp'), 'work-encourager-update')
  mkdirSync(dir, { recursive: true })
  return dir
}

function emitProgress(progress: UpdateProgress): void {
  const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
  if (!win) return
  win.webContents.send('update:progress', progress)
}

async function fetchReleases(): Promise<GithubRelease[]> {
  const response = await fetch(RELEASES_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT
    }
  })
  if (!response.ok) {
    if (response.status === 403) throw new Error('GitHub 接口被限流（403），稍后再试')
    throw new Error(`GitHub 返回 HTTP ${response.status}`)
  }
  const json = (await response.json()) as unknown
  return Array.isArray(json) ? (json as GithubRelease[]) : []
}

/**
 * 兜底路径：GitHub 未登录的 API 每小时只给 60 次，一旦 403 就整条更新链断掉。
 * 这里改用 releases/latest 的 302 重定向拿版本号，
 * 再用 releases/latest/download/<资产名> 这个稳定直链下载（不消耗 API 配额）。
 */
async function checkUpdateViaRedirect(currentVersion: string): Promise<UpdateInfo> {
  const response = await fetch(`https://github.com/${UPDATE_REPO}/releases/latest`, {
    method: 'HEAD',
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT }
  })
  const finalUrl = response.url || ''
  const matched = /\/releases\/tag\/([^/?#]+)/.exec(finalUrl)
  if (!matched) throw new Error(`拿不到最新版本号（HTTP ${response.status}）`)
  const latestVersion = decodeURIComponent(matched[1]).replace(/^v/i, '')
  const assetName = `WorkEncourager-Electron-Setup-${latestVersion}.msi`
  const assetUrl = `https://github.com/${UPDATE_REPO}/releases/latest/download/${assetName}`
  let assetSize = 0
  try {
    const head = await fetch(assetUrl, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } })
    assetSize = Number(head.headers.get('content-length') ?? 0) || 0
  } catch {
    // 体积只是给人看的，拿不到就算了
  }
  const info: UpdateInfo = {
    currentVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    notes: '',
    publishedAt: '',
    pageUrl: `https://github.com/${UPDATE_REPO}/releases/tag/v${latestVersion}`,
    asset: { name: assetName, size: assetSize, url: assetUrl },
    checkedAt: Date.now()
  }
  return info
}

/**
 * 开发态 app.getVersion() 拿到的是 Electron 自己的版本号（37.x），
 * 得从应用的 package.json 里读，打包后两者一致。
 */
function appVersion(): string {
  if (app.isPackaged) return app.getVersion()
  // 开发态 app.getAppPath() 指向 out/main，package.json 在上两级
  const candidates = [
    join(app.getAppPath(), 'package.json'),
    join(app.getAppPath(), '..', '..', 'package.json'),
    join(process.cwd(), 'package.json')
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: string }
      if (parsed.version) return String(parsed.version)
    } catch {
      // 换下一个候选
    }
  }
  return app.getVersion()
}

async function checkUpdate(): Promise<UpdateInfo> {
  const currentVersion = appVersion()
  let releases: GithubRelease[] = []
  try {
    releases = await fetchReleases()
  } catch (error) {
    // API 限流/网络不通时，改走重定向兜底，别让用户点一下就只见报错
    const info = await checkUpdateViaRedirect(currentVersion)
    latest = info
    return info
  }
  const release = releases.find((item) => !item.draft && !item.prerelease) ?? releases[0]
  if (!release) throw new Error('这个仓库还没有可用的 Release')

  const latestVersion = String(release.tag_name ?? release.name ?? '').replace(/^v/i, '')
  if (!latestVersion) throw new Error('Release 上没有版本号')

  const assets: UpdateAssetInfo[] = (release.assets ?? [])
    .filter((item) => Boolean(item.browser_download_url) && Boolean(item.name))
    .map((item) => ({
      name: String(item.name),
      size: Number(item.size ?? 0),
      url: String(item.browser_download_url)
    }))

  const info: UpdateInfo = {
    currentVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    notes: String(release.body ?? '').slice(0, 4000),
    publishedAt: String(release.published_at ?? ''),
    pageUrl: String(release.html_url ?? `https://github.com/${UPDATE_REPO}/releases`),
    asset: pickInstaller(assets, 'electron'),
    checkedAt: Date.now()
  }
  latest = info
  return info
}

async function downloadUpdate(): Promise<UpdateDownloadResult> {
  if (!latest) return { ok: false, message: '请先检查更新' }
  if (!latest.asset) return { ok: false, message: '这个版本没有提供 Windows 安装包' }
  if (downloading) return { ok: false, message: '正在下载中' }

  const dir = updateDir()
  const target = join(dir, latest.asset.name)
  rmSync(target, { force: true })

  downloading = true
  try {
    const response = await fetch(latest.asset.url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow'
    })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)

    const total = Number(response.headers.get('content-length') ?? latest.asset.size ?? 0)
    const file = createWriteStream(target)
    let received = 0
    let lastTick = 0

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      file.write(chunk)
      received += chunk.byteLength
      const now = Date.now()
      if (now - lastTick > 300 || received === total) {
        lastTick = now
        emitProgress({
          phase: 'download',
          received,
          total,
          percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0
        })
      }
    }

    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve())
      file.on('error', (error) => reject(error))
    })

    const size = existsSync(target) ? statSync(target).size : 0
    if (size <= 0) throw new Error('下载完成但文件是空的')
    downloadedPath = target
    emitProgress({ phase: 'download', received: size, total: size, percent: 100 })
    return { ok: true, path: target }
  } catch (error) {
    rmSync(target, { force: true })
    return { ok: false, message: (error as Error).message }
  } finally {
    downloading = false
  }
}

function installUpdate(): boolean {
  if (!downloadedPath || !existsSync(downloadedPath)) return false
  try {
    emitProgress({ phase: 'install', received: 0, total: 0, percent: 0 })
    // /passive：显示一个进度条，不打扰用户；/norestart：别擅自重启系统
    const child = spawn('msiexec', ['/i', downloadedPath, '/passive', '/norestart'], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    // 把窗口让开，让安装程序接管；进程退出才算释放安装目录
    setTimeout(() => app.exit(0), 600)
    return true
  } catch {
    return false
  }
}

export function registerUpdateIpc(): void {
  ipcMain.handle('update:version', () => appVersion())
  ipcMain.handle('update:check', () => checkUpdate())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => installUpdate())
  ipcMain.handle('update:open-release', async (_event, url: string) => {
    const target = typeof url === 'string' && url.startsWith('https://') ? url : `https://github.com/${UPDATE_REPO}/releases`
    await shell.openExternal(target)
    return true
  })
}
