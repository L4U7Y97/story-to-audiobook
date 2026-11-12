import { createRouter, createWebHashHistory } from 'vue-router';
import LibraryView from './views/LibraryView.vue';

// Hash history works the same in the browser and inside the Capacitor WebView.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'library', component: LibraryView },
    {
      path: '/story/:id',
      name: 'story',
      component: () => import('./views/StoryView.vue'),
      props: true,
    },
    {
      path: '/story/:id/read/:partId?',
      name: 'reader',
      component: () => import('./views/ReaderView.vue'),
      // ?line=<index> scrolls to that line of the part and marks it (from a cast card's lines).
      props: (route) => ({
        ...route.params,
        line: typeof route.query.line === 'string' ? Number(route.query.line) : undefined,
      }),
    },
    {
      path: '/story/:id/cast',
      name: 'cast',
      component: () => import('./views/CastView.vue'),
      props: true,
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
    },
  ],
});
