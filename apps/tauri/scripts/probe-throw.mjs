/**
 * 临时探针：Tauri 打包版里把宠物甩出去，验证歪斜、撞边反弹、落地晕倒、醒后走回原位。
 * 输出：maxTilt（拖动期间身体歪斜角度）、dizzySeen / walkSeen、窗口位置采样、inside / settled。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9521)
const exe = join(process.cwd(), 'src-tauri', 'target', 'release', 'work-encourager.exe')
const dataDir = 'F:\\DSH\\.tmp\\tauri-throw'
const env = {
  ...process.env,
  WORK_ENC_DATA_DIR: dataDir,
  WEBVIEW2_USER_DATA_FOLDER: join(dataDir, 'wv'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
}
const child = spawn(exe, [], { env, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch {
    return []
  }
}
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
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = rej
    })
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      const p = this.pending.get(m.id)
      if (p) {
        this.pending.delete(m.id)
        p(m)
      }
    }
  }
  send(method, params) {
    const my = ++this.id
    return new Promise((res) => {
      this.pending.set(my, res)
      this.ws.send(JSON.stringify({ id: my, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const ex = r.result?.exceptionDetails
    if (ex) throw new Error(ex.exception?.description || ex.text)
    return r.result?.result?.value
  }
}

const mainT = await waitTarget((t) => t.url.includes('tauri.localhost/') && !t.url.includes('pet.html'))
if (!mainT) {
  console.log('no main target')
  child.kill()
  process.exit(1)
}
const main = new Client(mainT.webSocketDebuggerUrl)
await main.ready
await main.send('Runtime.enable', {})
await sleep(2500)
const clicked = await main.eval(`(async () => {
  for (let i = 0; i < 120; i++) {
    const b = document.querySelector('button[title="摸鱼小宠物"]')
    if (b) { b.click(); return 'clicked' }
    await new Promise(r => setTimeout(r, 100))
  }
  return 'no-button'
})()`)

const petT = await waitTarget((t) => t.url.includes('pet.html'), 20000)
if (!petT) {
  console.log(JSON.stringify({ clicked, pet: false }))
  child.kill()
  process.exit(0)
}
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
  const wait = (ms) => new Promise(r => setTimeout(r, ms))

  const start = { x: env0.x, y: env0.y }
  grab(start.x + 80, start.y + 120)
  await wait(80)
  let x = start.x + 80
  let y = start.y + 120
  let maxTilt = 0
  for (let i = 0; i < 8; i++) {
    x -= 40
    y -= 70
    move(x, y)
    await wait(40)
    const st = window.__petState ? window.__petState() : null
    if (st && typeof st.tilt === 'number') maxTilt = Math.max(maxTilt, Math.abs(st.tilt))
  }
  for (let i = 0; i < 8; i++) {
    x += 120
    y += 40
    move(x, y)
    await wait(30)
    const st = window.__petState ? window.__petState() : null
    if (st && typeof st.tilt === 'number') maxTilt = Math.max(maxTilt, Math.abs(st.tilt))
  }
  release(x, y)

  const samples = []
  const modes = new Set()
  let dizzySeen = false
  let walkSeen = false
  for (let i = 0; i < 150; i++) {
    await wait(100)
    const e = await api.getPetEnv()
    const st = window.__petState ? window.__petState() : null
    if (st) {
      if (st.dizzy) dizzySeen = true
      if (st.walking) walkSeen = true
      if (st.mode) modes.add(String(st.mode))
    }
    samples.push({ x: e.x, y: e.y, st })
  }
  const envEnd = await api.getPetEnv()
  const wa = envEnd.workArea
  const inside = samples.every(s => s.x >= wa.x && s.y >= wa.y && s.x + envEnd.width <= wa.x + wa.width && s.y + envEnd.height <= wa.y + wa.height)
  const tail = samples.slice(-8)
  const settled = tail.every(s => Math.hypot(s.x - env0.x, s.y - env0.y) < 14)
  return {
    env0,
    maxTilt,
    dizzySeen,
    walkSeen,
    modes: [...modes],
    samples: samples.filter((_, i) => i % 10 === 0).map(s => ({ x: s.x, y: s.y, flying: !!(s.st && s.st.flying), walking: !!(s.st && s.st.walking), dizzy: !!(s.st && s.st.dizzy) })),
    envEnd, inside, settled
  }
})()`)

console.log(JSON.stringify({ clicked, ...result }, null, 2))
child.kill()
process.exit(0)
