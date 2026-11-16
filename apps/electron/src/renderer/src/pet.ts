import { createApp } from 'vue'
import PetView from './views/PetView.vue'
import './styles/base.css'

document.documentElement.style.background = 'transparent'
document.documentElement.style.overflow = 'hidden'
document.body.style.background = 'transparent'
document.body.style.overflow = 'hidden'
document.body.classList.add('pet-body')
createApp(PetView).mount('#pet')
