/**
 * Bundler config for the touch-floor browser fixture.
 *
 * Deliberately a copy of the shape the product's own web build uses -
 * `.web.*` extensions first, `react-native` aliased to
 * `react-native-web` - so the fixture renders the SAME component code
 * the browser ships. A fixture that rendered something else would
 * measure something else.
 *
 * The one substitution is the MSP session hook: the fixture has no
 * flight controller, and the screens gate their content on ownership.
 * Nothing about geometry is stubbed.
 */
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const HERE = new URL('.', import.meta.url).pathname;
const REPO = new URL('../../', import.meta.url).pathname;

export default defineConfig({
  root: HERE,
  plugins: [react()],
  resolve: {
    extensions: [
      '.web.tsx', '.web.ts', '.web.jsx', '.web.js',
      '.tsx', '.ts', '.jsx', '.js', '.json', '.mjs',
    ],
    alias: [
      {
        find: /^.*[\\/]useMspSessionState$/,
        replacement: `${HERE}sessionStateStub.ts`,
      },
      {find: /^react-native$/, replacement: 'react-native-web'},
      {
        find: /^react-native-svg$/,
        replacement: `${REPO}node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js`,
      },
    ],
  },
  define: {
    __DEV__: JSON.stringify(false),
    global: 'globalThis',
    'process.env.NODE_ENV': JSON.stringify('production'),
    __FPV_ARBCON_BUILD__: JSON.stringify('touch-target-fixture'),
  },
  optimizeDeps: {include: ['react', 'react-dom', 'react-native-web']},
  build: {
    outDir: `${HERE}dist`,
    emptyOutDir: true,
    rollupOptions: {input: {fixture: `${HERE}index.html`}},
    sourcemap: false,
    target: 'es2022',
  },
  preview: {port: 4193, host: '127.0.0.1'},
});
