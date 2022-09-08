import { createApp } from 'vue'
import App from './App.vue'
import hevueImgPreview from 'hevue-img-preview';
// import './samples/node-api'

createApp(App)
  .use(hevueImgPreview)
  .mount('#app')
  .$nextTick(() => {
    postMessage({ payload: 'removeLoading' }, '*')
  })
