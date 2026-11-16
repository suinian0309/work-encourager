/**
 * Live2D 宠物窗探针：启动应用 → CDP 点「摸鱼小宠物」→ 等 pet 页 → 截图 + 读 FPS/内存/尺寸
 * 用法：node scripts/probe-live2d.mjs [port] [outDir]
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 9405)
const outDir = process.argv[3] ?? join(process.cwd(), '.probe', 'live2d')
mkdirSync(outDir, { recursive: true })

const dataDir = process.env.WORK_ENC_PROBE_DATA || 'F:\\DSH\\.tmp\\pet-data2'
const env = { ...process.env, WORK_ENC_DATA_DIR: dataDir, WORK_ENC_DEBUG_CAPTURE: '1' }
delete env.ELECTRON_RUN_AS_NODE

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

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
    const list = await targets()
    const hit = list.find((t) => t.type === 'page' && match(t))
    if (hit) return hit
    await sleep(300)
  }
  return null
}

class Client {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = (e) => reject(e)
    })
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      const entry = this.pending.get(msg.id)
      if (entry) {
        this.pending.delete(msg.id)
        entry.resolve(msg)
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve) => {
      this.pending.set(id, { resolve })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails))
    return res.result?.result?.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // 已关闭
    }
  }
}

const electron = 'node_modules/electron/dist/electron.exe'
const child = spawn(electron, ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${port}`], {
  env,
  stdio: 'ignore',
  windowsHide: true
})

let ok = true
try {
  const main = await waitTarget((t) => t.url.includes('index.html'))
  if (!main) throw new Error('主窗口未出现')
  const client = new Client(main.webSocketDebuggerUrl)
  await client.ready
  await sleep(2500)

  const clicked = await client.eval(`(() => {
    const btn = document.querySelector('button[title="摸鱼小宠物"]');
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`)
  console.log('click:', clicked)

  const pet = await waitTarget((t) => t.url.includes('pet.html'))
  if (!pet) throw new Error('宠物窗口未出现')
  const petClient = new Client(pet.webSocketDebuggerUrl)
  await petClient.ready
  await sleep(6000)

  const info = await petClient.eval(`(async () => {
    const canvas = document.querySelector('canvas');
    let fps = 0;
    await new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - start < 1000) requestAnimationFrame(tick);
        else { fps = frames; resolve(); }
      };
      requestAnimationFrame(tick);
    });
    return {
      canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
      viewport: { w: innerWidth, h: innerHeight },
      fps,
      error: document.querySelector('.live2d-error')?.textContent?.trim() ?? '',
      loading: !!document.querySelector('.live2d-host.is-loading'),
      bodyText: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120)
    };
  })()`)
  console.log(JSON.stringify(info, null, 2))

  const bounds = await petClient.eval(`(() => {
    const dbg = window.__live2d;
    if (!dbg) return { error: 'no-debug-hook' };
    const m = dbg.model;
    const b = m.getBounds();
    return {
      bounds: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      scale: m.scale.x,
      pos: { x: Math.round(m.position.x), y: Math.round(m.position.y) },
      anchor: { x: m.anchor.x, y: m.anchor.y },
      original: { w: m.internalModel.originalWidth, h: m.internalModel.originalHeight },
      renderer: { w: dbg.app.renderer.width, h: dbg.app.renderer.height }
    };
  })()`)
  console.log('bounds:', JSON.stringify(bounds))

  await petClient.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 250, g: 248, b: 243, a: 1 }
  })
  const whiteShot = await petClient.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (whiteShot.result?.data) {
    writeFileSync(join(outDir, 'pet-live2d-solid.png'), Buffer.from(whiteShot.result.data, 'base64'))
    console.log('saved solid', join(outDir, 'pet-live2d-solid.png'))
  }

  await petClient.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 }
  })
  const shot = await petClient.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (shot.result?.data) {
    writeFileSync(join(outDir, 'pet-live2d-idle.png'), Buffer.from(shot.result.data, 'base64'))
    console.log('saved', join(outDir, 'pet-live2d-idle.png'))
  }

  // 点一下：验证动作 + 计数
  const tapped = await petClient.eval(`(() => {
    const host = document.querySelector('.live2d-host');
    if (!host) return 'no-host';
    const box = host.getBoundingClientRect();
    const opts = { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, pointerId: 1, button: 0, pointerType: 'mouse', isPrimary: true };
    host.dispatchEvent(new PointerEvent('pointerdown', opts));
    host.dispatchEvent(new PointerEvent('pointerup', opts));
    return 'tapped';
  })()`)
  console.log('tap:', tapped)
  await sleep(1200)
  const afterTap = await petClient.eval(`(async () => {
    const stats = await window.workEncourager.getPet();
    const pill = document.querySelector('.pet-pill')?.textContent?.replace(/\\s+/g, ' ').trim();
    return { stats, pill };
  })()`)
  console.log('afterTap:', JSON.stringify(afterTap))
  const shot2 = await petClient.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (shot2.result?.data) {
    writeFileSync(join(outDir, 'pet-live2d-tapped.png'), Buffer.from(shot2.result.data, 'base64'))
  }

  petClient.close()
  client.close()

  // 真实桌面截图：验证 GPU 开启后透明窗口没有被画成黑底/白底
  const envRect = await (async () => {
    const probe = new Client((await waitTarget((t) => t.url.includes('index.html'))).webSocketDebuggerUrl)
    await probe.ready
    const rect = await probe.eval('window.workEncourager.getPetEnv()')
    probe.close()
    return rect
  })()
  const deskShot = join(outDir, 'pet-desktop.png')
  const ps = `Add-Type -AssemblyName System.Drawing; $bmp=New-Object System.Drawing.Bitmap(${envRect.width},${envRect.height}); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${envRect.x},${envRect.y},0,0,$bmp.Size); $g.Dispose(); $bmp.Save('${deskShot.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()`
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
  console.log('desktop shot:', deskShot, JSON.stringify(envRect))

  // DXGI 抓屏对照：需要临时打开 WORK_ENC_DEBUG_CAPTURE 才可用（默认已关闭）
  const captured = await (async () => {
    const probe = new Client((await waitTarget((t) => t.url.includes('index.html'))).webSocketDebuggerUrl)
    await probe.ready
    const hasApi = await probe.eval("typeof window.workEncourager.captureScreen === 'function'")
    const base64 = hasApi ? await probe.eval('window.workEncourager.captureScreen()') : null
    probe.close()
    return base64
  })()
  if (captured) {
    writeFileSync(join(outDir, 'pet-dxgi.png'), Buffer.from(captured, 'base64'))
    console.log('dxgi shot: pet-dxgi.png')
  } else {
    console.log('dxgi shot: skipped（调试抓屏接口已移除）')
  }
  const list = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(process.cwd(), 'scripts', 'win-windows.ps1')], { encoding: 'utf8' })
  console.log('windows:\n' + list.trim())
} catch (error) {
  ok = false
  console.error('FAILED:', error instanceof Error ? error.message : error)
} finally {
  try {
    child.kill()
  } catch {
    // 已退出
  }
  try {
    execFileSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' })
  } catch {
    // 没有残留进程
  }
  process.exit(ok ? 0 : 1)
}
