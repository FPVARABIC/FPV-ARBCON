/**
 * THE BUILD-VARIANT SEAM - PRODUCTION IMPLEMENTATION.
 *
 * This file is what every ordinary build compiles against: TypeScript,
 * Jest, and the normal Production Release bundle all resolve
 * `./motorTestEngineVariant` to THIS module, which contains no motor-test
 * import of any kind. There is no flag to flip here and no branch to take:
 * production exclusion is a property of WHICH FILE WAS COMPILED, not of a
 * value evaluated at runtime.
 *
 * The Hardware Test build resolves the same specifier to
 * `motorTestEngineVariant.hardwareTest.ts` instead - see the
 * `resolveRequest` rule in metro.config.js, which is driven by the
 * `FPV_ARBCON_HARDWARE_TEST` build environment. Because the redirection
 * happens during bundling, the Production graph never contains the
 * hardware-test module and the motor engine is not merely unreachable in
 * it - it is absent, which the CI containment scanner proves on the real
 * emitted bytes.
 *
 * WHY NOT `__DEV__` ALONE. `__DEV__` separates Debug from Release; it
 * cannot express "a Release build that deliberately carries the engine".
 * A runtime flag, an environment read inside the app, or a hidden gesture
 * would all leave the engine present in Production and rely on nobody
 * reaching it. This seam removes it from the graph instead.
 */

import type {
  MotorTestBindingFactory,
  MotorTestRegistryConstructor,
  BenchScreenComponent,
  BenchEntryComponent,
} from './motorTestDebugSeam';

/** Absent in Production. Never a stub that pretends to work. */
export const variantMotorTestBindingFactory: MotorTestBindingFactory | undefined = undefined;

/** Absent in Production. */
export const variantMotorTestRegistryConstructor: MotorTestRegistryConstructor | undefined =
  undefined;

/**
 * Whether this build is the internal Hardware Test variant.
 *
 * Read it to DESCRIBE the build - in a banner, a label, or a log line -
 * never to decide whether a motor may run. That decision belongs to the
 * controller's activation gate, which requires a live continuous safety
 * monitor and is unaffected by this constant.
 */
export const IS_HARDWARE_TEST_BUILD = false;

/** The motor-test screen, absent in Production. */
export const variantBenchScreen: BenchScreenComponent | undefined = undefined;

/** The development-only entry control, absent in Production. */
export const variantBenchEntry: BenchEntryComponent | undefined = undefined;

/** The route NAME is data too: a literal would survive minification even
 * with the screen stripped, so Production carries none. */
export const variantBenchRouteName: 'Motors' | undefined = undefined;
