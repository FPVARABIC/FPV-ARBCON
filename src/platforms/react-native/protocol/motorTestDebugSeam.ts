/**
 * Repair Pass R2 - THE ONE BUILD-TIME CONTAINMENT SEAM for the motor-test
 * runtime graph.
 *
 * THE DEFECT THIS CLOSES. `MspSessionCoordinator` statically imported
 * `motorTestSessionBinding`, which imports the controller, which imports
 * the vector builders, the payload encoder, the lease and the pulse
 * constant. A static import is retained by Metro no matter what runtime
 * guard wraps its use, so an entire motor-command engine shipped inside
 * every Release bundle - reachable or not. Presence is the problem: a
 * bundle that contains a motor-command path is a bundle in which one bug,
 * one misrouted call or one future refactor can reach it.
 *
 * HOW IT IS CLOSED. Exactly the mechanism `debugPanels.ts` already
 * established for the debug panels, applied to the engine: a
 * `__DEV__`-guarded `require()`. Metro inlines `__DEV__` as the literal
 * `false` for `--dev false`, the branch becomes unreachable, and the
 * minifier drops the `require()` - so the binding, the controller and
 * everything they pull in never enter the Release dependency graph at all.
 * A static `import` could not achieve this, which is precisely why this
 * module exists.
 *
 * WHAT THIS IS NOT. It is not a feature flag, not a runtime toggle, not a
 * caller option, and not configurable. There is no setter, no exported
 * mutable, and no consultation of `NODE_ENV`, `process.env`, `globalThis`
 * or remote configuration. `__DEV__` is resolved by the BUILD, not at
 * runtime, and nothing can flip it afterwards. There is deliberately no
 * release-time fallback that would load the engine anyway.
 *
 * WHAT IT DOES NOT WEAKEN. In Debug and Jest the coordinator still builds
 * its scheduler THROUGH the binding, so the Phase 2E (P4) authoritative
 * construction boundary is untouched: the binding still mints the anchor
 * for the exact client it was given and is still the only thing that can
 * create a scheduler for it, so the "scheduler polls client A while the
 * anchor names client B" composition remains unrepresentable. R2 changes
 * WHERE the engine can exist, never HOW it is constructed.
 *
 * WHAT RELEASE DOES INSTEAD. Release telemetry builds its scheduler
 * directly from the accepted `createMspTelemetryScheduler` factory - the
 * same factory the binding itself delegates to - so polling registration,
 * cadence, tick, stop and disposal behaviour are identical. Release simply
 * has no motor-test anchor, because Release has no motor test.
 */

import type {MotorTestSessionCapability} from './motorTestSessionBinding';
import type {MotorTestTelemetryRegistry} from '../../../core/protocol/telemetry/motorTestTelemetryBarrier';
import type {MspClient} from '../../../core/protocol/mspClient';

/**
 * The binding factory, or `undefined` in a Release build.
 *
 * Type-only imports above erase completely at compile time and pull no
 * runtime module into the graph; this `require()` is the only runtime
 * reference, and it is unreachable under `--dev false`.
 */
export type MotorTestBindingFactory = (
  client: MspClient,
  options: {readonly registry: MotorTestTelemetryRegistry},
) => MotorTestSessionCapability;

export const devMotorTestBindingFactory: MotorTestBindingFactory | undefined =
  __DEV__
    ? (require('./motorTestSessionBinding')
        .createMotorTestSessionBinding as MotorTestBindingFactory)
    : undefined;

/**
 * The motor-test telemetry registry CONSTRUCTOR, or `undefined` in a
 * Release build.
 *
 * The registry is the coordinator-wide anchor store the barrier uses. It
 * exists solely to serve motor testing, so it is gated identically rather
 * than being left as a static import that would keep a motor-only module
 * in the Release graph.
 */
export type MotorTestRegistryConstructor = new () => MotorTestTelemetryRegistry;

export const devMotorTestRegistryConstructor:
  | MotorTestRegistryConstructor
  | undefined = __DEV__
  ? (require('../../../core/protocol/telemetry/motorTestTelemetryBarrier')
      .MotorTestTelemetryRegistry as MotorTestRegistryConstructor)
  : undefined;

/**
 * Whether this build contains the motor-test engine at all.
 *
 * Read it to DESCRIBE the build, never to decide whether a motor may run -
 * that decision belongs to the controller's own activation gate, which R1
 * made fail-closed and which this pass does not touch.
 */
export function isMotorTestEngineBundled(): boolean {
  return devMotorTestBindingFactory !== undefined;
}

/* ------------------------------------------------------------------ *
 * R2 - THE CAPABILITY STORE.
 *
 * The capability used to live on the coordinator's own session entry, and
 * the coordinator carried motor-named fields and accessors. Those names
 * survived into Release even once the engine itself was gone, because a
 * property key and a method name are data in the emitted bundle.
 *
 * They now live HERE, in the module that Release does not contain at all.
 * The coordinator keeps a generic lifecycle hook pair and no longer knows
 * that motor testing exists - which is the architectural boundary R2 is
 * actually about, not a renaming.
 * ------------------------------------------------------------------ */

/** Keyed by sessionId. Module-private: nothing outside this file can read,
 * replace or enumerate it, and in Release this module does not exist. */
const CAPABILITIES = new Map<string, MotorTestSessionCapability>();

/**
 * Builds the capability for one session and remembers it, or does nothing
 * at all in a build without the engine.
 *
 * Returns the scheduler the caller should use. In Debug that scheduler
 * comes from the binding, preserving the P4 construction boundary: the
 * binding mints the anchor for this exact client and is the only thing
 * that can create a scheduler for it. In Release it returns `undefined`
 * and the caller builds its own from the accepted factory.
 */
export function openMotorTestCapability(
  sessionId: string,
  client: MspClient,
  registry: MotorTestTelemetryRegistry | undefined,
): MotorTestSessionCapability | undefined {
  if (devMotorTestBindingFactory === undefined || registry === undefined) {
    return undefined;
  }
  const capability = devMotorTestBindingFactory(client, {registry});
  CAPABILITIES.set(sessionId, capability);
  return capability;
}

/** Closes and forgets one session's capability. A no-op in Release, and a
 * no-op for a session that never had one. */
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
