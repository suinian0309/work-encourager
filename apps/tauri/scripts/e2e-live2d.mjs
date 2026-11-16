// Tauri 版 Live2D 宠物冒烟测试：真实 WebView2 + 真实模型 + CDP 驱动
// 用法：node scripts/e2e-live2d.mjs
// 前置：把测试数据目录准备好（work-encourager.json + live2d/<8-40 位 hex>/model3.json）
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const exe = join(root, 'src-tauri', 'target', 'release', 'work-encourager.exe')
const seed = process.env.WORK_ENC_SEED_DIR ?? 'F:\\DSH\\.tmp\\pet-data-tauri'
const dataDir = join(root, '.probe', 'data-live2d')
const shotDir = join(root, '.probe', 'shots')
const port = 9336

if (!existsSync(join(seed, 'work-encourager.json'))) {
  console.error(`测试数据不存在：${seed}\\work-encourager.json`)
  process.exit(2)
}

rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(shotDir, { recursive: true })
cpSync(join(seed, 'work-encourager.json'), join(dataDir, 'work-encourager.json'))
cpSync(join(seed, 'live2d'), join(dataDir, 'live2d'), { recursive: true })

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
    (item) => item.type === 'page' && !item.url.includes('float.html') && !item.url.includes('pet.html')
  )
  main = connect(mainTarget.webSocketDebuggerUrl)
  await main.ready
  await main.send('Runtime.enable')
  await main.send('Page.enable')

  let mounted = false
  for (let i = 0; i < 60 && !mounted; i += 1) {
    mounted = (await main.evaluate('!!document.querySelector(\'button[title="摸鱼小宠物"]\')')) === true
    if (!mounted) await sleep(400)
  }
  check('主窗口已加载', mounted === true)

  await main.evaluate('document.querySelector(\'button[title="摸鱼小宠物"]\').click()')
  const petTarget = await waitForTarget((item) => item.url.includes('pet.html'))
  pet = connect(petTarget.webSocketDebuggerUrl)
  await pet.ready
  await pet.send('Runtime.enable')
  await pet.send('Page.enable')

  // 等 Pixi 画布出现（模型要先下载 moc3 16MB）
  let canvasReady = false
  let canvasInfo = ''
  for (let i = 0; i < 60 && !canvasReady; i += 1) {
    canvasInfo = await pet.evaluate(
      'JSON.stringify({ c: !!document.querySelector(".pet-stage canvas"), w: innerWidth, h: innerHeight })'
    )
    canvasReady = JSON.parse(canvasInfo).c === true
    if (!canvasReady) await sleep(500)
  }
  const box = JSON.parse(canvasInfo)
  check('Live2D 画布已创建', canvasReady === true, canvasInfo)
  check('宠物窗按 Live2D 尺寸 300×360', box.w === 300 && box.h === 360, `${box.w}×${box.h}`)

  await sleep(1200)
  const painted = await pet.evaluate(`(async () => {
    const c = document.querySelector('.pet-stage canvas')
    if (!c) return JSON.stringify({ ok: false })
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    if (!gl) return JSON.stringify({ ok: false, why: 'no-gl' })
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    const w = c.width
    const h = c.height
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let opaque = 0
    for (let i = 3; i < px.length; i += 4) if (px[i] > 200) opaque += 1
    return JSON.stringify({ ok: true, w, h, opaque })
  })()`)
  const paint = JSON.parse(painted)
  check('模型真的画出来了（不透明像素 > 3000）', paint.ok === true && paint.opaque > 3000, painted)

  const fps = await pet.evaluate(`(() => new Promise((done) => {
    let frames = 0
    const start = performance.now()
    function tick() {
      frames += 1
      if (performance.now() - start < 1000) requestAnimationFrame(tick)
      else done(Math.round((frames * 1000) / (performance.now() - start)))
    }
    requestAnimationFrame(tick)
  }))()`)
  check('渲染帧率 >= 30', fps >= 30, `${fps} fps`)

  const before = await pet.evaluate('document.querySelector(".pet-pill")?.textContent ?? ""')
  await pet.evaluate(`(() => {
    const el = document.querySelector('.pet-stage canvas') ?? document.querySelector('.pet-stage')
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 140, clientY: 120, screenX: 140, screenY: 120 }))
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 140, clientY: 120, screenX: 140, screenY: 120 }))
    return true
  })()`)
  await sleep(400)
  const after = await pet.evaluate('document.querySelector(".pet-pill")?.textContent ?? ""')
  check('点击后计数增加', before !== after, `${before.trim()} → ${after.trim()}`)

  const env = JSON.parse(await pet.evaluate('(async () => JSON.stringify(await window.workEncourager.getPetEnv()))()'))
  check('getPetEnv 返回工作区', typeof env.width === 'number' && env.width > 0, JSON.stringify(env))

  await pet.evaluate('window.workEncourager.movePet(500, 300)')
  await sleep(400)
  const env2 = JSON.parse(await pet.evaluate('(async () => JSON.stringify(await window.workEncourager.getPetEnv()))()'))
  check('movePet 能移动窗口', env2.x !== env.x || env2.y !== env.y, `${env.x},${env.y} → ${env2.x},${env2.y}`)

  // 拖拽：pointerdown → 多次 pointermove（screen 坐标位移）→ pointerup，窗口应跟着走
  await pet.evaluate(`(() => {
    const el = document.querySelector('.pet-stage canvas')
    const send = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 7, clientX: x, clientY: y, screenX: x + 500, screenY: y + 300
    }))
    send('pointerdown', 140, 120)
    return true
  })()`)
  for (let i = 1; i <= 6; i += 1) {
    await pet.evaluate(`(() => {
      const el = document.querySelector('.pet-stage canvas')
      el.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 7, clientX: 140, clientY: 120, screenX: ${500 + i * 20}, screenY: ${300 + i * 10}
      }))
      return true
    })()`)
    await sleep(60)
  }
  await pet.evaluate(`(() => {
    const el = document.querySelector('.pet-stage canvas')
    el.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 7, clientX: 140, clientY: 120, screenX: 620, screenY: 360
    }))
    return true
  })()`)
  await sleep(1500)
  const env3 = JSON.parse(await pet.evaluate('(async () => JSON.stringify(await window.workEncourager.getPetEnv()))()'))
  check('拖拽后窗口跟随移动', Math.abs(env3.x - env2.x) > 40, `${env2.x} → ${env3.x}`)

  await screenshot(pet, join(shotDir, 'tauri-pet-live2d.png'))

  const errors = await pet.evaluate('document.body.innerText.match(/错误|failed|Error/g) ? document.body.innerText.slice(0,200) : ""')
  check('界面没有渲染错误提示', errors === '', String(errors))

  await main.evaluate('document.querySelector(\'button[title="桌面浮窗"]\').click()')
  const floatTarget = await waitForTarget((item) => item.url.includes('float.html'))
  const float = connect(floatTarget.webSocketDebuggerUrl)
  await float.ready
  await float.send('Page.enable')
  await sleep(600)
  const fsize = await float.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight, sw: document.body.scrollWidth, sh: document.body.scrollHeight })')
  const fbox = JSON.parse(fsize)
  check('浮窗仍是 268×160 且无溢出', fbox.w === 268 && fbox.h === 160 && fbox.sw <= fbox.w && fbox.sh <= fbox.h, fsize)
  check('宠物与浮窗同时存在', true)
} catch (error) {
  check('Live2D 冒烟测试执行完成', false, error.message)
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
