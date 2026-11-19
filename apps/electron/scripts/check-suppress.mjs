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

const info = await evaluate(
  pws,
  `(() => {
    const im = window.__live2d.model.internalModel
    const d = (im.coreModel._model || {}).drawables
    const keyOf = (src) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (let i = 0; i < src.length; i += 2) {
        if (src[i] < minX) minX = src[i]
        if (src[i] > maxX) maxX = src[i]
        if (src[i + 1] < minY) minY = src[i + 1]
        if (src[i + 1] > maxY) maxY = src[i + 1]
      }
      return [minX, minY, maxX, maxY].map((v) => v.toFixed(4)).join(',')
    }
    const seen = new Set()
    const hidden = []
    for (let i = 0; i < d.count; i++) {
      const p = d.vertexPositions[i], u = d.vertexUvs[i]
      if (!p || !u) continue
      if (p.length < 6 || p.length > 400) continue
      const key = (d.textureIndices[i] ?? -1) + '|' + keyOf(p) + '|' + keyOf(u)
      if (seen.has(key)) { hidden.push(i); continue }
      seen.add(key)
    }
    return { hiddenCount: hidden.length, hidden: hidden.slice(0, 12), tickerListeners: window.__live2d.app.ticker._head ? 'ok' : 'n/a' }
  })()`
)
console.log(JSON.stringify(info))
pws.close()
