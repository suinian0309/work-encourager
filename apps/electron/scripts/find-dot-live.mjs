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
  const res = await call(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 600000 })
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
    const total = d.count
    const flags = d.dynamicFlags
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    let target = -1
    app.ticker.add(() => { if (target >= 0) flags[target] &= 0xfe }, undefined, 25)
    const inBox = () => {
      const px = app.renderer.extract.pixels()
      const w = app.renderer.width
      let n = 0
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40 && px[i + 3] > 200) {
          const p = i / 4
          const x = p % w, y = Math.floor(p / w)
          if (x > 120 && x < 175 && y > 190 && y < 230) n++
        }
      }
      return n
    }
    target = -1
    await frames()
    const baseline = inBox()
    const hits = []
    for (let i = 0; i < total; i++) {
      target = i
      await frames()
      const n = inBox()
      if (n < baseline) hits.push({ i, n })
    }
    target = -1
    hits.sort((a, b) => a.n - b.n)
    return { baseline, hits: hits.slice(0, 10), hitCount: hits.length }
  })()`
)
console.log(JSON.stringify(out))
pws.close()
