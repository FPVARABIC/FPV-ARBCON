import {MSP_RC, decodeRcChannels, type MspTelemetryScheduler} from '../../../core';
import {
  ATTITUDE_TELEMETRY_POLL_ID,
  mspSessionCoordinator,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';

export const RECEIVER_CHANNELS_POLL_ID = 'receiver-channels-live';
export const RECEIVER_CHANNELS_POLL_INTERVAL_MS = 50;
interface Registration {
  readonly generation: number;
  readonly scheduler: MspTelemetryScheduler;
  references: number;
  readonly unregister: () => void;
  readonly releaseAttitudeSuppression: () => void;
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
      staleAfterMs: 700,
      priority: 2,
      decode: decodeRcChannels,
    }),
    releaseAttitudeSuppression: scheduler.acquirePollSuppression(
      ATTITUDE_TELEMETRY_POLL_ID,
    ),
  };
  active.set(key.sessionId, registration);
  return releaseFor(key, registration);
}

function releaseFor(key: SetupUiSessionKey, registration: Registration): () => void {
  let released = false;
  return () => { if (released) return; released = true; const current = active.get(key.sessionId); if (current !== registration) return; current.references -= 1; if (current.references > 0) return; current.unregister(); current.releaseAttitudeSuppression(); active.delete(key.sessionId); };
}
