module.exports = {
  preset: '@react-native/jest-preset',
  // Pass 7.1: @react-navigation/* and react-native-screens (and some of
  // their transitive deps) ship ESM-only builds - the RN preset's default
  // transformIgnorePatterns only allows-list react-native/@react-native
  // packages, so these must be added or Jest fails to parse their `export`
  // syntax.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-screens|react-native-safe-area-context|@shopify/react-native-skia)/)',
  ],
  // Pass 7.4: OrientationRenderer.tsx (src/ui/orientation3d) imports the
  // real @shopify/react-native-skia - it has no native module to run
  // against under plain Jest, only its own official jestSetup.js mock
  // (CanvasKit-free, per that package's own documentation). This is
  // needed so SetupScreen.test.tsx (Step 5/6) can mount the real screen
  // without a GPU/WebGL context, per this pass's own testing strategy.
  setupFiles: ['@shopify/react-native-skia/jestSetup.js'],
};
