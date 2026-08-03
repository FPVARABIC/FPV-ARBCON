/**
 * VITE CONFIGURATION - the browser half of a single React Native codebase.
 *
 * Everything here exists to make Vite resolve modules the way Metro
 * already does, so that `src/` needs no bundler-specific code:
 *
 *   - resolve.extensions puts `.web.*` FIRST. This is the whole platform
 *     seam. `UsbSerialTransportClient.ts` imports
 *     './native/NativeUsbSerialTransport' with no extension; Metro picks
 *     the TurboModule file, Vite picks `NativeUsbSerialTransport.web.ts`
 *     and its Web Serial implementation. The same rule swaps the Skia
 *     orientation renderer for the SVG one, and App.tsx for App.web.tsx.
 *     No `Platform.OS` branch appears anywhere in the MSP encoder, the
 *     frame parser, or any save/safety path.
 *
 *   - `react-native` aliases to `react-native-web`. Every shared screen
 *     keeps importing 'react-native'.
 *
 *   - `__DEV__` is defined because React Native code (and this repo's own
 *     debug-panel resolution in src/ui/screens/debugPanels.ts) reads it as
 *     a global. It is FALSE in a production build, which is what keeps the
 *     debug panels out of the shipped browser bundle exactly as it keeps
 *     them out of a release APK.
 *
 * WHY NO SERVICE WORKER. A firmware flasher that serves itself from a
 * stale cache is a real hazard: the operator would flash from a build they
 * did not choose and could not identify. The PWA manifest gives the app
 * its name, icon, RTL direction and standalone display; caching is
 * deliberately left to ordinary HTTP.
 */

import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

/**
 * DEPLOYMENT KNOBS - environment-driven so the local run is untouched.
 *
 * All three default to the values the local `npm run web` / `npm run
 * build:web` already used, so an unset environment behaves exactly as
 * before. Only the GitHub Pages preview workflow sets them.
 *
 * FPV_ARBCON_WEB_BASE - GitHub Pages serves a project site from a
 * SUBPATH (/FPV-ARBCON/), not from the origin root. Without this every
 * asset and every lazy chunk would be requested from `/assets/...` and
 * 404. It stays '/' locally, where the app is served from the root.
 *
 * FPV_ARBCON_WEB_SOURCEMAP - see the `sourcemap` entry below for the
 * reasoning; the preview turns maps OFF, local builds keep them ON.
 *
 * VITE_FPV_ARBCON_PREVIEW - read by App.web.tsx (through
 * import.meta.env, which is why it carries Vite's own VITE_ prefix) to
 * show the preview banner. It changes NOTHING else: no transport is
 * stubbed, no capability is faked, and the real connection path is
 * untouched.
 */
const WEB_BASE = process.env.FPV_ARBCON_WEB_BASE ?? '/';
const PUBLISH_SOURCEMAPS = process.env.FPV_ARBCON_WEB_SOURCEMAP !== 'false';

export default defineConfig(({mode}) => {
  const isProduction = mode === 'production';

  return {
    base: WEB_BASE,

    // The plugin is configured with its defaults on purpose. This project's
    // Babel setup (@react-native/babel-preset) is Metro's concern; the
    // browser build compiles plain TS/TSX, and react-native-web ships
    // already-transpiled JavaScript.
    plugins: [react()],

    resolve: {
      // ORDER IS LOAD-BEARING. `.web.*` before the bare extensions.
      extensions: [
        '.web.tsx',
        '.web.ts',
        '.web.jsx',
        '.web.js',
        '.tsx',
        '.ts',
        '.jsx',
        '.js',
        '.json',
        '.mjs',
      ],
      alias: [{find: /^react-native$/, replacement: 'react-native-web'}],
    },

    define: {
      __DEV__: JSON.stringify(!isProduction),
      // Some React Native dependencies still reference `global`.
      global: 'globalThis',
      'process.env.NODE_ENV': JSON.stringify(mode),
    },

    optimizeDeps: {
      // Dev-server pre-bundling only; `vite build` does not consult this.
      include: ['react', 'react-dom', 'react-native-web', 'esptool-js'],
    },

    build: {
      outDir: 'dist-web',
      /**
       * ON locally, OFF for the public preview - a deliberate split, not
       * an oversight.
       *
       * KEEPING THEM LOCALLY: real stack traces for a tool that talks to
       * hardware. When an operator reports a flashing failure, a minified
       * frame number is not evidence.
       *
       * DROPPING THEM FROM THE PREVIEW: the maps inline the complete
       * original source of every module in the graph - this repository's
       * own files AND every dependency - which is ~5MB of payload that a
       * preview visitor downloads for no benefit to them. This repository
       * is public, so no secret is exposed either way and that is NOT the
       * argument; the argument is that a public preview should not serve
       * the entire internal source tree, including the reasoning in the
       * comments, as a side effect of being previewable. Debug builds are
       * where maps belong. No credential, token or internal hostname
       * exists in this source to leak in the first place - checked, not
       * assumed.
       */
      sourcemap: PUBLISH_SOURCEMAPS,
      target: 'es2022',
      rollupOptions: {
        output: {
          /**
           * Keep the React/react-native-web runtime in its own chunk so
           * the lazy screen chunks stay small and stay cacheable across
           * releases. Written as a FUNCTION rather than the object form:
           * Vite 8 bundles with Rolldown, which accepts only the function
           * signature and fails the build outright on the object.
           */
          manualChunks(id: string) {
            if (
              id.includes('node_modules/react-native-web/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react/') ||
              id.includes('node_modules/scheduler/')
            ) {
              return 'react-vendor';
            }
            return undefined;
          },
        },
      },
    },

    server: {
      port: 5173,
      // Web Serial and WebUSB require a secure context. localhost counts
      // as one, so plain HTTP is correct for local development; a
      // deployed build must be served over real HTTPS.
      host: '127.0.0.1',
    },

    preview: {
      port: 4173,
      host: '127.0.0.1',
    },
  };
});
