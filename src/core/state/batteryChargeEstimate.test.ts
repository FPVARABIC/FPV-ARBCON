import {BATTERY_CAPACITY_MAX_MAH, deriveBatteryChargeEstimate} from './batteryChargeEstimate';
import type {MspBatteryState, MspBatteryConfig, TelemetryValue} from '../protocol';
import {CURRENT_METER_SOURCE} from '../protocol';

function batteryState(overrides: Partial<MspBatteryState> = {}): MspBatteryState {
  return {
    cellCount: 4,
    configuredCapacityMah: 1500,
    legacyVoltageDecivolts: 168,
    consumedMah: 350,
    amperageCentiamps: 1234,
    batteryStateRaw: 0,
    voltageCentivolts: 1685,
    ...overrides,
  };
}

function fresh(overrides: Partial<MspBatteryState> = {}): TelemetryValue<MspBatteryState> {
  return {status: 'FRESH', value: batteryState(overrides), updatedAtMs: 1000};
}

function config(overrides: Partial<MspBatteryConfig> = {}): MspBatteryConfig {
  return {
    minCellVoltageDecivolts: 33,
    maxCellVoltageDecivolts: 43,
    warningCellVoltageDecivolts: 35,
    configuredCapacityMah: 1500,
    voltageMeterSourceRaw: 1,
    currentMeterSourceRaw: CURRENT_METER_SOURCE.ADC,
    ...overrides,
  };
}

