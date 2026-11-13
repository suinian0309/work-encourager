import { createApp } from 'vue'
import FloatView from './views/FloatView.vue'
import './styles/base.css'

document.documentElement.dataset.theme = 'dark'
document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'
document.body.classList.add('float-body')
createApp(FloatView).mount('#float')
