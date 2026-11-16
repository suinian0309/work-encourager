/**
 * 找出画在鼻子位置上、面积最小的 drawable（黑方块嫌疑对象）。
 * 用法：node scripts/find-nose-drawable.mjs [port]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9420)
const dataDir = process.env.WORK_ENC_PROBE_DATA || 'F:\\DSH\\.tmp\\import-data'
const env = { ...process.env, WORK_ENC_DATA_DIR: dataDir }
delete env.ELECTRON_RUN_AS_NODE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
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
    ws.onerror = () => reject(new Error('ws error'))
  })
}

let seq = 0
function call(ws, method, params = {}) {
  const id = (seq += 1)
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 30000)
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
  const res = await call(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + JSON.stringify(res.exceptionDetails.exception?.description ?? ''))
  return res.result?.value
}

async function main() {
  const child = spawn(join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'), [
    'out/main/index.js',
    '--no-sandbox',
    `--remote-debugging-port=${port}`
  ], { env, stdio: 'ignore' })

  try {
    const mainTarget = await waitTarget((t) => /index\.html/.test(t.url))
    const mainWs = await connect(mainTarget.webSocketDebuggerUrl)
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate(mainWs, `Boolean(document.querySelector('button[title="摸鱼小宠物"]'))`)) break
      await sleep(400)
    }
    await evaluate(mainWs, `document.querySelector('button[title="摸鱼小宠物"]').click()`)
    const petTarget = await waitTarget((t) => /pet\.html/.test(t.url))
    const petWs = await connect(petTarget.webSocketDebuggerUrl)
    for (let i = 0; i < 60; i += 1) {
      if (await evaluate(petWs, `Boolean(window.__live2d && window.__live2d.model)`)) break
      await sleep(400)
    }
    await sleep(1000)

    const report = await evaluate(petWs, `(() => {
      const model = window.__live2d.model
      const core = model.internalModel.coreModel
      const drawables = core._model.drawables
      const keys = Object.keys(drawables)
      const info = { keys }
      const vp = drawables.vertexPositions
      info.vpType = Object.prototype.toString.call(vp)
      info.vpLen = vp && vp.length
      info.vc = drawables.vertexCounts && drawables.vertexCounts.length
      info.dc = drawables.dynamicFlags && drawables.dynamicFlags.length
      info.texNo = Array.from(drawables.textureIndices || []).slice(0, 12)
      info.maskCounts = Array.from(drawables.maskCounts || []).slice(0, 12)
      // 每个 drawable 的顶点数（用于定位 flat 数组里的偏移）
      info.counts = Array.from(drawables.vertexCounts || []).slice(0, 12)
      info.firstVp = vp && vp[0] && Array.from(vp[0]).slice(0, 8)
      return JSON.stringify(info)
    })()`)
    console.log(report.slice(0, 2000))
  } finally {
    child.kill()
  }
}

main().catch((error) => {
  console.error('FAIL', error.message)
  process.exitCode = 1
})
