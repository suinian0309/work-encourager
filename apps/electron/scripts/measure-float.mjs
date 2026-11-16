import { execFileSync } from 'node:child_process'

const port = process.env.PORT || '9371'

async function list() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return response.json()
}

function call(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const data = JSON.parse(event.data)
      if (data.id !== id) return
      ws.removeEventListener('message', handler)
      if (data.error) reject(new Error(data.error.message))
      else resolve(data.result)
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  await call(ws, 1, 'Runtime.enable', {})
  return ws
}

const targets = await list()
const main = targets.find((t) => t.type === 'page' && !t.url.includes('float'))
if (!main) throw new Error('找不到主窗口')
const ws = await connect(main)
await call(ws, 2, 'Runtime.evaluate', {
  expression: '(async () => { await window.workEncourager.showFloat(); return 1 })()',
  awaitPromise: true
})
await new Promise((r) => setTimeout(r, 1500))
const after = await list()
const float = after.find((t) => t.url.includes('float'))
if (!float) throw new Error('浮窗没打开')
const fws = await connect(float)
const result = await call(fws, 3, 'Runtime.evaluate', {
  expression:
    "JSON.stringify({ inner:[innerWidth,innerHeight], card:[Math.round(document.querySelector('.float-card').getBoundingClientRect().width),Math.round(document.querySelector('.float-card').getBoundingClientRect().height)], dpr: devicePixelRatio })",
  returnByValue: true
})
console.log(result.result.value)
ws.close()
fws.close()
