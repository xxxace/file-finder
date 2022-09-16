import { createApp } from 'vue'
import App from './App.vue'
import './utils/flexible'
// import './samples/node-api'

createApp(App)
  .mount('#app')
  .$nextTick(() => {
    postMessage({ payload: 'removeLoading' }, '*')
  })
