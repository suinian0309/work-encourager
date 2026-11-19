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

async function evaluate(ws, expression) {
  const res = await call(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 300000 })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || ''))
  return res.result.value
}

const pet = (await list()).find((t) => t.url.includes('pet.html'))
if (!pet) throw new Error('pet window not found')
const pws = await connect(pet)

const result = await evaluate(
  pws,
  `(async () => {
    const app = window.__live2d.app
    const d = (window.__live2d.model.internalModel.coreModel._model || {}).drawables
    const flags = d.dynamicFlags
    const total = d.count
    app.ticker.stop()

    const countDark = () => {
      const px = app.renderer.extract.pixels()
      let n = 0
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40 && px[i + 3] > 200) n++
      }
      return n
    }

    app.renderer.render(app.stage)
    const baseline = countDark()

    const best = []
    for (let i = 0; i < total; i++) {
      const saved = flags[i]
      flags[i] = saved & 0xfe
      app.renderer.render(app.stage)
      const n = countDark()
      flags[i] = saved
      if (n < baseline) best.push({ i, n })
    }
    app.renderer.render(app.stage)
    const restored = countDark()
    app.ticker.start()
    best.sort((a, b) => a.n - b.n)
    return { total, baseline, restored, best: best.slice(0, 10), hitCount: best.length }
  })()`
)
console.log(JSON.stringify(result))
pws.close()
