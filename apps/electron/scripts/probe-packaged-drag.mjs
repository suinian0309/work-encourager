/**
 * 临时探针：打包后的 Electron (win-unpacked) 里，宠物拖动是否还被裁、点击是否 +1。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9481)
const exe = join(process.cwd(), 'release', 'win-unpacked', '上班鼓励器.exe')
const env = { ...process.env, WORK_ENC_DATA_DIR: 'F:\\DSH\\.tmp\\pkg-data-142' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, '--user-data-dir=F:\\DSH\\.tmp\\pkg-ud-142'], { env, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = async () => {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return [] }
}
async function waitTarget(match, timeout = 45000) {
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
    if (res.result?.exceptionDetails) return { __error: JSON.stringify(res.result.exceptionDetails).slice(0, 300) }
    return res.result?.result?.value
  }
}

const out = {}
try {
  const main = await waitTarget((t) => t.url.includes('index.html'))
  const mc = new Client(main.webSocketDebuggerUrl)
  await mc.ready
  await mc.send('Runtime.enable')
  out.clicked = await mc.evaluate(`(async () => {
    for (let i = 0; i < 150; i++) {
      const b = document.querySelector('button[title="摸鱼小宠物"]')
      if (b) { b.click(); return true }
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  })()`)
  const pet = await waitTarget((t) => t.url.includes('pet.html'), 8000)
  out.petTarget = !!pet
  if (pet) {
    const pc = new Client(pet.webSocketDebuggerUrl)
    await pc.ready
    await pc.send('Runtime.enable')
    await sleep(2000)
    out.drag = await pc.evaluate(`(async () => {
      const canvas = document.querySelector('svg.kit canvas')
      const petG = document.querySelector('svg.kit').children[1]
      const r = canvas.getBoundingClientRect()
      const cx = r.left + r.width / 2, cy = r.top + r.height * 0.55
      const mk = (type, x, y, sx, sy, buttons) => new PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons, clientX: x, clientY: y, screenX: sx, screenY: sy })
      const sx = window.screenX + cx, sy = window.screenY + cy
      const start = petG.getAttribute('transform')
      canvas.dispatchEvent(mk('pointerdown', cx, cy, sx, sy, 1))
      await new Promise((res) => setTimeout(res, 120))
      for (let i = 1; i <= 3; i++) { canvas.dispatchEvent(mk('pointermove', cx + i * 8, cy + i * 2, sx + i * 8, sy + i * 2, 1)); await new Promise((res) => setTimeout(res, 70)) }
      const grabbed = petG.getAttribute('transform')
      for (let i = 1; i <= 12; i++) { canvas.dispatchEvent(mk('pointermove', cx + 24, cy + 6, sx + 24 + i * 6, sy + 6 + i * 2, 1)); await new Promise((res) => setTimeout(res, 70)) }
      const during = petG.getAttribute('transform')
      canvas.dispatchEvent(mk('pointerup', cx + 24, cy + 6, sx + 96, sy + 30, 0))
      await new Promise((res) => setTimeout(res, 500))
      const inner = [innerWidth, innerHeight]
      const pillBefore = document.querySelector('.pet-pill')?.innerText
      canvas.dispatchEvent(mk('pointerdown', cx, cy, sx, sy, 1))
      await new Promise((res) => setTimeout(res, 60))
      canvas.dispatchEvent(mk('pointerup', cx, cy, sx, sy, 0))
      await new Promise((res) => setTimeout(res, 800))
      return { start, grabbed, during, inner, pillBefore, pillAfter: document.querySelector('.pet-pill')?.innerText }
    })()`)
  }
} catch (e) {
  out.error = String(e)
} finally {
  try { child.kill() } catch {}
  spawn('taskkill', ['/F', '/IM', '上班鼓励器.exe'], { stdio: 'ignore' })
  console.log(JSON.stringify(out, null, 2))
}
