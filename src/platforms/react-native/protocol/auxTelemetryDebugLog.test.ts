/**
 * Pass 7.6c - bounded [FPV-TELEM] aux-telemetry observability: stable tag,
 * session/generation identity on every line, bounded summaries only,
 * teardown line. Tested via an injected sink (the default sink is silenced
 * under Jest by design - see auxTelemetryDebugLog.ts).
 */

import {AUX_TELEMETRY_DEBUG_LOG_TAG, createAuxTelemetryDebugLogger} from './auxTelemetryDebugLog';

describe('auxTelemetryDebugLog', () => {
  it('uses the stable FPV-TELEM tag (distinct from FPV-BATT, filterable by the same one-liner)', () => {
    expect(AUX_TELEMETRY_DEBUG_LOG_TAG).toBe('FPV-TELEM');
  });

  it('emits service start, first outcomes, transitions, circuit breaks, battery-config outcome, and teardown with identity on EVERY line', () => {
    const lines: string[] = [];
    const logger = createAuxTelemetryDebugLogger('session-9', 3, line => lines.push(line));

    logger.onServiceStart(['receiver', 'gps', 'fcStatus']);
    logger.onFirstOutcome('receiver', 'FRESH', 'rssi=540');
    logger.onChannelTransition('gps', 'STALE');
    logger.onCircuitBreak('fcStatus', 'UNSUPPORTED', 'MSP_REMOTE_ERROR');
    logger.onBatteryConfigOutcome('READY capacity=1500 currentMeterSource=1');
    logger.onTeardown('deactivated');

    expect(lines).toEqual([
      '[FPV-TELEM] start session=session-9 gen=3 channels=receiver,gps,fcStatus',
      '[FPV-TELEM] first-outcome session=session-9 gen=3 receiver=FRESH rssi=540',
      '[FPV-TELEM] session=session-9 gen=3 gps=STALE',
      '[FPV-TELEM] circuit-break session=session-9 gen=3 fcStatus->UNSUPPORTED cause=MSP_REMOTE_ERROR',
      '[FPV-TELEM] battery-config session=session-9 gen=3 READY capacity=1500 currentMeterSource=1',
      '[FPV-TELEM] stop session=session-9 gen=3 reason=deactivated',
    ]);
    for (const line of lines) {
      expect(line).toContain('session=session-9 gen=3');
    }
  });

  it('the default sink is silent under Jest (no console noise from the coordinator suites)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const logger = createAuxTelemetryDebugLogger('session-9', 5); // no injected sink
      logger.onServiceStart(['receiver']);
      logger.onCircuitBreak('receiver', 'DISABLED', 'timeouts');
      logger.onTeardown('detached');
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
