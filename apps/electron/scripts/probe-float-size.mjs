/**
 * 量浮窗卡片的真实高度：把窗口切到卡片高度，输出建议的窗口尺寸。
 * 用法：node scripts/probe-float-size.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const appDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//,'')), '..')
const electron = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const dataDir = path.join(os.tmpdir(), 'work-enc-float-size')
const port = 9371

const env = { ...process.env, WORK_ENC_DATA_DIR: dataDir }
delete env.ELECTRON_RUN_AS_NODE

async function waitForTargets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json()
      if (list.length) return list
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('CDP 没起来')
}

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.id !== id) return
      ws.removeEventListener('message', onMessage)
      if (data.error) reject(new Error(data.error.message))
      else resolve(data.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function main() {
  fs.rmSync(dataDir, { recursive: true, force: true })
  const child = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`], {
    cwd: appDir,
    env,
    stdio: 'ignore'
  })
  try {
    const targets = await waitForTargets()
    const main = targets.find((item) => item.type === 'page' && !item.url.includes('float'))
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
    await rpc(ws, 1, 'Runtime.enable', {})
    await rpc(ws, 2, 'Runtime.evaluate', {
      expression: '(async () => { await window.workEncourager.showFloat(); return true })()',
      awaitPromise: true
    })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const float = list.find((item) => item.url.includes('float'))
    const fws = new WebSocket(float.webSocketDebuggerUrl)
    await new Promise((resolve) => fws.addEventListener('open', resolve, { once: true }))
    await rpc(fws, 1, 'Runtime.enable', {})
    const result = await rpc(fws, 2, 'Runtime.evaluate', {
      expression:
        "JSON.stringify({inner:[innerWidth,innerHeight], card:[Math.round(document.querySelector('.float-card').getBoundingClientRect().width), Math.round(document.querySelector('.float-card').getBoundingClientRect().height)]})",
      returnByValue: true
    })
    console.log(result.result.value)
    ws.close()
    fws.close()
  } finally {
    child.kill()
  }
}

main().catch((error) => {
  console.error('FAIL', error.message)
  process.exit(1)
})
