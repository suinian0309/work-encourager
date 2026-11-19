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
  const res = await call(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 300000 })
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
    const snapshot = Uint8Array.from(flags)
    app.ticker.stop()

    const darkPts = () => {
      const px = app.renderer.extract.pixels()
      const w = app.renderer.width
      const pts = []
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40 && px[i + 3] > 200) {
          const p = i / 4
          pts.push([p % w, Math.floor(p / w)])
        }
      }
      return pts
    }

    const solo = []
    for (let i = 0; i < total; i++) {
      for (let k = 0; k < total; k++) flags[k] = (k === i ? (snapshot[k] | 1) : (snapshot[k] & 0xfe))
      app.renderer.render(app.stage)
      const pts = darkPts()
      if (pts.length > 0) solo.push({ i, n: pts.length, pts: pts.slice(0, 3) })
    }
    flags.set(snapshot)
    app.ticker.start()
    app.renderer.render(app.stage)
    return { total, soloCount: solo.length, solo: solo.slice(0, 12) }
  })()`
)
console.log(JSON.stringify(out))
pws.close()
