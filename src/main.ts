import { createApp } from 'vue'
import App from './App.vue'
import './utils/flexible'
import 'file-icon-vectors/dist/file-icon-classic.min.css';
import 'file-icon-vectors/dist/file-icon-vectors.min.css';
// import './samples/node-api'

createApp(App)
  .mount('#app')
  .$nextTick(() => {
    postMessage({ payload: 'removeLoading' }, '*')
  })
