// 截一张设置页「桌面形象」分组的图，人工核对排版
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '..')
const exe = join(root, 'src-tauri', 'target', 'release', 'work-encourager.exe')
const dataDir = process.env.WORK_ENC_DATA_DIR ?? join(root, '.probe', 'data-live2d')
const port = 9338

async function list() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

async function waitTarget(match, timeout = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const found = (await list()).find(match)
      if (found) return found
    } catch {
      /* 等端口 */
    }
    await sleep(300)
  }
  throw new Error('timeout')
}

function client(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let id = 0
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data)
    if (data.id && pending.has(data.id)) {
      const { resolve: ok, reject } = pending.get(data.id)
      pending.delete(data.id)
      data.error ? reject(new Error(data.error.message)) : ok(data.result)
    }
  })
  const ready = new Promise((ok) => ws.addEventListener('open', () => ok()))
  const send = (method, params = {}) => {
    const mid = ++id
    ws.send(JSON.stringify({ id: mid, method, params }))
    return new Promise((ok, reject) => pending.set(mid, { resolve: ok, reject }))
  }
  const evalx = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
    return r.result.value
  }
  return { ready, send, evalx, close: () => ws.close() }
}

const child = spawn(exe, [], {
  env: {
    ...process.env,
    WORK_ENC_DATA_DIR: dataDir,
    WEBVIEW2_USER_DATA_FOLDER: join(dataDir, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
  },
  stdio: 'ignore'
})

try {
  const mainT = await waitTarget((t) => t.type === 'page' && !t.url.includes('float.html') && !t.url.includes('pet.html'))
  const main = client(mainT.webSocketDebuggerUrl)
  await main.ready
  await main.send('Page.enable')
  let ready = false
  for (let i = 0; i < 60 && !ready; i += 1) {
    ready = (await main.evalx('!!document.querySelector(\'button[title="设置"]\')')) === true
    if (!ready) await sleep(300)
  }
  await main.evalx('document.querySelector(\'button[title="设置"]\').click()')
  await sleep(1200)
  const moved = await main.evalx(`(() => {
    const card = [...document.querySelectorAll('.section-title')].find((el) => el.textContent.includes('桌面形象'))
    if (!card) return 'not-found'
    card.scrollIntoView({ block: 'start' })
    return 'ok'
  })()`)
  await sleep(600)
  const shot = await main.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = join(root, '.probe', 'shots', 'tauri-settings-pet.png')
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log('scroll:', moved, 'saved:', file)
  main.close()
} catch (error) {
  console.log('failed:', error.message)
} finally {
  child.kill()
  await sleep(300)
}
