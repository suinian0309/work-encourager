const port = process.env.PORT || '9371'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json()

let seq = 0
function call(ws, method, params) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const data = JSON.parse(event.data)
      if (data.id !== id) return
      ws.removeEventListener('message', handler)
      if (data.error) reject(new Error(JSON.stringify(data.error)))
      else resolve(data.result)
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await call(ws, 'Runtime.enable', {})
  return ws
}

const evaluate = async (ws, expression) => {
  const res = await call(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || ''))
  return res.result.value
}

const targets = await list()
const main = targets.find((t) => t.url.includes('index.html'))
const ws = await connect(main)
await evaluate(ws, '(async () => { await window.workEncourager.setPetStyle("live2d"); await window.workEncourager.showPet(); return 1 })()')
await sleep(4000)

const pet = (await list()).find((t) => t.url.includes('pet.html'))
if (!pet) throw new Error('pet window not found')
const pws = await connect(pet)

const info = await evaluate(
  pws,
  `(() => {
    const m = window.__live2d?.model
    if (!m) return { error: 'no model' }
    const im = m.internalModel
    const cm = im.coreModel
    const raw = cm._model || cm
    const d = raw.drawables
    return {
      coreModelKeys: Object.keys(cm).slice(0, 20),
      rawKeys: Object.keys(raw).slice(0, 20),
      drawableKeys: Object.keys(d),
      count: d.count,
      hasDynamicFlags: !!d.dynamicFlags,
      flagType: d.dynamicFlags?.constructor?.name,
      canvasSize: [im.originalWidth, im.originalHeight],
      modelKeys: Object.keys(m).slice(0, 24)
    }
  })()`
)
console.log(JSON.stringify(info, null, 2))
pws.close()
ws.close()
