import { createApp } from 'vue';
import App from './App.vue';
import { router } from './ui/router';
import { requestPersistentStorage } from './storage/db';
import { getSetting } from './storage/settings';
import { applyTheme } from './ui/theme';
import './ui/styles/base.css';

void requestPersistentStorage();
void getSetting('theme').then(applyTheme);

createApp(App).use(router).mount('#app');
