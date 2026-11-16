/**
 * 构图调参：同一会话里依次套用 (scale, anchorY) 组合，每档截一张图并测角色墨迹包围盒
 * 用法：node scripts/tune-live2d.mjs [port]
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9420)
const outDir = join(process.cwd(), '.probe', 'live2d', 'tune')
mkdirSync(outDir, { recursive: true })

const env = { ...process.env, WORK_ENC_DATA_DIR: 'F:\\DSH\\.tmp\\pet-data2' }
delete env.ELECTRON_RUN_AS_NODE

const COMBOS = [
  // [scale, anchorY, positionY(占画布高度比例)] —— 先用小比例看清整只模型，再逐步放大
  [1.0, 0.0, 0.06],
  [1.6, 0.0, 0.0],
  [2.2, 0.0, -0.12],
  [2.8, 0.0, -0.26]
]

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
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails))
    return res.result?.result?.value
  }
}

const child = spawn('node_modules/electron/dist/electron.exe', ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${port}`], {
  env,
  stdio: 'ignore',
  windowsHide: true
})

let ok = true
try {
  const main = await waitTarget((t) => t.url.includes('index.html'))
  const mainClient = new Client(main.webSocketDebuggerUrl)
  await mainClient.ready
  await sleep(2500)
  await mainClient.eval(`(() => { const b = document.querySelector('button[title="摸鱼小宠物"]'); b && b.click(); return 1 })()`)

  const pet = await waitTarget((t) => t.url.includes('pet.html'))
  const petClient = new Client(pet.webSocketDebuggerUrl)
  await petClient.ready
  await sleep(5000)

  // 只留角色，量真实墨迹
  await petClient.eval(`(() => {
    const style = document.createElement('style');
    style.textContent = '.pet-pill,.pet-bubble,.pet-close{display:none!important}';
    document.head.appendChild(style);
    return 1;
  })()`)

  for (const [scale, anchorY, posY] of COMBOS) {
    await petClient.eval(`(() => { window.__live2d.tune(${scale}, ${anchorY}, ${posY}); return 1 })()`)
    await sleep(700)
    const meta = await petClient.eval(`(() => {
      const m = window.__live2d.model; const b = m.getBounds();
      return { bounds: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], renderer: [window.__live2d.app.renderer.width, window.__live2d.app.renderer.height] };
    })()`)
    await petClient.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 250, g: 248, b: 243, a: 1 } })
    const shot = await petClient.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const name = `s${String(scale).replace('.', 'p')}-y${String(posY).replace('.', 'p').replace('-', 'n')}.png`
    const file = join(outDir, name)
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log(`scale=${scale} anchorY=${anchorY} posY=${posY}`, JSON.stringify(meta), '→', name)
  }
} catch (error) {
  ok = false
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
  process.exit(ok ? 0 : 1)
}
