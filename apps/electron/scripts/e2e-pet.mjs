// 端到端验证：真实启动打包后的主进程，通过 CDP 点击「摸鱼小宠物」，
// 连点 3 次、截图、重启进程校验计数持久化，并顺手截一张浮窗阴影图。
// 用法：node scripts/e2e-pet.mjs   （demo 页由 out/renderer 提供，需先 pnpm build）
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const shotDir = join(appDir, '.probe')
const port = 9333
const dataDir = mkdtempSync(join(tmpdir(), 'we-pet-'))
const mainEntry = join(appDir, 'out', 'main', 'index.js')

mkdirSync(shotDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, WORK_ENC_DATA_DIR: dataDir }
delete env.ELECTRON_RUN_AS_NODE

function launch() {
  const child = spawn(
    electronPath,
    [mainEntry, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`],
    { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  child.logs = logs
  return child
}

async function targets() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}

async function waitTarget(predicate, label, timeout = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const list = await targets()
    const hit = list.find(predicate)
    if (hit) return hit
    await sleep(200)
  }
  throw new Error(`等待目标超时：${label}`)
}

function openWs(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    ws.onopen = () => res(ws)
    ws.onerror = () => rej(new Error(`WebSocket 连接失败 ${url}`))
    setTimeout(() => rej(new Error('WebSocket 连接超时')), 10000)
  })
}

async function evaluate(wsUrl, expression) {
  const ws = await openWs(wsUrl)
  const id = 1
  const done = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('evaluate 超时')), 15000)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== id) return
      clearTimeout(timer)
      if (msg.error) rej(new Error(JSON.stringify(msg.error)))
      else res(msg.result?.result?.value)
    }
    ws.onerror = () => rej(new Error('evaluate 连接错误'))
  })
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    })
  )
  try {
    return await done
  } finally {
    ws.close()
  }
}

async function screenshot(wsUrl, file) {
  const ws = await openWs(wsUrl)
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p(msg)
    }
  }
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)))
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => rej(new Error(`${method} 超时`)), 15000)
    })
  await call('Page.enable')
  await call('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 }
  })
  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  writeFileSync(join(shotDir, file), Buffer.from(shot.data, 'base64'))
  ws.close()
  return join(shotDir, file)
}

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

let child = launch()
try {
  const main = await waitTarget((t) => t.type === 'page' && t.url.includes('/index.html'), '主窗口')
  await sleep(1800)

  const clicked = await evaluate(
    main.webSocketDebuggerUrl,
    `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.title === '摸鱼小宠物')
      if (!btn) return 'missing'
      btn.click()
      return 'ok'
    })()`
  )
  check('主界面存在摸鱼按钮并成功点击', clicked === 'ok', String(clicked))

  const pet = await waitTarget((t) => t.type === 'page' && t.url.includes('/pet.html'), '宠物窗口')
  await sleep(1200)
  check('宠物窗口已打开', Boolean(pet))

  const idleText = await evaluate(pet.webSocketDebuggerUrl, `document.querySelector('.pet-pill').innerText`)
  check('初始计数为 0', /0\s*次/.test(String(idleText)), String(idleText))
  await screenshot(pet.webSocketDebuggerUrl, 'pet-idle.png')

  for (let i = 0; i < 3; i += 1) {
    await evaluate(pet.webSocketDebuggerUrl, `document.querySelector('.pet-svg').dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
    await sleep(420)
  }
  const tappedText = await evaluate(pet.webSocketDebuggerUrl, `document.querySelector('.pet-pill').innerText`)
  check('点击 3 次后计数变为 3', /3\s*次/.test(String(tappedText)), String(tappedText))
  await screenshot(pet.webSocketDebuggerUrl, 'pet-tapped.png')

  const stats = JSON.parse(String(await evaluate(
    pet.webSocketDebuggerUrl,
    `window.workEncourager.getPet().then((s) => JSON.stringify(s))`
  )))
  check('宠物统计 via API', stats.today === 3 && stats.total === 3, JSON.stringify(stats))

  const petOverflow = JSON.parse(String(await evaluate(
    pet.webSocketDebuggerUrl,
    `JSON.stringify({ sh: document.body.scrollHeight, ch: document.body.clientHeight, sw: document.body.scrollWidth, cw: document.body.clientWidth })`
  )))
  check(
    '宠物窗口内容无溢出',
    petOverflow.sh <= petOverflow.ch + 1 && petOverflow.sw <= petOverflow.cw + 1,
    JSON.stringify(petOverflow)
  )

  // 再点两次凑满 5 次，触发气泡台词，截图给视觉验收
  for (let i = 0; i < 2; i += 1) {
    await evaluate(pet.webSocketDebuggerUrl, `document.querySelector('.pet-svg').dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
    await sleep(320)
  }
  const bubble = await evaluate(pet.webSocketDebuggerUrl, `document.querySelector('.pet-bubble').classList.contains('show')`)
  check('第 5 次点击弹出鼓励气泡', bubble === true, String(bubble))
  await screenshot(pet.webSocketDebuggerUrl, 'pet-bubble.png')

  // 浮窗阴影
  await evaluate(
    main.webSocketDebuggerUrl,
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '桌面浮窗'); b && b.click(); return 'ok' })()`
  )
  const float = await waitTarget((t) => t.type === 'page' && t.url.includes('/float.html'), '浮窗')
  await sleep(1200)
  const floatOpen = float && (await evaluate(float.webSocketDebuggerUrl, `document.body.innerText.length > 0`))
  check('浮窗与宠物可同时存在', Boolean(floatOpen))
  const floatOverflow = JSON.parse(String(await evaluate(
    float.webSocketDebuggerUrl,
    `JSON.stringify({ sh: document.body.scrollHeight, ch: document.body.clientHeight, sw: document.body.scrollWidth, cw: document.body.clientWidth })`
  )))
  check(
    '浮窗卡片无溢出（阴影留白足够）',
    floatOverflow.sh <= floatOverflow.ch + 1 && floatOverflow.sw <= floatOverflow.cw + 1,
    JSON.stringify(floatOverflow)
  )
  await screenshot(float.webSocketDebuggerUrl, 'float.png')
} finally {
  child.kill()
  await sleep(1500)
}

child = launch()
try {
  const main = await waitTarget((t) => t.type === 'page' && t.url.includes('/index.html'), '主窗口(重启)')
  await sleep(2000)
  const stats = await evaluate(
    main.webSocketDebuggerUrl,
    `window.workEncourager.getPet().then((s) => JSON.stringify(s))`
  )
  const parsed = JSON.parse(String(stats))
  check('重启后计数持久化', parsed.today === 5 && parsed.total === 5, String(stats))

  const petVisible = await evaluate(
    main.webSocketDebuggerUrl,
    `window.workEncourager.getPet().then((s) => String(s.visible))`
  )
  check('重启后宠物窗口默认隐藏（由用户再点开）', petVisible === 'false' || petVisible === 'undefined', String(petVisible))
} finally {
  child.kill()
  await sleep(800)
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录残留不影响结果 */
  }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('；'))
  process.exitCode = 1
}
