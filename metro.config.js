const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * BUILD-VARIANT SEAM (R3). `FPV_ARBCON_HARDWARE_TEST=1` redirects the
 * specifier `./motorTestEngineVariant` to its `.hardwareTest` sibling, so
 * the internal Hardware Test bundle contains the motor-test engine and an
 * ordinary Production bundle contains no motor module at all. The choice
 * is made HERE, while the graph is built - not by a runtime flag inside
 * the app - which is why the engine is absent from Production rather than
 * merely unreachable in it. The `hardwareTest` Gradle build type sets the
 * variable; every other build leaves it unset.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const HARDWARE_TEST_BUILD = process.env.FPV_ARBCON_HARDWARE_TEST === '1';

const VARIANT_MODULE = 'motorTestEngineVariant';

const config = {
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      if (HARDWARE_TEST_BUILD && moduleName.endsWith(`/${VARIANT_MODULE}`)) {
        return context.resolveRequest(
          context,
          `${moduleName}.hardwareTest`,
          platform,
        );
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
