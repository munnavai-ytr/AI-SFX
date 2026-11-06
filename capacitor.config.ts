import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sfxai.app',
  appName: 'SFX AI',
  webDir: 'out',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    FilePicker: {
      readData: false,
    },
  },
};

export default config;
