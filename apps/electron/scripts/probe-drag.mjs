/**
 * 临时探针：Electron 宠物窗里 canvas 的 CSS 尺寸，以及拖拽过程中角色是否被画布裁切。
 * 用法：node scripts/probe-drag.mjs [port]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9471)
const outDir = join(process.cwd(), '.probe', 'drag')
mkdirSync(outDir, { recursive: true })

const dataDir = process.env.WORK_ENC_PROBE_DATA || 'F:\\DSH\\.tmp\\whale-enc'
const env = { ...process.env, WORK_ENC_DATA_DIR: dataDir }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--no-sandbox', `--remote-debugging-port=${port}`], { env, stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = async () => {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return [] }
}
async function waitTarget(match, timeout = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const hit = (await list()).find((t) => t.type === 'page' && match(t))
    if (hit) return hit
    await sleep(300)
  }
  return null
}
class Client {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m) } }
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((r) => { this.pending.set(id, r); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) return { __error: JSON.stringify(res.result.exceptionDetails).slice(0, 400) }
    return res.result?.result?.value
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64'))
  }
}

const out = { ok: false }
try {
  const main = await waitTarget((t) => t.url.includes('index.html'))
  if (!main) throw new Error('主窗口没起来')
  const mc = new Client(main.webSocketDebuggerUrl)
  await mc.ready
  await mc.send('Runtime.enable')
  out.clicked = await mc.evaluate(`(async () => {
    for (let i = 0; i < 120; i++) {
      const b = document.querySelector('button[title="摸鱼小宠物"]')
      if (b) { b.click(); return true }
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  })()`)

  const pet = await waitTarget((t) => t.url.includes('pet.html'))
  if (!pet) throw new Error('宠物窗没出现')
  const pc = new Client(pet.webSocketDebuggerUrl)
  await pc.ready
  await pc.send('Runtime.enable')
  await pc.send('Page.enable')
  await sleep(1500)

  out.geometry = await pc.evaluate(`(() => {
    const q = (s) => document.querySelector(s)
    const canvas = q('svg.kit canvas')
    const kit = q('svg.kit')
    const stage = q('.whale-stage')
    const r = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), left: Math.round(el.getBoundingClientRect().left), top: Math.round(el.getBoundingClientRect().top) } : null
    return {
      inner: [innerWidth, innerHeight],
      canvasAttr: canvas ? [canvas.width, canvas.height] : null,
      canvasCss: r(canvas),
      kit: r(kit),
      stage: r(stage),
      svgViewBox: kit ? kit.getAttribute('viewBox') : null,
      svgAttrs: kit ? { w: kit.getAttribute('width'), h: kit.getAttribute('height') } : null
    }
  })()`)

  await pc.shot('before.png')

  out.drag = await pc.evaluate(`(async () => {
    const canvas = document.querySelector('svg.kit canvas') || document.querySelector('.whale-stage')
    const kitSvg = document.querySelector('svg.kit')
    const petG = kitSvg.children[1]
    const rect = canvas.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height * 0.55
    const mk = (type, clientX, clientY, screenX, screenY) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX, clientY, screenX, screenY
    })
    const target = canvas
    const sx = window.screenX + cx
    const sy = window.screenY + cy
    const start = petG.getAttribute('transform')
    target.dispatchEvent(mk('pointerdown', cx, cy, sx, sy))
    await new Promise((r) => setTimeout(r, 120))
    // 前 3 步：指针在窗口里真的挪了 8px，越过抓起阈值（真实拖拽都是这样开始的）
    for (let i = 1; i <= 3; i++) {
      target.dispatchEvent(mk('pointermove', cx + i * 8, cy + i * 2, sx + i * 8, sy + i * 2))
      await new Promise((r) => setTimeout(r, 70))
    }
    const grabbed = petG.getAttribute('transform')
    // 之后窗口跟上指针：页面坐标不动、屏幕坐标继续走
    for (let i = 1; i <= 12; i++) {
      target.dispatchEvent(mk('pointermove', cx + 24, cy + 6, sx + 24 + i * 6, sy + 6 + i * 2))
      await new Promise((r) => setTimeout(r, 70))
    }
    const during = petG.getAttribute('transform')
    return { moved: 15, screenX: window.screenX, screenY: window.screenY, start, grabbed, during }
  })()`)

  await sleep(600)
  await pc.shot('during.png')
  out.env = await pc.evaluate(`window.workEncourager.getPetEnv()`)
  out.after = await pc.evaluate(`(() => {
    const canvas = document.querySelector('svg.kit canvas')
    const r = canvas.getBoundingClientRect()
    const g = document.querySelector('.whale-stage g.kit-g') || null
    return { inner: [innerWidth, innerHeight], canvasCss: [Math.round(r.width), Math.round(r.height)], hasKit: !!document.querySelector('svg.kit') }
  })()`)

  await pc.evaluate(`(async () => {
    const canvas = document.querySelector('svg.kit canvas')
    const r = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
    await new Promise((res) => setTimeout(res, 400))
    return true
  })()`)
  await pc.shot('dropped.png')

  out.poke = await pc.evaluate(`(async () => {
    const canvas = document.querySelector('svg.kit canvas')
    const r = canvas.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height * 0.55
    const opt = { bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: cx, clientY: cy }
    const before = document.querySelector('.pet-pill')?.innerText
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...opt, buttons: 1, screenX: window.screenX + cx, screenY: window.screenY + cy }))
    await new Promise((res) => setTimeout(res, 60))
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...opt, buttons: 0, screenX: window.screenX + cx, screenY: window.screenY + cy }))
    await new Promise((res) => setTimeout(res, 700))
    return { before, after: document.querySelector('.pet-pill')?.innerText }
  })()`)

  out.ok = true
} catch (e) {
  out.error = String(e)
} finally {
  try { child.kill() } catch {}
  spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' })
  console.log(JSON.stringify(out, null, 2))
}
