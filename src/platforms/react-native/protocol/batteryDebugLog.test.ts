/**
 * Pass 7.6b - bounded battery debug observability: transition-driven
 * output only, bounded decoded summary, stable tag, teardown line. Tested
 * via an injected sink (the default sink is silenced under Jest by
 * design - see batteryDebugLog.ts).
 */

import {createBatteryDebugLogger, formatBatteryDebugValue, BATTERY_DEBUG_LOG_TAG} from './batteryDebugLog';
import type {MspBatteryState, TelemetryValue} from '../../../core';

const FRESH: TelemetryValue<MspBatteryState> = {
  status: 'FRESH',
  value: {
    cellCount: 4,
    configuredCapacityMah: 1500,
    legacyVoltageDecivolts: 168,
    consumedMah: 350,
    amperageCentiamps: -250,
    batteryStateRaw: 0,
    voltageCentivolts: 1685,
  },
  updatedAtMs: 1000,
};

describe('batteryDebugLog', () => {
  it('formats a bounded decoded summary (status, cells, voltage, raw state) - never raw frames', () => {
    expect(formatBatteryDebugValue(FRESH)).toBe('FRESH cells=4 v=16.85V stateRaw=0');
    expect(formatBatteryDebugValue({status: 'WAITING'})).toBe('WAITING');
    expect(formatBatteryDebugValue({status: 'UNAVAILABLE'})).toBe('UNAVAILABLE');
    expect(formatBatteryDebugValue({status: 'ERROR', error: new Error('x')})).toBe('ERROR');
  });

  it('logs start, first outcome, and TRANSITIONS only - an unchanged status on the 3000ms cadence logs nothing', () => {
    const lines: string[] = [];
    const logger = createBatteryDebugLogger('session-9', 3, line => lines.push(line));

    logger.onRegistered(3000, 9000);
    logger.onValue({status: 'WAITING'});
    logger.onValue({status: 'WAITING'}); // unchanged: nothing
    logger.onValue(FRESH); // first settled outcome
    logger.onValue(FRESH); // unchanged: nothing
    logger.onValue(FRESH); // unchanged: nothing
    logger.onValue({status: 'STALE', value: FRESH.value, updatedAtMs: 1000, ageMs: 9500}); // transition
    logger.onTeardown('deactivated');

    expect(lines).toEqual([
      `[${BATTERY_DEBUG_LOG_TAG}] start session=session-9 gen=3 intervalMs=3000 staleAfterMs=9000`,
      `[${BATTERY_DEBUG_LOG_TAG}] session=session-9 gen=3 WAITING`,
      `[${BATTERY_DEBUG_LOG_TAG}] first-outcome session=session-9 gen=3 FRESH cells=4 v=16.85V stateRaw=0`,
      `[${BATTERY_DEBUG_LOG_TAG}] session=session-9 gen=3 STALE cells=4 v=16.85V stateRaw=0`,
      `[${BATTERY_DEBUG_LOG_TAG}] stop session=session-9 gen=3 reason=deactivated`,
    ]);
  });

  it('identifies the session and generation on every line (identity/generation change = a new logger, new lines)', () => {
    const lines: string[] = [];
    const logger = createBatteryDebugLogger('session-9', 4, line => lines.push(line));
    logger.onRegistered(3000, 9000);
    expect(lines[0]).toContain('session=session-9 gen=4');
  });

  it('Pass 7.6c battery-timeout closure: the circuit-break line carries identity, the DISABLED verdict, and the cause - one bounded line', () => {
    const lines: string[] = [];
    const logger = createBatteryDebugLogger('session-9', 3, line => lines.push(line));
    logger.onCircuitBreak('timeout');
    expect(lines).toEqual(['[FPV-BATT] circuit-break session=session-9 gen=3 battery->DISABLED cause=timeout']);
  });

  it('the default sink is silent under Jest (bounded: no console noise from hundreds of coordinator tests)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const logger = createBatteryDebugLogger('session-9', 5); // no injected sink
      logger.onRegistered(3000, 9000);
      logger.onValue(FRESH);
      logger.onCircuitBreak('timeout');
      logger.onTeardown('detached');
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
