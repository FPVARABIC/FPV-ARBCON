import {MSP_RC, decodeRcChannels, type MspTelemetryScheduler} from '../../../core';
import {mspSessionCoordinator, type SetupUiSessionKey} from './MspSessionCoordinator';

export const RECEIVER_CHANNELS_POLL_ID = 'receiver-channels-live';
interface Registration { readonly generation: number; readonly scheduler: MspTelemetryScheduler; references: number; readonly unregister: () => void }
const active = new Map<string, Registration>();

export function acquireReceiverTelemetry(key: SetupUiSessionKey): () => void {
  const scheduler = mspSessionCoordinator.getTelemetryScheduler(key.sessionId);
  const currentKey = mspSessionCoordinator.getSessionKey(key.sessionId);
  if (scheduler === undefined || currentKey?.generation !== key.generation) return () => {};
  const existing = active.get(key.sessionId);
  if (existing?.generation === key.generation && existing.scheduler === scheduler) { existing.references += 1; return releaseFor(key, existing); }
  if (existing !== undefined) existing.unregister();
  const registration: Registration = {generation: key.generation, scheduler, references: 1, unregister: scheduler.registerPoll({id: RECEIVER_CHANNELS_POLL_ID, command: MSP_RC, intervalMs: 100, staleAfterMs: 700, priority: 2, decode: decodeRcChannels})};
  active.set(key.sessionId, registration);
  return releaseFor(key, registration);
}

function releaseFor(key: SetupUiSessionKey, registration: Registration): () => void {
  let released = false;
  return () => { if (released) return; released = true; const current = active.get(key.sessionId); if (current !== registration) return; current.references -= 1; if (current.references > 0) return; current.unregister(); active.delete(key.sessionId); };
}
