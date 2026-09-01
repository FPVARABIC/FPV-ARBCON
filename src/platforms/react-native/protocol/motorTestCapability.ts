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
 *   - renewable touch heartbeat with a short lost-touch deadline;
 *   - explicit STOP with queue priority;
 *   - continuous MSP_STATUS_EX armed-state monitoring, whose absence is
 *     itself an authoritative blocker;
 *   - a fresh disarmed-state observation before activation and throughout
 *     every live pulse;
 *   - supported motor count/protocol scope and 3D-mode rejection;
 *   - displaced-response quarantine, and the native write timeout
 *     (`TX_WRITE_TIMEOUT_MILLIS`, UsbSerialTransportModule.kt:1329 - the
 *     value there is 150, read rather than assumed).
 *
 * The current controller does NOT infer or enforce a battery cell count;
 * battery suitability remains an explicit operator warning rather
 * than a claim derived from MSP. None of the runtime gates above is touched
 * by this module, and none may be weakened,
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
import type {MotorTestControllerSnapshot} from '../../../core/state/motorTestController';
import {
  evaluateMotorOutputEngagement,
  type MotorOutputEngagementVerdict,
} from '../../../core/state/motorOutputEngagement';

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
 * Listeners waiting for a session's capability to APPEAR, keyed by sessionId.
 *
 * WHY THIS EXISTS - THE DEFECT IT CLOSES. The capability is created inside
 * `MspSessionCoordinator.startTelemetry()`, which runs in the continuation
 * of `client.startReading()`. Navigation to the post-connection route
 * happens earlier, the moment ownership goes ACTIVE. So there is a real
 * window in which the operator is looking at the tab shell and the
 * capability for that session does not exist yet.
 *
 * The Motors container reads the capability once, in a `useMemo` keyed on
 * `sessionKey.sessionId` - a value that never changes for the life of the
 * mounted panel. Under the old stack navigation the screen was mounted
 * fresh on every navigation, so a read that came back `undefined` could
 * not persist. Under the tab shell the panel is mounted once and then kept
 * alive with `display: 'none'`, so an `undefined` read became PERMANENT:
 * the screen stayed in its blocked no-session presentation forever, the
 * hold control stayed `disabled`, and pressing it did nothing at all -
 * even after identification had long since succeeded.
 *
 * A subscription is the honest fix. Polling would race, and re-deriving off
 * an indirect signal (identification or ownership state) would only be
 * correct by coincidence of ordering. This fires from the one place that
 * knows: the store, at the moment it stores.
 */
const OPENED_LISTENERS = new Map<string, Set<() => void>>();

/**
 * Notified when `openMotorTestCapability` stores a capability for this
 * exact sessionId. Returns an unsubscribe.
 *
 * Fires ONLY on transition to existing. It is not a general-purpose event
 * bus: it carries no capability, no client and no session, so a listener
 * cannot obtain anything through it - it must still call
 * `readMotorTestCapability` and go through the same checks as any caller.
 */
export function subscribeMotorTestCapabilityOpened(
  sessionId: string,
  listener: () => void,
): () => void {
  const existing = OPENED_LISTENERS.get(sessionId) ?? new Set<() => void>();
  existing.add(listener);
  OPENED_LISTENERS.set(sessionId, existing);
  return () => {
    const set = OPENED_LISTENERS.get(sessionId);
    if (set === undefined) {
      return;
    }
    set.delete(listener);
    if (set.size === 0) {
      OPENED_LISTENERS.delete(sessionId);
    }
  };
}

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
  // Announce AFTER the store is consistent, so any listener that
  // immediately calls readMotorTestCapability() sees it. Iterated over a
  // copy: a listener that unsubscribes itself must not mutate the set
  // mid-iteration.
  for (const listener of [...(OPENED_LISTENERS.get(sessionId) ?? [])]) {
    listener();
  }
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

