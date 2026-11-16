/**
 * 对照组：打开浮窗后抓桌面像素，验证「GDI 屏幕抓取能否看见透明窗口」
 * 浮窗是已知渲染正常的窗口，若它抓出来也是一块纯色，说明抓取方式对分层窗口无效
 */
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9430)
const env = { ...process.env, WORK_ENC_DATA_DIR: 'F:\\DSH\\.tmp\\pet-data2' }
delete env.ELECTRON_RUN_AS_NODE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch {
    return []
  }
}

async function waitTarget(match, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const hit = (await targets()).find((t) => t.type === 'page' && match(t))
    if (hit) return hit
    await sleep(300)
  }
  return null
}

class Client {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = reject
    })
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      const entry = this.pending.get(msg.id)
      if (entry) {
        this.pending.delete(msg.id)
        entry(msg)
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return res.result?.result?.value
  }
}

const child = spawn('node_modules/electron/dist/electron.exe', ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${port}`], {
  env,
  stdio: 'ignore',
  windowsHide: true
})

try {
  const mainTarget = await waitTarget((t) => t.url.includes('index.html'))
  const main = new Client(mainTarget.webSocketDebuggerUrl)
  await main.ready
  await sleep(2500)
  const shown = await main.eval('window.workEncourager.showFloat()')
  console.log('showFloat:', shown)
  await sleep(1500)

  const rect = { x: 2560 - 268 - 20, y: 24 + 1416 - 160 - 20, width: 268, height: 160 }
  const out = join(process.cwd(), '.probe', 'live2d', 'float-desktop.png')
  const ps = `Add-Type -AssemblyName System.Drawing; $bmp=New-Object System.Drawing.Bitmap(${rect.width},${rect.height}); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${rect.x},${rect.y},0,0,$bmp.Size); $g.Dispose(); $bmp.Save('${out.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()`
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })

  const grid = await main.eval(`(() => {
    const s = document.querySelector('.float-card');
    return s ? { rect: s.getBoundingClientRect().toJSON(), bg: getComputedStyle(s).backgroundColor } : null;
  })()`)
  console.log('float-card dom:', JSON.stringify(grid))
  console.log('captured:', out)
} catch (error) {
  console.error('FAILED:', error instanceof Error ? error.message : error)
} finally {
  try {
    child.kill()
  } catch {
    // 已退出
  }
  try {
    execFileSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' })
  } catch {
    // 无残留
  }
}
