/**
 * 黑点诊断：打开宠物窗，把 GL 画布清屏改成不透明白色，观察鼻子处是否还发黑。
 * 用法：node scripts/inspect-nose.mjs [port]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9410)
const outDir = join(process.cwd(), '.probe', 'nose')
mkdirSync(outDir, { recursive: true })

const dataDir = process.env.WORK_ENC_PROBE_DATA || 'F:\\DSH\\.tmp\\import-data'
const env = { ...process.env, WORK_ENC_DATA_DIR: dataDir }
delete env.ELECTRON_RUN_AS_NODE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    return await res.json()
  } catch {
    return []
  }
}

async function waitTarget(match, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const hit = (await targets()).find((t) => t.type === 'page' && match(t))
    if (hit) return hit
    await sleep(300)
  }
  return null
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error('ws error ' + String(e.message || e)))
  })
}

let seq = 0
function call(ws, method, params = {}) {
  const id = (seq += 1)
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 20000)
    const onMessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      if (msg.error) reject(new Error(method + ': ' + msg.error.message))
      else resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
  })
}

async function evaluate(ws, expression) {
  const result = await call(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return result.result?.value
}

async function shot(ws, file) {
  const result = await call(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(file, Buffer.from(result.data, 'base64'))
}

async function main() {
  const child = spawn(join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'), [
    'out/main/index.js',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    `--remote-debugging-port=${port}`
  ], { env, stdio: 'ignore' })

  try {
    const mainTarget = await waitTarget((t) => /index\.html/.test(t.url))
    const mainWs = await connect(mainTarget.webSocketDebuggerUrl)
    for (let i = 0; i < 40; i += 1) {
      const ok = await evaluate(mainWs, `Boolean(document.querySelector('button[title="摸鱼小宠物"]'))`)
      if (ok) break
      await sleep(400)
    }
    await evaluate(mainWs, `document.querySelector('button[title="摸鱼小宠物"]').click()`)
    const petTarget = await waitTarget((t) => /pet\.html/.test(t.url))
    const petWs = await connect(petTarget.webSocketDebuggerUrl)
    for (let i = 0; i < 60; i += 1) {
      const ready = await evaluate(petWs, `Boolean(window.__live2d && window.__live2d.model)`)
      if (ready) break
      await sleep(400)
    }
    await sleep(800)
    await shot(petWs, join(outDir, 'transparent.png'))

    const info = await evaluate(petWs, `(() => {
      const app = window.__live2d.app
      const gl = app.renderer.gl
      return JSON.stringify({
        version: gl.getParameter(gl.VERSION),
        maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        alpha: gl.getContextAttributes(),
        background: app.renderer.background.alpha,
      })
    })()`)
    console.log('gl:', info)

    await evaluate(petWs, `(() => {
      const app = window.__live2d.app
      app.renderer.background.color = 0xffffff
      app.renderer.background.alpha = 1
      app.render()
      return true
    })()`)
    await sleep(600)
    await shot(petWs, join(outDir, 'opaque.png'))
    console.log('saved', outDir)
  } finally {
    child.kill()
  }
}

main().catch((error) => {
  console.error('FAIL', error.message)
  process.exitCode = 1
})
