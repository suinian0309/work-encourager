/**
 * 打包版鲸鱼探针：启动 release/win-unpacked/上班鼓励器.exe → 开宠物窗 → 量 canvas/FPS → 点一下。
 * 用法：node scripts/probe-packaged-whale.mjs [port]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9452)
const outDir = join(process.cwd(), '.probe', 'whale')
mkdirSync(outDir, { recursive: true })

const exe = join(process.cwd(), 'release', 'win-unpacked', '上班鼓励器.exe')
const env = { ...process.env, WORK_ENC_DATA_DIR: 'F:\\DSH\\.tmp\\whale-e-pack' }
delete env['ELECTRON_RUN_AS_NODE']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch {
    return []
  }
}

async function waitTarget(match, timeout = 40000) {
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
      this.ws.onerror = (e) => reject(e)
    })
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      const entry = this.pending.get(msg.id)
      if (entry) {
        this.pending.delete(msg.id)
        entry.resolve(msg)
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails))
    return res.result?.result?.value
  }
}

const child = spawn(exe, ['--no-sandbox', '--user-data-dir=F:\\DSH\\.tmp\\whale-pkg-userdata', `--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
const result = { ok: false }

try {
  const main = await waitTarget((t) => t.url.includes('index.html'))
  if (!main) throw new Error('主窗口没起来')
  const mainClient = new Client(main.webSocketDebuggerUrl)
  await mainClient.ready
  await mainClient.send('Runtime.enable')
  result.clicked = await mainClient.evaluate(`(async () => {
    for (let i = 0; i < 120; i++) {
      const btn = document.querySelector('button[title="摸鱼小宠物"]')
      if (btn) { btn.click(); return true }
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  })()`)

  const pet = await waitTarget((t) => t.url.includes('pet.html'))
  if (!pet) throw new Error('宠物窗没出现')
  const petClient = new Client(pet.webSocketDebuggerUrl)
  await petClient.ready
  await petClient.send('Runtime.enable')
  await petClient.send('Page.enable')

  result.state = await petClient.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const q = (s) => document.querySelector(s)
    for (let i = 0; i < 100 && !q('svg.kit canvas'); i++) await wait(200)
    const canvas = q('svg.kit canvas')
    let frames = 0
    const t0 = performance.now()
    await new Promise((res) => {
      const step = () => { frames++; if (performance.now() - t0 < 1000) requestAnimationFrame(step); else res() }
      requestAnimationFrame(step)
    })
    return {
      kit: !!q('svg.kit'),
      canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
      fps: Math.round(frames / ((performance.now() - t0) / 1000)),
      pill: (q('.pet-pill')?.innerText || '').replace(/\\s+/g, ' '),
      error: q('.pet-error')?.textContent ?? '',
      inner: [innerWidth, innerHeight]
    }
  })()`)

  await petClient.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  const shot = await petClient.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, 'packaged-whale.png'), Buffer.from(shot.result.data, 'base64'))

  result.tap = await petClient.evaluate(`(async () => {
    const canvas = document.querySelector('svg.kit canvas') || document.querySelector('.pet-stage')
    const rect = canvas.getBoundingClientRect()
    const opts = { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * 0.55, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: 1 }
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts))
    await new Promise((r) => setTimeout(r, 60))
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }))
    await new Promise((r) => setTimeout(r, 500))
    return (document.querySelector('.pet-pill')?.innerText || '').replace(/\\s+/g, ' ')
  })()`)

  result.ok = true
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
} finally {
  try {
    child.kill()
  } catch {}
  await sleep(1000)
  try {
    spawn('taskkill', ['/F', '/IM', '上班鼓励器.exe'], { stdio: 'ignore' })
  } catch {}
  writeFileSync(join(outDir, 'packaged-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
