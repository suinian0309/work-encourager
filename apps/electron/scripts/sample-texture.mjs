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

const result = await evaluate(
  pws,
  `(async () => {
    const im = window.__live2d.model.internalModel
    const texs = im.textures
    const src = texs[0]
    const el = src.baseTexture.resource.source
    const cv = document.createElement('canvas')
    cv.width = el.width
    cv.height = el.height
    cv.getContext('2d').drawImage(el, 0, 0)
    const ctx = cv.getContext('2d')
    const sample = (u, v) => {
      const p = ctx.getImageData(Math.floor(u * el.width), Math.floor(v * el.height), 1, 1).data
      return [p[0], p[1], p[2], p[3]]
    }
    return {
      texSize: [el.width, el.height],
      center: sample(0.8645, 0.6929),
      corners: [sample(0.85, 0.665), sample(0.88, 0.665), sample(0.85, 0.72), sample(0.88, 0.72)],
      partCount: im.coreModel._model.parts ? im.coreModel._model.parts.count : null,
      part16: im.coreModel._model.parts ? {
        opacities: im.coreModel._model.parts.opacities[16],
        parent: im.coreModel._model.parts.parentIndices ? im.coreModel._model.parts.parentIndices[16] : null
      } : null
    }
  })()`
)
console.log(JSON.stringify(result))
pws.close()
