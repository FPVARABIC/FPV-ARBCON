import {MSP_RC, decodeRcChannels, type MspTelemetryScheduler} from '../../../core';
import {
  ATTITUDE_TELEMETRY_POLL_ID,
  FC_STATUS_TELEMETRY_POLL_ID,
  mspSessionCoordinator,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';

/**
 * RECEIVER P2 - how fast the SHARED FC status poll runs while a Receiver
 * surface is visible.
 *
 * The status poll carries the arming-disable flags from which failsafe /
 * RXLOSS / BOXFAILSAFE are resolved. Its registered cadence is 8000ms,
 * chosen for an idle Setup screen; for a live receiver view that is far
 * too slow - a pilot could lose the link and see a healthy screen for up
 * to eight seconds.
 *
 * This is a reference-counted OVERRIDE of the one canonical poll, not a
 * second registration: duplicating the status command would put two
 * requests for identical data on a serialised link and let two screens
 * disagree. The boost is released with the Receiver acquisition, so
 * Setup's idle cadence is unaffected once the screen is left.
 *
 * 300ms, chosen against our own scheduler rather than copied: it makes a
 * failsafe transition visible inside roughly a third of a second, and it
 * costs ~3.3 requests/second against the ~25/second live RC already uses.
 * Deterministic mixed-load tests confirm RC keeps its cadence and no
 * slower family is starved. Betaflight Configurator polls comparable
 * status at 250ms; that is corroboration, not the reason.
 */
export const RECEIVER_STATUS_BOOST_INTERVAL_MS = 300;

export const RECEIVER_CHANNELS_POLL_ID = 'receiver-channels-live';

/**
 * REQUESTED live-RC interval. Not a promise of a delivered rate - the
 * achieved cadence is transport-dependent and is measured, not declared
 * (see MspTelemetryScheduler's observedSampleRateHz).
 *
 * Chosen against our own scheduler, not copied from another configurator.
 * With the opportunity clock at 10ms (MspSessionCoordinator's own
 * TELEMETRY_TICK_INTERVAL_MS note), a poll's steady-state period is its
 * interval rounded up to the next 10ms boundary, so 33ms settles at a
 * 40ms period - about 25 delivered samples per second whenever the link
 * services a request inside that window.
 *
 * Why not lower: 30ms would land exactly on the grid and run ~33Hz, which
 * buys little perceptually and spends noticeably more of a serialised
 * link that also carries attitude, battery, GPS and status. At a 15ms
 * service time, 33ms leaves roughly 60% of the link idle for them;
 * chasing 40Hz would leave far less. Why not higher: 50ms is where the
 * old cadence already sat.
 *
 * Anything in (30, 40] produces the same 40ms period; 33 is stated
 * because it is the value the P0 model was built and re-verified on.
 */
export const RECEIVER_CHANNELS_POLL_INTERVAL_MS = 33;

/**
 * Audited at the P1 cadence rather than rescaled with it. 700ms is ~17
 * missed samples at the new 40ms period (it was ~14 at the old 50ms one)
 * - still comfortably under a second, so a genuinely frozen link is still
 * flagged promptly. It must also stay well clear of the worst delivered
 * gap on a SLOW but working link: at a 224ms service time the measured
 * gap is ~230ms, so 700ms leaves 3x headroom and cannot flash a false
 * stale state on a link that is merely slow. Deliberately unchanged.
 */
const RECEIVER_CHANNELS_STALE_AFTER_MS = 700;
interface Registration {
  readonly generation: number;
  readonly scheduler: MspTelemetryScheduler;
  references: number;
  readonly unregister: () => void;
  readonly releaseAttitudeSuppression: () => void;
  /** P2: the shared FC status poll's Receiver-scoped cadence boost. */
  readonly releaseStatusBoost: () => void;
}
const active = new Map<string, Registration>();

export function acquireReceiverTelemetry(key: SetupUiSessionKey): () => void {
  const scheduler = mspSessionCoordinator.getTelemetryScheduler(key.sessionId);
  const currentKey = mspSessionCoordinator.getSessionKey(key.sessionId);
  if (scheduler === undefined || currentKey?.generation !== key.generation) return () => {};
  const existing = active.get(key.sessionId);
  if (existing?.generation === key.generation && existing.scheduler === scheduler) { existing.references += 1; return releaseFor(key, existing); }
  if (existing !== undefined) {
    existing.unregister();
    existing.releaseAttitudeSuppression();
    existing.releaseStatusBoost();
  }
  // The hidden Setup model otherwise consumes every other 50ms scheduler
  // slot. Suppress only that poll while Receiver is visible, preserving
  // the scheduler's single-flight/no-backlog guarantee and restoring it
  // immediately when the last Receiver consumer leaves.
  const registration: Registration = {
    generation: key.generation,
    scheduler,
    references: 1,
    unregister: scheduler.registerPoll({
      id: RECEIVER_CHANNELS_POLL_ID,
      command: MSP_RC,
      intervalMs: RECEIVER_CHANNELS_POLL_INTERVAL_MS,
      staleAfterMs: RECEIVER_CHANNELS_STALE_AFTER_MS,
      priority: 2,
      decode: decodeRcChannels,
    }),
    releaseAttitudeSuppression: scheduler.acquirePollSuppression(
      ATTITUDE_TELEMETRY_POLL_ID,
    ),
    releaseStatusBoost: scheduler.acquirePollIntervalOverride(
      FC_STATUS_TELEMETRY_POLL_ID,
      RECEIVER_STATUS_BOOST_INTERVAL_MS,
    ),
  };
  active.set(key.sessionId, registration);
  return releaseFor(key, registration);
}

function releaseFor(key: SetupUiSessionKey, registration: Registration): () => void {
  let released = false;
  return () => { if (released) return; released = true; const current = active.get(key.sessionId); if (current !== registration) return; current.references -= 1; if (current.references > 0) return; current.unregister(); current.releaseAttitudeSuppression(); current.releaseStatusBoost(); active.delete(key.sessionId); };
}

/**
 * RECEIVER P3 - the OBSERVED live-RC update rate, for display.
 *
 * Derived from samples the scheduler actually delivered (P1's
 * observedSampleRateHz, a bounded rolling window), never from the
 * requested interval. This is the facade that lets the screen show a
 * measured rate without importing the scheduler: the UI asks this
 * module, this module asks the session's scheduler.
 *
 * Returns undefined when there is not yet enough evidence, when the poll
 * is not registered, or when there is no session at all - so the screen
 * can render an honest placeholder rather than invent a number. Because
 * the scheduler is created per session, a disconnect or a replacement
 * session naturally resets this to undefined.
 */
export function getReceiverObservedRateHz(sessionId: string): number | undefined {
  const scheduler = mspSessionCoordinator.getTelemetryScheduler(sessionId);
  if (scheduler === undefined) return undefined;
  const poll = scheduler
    .describeDiagnostics()
    .polls.find(entry => entry.id === RECEIVER_CHANNELS_POLL_ID);
  // Require a few real samples before quoting a rate: one or two gaps
  // are noise, not a cadence.
  if (poll === undefined || (poll.deliveredSampleCount ?? 0) < 5) return undefined;
  return poll.observedSampleRateHz;
}
