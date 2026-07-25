/**
 * Pass 7.6b - BOUNDED, debug-build-only battery-telemetry observability
 * for real-device `logcat` verification (the Pass 7.6a hardware trial was
 * inconclusive precisely because nothing observable existed).
 *
 * One stable tag, transition-driven output only:
 *  - battery poll registration (session identity + generation + cadence);
 *  - the FIRST settled outcome;
 *  - every status transition among WAITING/FRESH/STALE/ERROR/UNAVAILABLE
 *    (an unchanged status on the 3000ms cadence logs NOTHING);
 *  - a bounded decoded summary (status, cellCount, voltage, raw firmware
 *    state) - never raw MSP frames;
 *  - teardown (deactivate / detach / replacement / disposal).
 *
 * Visibility: RN debug builds forward console.log to Android logcat under
 * the `ReactNativeJS` tag, so on-device filtering is:
 *
 *   adb logcat -v time ReactNativeJS:I *:S | grep "FPV-BATT"
 *
 * Silencing: enabled only in dev (debug) builds, and additionally
 * silenced under Jest (the `jest` global exists there) so hundreds of
 * coordinator tests don't spray transition lines into CI output - the
 * logger's formatting/transition logic stays fully testable by injecting
 * a sink.
 */

import type {MspBatteryState, TelemetryValue} from '../../../core';

export const BATTERY_DEBUG_LOG_TAG = 'FPV-BATT';

declare const __DEV__: boolean | undefined;

function defaultSinkEnabled(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true && typeof jest === 'undefined';
}

export type BatteryDebugSink = (line: string) => void;

/** Bounded one-line summary of a battery TelemetryValue - status plus the
 * three most diagnostic decoded fields. Pure and exported for direct
 * testing. */
export function formatBatteryDebugValue(value: TelemetryValue<MspBatteryState>): string {
  switch (value.status) {
    case 'FRESH':
    case 'STALE': {
      const {cellCount, voltageCentivolts, batteryStateRaw} = value.value;
      const volts = (voltageCentivolts / 100).toFixed(2);
      return `${value.status} cells=${cellCount} v=${volts}V stateRaw=${batteryStateRaw}`;
    }
    case 'ERROR':
      return 'ERROR';
    case 'WAITING':
      return 'WAITING';
    case 'UNAVAILABLE':
      return 'UNAVAILABLE';
  }
}

export interface BatteryDebugLogger {
  onRegistered(intervalMs: number, staleAfterMs: number): void;
  /** Call on every scheduler notification with the CURRENT battery value -
   * logs only on a status transition (plus the first settled outcome). */
  onValue(value: TelemetryValue<MspBatteryState>): void;
  /** Pass 7.6c battery-timeout closure (additive): the ONE line emitted
   * when a genuine MSP response timeout disables battery polling for the
   * remainder of this physical session. */
  onCircuitBreak(cause: string): void;
  onTeardown(reason: 'deactivated' | 'detached' | 'replaced' | 'disposed'): void;
}

export function createBatteryDebugLogger(
  sessionId: string,
  generation: number,
  sink?: BatteryDebugSink,
): BatteryDebugLogger {
  const write: BatteryDebugSink =
    sink ??
    (defaultSinkEnabled()
      ? line => {
          console.log(line);
        }
      : () => undefined);
  const identity = `session=${sessionId} gen=${generation}`;
  let lastStatus: TelemetryValue<MspBatteryState>['status'] | undefined;
  let firstSettledLogged = false;

  return {
    onRegistered(intervalMs: number, staleAfterMs: number): void {
      write(`[${BATTERY_DEBUG_LOG_TAG}] start ${identity} intervalMs=${intervalMs} staleAfterMs=${staleAfterMs}`);
    },
    onValue(value: TelemetryValue<MspBatteryState>): void {
      const settled = value.status === 'FRESH' || value.status === 'STALE' || value.status === 'ERROR';
      const isFirstSettled = settled && !firstSettledLogged;
      if (value.status === lastStatus && !isFirstSettled) {
        return; // unchanged status on the polling cadence: log nothing
      }
      if (isFirstSettled) {
        firstSettledLogged = true;
        write(`[${BATTERY_DEBUG_LOG_TAG}] first-outcome ${identity} ${formatBatteryDebugValue(value)}`);
      } else {
        write(`[${BATTERY_DEBUG_LOG_TAG}] ${identity} ${formatBatteryDebugValue(value)}`);
      }
      lastStatus = value.status;
    },
    onCircuitBreak(cause: string): void {
      write(`[${BATTERY_DEBUG_LOG_TAG}] circuit-break ${identity} battery->DISABLED cause=${cause}`);
    },
    onTeardown(reason): void {
      write(`[${BATTERY_DEBUG_LOG_TAG}] stop ${identity} reason=${reason}`);
    },
  };
}
