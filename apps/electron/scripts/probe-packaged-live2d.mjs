// 验证打包后的 Electron 应用里 Live2D 宠物也能正常渲染
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const exe = join(root, 'release', 'win-unpacked', '上班鼓励器.exe')
const seed = process.env.WORK_ENC_SEED_DIR ?? 'F:\\DSH\\.tmp\\pet-data-tauri'
const dataDir = join(root, '.probe', 'pkg-live2d')
const shotDir = join(root, '.probe', 'shots')
const port = 9342

if (!existsSync(exe)) {
  console.error('未找到打包产物：' + exe)
  process.exit(2)
}
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(shotDir, { recursive: true })
cpSync(join(seed, 'work-encourager.json'), join(dataDir, 'work-encourager.json'))
cpSync(join(seed, 'live2d'), join(dataDir, 'live2d'), { recursive: true })

const env = {
  ...process.env,
  WORK_ENC_DATA_DIR: dataDir
}
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  exe,
  ['--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dataDir, 'userdata')}`],
  { cwd: root, env, stdio: 'ignore' }
)

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
  throw new Error('等待调试目标超时')
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

let ok = true
try {
  const mainT = await waitTarget((t) => t.url.includes('index.html'))
  const main = client(mainT.webSocketDebuggerUrl)
  await main.ready
  let mounted = false
  for (let i = 0; i < 80 && !mounted; i += 1) {
    mounted = (await main.evalx('!!document.querySelector(\'button[title="摸鱼小宠物"]\')')) === true
    if (!mounted) await sleep(300)
  }
  console.log('主界面就绪:', mounted)
  await main.evalx('document.querySelector(\'button[title="摸鱼小宠物"]\').click()')

  const petT = await waitTarget((t) => t.url.includes('pet.html'))
  const pet = client(petT.webSocketDebuggerUrl)
  await pet.ready
  await pet.send('Runtime.enable')
  await pet.send('Page.enable')

  let info = ''
  for (let i = 0; i < 60; i += 1) {
    info = await pet.evalx(
      'JSON.stringify({ canvas: !!document.querySelector(".pet-stage canvas"), err: document.querySelector(".live2d-error")?.textContent ?? "" })'
    )
    if (JSON.parse(info).canvas) break
    await sleep(500)
  }
  console.log('宠物窗:', info, '尺寸', await pet.evalx('innerWidth + "x" + innerHeight'))

  const painted = await pet.evalx(`(async () => {
    const c = document.querySelector('.pet-stage canvas')
    if (!c) return JSON.stringify({ ok: false })
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    if (!gl) return JSON.stringify({ ok: false, why: 'no-gl' })
    await new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(d)))
    const px = new Uint8Array(c.width * c.height * 4)
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let opaque = 0
    for (let i = 3; i < px.length; i += 4) if (px[i] > 200) opaque += 1
    return JSON.stringify({ ok: true, w: c.width, h: c.height, opaque })
  })()`)
  console.log('像素:', painted)
  ok = JSON.parse(painted).opaque > 3000

  const shot = await pet.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shotDir, 'pkg-live2d.png'), Buffer.from(shot.data, 'base64'))
  console.log('截图:', join(shotDir, 'pkg-live2d.png'))
  pet.close()
  main.close()
} catch (error) {
  ok = false
  console.log('失败:', error.message)
} finally {
  child.kill()
  await sleep(400)
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
  process.exit(ok ? 0 : 1)
}
