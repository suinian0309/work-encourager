// 诊断：Tauri 宠物窗里 Live2D 是否真的加载（协议、模型、错误文本）
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const exe = join(root, 'src-tauri', 'target', 'release', 'work-encourager.exe')
const dataDir = process.env.WORK_ENC_DATA_DIR ?? join(root, '.probe', 'data-live2d')
const port = 9337

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return response.json()
}

async function waitForTarget(match, timeout = 25000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const found = (await targets()).find(match)
      if (found) return found
    } catch {
      /* 等端口 */
    }
    await sleep(300)
  }
  throw new Error('等待调试目标超时')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let id = 0
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data)
    if (data.id && pending.has(data.id)) {
      const { resolve: done, reject } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) reject(new Error(data.error.message))
      else done(data.result)
    }
  })
  const ready = new Promise((done) => ws.addEventListener('open', () => done()))
  const send = (method, params = {}) => {
    const messageId = ++id
    ws.send(JSON.stringify({ id: messageId, method, params }))
    return new Promise((done, reject) => pending.set(messageId, { resolve: done, reject }))
  }
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description ?? ''))
    }
    return result.result.value
  }
  return { send, ready, evaluate, close: () => ws.close() }
}

const child = spawn(exe, [], {
  env: {
    ...process.env,
    WORK_ENC_DATA_DIR: dataDir,
    WEBVIEW2_USER_DATA_FOLDER: join(dataDir, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
  },
  stdio: 'ignore'
})

let main
let pet
try {
  const mainTarget = await waitForTarget(
    (item) => item.type === 'page' && !item.url.includes('float.html') && !item.url.includes('pet.html')
  )
  main = connect(mainTarget.webSocketDebuggerUrl)
  await main.ready
  await main.send('Runtime.enable')
  for (let i = 0; i < 60; i += 1) {
    if (await main.evaluate('!!document.querySelector(\'button[title="摸鱼小宠物"]\')')) break
    await sleep(400)
  }
  const hasBtn = await main.evaluate('!!document.querySelector(\'button[title="摸鱼小宠物"]\')')
  if (!hasBtn) {
    console.log('main title:', await main.evaluate('document.title'))
    console.log('main body:', (await main.evaluate('document.body.innerText')).slice(0, 300))
  }
  await main.evaluate('document.querySelector(\'button[title="摸鱼小宠物"]\')?.click()')

  const petTarget = await waitForTarget((item) => item.url.includes('pet.html'))
  pet = connect(petTarget.webSocketDebuggerUrl)
  await pet.ready
  await pet.send('Runtime.enable')
  await pet.send('Log.enable')
  await sleep(3000)

  const style = await pet.evaluate('(async () => JSON.stringify(await window.workEncourager.getPetStyle()))()')
  console.log('style:', style)
  console.log('error text:', await pet.evaluate('document.querySelector(".live2d-error")?.textContent ?? ""'))
  console.log('loading text:', await pet.evaluate('document.querySelector(".live2d-loading")?.textContent ?? ""'))
  console.log('stage html:', (await pet.evaluate('document.querySelector(".pet-stage")?.innerHTML ?? ""')).slice(0, 300))
  console.log(
    'model3 status:',
    await pet.evaluate(`(async () => {
      const info = await window.workEncourager.getPetStyle()
      const base = 'http://live2d.localhost/' + info.model.id + '/'
      const res = await fetch(base + 'model3.json')
      const text = await res.text()
      return JSON.stringify({ base, status: res.status, len: text.length, head: text.slice(0, 120) })
    })()`)
  )
  console.log(
    'moc3 head:',
    await pet.evaluate(`(async () => {
      const info = await window.workEncourager.getPetStyle()
      const res = await fetch('http://live2d.localhost/' + info.model.id + '/model.moc3')
      const buf = await res.arrayBuffer()
      return JSON.stringify({ status: res.status, bytes: buf.byteLength })
    })()`)
  )
  console.log('has model:', await pet.evaluate('!!window.__live2d'))
} catch (error) {
  console.log('probe failed:', error.message)
} finally {
  main?.close()
  pet?.close()
  child.kill()
  await sleep(300)
}
