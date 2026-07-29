/**
 * THE MOTOR-TEST ENGINE REFERENCES - ONE IMPLEMENTATION, EVERY BUILD.
 *
 * WHAT THIS REPLACES. R3's build-variant seam: `motorTestEngineVariant.ts`
 * (all exports `undefined`) and `motorTestEngineVariant.hardwareTest.ts`
 * (the real ones), selected between by a `resolveRequest` rule in
 * metro.config.js driven by `FPV_ARBCON_HARDWARE_TEST=1`. Two files, a
 * bundler rule and an environment variable existed to answer one question:
 * does this build contain the motor engine? The answer is now
 * unconditionally yes, so the question - and every mechanism that asked
 * it - is gone rather than left with one branch permanently taken.
 *
 * WHAT THAT TRADE ACTUALLY IS, stated plainly rather than implied. The
 * seam WAS a real barrier: Production did not contain a motor-command
 * path, so no bug in it could reach one. It is replaced by nothing. The
 * RUNTIME gates in `MotorTestController` are now the sole remaining
 * barrier:
 *
 *   - single-motor payload only, fixed low pulse;
 *   - 3-second deadline measured from command start;
 *   - explicit STOP with queue priority;
 *   - continuous MSP_STATUS_EX / MSP_BATTERY_STATE monitoring, whose
 *     absence is itself an authoritative blocker;
 *   - armed-state and arming-restriction blocks;
 *   - battery scope enforcement (4S only; 6S rejected);
 *   - 3D-mode rejection;
 *   - displaced-response quarantine, and the native write timeout
 *     (`TX_WRITE_TIMEOUT_MILLIS`, UsbSerialTransportModule.kt:1329 - the
 *     value there is 150, read rather than assumed).
 *
 * None of them is touched by this module, and none may be weakened,
 * simplified or refactored as a consequence of the merge.
 *
 * WHY `require()` AND NOT `import`. Not containment - CYCLE BREAKING.
 * `MotorsScreen` imports the capability reader from this package, so a
 * static import of the screen here would close a module-evaluation cycle.
 * The `require()` calls below are unconditional and always execute; they
 * defer evaluation, they do not gate it. There is no `__DEV__`, no
 * `process.env`, no `globalThis` and no flag anywhere in this file.
 */

import type {MotorTestSessionCapability} from './motorTestSessionBinding';
import type {MotorTestTelemetryRegistry} from '../../../core/protocol/telemetry/motorTestTelemetryBarrier';
import type {MspClient} from '../../../core/protocol/mspClient';

export type MotorTestBindingFactory = (
  client: MspClient,
  options: {readonly registry: MotorTestTelemetryRegistry},
) => MotorTestSessionCapability;

export type MotorTestRegistryConstructor = new () => MotorTestTelemetryRegistry;

/** Structural types, so this module's type surface pulls in no component. */
export type BenchScreenComponent = typeof import('../../../ui/screens/MotorsScreen').default;
export type BenchEntryComponent = typeof import('../../../ui/screens/MotorsDevEntry').default;

export const motorTestBindingFactory: MotorTestBindingFactory =
  require('./motorTestSessionBinding')
    .createMotorTestSessionBinding as MotorTestBindingFactory;

export const motorTestRegistryConstructor: MotorTestRegistryConstructor =
  require('../../../core/protocol/telemetry/motorTestTelemetryBarrier')
    .MotorTestTelemetryRegistry as MotorTestRegistryConstructor;

export const benchScreen: BenchScreenComponent =
  require('../../../ui/screens/MotorsScreen').default as BenchScreenComponent;

export const benchEntry: BenchEntryComponent =
  require('../../../ui/screens/MotorsDevEntry').default as BenchEntryComponent;

export const benchRouteName: 'Motors' =
  require('../../../ui/screens/MotorsDevEntry').MOTORS_ROUTE_NAME as 'Motors';
