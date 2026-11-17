import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
const HERE = new URL('.', import.meta.url).pathname;
const REPO = new URL('../../', import.meta.url).pathname;
export default defineConfig({
  root: HERE,
  plugins: [react()],
  resolve: {
    extensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json', '.mjs'],
    alias: [
      {find: /^.*[\\/]useMspSessionState$/, replacement: `${HERE}sessionState.ts`},
      {find: /^.*[\\/]useTelemetryValue$/, replacement: `${HERE}telemetry.ts`},
      {find: /^react-native$/, replacement: 'react-native-web'},
      {find: /^react-native-svg$/, replacement: `${REPO}node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js`},
    ],
  },
  define: {__DEV__: false, global: 'globalThis', 'process.env.NODE_ENV': JSON.stringify('production'), __FPV_ARBCON_BUILD__: JSON.stringify('dutch-guide-fixture')},
  build: {outDir: `${HERE}dist`, emptyOutDir: true, target: 'es2022'},
  preview: {port: 4182, host: '127.0.0.1'},
});
