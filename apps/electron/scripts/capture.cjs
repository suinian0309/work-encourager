// 临时视觉核验脚本：把构建产物加载到固定尺寸窗口里截图，不参与打包
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { writeFileSync, mkdirSync } = require('node:fs')

const outDir = join(__dirname, '..', '.probe')
mkdirSync(outDir, { recursive: true })
const renderer = join(__dirname, '..', 'out', 'renderer')

async function shot(file, width, height, name, opts = {}) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: opts.bg ?? '#cdd5d0',
    webPreferences: { offscreen: false, contextIsolation: true }
  })
  await win.loadFile(join(renderer, file))
  await new Promise((r) => setTimeout(r, 1200))
  if (opts.action) {
    await win.webContents.executeJavaScript(opts.action)
    await new Promise((r) => setTimeout(r, opts.after ?? 220))
  }
  const image = await win.webContents.capturePage()
  writeFileSync(join(outDir, name), image.toPNG())
  console.log(name, image.getSize())
  win.destroy()
}

app.whenReady().then(async () => {
  const only = process.argv.find((item) => item === 'pet' || item === 'float') ?? 'all'
  try {
    if (only !== 'pet') await shot('float.html', 272, 164, 'float.png')
    if (only !== 'float') {
      await new Promise((r) => setTimeout(r, 300))
      await shot('pet.html', 256, 248, 'pet-idle.png')
      await new Promise((r) => setTimeout(r, 300))
      await shot('pet.html', 256, 248, 'pet-tap.png', {
        action: 'document.querySelector(".pet-stage").click()',
        after: 120
      })
      await new Promise((r) => setTimeout(r, 300))
      await shot('pet.html', 256, 248, 'pet-happy-combo.png', {
        action:
          'document.querySelector(".pet-stage").click();' +
          'setTimeout(()=>document.querySelector(".pet-stage").click(),120);' +
          'setTimeout(()=>document.querySelector(".pet-stage").click(),240)',
        after: 600
      })
    }
  } catch (error) {
    console.error('capture failed', error)
  }
  app.quit()
})
