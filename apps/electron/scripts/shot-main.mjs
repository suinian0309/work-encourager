import fs from 'node:fs'

const port = process.env.PORT || '9391'
const out = process.env.OUT || 'F:\\DSH\\work-encourager-repo\\apps\\electron\\.probe\\main.png'

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const main = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(main.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

function call(id, method, params) {
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

await call(1, 'Runtime.enable', {})
await call(2, 'Page.enable', {})
const info = await call(3, 'Runtime.evaluate', {
  expression: `(() => {
    const card = document.querySelector('.earn-card')
    const r = card.getBoundingClientRect()
    return JSON.stringify({
      card: [Math.round(r.top), Math.round(r.height), Math.round(r.bottom)],
      kids: [...card.children].map(el => { const b = el.getBoundingClientRect(); return [el.className, Math.round(b.top), Math.round(b.bottom)] }),
      amount: (() => { const el = card.querySelector('.amount, .earn-amount, .amount-row'); if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom), getComputedStyle(el).fontSize] })()
    })
  })()`,
  returnByValue: true
})
console.log(info.result.value)
const shot = await call(4, 'Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
ws.close()
