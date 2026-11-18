/**
 * 临时探针：Tauri 打包版里把宠物甩出去，验证撞边反弹 + 落地后走回原位。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9511)
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

const mainT = await waitTarget((t) => t.url.includes('tauri.localhost/') && !t.url.includes('pet.html'))
if (!mainT) { console.log('no main target'); child.kill(); process.exit(1) }
const main = new Client(mainT.webSocketDebuggerUrl)
await main.ready
await main.send('Runtime.enable', {})
await sleep(2500)
const clicked = await main.eval(`(async () => { for (let i = 0; i < 120; i++) { const b = document.querySelector('button[title="摸鱼小宠物"]'); if (b) { b.click(); return 'clicked' } await new Promise(r => setTimeout(r, 100)) } return 'no-button' })()`)

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
  const start = { x: env0.x, y: env0.y }
  fire('pointerdown', start.x + 80, start.y + 120)
  await new Promise(r => setTimeout(r, 80))
  let x = start.x + 80
  let y = start.y + 120
  for (let i = 0; i < 10; i++) {
    x += 90
    y += 26
    fire('pointermove', x, y)
    await new Promise(r => setTimeout(r, 16))
  }
  fire('pointerup', x, y)
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
  const timeline = samples.filter((_, i) => i % 10 === 0).map(s => \`\${s.x} \${s.y} \${s.st && s.st.flying ? 'fly' : s.st && s.st.walking ? 'walk' : 'idle'}\`)
  return { env0, envEnd, inside, settled, home, timeline }
})()`)

console.log(JSON.stringify({ clicked, ...result }, null, 2))
child.kill()
process.exit(0)
