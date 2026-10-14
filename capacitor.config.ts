import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.storytoaudiobook.app',
  appName: 'Story to Audiobook',
  webDir: 'dist',
  android: {
    minWebViewVersion: 100,
  },
};

export default config;
