const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * NO BUILD-VARIANT SEAM. R3 installed a `resolveRequest` rule here that
 * redirected `./motorTestEngineVariant` to a `.hardwareTest` sibling when
 * `FPV_ARBCON_HARDWARE_TEST=1`, so the internal Hardware Test bundle
 * carried the motor-test engine and an ordinary Production bundle carried
 * no motor module at all.
 *
 * That split is deliberately gone. The owner has settled on a single
 * unified app in which Motors is reached through normal navigation after a
 * real connection - the same model Betaflight Configurator uses - so there
 * is one bundle, one application id, and one module graph. Removing the
 * rule removes a real barrier: a bundle that does not contain a
 * motor-command path cannot be made to execute one by any bug. The runtime
 * gates in MotorTestController are now the sole barrier, and they are
 * load-bearing in a way they were not before. See
 * src/platforms/react-native/protocol/motorTestEngine.ts.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
