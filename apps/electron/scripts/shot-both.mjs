import fs from 'node:fs'

const port = process.env.PORT || '9371'
const outDir = process.env.OUT_DIR || 'F:\\DSH\\work-encourager-repo\\apps\\electron\\.probe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function list() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
}

function call(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const data = JSON.parse(event.data)
      if (data.id !== id) return
      ws.removeEventListener('message', handler)
      if (data.error) reject(new Error(data.error.message))
      else resolve(data.result)
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await call(ws, 1, 'Runtime.enable', {})
  await call(ws, 2, 'Page.enable', {})
  return ws
}

async function shot(ws, name) {
  const result = await call(ws, 9, 'Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`${outDir}\\${name}.png`, Buffer.from(result.data, 'base64'))
}

const targets = await list()
const main = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
const ws = await connect(main)
await call(ws, 3, 'Runtime.evaluate', {
  expression: '(async () => { await window.workEncourager.showFloat(); await window.workEncourager.setPetStyle("live2d"); await window.workEncourager.showPet(); return 1 })()',
  awaitPromise: true
})
await sleep(3500)
const after = await list()
const floatTarget = after.find((t) => t.url.includes('float'))
const petTarget = after.find((t) => t.url.includes('pet.html'))
if (floatTarget) {
  const fws = await connect(floatTarget)
  const size = await call(fws, 4, 'Runtime.evaluate', {
    expression: 'JSON.stringify([innerWidth, innerHeight, Math.round(document.querySelector(".float-card").getBoundingClientRect().height)])',
    returnByValue: true
  })
  await shot(fws, 'v132-float')
  console.log('float', size.result.value)
  fws.close()
}
if (petTarget) {
  const pws = await connect(petTarget)
  const info = await call(pws, 5, 'Runtime.evaluate', {
    expression: 'JSON.stringify({ size: [innerWidth, innerHeight], err: document.querySelector(".live2d-error")?.textContent || "", frames: window.__live2d?.model?.internalModel?.motionManager?.groups })',
    returnByValue: true
  })
  await shot(pws, 'v132-pet')
  console.log('pet', info.result.value)
  pws.close()
}
ws.close()
