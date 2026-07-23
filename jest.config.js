module.exports = {
  preset: '@react-native/jest-preset',
  // Pass 7.1: @react-navigation/* and react-native-screens (and some of
  // their transitive deps) ship ESM-only builds - the RN preset's default
  // transformIgnorePatterns only allows-list react-native/@react-native
  // packages, so these must be added or Jest fails to parse their `export`
  // syntax.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-screens|react-native-safe-area-context)/)',
  ],
};