/**
 * Whether a motor-test session is occupying this link RIGHT NOW.
 *
 * THE FIELD BUG THIS REPLACES. Four controllers (Ports, GPS, General and
 * Motor configuration) each carried an identical private copy of this
 * predicate, and every copy treated `pulse.mayHaveReachedFc` as a
 * liveness signal. That flag is a PERMANENT per-session safety latch -
 * the controller sets it at pulse submission and documents it as "never
 * cleared" - so a single motor test made every one of those screens
 * answer MOTOR_TEST_ACTIVE for the rest of the physical session. The
 * operator saw "أوقف جلسة اختبار المحركات قبل تعديل التكوينات" with no
 * motor session visibly running, could not save Ports or Configurations,
 * and had to unplug and replug the USB cable to recover.
 *
 * The latch itself is correct and is kept: while a session is live it
 * genuinely means "a motor command may already have reached the FC".
 * What was wrong was reading history as liveness.
 *
 * A CLOSED controller whose own teardown reported `complete` has
 * conclusively given up exclusivity (that is exactly what
 * MotorTestTeardownReport.complete means: exclusivity gone AND every
 * teardown step finished). That is not an active session. Every other
 * shape - closing, closed with an unresolved lease release, or no
 * teardown report at all - still blocks, so an UNCONFIRMED stop keeps
 * every configuration screen locked exactly as before.
 */
export function isMotorTestSnapshotActive(
  snapshot: MotorTestControllerSnapshot | undefined,
): boolean {
  if (snapshot === undefined) {
    return false;
  }
  if (snapshot.phase === 'IDLE') {
    // Nothing was ever acquired for this capability.
    return false;
  }
  if (snapshot.phase === 'CLOSED' && snapshot.teardown?.complete === true) {
    return false;
  }
  return (
    snapshot.phase === 'PREPARING' ||
    snapshot.phase === 'ACTIVE' ||
    snapshot.phase === 'CLOSING' ||
    snapshot.pulse.mayHaveReachedFc ||
    snapshot.machine?.name === 'Starting' ||
    snapshot.machine?.name === 'Pulsing' ||
    snapshot.machine?.name === 'Stopping'
  );
}

/** The session-id lookup over isMotorTestSnapshotActive(). */
export function isMotorTestSessionActive(sessionId: string): boolean {
  return isMotorTestSnapshotActive(
    CAPABILITIES.get(sessionId)?.lifecycleStopPort()?.getSnapshot(),
  );
}

/**
 * The session-id lookup over evaluateMotorOutputEngagement().
 *
 * DIFFERENT QUESTION FROM isMotorTestSessionActive, deliberately. That one
 * asks whether a session EXISTS and is used where an open session genuinely
 * matters - the other screens, which share one serial link and must not
 * interleave writes with a motor bench. This one asks whether a motor could
 * be TURNING, which is the question the in-Motors configuration gate should
 * have been asking all along.
 *
 * THREE STATES, NOT TWO. Collapsing the first two is a defect this function
 * shipped and now fixes:
 *
 *   no capability .......... no identified session, or one torn down while a
 *                            command may have been live -> ENGAGED.
 *   capability, no port .... the session is open but never built a
 *                            controller -> AT REST, see below.
 *   capability with port ... ask the snapshot.
 *
 * WHY "NO PORT" IS PROOF OF REST, NOT AN ASSUMPTION. lifecycleStopPort()
 * returns undefined for exactly one reason - the binding never constructed a
 * MotorTestController - and that controller is the ONLY thing in the build
 * that can issue MSP_SET_MOTOR. No controller means no motor command was ever
 * emitted for this capability, which is a stronger guarantee than any latch.
 *
 * The isOpen() test is what keeps that honest. close() clears the controller
 * as well as the session, so a closed binding would otherwise present as
 * "never initiated" and read AT REST after a real motor test. The only
 * production teardown removes the capability from the registry first, but
 * close() is on the public facade, so this does not rely on that ordering.
 *
 * Absent or unreadable evidence is never evidence of safety: every path that
 * cannot prove rest returns ENGAGED.
 */
export function motorOutputEngagementForSession(
  sessionId: string,
): MotorOutputEngagementVerdict {
  const capability = CAPABILITIES.get(sessionId);
  if (capability === undefined) {
    return {engagement: 'ENGAGED', reason: 'NO_SNAPSHOT'};
  }
  const port = capability.lifecycleStopPort();
  if (port === undefined) {
    return capability.isOpen()
      ? {engagement: 'AT_REST', reason: 'NEVER_INITIATED'}
      : {engagement: 'ENGAGED', reason: 'NO_SNAPSHOT'};
  }
  return evaluateMotorOutputEngagement(port.getSnapshot());
}

/**
 * Convenience for gates that only need the boolean.
 *
 * DELEGATES rather than re-deriving. These two were written independently and
 * that is precisely how they could have disagreed - a gate blocking for one
 * reason while the screen explained a different one.
 */
export function isMotorOutputEngagedForSession(sessionId: string): boolean {
  return motorOutputEngagementForSession(sessionId).engagement === 'ENGAGED';
}
