import type { Settings } from '@/storage/settings';

/** 'system' follows prefers-color-scheme; 'light' and 'dark' override it (see base.css). */
export function applyTheme(theme: Settings['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}
