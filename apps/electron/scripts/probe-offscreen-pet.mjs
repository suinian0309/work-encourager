/** 临时探针：预置离屏 petBounds，验证打包版 Electron 打开宠物窗时会夹回工作区。 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

const port = Number(process.argv[2] ?? 9499)
const dataDir = 'F:\\DSH\\.tmp\\el-offscreen'
const exe = join(process.cwd(), 'release', 'win-unpacked', '上班鼓励器.exe')
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, 'work-encourager.json')
if (existsSync(dbPath)) {
  const db = JSON.parse(readFileSync(dbPath, 'utf8'))
  db.petBounds = { x: 9000, y: 9000 }
  writeFileSync(dbPath, JSON.stringify(db, null, 2))
  console.log('seeded petBounds 9000,9000')
}
const env = { ...process.env, WORK_ENC_DATA_DIR: dataDir }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dataDir, 'ud')}`], { env, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return [] } }
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
  send(method, params) { const my = ++this.id; return new Promise((res) => { this.pending.set(my, res); this.ws.send(JSON.stringify({ id: my, method, params })) }) }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return r.result?.result?.value
  }
}

const main = await waitTarget((t) => !t.url.includes('pet.html') && !t.url.includes('float'))
if (!main) { console.log('no main target'); child.kill(); process.exit(1) }
const c1 = new Client(main.webSocketDebuggerUrl)
await c1.ready
await c1.send('Runtime.enable', {})
await sleep(1200)
const clicked = await c1.eval(`(async () => { for (let i = 0; i < 80; i++) { const b = document.querySelector('button[title="摸鱼小宠物"]'); if (b) { b.click(); return 'clicked' } await new Promise(r => setTimeout(r, 100)) } return 'no-button' })()`)
await sleep(2000)
const petT = await waitTarget((t) => t.url.includes('pet.html'), 15000)
let env2 = null
if (petT) {
  const c2 = new Client(petT.webSocketDebuggerUrl)
  await c2.ready
  await c2.send('Runtime.enable', {})
  env2 = await c2.eval(`JSON.stringify(window.workEncourager.getPetEnv().then(v => v))`)
  env2 = await c2.eval(`(async () => JSON.stringify(await window.workEncourager.getPetEnv()))()`)
}
console.log(JSON.stringify({ clicked, petTarget: !!petT, env: env2 }, null, 2))
child.kill()
process.exit(0)
