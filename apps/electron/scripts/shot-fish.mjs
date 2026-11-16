import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const appDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..')
const electron = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const dataDir = 'F:\\DSH\\.tmp\\fish-data'
const outDir = path.join(appDir, '.probe')
const port = 9381

fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const env = { ...process.env, WORK_ENC_DATA_DIR: dataDir }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['./out/main/index.js', '--no-sandbox', `--remote-debugging-port=${port}`], {
  cwd: appDir,
  env,
  stdio: 'ignore'
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function list() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return response.json()
}

function call(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const data = JSON.parse(event.data)
      if (data.id !== id) return
      ws.removeEventListener('message', handler)
      if (data.error) reject(new Error(data.error.message))
      else resolve(data.result)
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  await call(ws, 1, 'Runtime.enable', {})
  await call(ws, 2, 'Page.enable', {})
  return ws
}

try {
  let targets = []
  for (let i = 0; i < 40 && !targets.length; i += 1) {
    try {
      targets = await list()
    } catch {
      await sleep(400)
    }
  }
  const main = targets.find((t) => t.type === 'page' && !t.url.includes('float'))
  const ws = await connect(main)
  await call(ws, 3, 'Runtime.evaluate', {
    expression: "(async () => { await window.workEncourager.setPetStyle('mochi'); await window.workEncourager.showPet(); return 1 })()",
    awaitPromise: true
  })
  await sleep(1500)
  targets = await list()
  const pet = targets.find((t) => t.url.includes('pet.html'))
  const pws = await connect(pet)
  const shot = await call(pws, 4, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  })
  fs.writeFileSync(path.join(outDir, 'fish.png'), Buffer.from(shot.data, 'base64'))
  const size = await call(pws, 5, 'Runtime.evaluate', {
    expression: 'JSON.stringify([innerWidth, innerHeight])',
    returnByValue: true
  })
  console.log('pet window', size.result.value)
  ws.close()
  pws.close()
} finally {
  child.kill()
}
