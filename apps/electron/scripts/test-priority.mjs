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
    const countDark = () => {
      const px = app.renderer.extract.pixels()
      let n = 0
      for (let i = 0; i < px.length; i += 4) if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40 && px[i + 3] > 200) n++
      return n
    }
    await frames()
    const before = countDark()

    const hits = []
    for (const prio of [25, 100, -10, -24]) {
      let calls = 0
      const log = []
      const fn = () => {
        calls++
        d.dynamicFlags[514] &= 0xfe
        log.push(d.dynamicFlags[514])
      }
      app.ticker.add(fn, undefined, prio)
      await frames()
      await frames()
      const after = countDark()
      app.ticker.remove(fn)
      hits.push({ prio, calls, after, lastFlags: log.slice(-3) })
    }
    return { before, hits }
  })()`
)
console.log(JSON.stringify(out))
pws.close()
