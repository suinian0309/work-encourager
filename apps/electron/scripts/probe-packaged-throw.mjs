/**
 * 临时探针：把宠物甩出去，看窗口是不是撞在屏幕边缘弹回来、落地后自己走回原位。
 * 输出：飞行过程中的窗口位置采样（应始终在工作区内）、最终位置（应贴近 home）。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9501)
const exe = join(process.cwd(), 'release', 'win-unpacked', '上班鼓励器.exe')
const env = { ...process.env, WORK_ENC_DATA_DIR: 'F:\\DSH\\.tmp\\throw-data' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, '--user-data-dir=F:\\DSH\\.tmp\\pkg-ud-throw'], { env, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return [] } }
async function waitTarget(match, timeout = 45000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const hit = (await list()).find((t) => t.type === 'page' && match(t))
    if (hit) return hit
    await sleep(250)
  }
  return null
}
class Client {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m) } }
  }
  send(method, params) { const my = ++this.id; return new Promise((res) => { this.pending.set(my, res); this.ws.send(JSON.stringify({ id: my, method, params })) }) }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const ex = r.result?.exceptionDetails
    if (ex) throw new Error(ex.exception?.description || ex.text)
    return r.result?.result?.value
  }
}

const mainT = await waitTarget((t) => !t.url.includes('pet.html') && !t.url.includes('float'))
if (!mainT) { console.log('no main target'); child.kill(); process.exit(1) }
const main = new Client(mainT.webSocketDebuggerUrl)
await main.ready
await main.send('Runtime.enable', {})
await sleep(1500)
const clicked = await main.eval(`(async () => { for (let i = 0; i < 100; i++) { const b = document.querySelector('button[title="摸鱼小宠物"]'); if (b) { b.click(); return 'clicked' } await new Promise(r => setTimeout(r, 100)) } return 'no-button' })()`)

const petT = await waitTarget((t) => t.url.includes('pet.html'), 20000)
if (!petT) { console.log(JSON.stringify({ clicked, pet: false })); child.kill(); process.exit(0) }
const pet = new Client(petT.webSocketDebuggerUrl)
await pet.ready
await pet.send('Runtime.enable', {})
await sleep(2500)

const result = await pet.eval(`(async () => {
  const api = window.workEncourager
  const env0 = await api.getPetEnv()
  const stage = document.querySelector('.whale-stage')
  const canvas = stage.querySelector('canvas') || stage
  const fire = (type, sx, sy) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    clientX: 100, clientY: 200, screenX: sx, screenY: sy, buttons: type === 'pointerup' ? 0 : 1
  }))
  const grab = (x, y) => fire('pointerdown', x, y)
  const move = (x, y) => fire('pointermove', x, y)
  const release = (x, y) => fire('pointerup', x, y)

  const start = { x: env0.x, y: env0.y }
  grab(start.x + 80, start.y + 120)
  await new Promise(r => setTimeout(r, 80))
  let x = start.x + 80
  let y = start.y + 120
  for (let i = 0; i < 10; i++) {
    x += 90
    y += 26
    move(x, y)
    await new Promise(r => setTimeout(r, 16))
  }
  release(x, y)

  const samples = []
  for (let i = 0; i < 130; i++) {
    await new Promise(r => setTimeout(r, 100))
    const e = await api.getPetEnv()
    samples.push({ x: e.x, y: e.y, st: window.__petState ? window.__petState() : null })
  }
  const envEnd = await api.getPetEnv()
  const wa = envEnd.workArea
  const inside = samples.every(s => s.x >= wa.x && s.y >= wa.y && s.x + envEnd.width <= wa.x + wa.width && s.y + envEnd.height <= wa.y + wa.height)
  const home = { x: wa.x + wa.width - envEnd.width - 40, y: wa.y + wa.height - envEnd.height - 80 }
  const tail = samples.slice(-8)
  const settled = tail.every(s => Math.hypot(s.x - env0.x, s.y - env0.y) < 14)
  return { env0, samples: samples.filter((_, i) => i % 10 === 0).map(s => ({ x: s.x, y: s.y, flying: !!(s.st && s.st.flying), walking: !!(s.st && s.st.walking), home: s.st && s.st.home, area: s.st && s.st.area, win: s.st && s.st.win })), envEnd, inside, settled, home }
})()`)

console.log(JSON.stringify({ clicked, ...result }, null, 2))
child.kill()
process.exit(0)
