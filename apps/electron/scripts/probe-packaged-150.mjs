import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = 'F:/DSH/work-encourager-repo/apps/electron'
const exe = join(root, 'release/win-unpacked/上班鼓励器.exe')
const dataDir = 'F:\\DSH\\.tmp\\pkg-ud-150'
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
const port = 9521

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${dataDir}`], {
  env,
  stdio: 'ignore'
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

async function waitMain() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await targets()
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
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000)
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

const evaluate = async (expression, id) => {
  const res = await rpc(ws, id, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return res?.result?.value
}

await sleep(2500)
const version = await evaluate('window.workEncourager.getAppVersion()', 2)
console.log('appVersion:', version)

// 打开设置页，读「关于与更新」分组
await evaluate(
  `(() => {
     const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === '设置' || b.textContent.trim() === '设置')
     if (btn) { btn.click(); return 'clicked' }
     return 'no-settings-button'
   })()`,
  3
)
await sleep(1200)
const text = await evaluate('document.body.innerText', 4)
const hasAbout = /关于与更新/.test(text || '')
const versionLine = (text || '').split('\n').find((line) => line.includes('当前版本')) || ''
const hasCheck = /检查更新/.test(text || '')
console.log('settingsHasAbout:', hasAbout)
console.log('versionLine:', versionLine.trim())
console.log('hasCheckButton:', hasCheck)

child.kill()
await sleep(500)
const ok = hasAbout && hasCheck && /1\.5\.0/.test(versionLine)
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(ok ? 0 : 1)
