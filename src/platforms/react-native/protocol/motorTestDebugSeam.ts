/**
 * TRANSITIONAL - the former containment seam, now a plain re-export layer.
 *
 * STEP 2a OF THE SINGLE-APP MERGE. The build-variant seam this module used
 * to consume (`motorTestEngineVariant.ts` / `.hardwareTest.ts`, selected by
 * a `resolveRequest` rule in metro.config.js) is gone: there is one engine
 * module, `motorTestEngine.ts`, and every build has it. Nothing here is
 * conditional any more - no `__DEV__`, no environment read, no variant.
 *
 * The `dev*` and `hardwareTest*` export NAMES are retained for exactly one
 * step so this change stays reviewable in isolation. They are inaccurate,
 * and step 2c deletes this file: its consumers move to a capability store
 * that owns the per-session map and nothing else. Do not build on these
 * names.
 *
 * WHAT DID NOT CHANGE. The P4 construction boundary: the binding still
 * mints the telemetry anchor for the exact client it was given and is
 * still the only thing that can create a scheduler for that client, so the
 * "scheduler polls client A while the anchor names client B" composition
 * remains unrepresentable. And every runtime safety gate in
 * MotorTestController is untouched - see motorTestEngine.ts for the list
 * and for what the removed compile-time barrier actually cost.
 */

import {
  motorTestBindingFactory,
  motorTestRegistryConstructor,
  benchScreen,
  benchEntry,
  benchRouteName,
  type MotorTestBindingFactory,
  type MotorTestRegistryConstructor,
  type BenchScreenComponent,
  type BenchEntryComponent,
} from './motorTestEngine';
import type {MotorTestSessionCapability} from './motorTestSessionBinding';
import type {MotorTestTelemetryRegistry} from '../../../core/protocol/telemetry/motorTestTelemetryBarrier';
import type {MspClient} from '../../../core/protocol/mspClient';

export type {MotorTestBindingFactory};

/** One implementation, every build. Never `undefined`. */
export const devMotorTestBindingFactory: MotorTestBindingFactory =
  motorTestBindingFactory;

export type {MotorTestRegistryConstructor};

/** One implementation, every build. Never `undefined`. */
export const devMotorTestRegistryConstructor: MotorTestRegistryConstructor =
  motorTestRegistryConstructor;

/** Every build contains the engine now. Retained for one step so the
 * existing callers keep compiling; removed with this file in step 2c. */
export function isMotorTestEngineBundled(): boolean {
  return true;
}

/* ------------------------------------------------------------------ *
 * THE CAPABILITY STORE. Exactly one module may construct a capability, so
 * a second, unregistered capability for the same client cannot be minted
 * by any consumer.
 * ------------------------------------------------------------------ */

/** Keyed by sessionId. Module-private: nothing outside this file can read,
 * replace or enumerate it. */
const CAPABILITIES = new Map<string, MotorTestSessionCapability>();

/**
 * Builds the capability for one session and remembers it.
 *
 * The caller creates its telemetry scheduler FROM the returned capability,
 * which is what preserves the P4 construction boundary. `undefined` is
 * returned only when no registry was supplied - never because of a build.
 */
export function openMotorTestCapability(
  sessionId: string,
  client: MspClient,
  registry: MotorTestTelemetryRegistry | undefined,
): MotorTestSessionCapability | undefined {
  if (registry === undefined) {
    return undefined;
  }
  const capability = devMotorTestBindingFactory(client, {registry});
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

/** The capability for one session, or undefined. */
export function readMotorTestCapability(
  sessionId: string,
): MotorTestSessionCapability | undefined {
  return CAPABILITIES.get(sessionId);
}


/* ------------------------------------------------------------------ *
 * The SCREEN references. Unconditional, like the engine ones above.
 * ------------------------------------------------------------------ */

export type {BenchScreenComponent, BenchEntryComponent};

/** The motor-test screen. Present in every build. */
export const hardwareTestBenchScreen: BenchScreenComponent = benchScreen;

/** The entry control. Present in every build. */
export const hardwareTestBenchEntry: BenchEntryComponent = benchEntry;

/** The route name. Present in every build. */
export const hardwareTestBenchRouteName: 'Motors' = benchRouteName;