describe('deriveBatteryChargeEstimate', () => {
  describe('the happy path (every prerequisite proven)', () => {
    it('computes round(((capacity - consumed) / capacity) * 100): 1500/350 -> 77%', () => {
      // (1500 - 350) / 1500 = 0.7666... -> 77
      expect(deriveBatteryChargeEstimate(fresh(), config())).toEqual({kind: 'ESTIMATE', percent: 77});
    });

    it('yields a legitimate 100% for zero consumed mAh', () => {
      expect(deriveBatteryChargeEstimate(fresh({consumedMah: 0}), config())).toEqual({kind: 'ESTIMATE', percent: 100});
    });

    it('yields 0% when consumed equals capacity exactly (still in range, never clamped)', () => {
      expect(deriveBatteryChargeEstimate(fresh({consumedMah: 1500}), config())).toEqual({kind: 'ESTIMATE', percent: 0});
    });

    it('rounds half-up per Math.round (e.g. 1000/25 -> 97.5 -> 98)', () => {
      expect(
        deriveBatteryChargeEstimate(
          fresh({consumedMah: 25, configuredCapacityMah: 1000}),
          config({configuredCapacityMah: 1000}),
        ),
      ).toEqual({kind: 'ESTIMATE', percent: 98});
    });

    it('accepts capacity at exactly BATTERY_CAPACITY_MAX_MAH = 20000', () => {
      expect(BATTERY_CAPACITY_MAX_MAH).toBe(20000);
      expect(
        deriveBatteryChargeEstimate(
          fresh({consumedMah: 10000, configuredCapacityMah: 20000}),
          config({configuredCapacityMah: 20000}),
        ),
      ).toEqual({kind: 'ESTIMATE', percent: 50});
    });
  });

  describe('prerequisite 1 - sample freshness (STALE/ERROR/WAITING/UNAVAILABLE all disqualify)', () => {
    it.each([
      ['UNAVAILABLE', {status: 'UNAVAILABLE'} as const],
      ['WAITING', {status: 'WAITING'} as const],
      ['STALE', {status: 'STALE', value: batteryState(), updatedAtMs: 1000, ageMs: 9500} as const],
      ['ERROR', {status: 'ERROR', error: new Error('x'), updatedAtMs: 1000} as const],
    ])('%s -> SAMPLE_NOT_FRESH', (_label, value) => {
      expect(deriveBatteryChargeEstimate(value, config())).toEqual({
        kind: 'UNAVAILABLE',
        reason: 'SAMPLE_NOT_FRESH',
      });
    });
  });

  describe('prerequisite 2 - battery detection', () => {
    it('cellCount 0 -> BATTERY_NOT_DETECTED even with a perfect config', () => {
      expect(deriveBatteryChargeEstimate(fresh({cellCount: 0}), config())).toEqual({
        kind: 'UNAVAILABLE',
        reason: 'BATTERY_NOT_DETECTED',
      });
    });
  });

  describe('prerequisite 3 - config availability', () => {
    it('absent config (one-shot failed or never ran) -> CONFIG_UNAVAILABLE', () => {
      expect(deriveBatteryChargeEstimate(fresh(), undefined)).toEqual({
        kind: 'UNAVAILABLE',
        reason: 'CONFIG_UNAVAILABLE',
      });
    });
  });

  describe('prerequisite 4 - configured capacity range (0 < capacity <= 20000)', () => {
    it('capacity 0 -> CAPACITY_NOT_CONFIGURED', () => {
      expect(
        deriveBatteryChargeEstimate(fresh({configuredCapacityMah: 0}), config({configuredCapacityMah: 0})),
      ).toEqual({kind: 'UNAVAILABLE', reason: 'CAPACITY_NOT_CONFIGURED'});
    });

    it('capacity 20001 (above the CLI-proven maximum) -> CAPACITY_OUT_OF_RANGE', () => {
      expect(
        deriveBatteryChargeEstimate(fresh({configuredCapacityMah: 20001}), config({configuredCapacityMah: 20001})),
      ).toEqual({kind: 'UNAVAILABLE', reason: 'CAPACITY_OUT_OF_RANGE'});
    });
  });

  describe('prerequisite 5 - capacity agreement between CONFIG and STATE', () => {
    it('mismatched capacities -> CAPACITY_MISMATCH (assumption broken, no estimate)', () => {
      expect(
        deriveBatteryChargeEstimate(fresh({configuredCapacityMah: 1300}), config({configuredCapacityMah: 1500})),
      ).toEqual({kind: 'UNAVAILABLE', reason: 'CAPACITY_MISMATCH'});
    });
  });

  describe('prerequisite 6 - current-meter source (exactly ADC qualifies in this pass)', () => {
    it.each([
      ['NONE', CURRENT_METER_SOURCE.NONE],
      ['VIRTUAL', CURRENT_METER_SOURCE.VIRTUAL],
      ['ESC', CURRENT_METER_SOURCE.ESC],
      ['MSP', CURRENT_METER_SOURCE.MSP],
      ['unknown future value', 9],
    ])('%s -> METER_SOURCE_NOT_QUALIFIED', (_label, raw) => {
      expect(deriveBatteryChargeEstimate(fresh(), config({currentMeterSourceRaw: raw}))).toEqual({
        kind: 'UNAVAILABLE',
        reason: 'METER_SOURCE_NOT_QUALIFIED',
      });
    });
  });

  describe('prerequisite 7 - consumed range (0 <= consumed <= capacity, never clamped)', () => {
    it('consumed above capacity -> CONSUMED_OUT_OF_RANGE, never a clamped 0%', () => {
      expect(deriveBatteryChargeEstimate(fresh({consumedMah: 1501}), config())).toEqual({
        kind: 'UNAVAILABLE',
        reason: 'CONSUMED_OUT_OF_RANGE',
      });
    });
  });

  it('is purely consumption-based: pack voltage never influences the result', () => {
    const low = deriveBatteryChargeEstimate(fresh({voltageCentivolts: 1200, legacyVoltageDecivolts: 120}), config());
    const high = deriveBatteryChargeEstimate(fresh({voltageCentivolts: 1685, legacyVoltageDecivolts: 168}), config());
    expect(low).toEqual(high);
    expect(low).toEqual({kind: 'ESTIMATE', percent: 77});
  });
});
