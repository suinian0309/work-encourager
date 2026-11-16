import fs from 'node:fs'

const port = process.env.PORT || '9391'

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

const targets = await list()
const main = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(main.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await call(ws, 1, 'Runtime.enable', {})
const out = await call(ws, 2, 'Runtime.evaluate', {
  expression: `JSON.stringify({
    inner: [innerWidth, innerHeight],
    bodyScroll: document.body.scrollHeight,
    viewScroll: document.querySelector('.main-view')?.scrollHeight ?? null,
    viewClient: document.querySelector('.main-view')?.clientHeight ?? null,
    cards: [...document.querySelectorAll('.card')].map(el => {
      const r = el.getBoundingClientRect()
      return [el.className.replace('card ',''), Math.round(r.top), Math.round(r.height)]
    }),
    earnScroll: document.querySelector('.earn-card')?.scrollHeight ?? null,
    earnClient: document.querySelector('.earn-card')?.clientHeight ?? null
  })`,
  returnByValue: true
})
console.log(out.result.value)
ws.close()
