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
  const res = await call(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 180000 })
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
    const frames = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    const hist = []
    for (let f = 0; f < 40; f++) {
      await frames()
      const px = app.renderer.extract.pixels()
      const w = app.renderer.width
      const pts = []
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40 && px[i + 3] > 200) {
          const p = i / 4
          pts.push([p % w, Math.floor(p / w)])
        }
      }
      hist.push(pts.length)
      if (f === 39) {
        return {
          canvas: [w, app.renderer.height],
          counts: hist,
          lastPoints: pts.slice(0, 30),
          modelPos: [Math.round(window.__live2d.model.x), Math.round(window.__live2d.model.y)]
        }
      }
    }
  })()`
)
console.log(JSON.stringify(result, null, 2))
pws.close()
