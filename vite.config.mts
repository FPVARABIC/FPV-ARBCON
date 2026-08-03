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

export default defineConfig(({mode}) => {
  const isProduction = mode === 'production';

  return {
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
      // Real stack traces for a tool that talks to hardware. When an
      // operator reports a flashing failure, a minified frame number is
      // not evidence.
      sourcemap: true,
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
