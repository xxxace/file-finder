import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles/tokens.css'
import './utils/flexible'
import 'file-icon-vectors/dist/file-icon-classic.min.css';
import 'file-icon-vectors/dist/file-icon-vectors.min.css';

createApp(App)
  .use(router)
  .mount('#app')
  .$nextTick(() => {
    postMessage({ payload: 'removeLoading' }, '*')
  })
