/**
 * Pass 7.6c - BOUNDED, debug-build-only observability for the auxiliary
 * Region 3 telemetry channels (Receiver / GPS / FC status) and the
 * one-shot battery-config read, under ONE stable prefix: [FPV-TELEM].
 * Same design rules as batteryDebugLog.ts ([FPV-BATT], preserved
 * unchanged): transition-driven output only, bounded decoded summaries,
 * never raw MSP frames, NEVER GPS coordinates (the compact GPS model
 * cannot even carry them), silenced under Jest, injectable sink for
 * tests.
 *
 * On-device filtering:
 *   POSIX:      adb logcat -v time ReactNativeJS:I '*:S' | grep -E 'FPV-(BATT|TELEM)'
 *   PowerShell: adb logcat -v time ReactNativeJS:I *:S | Select-String -Pattern 'FPV-BATT|FPV-TELEM'
 */

export const AUX_TELEMETRY_DEBUG_LOG_TAG = 'FPV-TELEM';

declare const __DEV__: boolean | undefined;

function defaultSinkEnabled(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true && typeof jest === 'undefined';
}

export type AuxTelemetryDebugSink = (line: string) => void;

export interface AuxTelemetryDebugLogger {
  onServiceStart(channelIds: readonly string[]): void;
  /** Transition-driven per-channel status line; `summary` is a bounded,
   * caller-built description (never coordinates, never raw frames). */
  onChannelTransition(channelId: string, status: string, summary?: string): void;
  onFirstOutcome(channelId: string, status: string, summary?: string): void;
  onCircuitBreak(channelId: string, state: string, cause: string): void;
  onBatteryConfigOutcome(outcome: string): void;
  onTeardown(reason: 'deactivated' | 'detached' | 'replaced' | 'disposed'): void;
}

export function createAuxTelemetryDebugLogger(
  sessionId: string,
  generation: number,
  sink?: AuxTelemetryDebugSink,
): AuxTelemetryDebugLogger {
  const write: AuxTelemetryDebugSink =
    sink ??
    (defaultSinkEnabled()
      ? line => {
          console.log(line);
        }
      : () => undefined);
  const identity = `session=${sessionId} gen=${generation}`;

  return {
    onServiceStart(channelIds: readonly string[]): void {
      write(`[${AUX_TELEMETRY_DEBUG_LOG_TAG}] start ${identity} channels=${channelIds.join(',')}`);
    },
    onChannelTransition(channelId: string, status: string, summary?: string): void {
      write(`[${AUX_TELEMETRY_DEBUG_LOG_TAG}] ${identity} ${channelId}=${status}${summary ? ` ${summary}` : ''}`);
    },
    onFirstOutcome(channelId: string, status: string, summary?: string): void {
      write(
        `[${AUX_TELEMETRY_DEBUG_LOG_TAG}] first-outcome ${identity} ${channelId}=${status}${summary ? ` ${summary}` : ''}`,
      );
    },
    onCircuitBreak(channelId: string, state: string, cause: string): void {
      write(`[${AUX_TELEMETRY_DEBUG_LOG_TAG}] circuit-break ${identity} ${channelId}->${state} cause=${cause}`);
    },
    onBatteryConfigOutcome(outcome: string): void {
      write(`[${AUX_TELEMETRY_DEBUG_LOG_TAG}] battery-config ${identity} ${outcome}`);
    },
    onTeardown(reason): void {
      write(`[${AUX_TELEMETRY_DEBUG_LOG_TAG}] stop ${identity} reason=${reason}`);
    },
  };
}
