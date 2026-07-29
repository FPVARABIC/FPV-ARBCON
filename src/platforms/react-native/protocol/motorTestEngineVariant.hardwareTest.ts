/**
 * THE BUILD-VARIANT SEAM - HARDWARE TEST IMPLEMENTATION.
 *
 * Compiled ONLY into the internal `FPV-ARBCON Hardware Test` variant.
 * metro.config.js redirects `./motorTestEngineVariant` here when the
 * bundle is produced with `FPV_ARBCON_HARDWARE_TEST=1`, which the
 * `hardwareTest` Gradle build type sets. No ordinary Production build
 * ever resolves this file, so nothing it requires can enter the
 * Production dependency graph.
 *
 * These are STATIC requires on purpose: this module only exists inside a
 * build that is meant to contain the engine, so there is nothing here to
 * hide behind a runtime guard. The safety gates are entirely unchanged -
 * carrying the engine is not permission to run a motor, and the
 * controller still refuses activation without a live, fresh continuous
 * safety observation.
 */

import type {
  MotorTestBindingFactory,
  MotorTestRegistryConstructor,
  BenchScreenComponent,
  BenchEntryComponent,
} from './motorTestDebugSeam';

export const variantMotorTestBindingFactory: MotorTestBindingFactory | undefined =
  require('./motorTestSessionBinding').createMotorTestSessionBinding as MotorTestBindingFactory;

export const variantMotorTestRegistryConstructor: MotorTestRegistryConstructor | undefined =
  require('../../../core/protocol/telemetry/motorTestTelemetryBarrier')
    .MotorTestTelemetryRegistry as MotorTestRegistryConstructor;

/** This build IS the internal Hardware Test variant. Descriptive only -
 * it grants nothing and no gate consults it. */
export const IS_HARDWARE_TEST_BUILD = true;

export const variantBenchScreen: BenchScreenComponent | undefined =
  require('../../../ui/screens/MotorsScreen').default as BenchScreenComponent;

export const variantBenchEntry: BenchEntryComponent | undefined =
  require('../../../ui/screens/MotorsDevEntry').default as BenchEntryComponent;

export const variantBenchRouteName: 'Motors' | undefined =
  require('../../../ui/screens/MotorsDevEntry').MOTORS_ROUTE_NAME as 'Motors';
