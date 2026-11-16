// 直接验证 Electron 宠物窗的点击链路（不依赖 e2e 脚本假设）
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const dataDir = join(root, '.probe', 'data-tap')
const port = 9341

const env = { ...process.env, WORK_ENC_DATA_DIR: dataDir }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['out/main/index.js', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`], {
  cwd: root,
  env,
  stdio: 'ignore'
})

async function list() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

async function waitTarget(match) {
  for (let i = 0; i < 60; i += 1) {
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

try {
  const mainT = await waitTarget((t) => t.url.includes('index.html'))
  const main = client(mainT.webSocketDebuggerUrl)
  await main.ready
  for (let i = 0; i < 60; i += 1) {
    if (await main.evalx('!!document.querySelector(\'button[title="摸鱼小宠物"]\')')) break
    await sleep(300)
  }
  await main.evalx('document.querySelector(\'button[title="摸鱼小宠物"]\').click()')
  const petT = await waitTarget((t) => t.url.includes('pet.html'))
  const pet = client(petT.webSocketDebuggerUrl)
  await pet.ready
  await sleep(1200)
  console.log('has svg:', await pet.evalx('!!document.querySelector(".pet-svg")'))
  console.log('has canvas:', await pet.evalx('!!document.querySelector(".pet-stage canvas")'))
  console.log('direct tapPet:', JSON.stringify(await pet.evalx('(async () => { try { return await window.workEncourager.tapPet() } catch (e) { return { error: String(e && e.message || e) } } })()')))
  console.log('after direct:', await pet.evalx('document.querySelector(".pet-pill")?.textContent?.trim()'))
  await pet.evalx('document.querySelector(".pet-svg")?.click()')
  await sleep(500)
  console.log('after svg click:', await pet.evalx('document.querySelector(".pet-pill")?.textContent?.trim()'))
  pet.close()
  main.close()
} catch (error) {
  console.log('probe failed:', error.message)
} finally {
  child.kill()
  await sleep(300)
}
