import {
  MSP_ALTITUDE,
  MSP_RAW_IMU,
  decodeAltitude,
  decodeRawImu,
  type MspTelemetryScheduler,
} from '../../../core';
import {
  ATTITUDE_TELEMETRY_POLL_ID,
  mspSessionCoordinator,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';
export const SENSOR_IMU_POLL_ID = 'sensors-imu-live';
export const SENSOR_ALTITUDE_POLL_ID = 'sensors-altitude-live';
export const SENSOR_IMU_INTERVAL_MS = 50;
interface Registration {
  readonly generation: number;
  readonly scheduler: MspTelemetryScheduler;
  references: number;
  readonly unregister: readonly (() => void)[];
  readonly releaseAttitudeSuppression: () => void;
}
const active = new Map<string, Registration>();
export function acquireSensorsTelemetry(key: SetupUiSessionKey): () => void {
  const scheduler = mspSessionCoordinator.getTelemetryScheduler(key.sessionId);
  const currentKey = mspSessionCoordinator.getSessionKey(key.sessionId);
  if (scheduler === undefined || currentKey?.generation !== key.generation)
    return () => {};
  const existing = active.get(key.sessionId);
  if (
    existing?.generation === key.generation &&
    existing.scheduler === scheduler
  ) {
    existing.references += 1;
    return releaseFor(key, existing);
  }
  if (existing !== undefined) {
    existing.unregister.forEach(unregister => unregister());
    existing.releaseAttitudeSuppression();
  }
  const registration: Registration = {
    generation: key.generation,
    scheduler,
    references: 1,
    unregister: Object.freeze([
      scheduler.registerPoll({
        id: SENSOR_IMU_POLL_ID,
        command: MSP_RAW_IMU,
        intervalMs: SENSOR_IMU_INTERVAL_MS,
        staleAfterMs: 700,
        priority: 2,
        decode: decodeRawImu,
      }),
      scheduler.registerPoll({
        id: SENSOR_ALTITUDE_POLL_ID,
        command: MSP_ALTITUDE,
        intervalMs: 200,
        staleAfterMs: 1200,
        priority: 1,
        initialDelayMs: 100,
        decode: decodeAltitude,
      }),
    ]),
    releaseAttitudeSuppression: scheduler.acquirePollSuppression(
      ATTITUDE_TELEMETRY_POLL_ID,
    ),
  };
  active.set(key.sessionId, registration);
  return releaseFor(key, registration);
}
function releaseFor(
  key: SetupUiSessionKey,
  registration: Registration,
): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = active.get(key.sessionId);
    if (current !== registration) return;
    current.references -= 1;
    if (current.references > 0) return;
    current.unregister.forEach(unregister => unregister());
    current.releaseAttitudeSuppression();
    active.delete(key.sessionId);
  };
}
