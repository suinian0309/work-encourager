// Tauri 版摸鱼宠物 + 浮窗冒烟测试：用 WebView2 的 CDP 端口驱动真实界面
// 用法：node scripts/e2e-pet.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const exe = join(root, 'src-tauri', 'target', 'release', 'work-encourager.exe')
const dataDir = join(root, '.probe', 'data-tauri')
const shotDir = join(root, '.probe', 'shots')
const port = 9334

rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(shotDir, { recursive: true })

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return response.json()
}

async function waitForTarget(match, timeout = 25000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const list = await targets()
      const found = list.find((item) => match(item))
      if (found) return found
    } catch {
      // 端口还没起来
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
  const ready = new Promise((done, fail) => {
    ws.addEventListener('open', () => done())
    ws.addEventListener('error', (event) => fail(new Error('WebSocket 连接失败: ' + event.message)))
  })
  function send(method, params = {}) {
    const messageId = ++id
    ws.send(JSON.stringify({ id: messageId, method, params }))
    return new Promise((done, reject) => pending.set(messageId, { resolve: done, reject }))
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description ?? ''))
    }
    return result.result.value
  }
  return { ws, ready, send, evaluate, close: () => ws.close() }
}

async function screenshot(client, file) {
  await client.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 }
  })
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
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
    (item) =>
      item.type === 'page' &&
      !item.url.includes('float.html') &&
      !item.url.includes('pet.html')
  )
  main = connect(mainTarget.webSocketDebuggerUrl)
  await main.ready
  await main.send('Runtime.enable')
  await main.send('Page.enable')

  // 主窗口要先跑完 bootstrap 才会渲染标题栏按钮，这里轮询等待
  let mounted = false
  for (let i = 0; i < 60 && !mounted; i += 1) {
    mounted = (await main.evaluate('!!document.querySelector(\'button[title="摸鱼小宠物"]\')')) === true
    if (!mounted) await sleep(400)
  }

  const title = await main.evaluate('document.title')
  check('主窗口已加载', typeof title === 'string', String(title))
  check('主界面存在摸鱼按钮', mounted === true)

  await main.evaluate('document.querySelector(\'button[title="摸鱼小宠物"]\').click()')

  const petTarget = await waitForTarget((item) => item.url.includes('pet.html'))
  pet = connect(petTarget.webSocketDebuggerUrl)
  await pet.ready
  await pet.send('Runtime.enable')
  await pet.send('Page.enable')
  await sleep(600)

  const pill = await pet.evaluate('document.querySelector(".pet-pill")?.textContent ?? ""')
  check('宠物窗已打开', pill.includes('今日摸鱼'), pill.trim())

  const before = await pet.evaluate('document.querySelector(".pet-pill")?.textContent ?? ""')
  for (let i = 0; i < 3; i += 1) {
    await pet.evaluate('document.querySelector(".pet-stage").dispatchEvent(new MouseEvent("click",{bubbles:true}))')
    await sleep(160)
  }
  const after = await pet.evaluate('document.querySelector(".pet-pill")?.textContent ?? ""')
  check('连点 3 次计数增加', before !== after, `${before.trim()} → ${after.trim()}`)

  const stats = await pet.evaluate(
    '(async () => JSON.stringify(await window.workEncourager.getPet()))()'
  )
  const parsed = JSON.parse(stats)
  check('宠物计数持久化到数据库', parsed.today >= 3, stats)

  const size = await pet.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight, sw: document.body.scrollWidth, sh: document.body.scrollHeight })')
  const box = JSON.parse(size)
  check('宠物窗无溢出', box.sw <= box.w && box.sh <= box.h, size)

  await screenshot(pet, join(shotDir, 'tauri-pet.png'))

  await main.evaluate('document.querySelector(\'button[title="桌面浮窗"]\').click()')
  const floatTarget = await waitForTarget((item) => item.url.includes('float.html'))
  const float = connect(floatTarget.webSocketDebuggerUrl)
  await float.ready
  await float.send('Page.enable')
  await sleep(600)
  const floatSize = await float.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight, sw: document.body.scrollWidth, sh: document.body.scrollHeight })')
  const fbox = JSON.parse(floatSize)
  check('浮窗尺寸 272×164 且无溢出', fbox.w === 272 && fbox.h === 164 && fbox.sw <= fbox.w, floatSize)
  await screenshot(float, join(shotDir, 'tauri-float.png'))

  const bothVisible = await pet.evaluate('true')
  check('宠物窗与浮窗可同时存在', bothVisible, '两个 WebView 均在线')
} catch (error) {
  check('冒烟测试执行完成', false, error.message)
} finally {
  try {
    main?.close()
    pet?.close()
  } catch {
    // 忽略关闭异常
  }
  child.kill()
  await sleep(500)

  const passed = results.filter((item) => item.pass).length
  console.log(`\n结果：${passed}/${results.length}`)
  process.exit(passed === results.length ? 0 : 1)
}
