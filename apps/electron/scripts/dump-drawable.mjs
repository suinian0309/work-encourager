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
if (!pet) throw new Error('pet window not found')
const pws = await connect(pet)

const result = await evaluate(
  pws,
  `(() => {
    const d = window.__live2d.model.internalModel.coreModel._model.drawables
    const dump = (i) => {
      const vp = d.vertexPositions[i]
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
      let uvMinU = 1e9, uvMinV = 1e9, uvMaxU = -1e9, uvMaxV = -1e9
      for (let k = 0; k < vp.length; k += 2) {
        minX = Math.min(minX, vp[k]); maxX = Math.max(maxX, vp[k])
        minY = Math.min(minY, vp[k + 1]); maxY = Math.max(maxY, vp[k + 1])
      }
      const uv = d.vertexUvs[i]
      for (let k = 0; k < uv.length; k += 2) {
        uvMinU = Math.min(uvMinU, uv[k]); uvMaxU = Math.max(uvMaxU, uv[k])
        uvMinV = Math.min(uvMinV, uv[k + 1]); uvMaxV = Math.max(uvMaxV, uv[k + 1])
      }
      return {
        i,
        texture: d.textureIndices[i],
        opacity: d.opacities[i],
        masks: d.maskCounts[i],
        verts: vp.length / 2,
        bbox: [minX, minY, maxX, maxY].map((v) => Math.round(v * 1000) / 1000),
        uv: [uvMinU, uvMinV, uvMaxU, uvMaxV].map((v) => Math.round(v * 10000) / 10000),
        parentPart: d.parentPartIndices ? d.parentPartIndices[i] : null
      }
    }
    const around = []
    for (let i = 505; i < 525; i++) around.push(dump(i))
    return { canvas: [window.__live2d.model.internalModel.originalWidth, window.__live2d.model.internalModel.originalHeight], around }
  })()`
)
console.log(JSON.stringify(result, null, 1))
pws.close()
