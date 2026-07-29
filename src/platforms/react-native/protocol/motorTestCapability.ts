/**
 * THE MOTOR-TEST CAPABILITY STORE - one implementation, every build.
 *
 * WHAT THIS REPLACES. Three modules and a bundler rule:
 * `motorTestDebugSeam.ts` (a `__DEV__` gate), `motorTestEngineVariant.ts` /
 * `.hardwareTest.ts` (a build-variant pair), and the `resolveRequest` rule
 * in metro.config.js that chose between them from
 * `FPV_ARBCON_HARDWARE_TEST=1`. All of it existed to answer one question:
 * does this build contain the motor engine? The answer is now
 * unconditionally yes, so the question and every mechanism that asked it
 * are gone rather than left with one branch permanently taken.
 *
 * The imports below are STATIC. The earlier `require()`s were
 * cycle-breaking, needed only because the variant module pulled in
 * `MotorsScreen`, which imports this store. Motors is now reached through
 * the tab shell rather than through the seam, so no cycle exists and
 * nothing here defers evaluation.
 *
 * WHAT THE MERGE ACTUALLY COST, stated plainly rather than implied. The
 * removed seam WAS a real barrier: a bundle that does not contain a
 * motor-command path cannot be made to execute one by any bug. It is
 * replaced by nothing. The RUNTIME gates in `MotorTestController` are now
 * the sole remaining barrier:
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
 * WHAT IT IS NOT. Not a feature flag, not a runtime toggle, not a caller
 * option. No setter, no exported mutable, no build conditional, and no
 * consultation of `__DEV__`, `NODE_ENV`, `process.env` or `globalThis`.
 */

import {
  createMotorTestSessionBinding,
  type MotorTestSessionCapability,
} from './motorTestSessionBinding';
import {MotorTestTelemetryRegistry} from '../../../core/protocol/telemetry/motorTestTelemetryBarrier';
import type {MspClient} from '../../../core/protocol/mspClient';

/**
 * Builds the coordinator-wide motor-test telemetry registry.
 *
 * A function rather than a module-level singleton: the registry is the
 * anchor store for ONE coordinator, and a shared instance would let one
 * coordinator's anchors be visible to another's (including across Jest
 * module registries).
 */
export function createMotorTestTelemetryRegistry(): MotorTestTelemetryRegistry {
  return new MotorTestTelemetryRegistry();
}

/** Keyed by sessionId. Module-private: nothing outside this file can read,
 * replace or enumerate it. */
const CAPABILITIES = new Map<string, MotorTestSessionCapability>();

/**
 * Builds the capability for one session and remembers it.
 *
 * TOTAL, NEVER PARTIAL. There is no build, and no caller, in which this
 * can fail to produce a capability:
 *   - `createMotorTestSessionBinding` is a static import of a module every
 *     build contains, so the factory is never absent;
 *   - the registry is a `private readonly` field on the coordinator,
 *     initialised inline in the class body, so it exists before any
 *     instance method can run.
 * The former `| undefined` return - and the coordinator's fallback that
 * read it - are therefore removed rather than left as an unreachable
 * second way to construct a scheduler.
 *
 * The caller creates its telemetry scheduler FROM the returned capability,
 * which is what preserves the P4 construction boundary: the binding mints
 * the anchor for this exact client and is the only thing that can create a
 * scheduler for it, so "scheduler polls client A while the anchor names
 * client B" stays unrepresentable.
 */
export function openMotorTestCapability(
  sessionId: string,
  client: MspClient,
  registry: MotorTestTelemetryRegistry,
): MotorTestSessionCapability {
  const capability = createMotorTestSessionBinding(client, {registry});
  CAPABILITIES.set(sessionId, capability);
  return capability;
}

/** Closes and forgets one session's capability. A no-op for a session that
 * never had one. */
export function closeMotorTestCapability(sessionId: string): void {
  const capability = CAPABILITIES.get(sessionId);
  CAPABILITIES.delete(sessionId);
  capability?.close();
}

/**
 * The capability for one session, or `undefined` when that session has
 * none.
 *
 * `undefined` here means exactly one thing: no live, identified session by
 * that id ever opened a capability. It is NOT a build condition. The
 * Motors tab presents it as the blocked "no session" state, which is the
 * correct presentation for a tab opened before a connection exists.
 */
export function readMotorTestCapability(
  sessionId: string,
): MotorTestSessionCapability | undefined {
  return CAPABILITIES.get(sessionId);
}
