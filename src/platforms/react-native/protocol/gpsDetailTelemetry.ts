import {
  MSP_COMP_GPS,
  MSP_GPS_SV_INFO,
  MSP_RAW_GPS,
  decodeCompGps,
  decodeDetailedGps,
  decodeGpsSatelliteInfo,
  type MspTelemetryScheduler,
} from '../../../core';
import {
  mspSessionCoordinator,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';

export const GPS_DETAIL_RAW_POLL_ID = 'gps-detail-raw';
export const GPS_DETAIL_HOME_POLL_ID = 'gps-detail-home';
export const GPS_DETAIL_SATELLITES_POLL_ID = 'gps-detail-satellites';

interface ActiveRegistration {
  readonly generation: number;
  readonly scheduler: MspTelemetryScheduler;
  references: number;
  readonly unregister: readonly (() => void)[];
}

const active = new Map<string, ActiveRegistration>();

/**
 * Registers detailed GPS traffic only while its screen is visible. The
 * reference count prevents a transient double-render from replacing a live
 * registration, while generation checks keep a reused native session id from
 * inheriting polls from an older physical connection.
 */
export function acquireGpsDetailTelemetry(
  sessionKey: SetupUiSessionKey,
): () => void {
  const scheduler = mspSessionCoordinator.getTelemetryScheduler(
    sessionKey.sessionId,
  );
  const currentKey = mspSessionCoordinator.getSessionKey(sessionKey.sessionId);
  if (
    scheduler === undefined ||
    currentKey?.generation !== sessionKey.generation
  )
    return () => {};

  const existing = active.get(sessionKey.sessionId);
  if (
    existing?.generation === sessionKey.generation &&
    existing.scheduler === scheduler
  ) {
    existing.references += 1;
    return releaseFor(sessionKey, existing);
  }
  if (existing !== undefined) {
    for (const unregister of existing.unregister) unregister();
    active.delete(sessionKey.sessionId);
  }

  const registration: ActiveRegistration = {
    generation: sessionKey.generation,
    scheduler,
    references: 1,
    unregister: Object.freeze([
      scheduler.registerPoll({
        id: GPS_DETAIL_RAW_POLL_ID,
        command: MSP_RAW_GPS,
        intervalMs: 750,
        staleAfterMs: 2500,
        priority: -1,
        decode: decodeDetailedGps,
      }),
      scheduler.registerPoll({
        id: GPS_DETAIL_HOME_POLL_ID,
        command: MSP_COMP_GPS,
        intervalMs: 1000,
        staleAfterMs: 3500,
        priority: -2,
        initialDelayMs: 200,
        decode: decodeCompGps,
      }),
      scheduler.registerPoll({
        id: GPS_DETAIL_SATELLITES_POLL_ID,
        command: MSP_GPS_SV_INFO,
        intervalMs: 2500,
        staleAfterMs: 7500,
        priority: -3,
        initialDelayMs: 450,
        decode: decodeGpsSatelliteInfo,
      }),
    ]),
  };
  active.set(sessionKey.sessionId, registration);
  return releaseFor(sessionKey, registration);
}

function releaseFor(
  sessionKey: SetupUiSessionKey,
  registration: ActiveRegistration,
): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = active.get(sessionKey.sessionId);
    if (current !== registration) return;
    current.references -= 1;
    if (current.references > 0) return;
    for (const unregister of current.unregister) unregister();
    active.delete(sessionKey.sessionId);
  };
}
