import { createApp } from 'vue';
import App from './App.vue';
import { router } from './ui/router';
import { requestPersistentStorage } from './storage/db';
import './ui/styles/base.css';

void requestPersistentStorage();

createApp(App).use(router).mount('#app');
