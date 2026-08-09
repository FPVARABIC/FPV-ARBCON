module.exports = {
  preset: '@react-native/jest-preset',
  // Pass 7.1: @react-navigation/* and react-native-screens (and some of
  // their transitive deps) ship ESM-only builds - the RN preset's default
  // transformIgnorePatterns only allows-list react-native/@react-native
  // packages, so these must be added or Jest fails to parse their `export`
  // syntax.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-screens|react-native-safe-area-context|@shopify/react-native-skia|esptool-js)/)',
  ],
  // Pass 7.4: OrientationRenderer.tsx (src/ui/orientation3d) imports the
  // real @shopify/react-native-skia - it has no native module to run
  // against under plain Jest, only its own official jestSetup.js mock
  // (CanvasKit-free, per that package's own documentation). This is
  // needed so SetupScreen.test.tsx (Step 5/6) can mount the real screen
  // without a GPU/WebGL context, per this pass's own testing strategy.
  setupFiles: ['@shopify/react-native-skia/jestSetup.js'],
  /**
   * THE FIX FOR A LOAD-DEPENDENT FLAKE, diagnosed rather than reruled away.
   *
   * One full-suite run failed with a single unidentified test. Thirteen
   * idle reruns were clean, so the cause was found by changing the
   * CONDITIONS instead of repeating them: with the CPU oversubscribed 8x
   * and maxWorkers=100%, 38 tests fail together, every one of them with
   * `Exceeded timeout of 5000 ms for a test` - Jest's IMPLICIT default,
   * which this project had never set.
   *
   * The suites that fail are the honest, heavy ones: they drive the real
   * MspSessionCoordinator, the real MspClient and thousands of fake-timer
   * ticks. Measured idle, the slowest single test already sat at ~3.5s -
   * about 70% of the implicit budget - and it reaches 20.3s under load.
   * (Measured: that test's own work is only ~48ms of encode+decode; the
   * rest is Jest's deep-equality over a 262,147-element Uint8Array. The
   * cost is CPU-bound, so it scales directly with how busy the machine is.)
   *
   * So the pass/fail signal depended on machine load rather than on
   * correctness. An explicit budget removes that dependence without
   * weakening a single assertion. 30s is ~8.5x the idle worst case and
   * still fails a genuinely hung test promptly - a hang never completes.
   */
  testTimeout: 30000,
};
