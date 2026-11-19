const port = process.env.PORT || '9371'
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

async function evaluate(ws, expression) {
  const res = await call(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || ''))
  return res.result.value
}

const pet = (await list()).find((t) => t.url.includes('pet.html'))
const pws = await connect(pet)

const out = await evaluate(
  pws,
  `(async () => {
    const app = window.__live2d.app
    const d = window.__live2d.model.internalModel.coreModel._model.drawables
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    const pts = () => {
      const px = app.renderer.extract.pixels()
      const w = app.renderer.width
      const out = []
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40 && px[i + 3] > 200) {
          const p = i / 4
          out.push([p % w, Math.floor(p / w)])
        }
      }
      return out
    }
    await frames()
    const on = pts()
    for (const i of [513, 514]) d.dynamicFlags[i] &= 0xfe
    await frames()
    await frames()
    const off = pts()
    const inBox = (arr) => arr.filter(([x, y]) => x > 120 && x < 175 && y > 190 && y < 230).length
    return {
      withLayers: { total: on.length, inBox: inBox(on), sample: on.slice(0, 6) },
      withoutLayers: { total: off.length, inBox: inBox(off), sample: off.slice(0, 6) }
    }
  })()`
)
console.log(JSON.stringify(out))
pws.close()
