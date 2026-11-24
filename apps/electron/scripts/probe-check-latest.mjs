import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = 'F:/DSH/work-encourager-repo/apps/electron'
const exe = join(root, 'release/win-unpacked/上班鼓励器.exe')
const dataDir = 'F:\\DSH\\.tmp\\pkg-ud-upd'
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
const port = 9527

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${dataDir}`], {
  env,
  stdio: 'ignore'
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitMain() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const main = list.find((t) => t.type === 'page' && !t.url.includes('pet') && !t.url.includes('float'))
      if (main) return main
    } catch {
      /* not ready */
    }
    await sleep(250)
  }
  return null
}

function rpc(ws, id, method, params) {
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 60000)
    const onMsg = (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
    ws.addEventListener('message', onMsg)
  })
}

const main = await waitMain()
if (!main) {
  console.log('RESULT: FAIL 主窗口没起来')
  child.kill()
  process.exit(1)
}

const ws = new WebSocket(main.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await rpc(ws, 1, 'Runtime.enable')
let seq = 10
const evaluate = async (expression) => {
  const res = await rpc(ws, (seq += 1), 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return res?.result?.value
}

await sleep(2500)
const info = await evaluate('window.workEncourager.checkUpdate()')
console.log('checkUpdate:', JSON.stringify(info).slice(0, 300))

await evaluate(
  `(() => {
     const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === '设置' || b.textContent.trim() === '设置')
     if (btn) btn.click()
   })()`
)
await sleep(1200)
const text = await evaluate('document.body.innerText')
const line = (text || '').split('\n').map((s) => s.trim()).filter((s) => s.includes('版本') || s.includes('更新')).slice(0, 6)
console.log('ui lines:', JSON.stringify(line, null, 1))

child.kill()
await sleep(400)
const ok = info && info.latestVersion === '1.5.0' && info.hasUpdate === false
console.log(ok ? 'RESULT: PASS 已是最新版本' : 'RESULT: FAIL')
process.exit(ok ? 0 : 1)
