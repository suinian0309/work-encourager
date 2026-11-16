import { createApp } from 'vue'
import PetView from './views/PetView.vue'
import './styles/base.css'
import { createPetApi } from './pet-api'

document.documentElement.style.background = 'transparent'
document.documentElement.style.overflow = 'hidden'
document.body.style.background = 'transparent'
document.body.style.overflow = 'hidden'
document.body.classList.add('pet-body')

window.workEncourager = createPetApi()

createApp(PetView).mount('#pet')
