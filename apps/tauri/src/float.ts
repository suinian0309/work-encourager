import { createApp } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import FloatView from './views/FloatView.vue'
import './styles/base.css'
import { createFloatApi } from './float-api'

document.documentElement.dataset.theme = 'dark'
document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'
document.body.classList.add('float-body')

window.workEncourager = createFloatApi()

void getCurrentWindow()
  .onMoved(({ payload }) => {
    try {
      localStorage.setItem('float-position', JSON.stringify({ x: payload.x, y: payload.y }))
    } catch {
      // 位置无法保存时忽略
    }
  })
  .catch(() => undefined)

createApp(FloatView).mount('#float')
