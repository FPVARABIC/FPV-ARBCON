import { deriveBatterySemantics } from './batteryTelemetry';
import type { MspBatteryState } from '../protocol';

function raw(overrides: Partial<MspBatteryState> = {}): MspBatteryState {
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

describe('deriveBatterySemantics', () => {
  it('reports NOT_DETECTED exactly when cellCount is 0 (the verified firmware meaning) - and DETECTED otherwise', () => {
    expect(deriveBatterySemantics(raw({ cellCount: 0 })).detection).toBe(
      'NOT_DETECTED',
    );
    expect(deriveBatterySemantics(raw({ cellCount: 1 })).detection).toBe(
      'DETECTED',
    );
    expect(deriveBatterySemantics(raw({ cellCount: 6 })).detection).toBe(
      'DETECTED',
    );
    // NOT_DETECTED is the firmware's judgment only - the shape carries no
    // "physically disconnected" claim anywhere to assert.
  });

  it('maps every verified batteryState_e value to its named firmware state', () => {
    expect(
      deriveBatterySemantics(raw({ batteryStateRaw: 0 })).firmwareState,
    ).toBe('OK');
    expect(
      deriveBatterySemantics(raw({ batteryStateRaw: 1 })).firmwareState,
    ).toBe('WARNING');
    expect(
      deriveBatterySemantics(raw({ batteryStateRaw: 2 })).firmwareState,
    ).toBe('CRITICAL');
    expect(
      deriveBatterySemantics(raw({ batteryStateRaw: 3 })).firmwareState,
    ).toBe('NOT_PRESENT');
    expect(
      deriveBatterySemantics(raw({ batteryStateRaw: 4 })).firmwareState,
    ).toBe('INIT');
  });

  it('preserves an unknown enum value as {kind:UNKNOWN, raw} and NEVER defaults it to OK', () => {
    const state = deriveBatterySemantics(
      raw({ batteryStateRaw: 9 }),
    ).firmwareState;
    expect(state).toEqual({ kind: 'UNKNOWN', raw: 9 });
    expect(state).not.toBe('OK');
  });

  it('uses the high-resolution centivolt field as the canonical voltage and keeps the saturated legacy field as a separate echo', () => {
    const semantics = deriveBatterySemantics(
      raw({ voltageCentivolts: 2570, legacyVoltageDecivolts: 255 }),
    );
    expect(semantics.voltageVolts).toBeCloseTo(25.7, 10);
    expect(semantics.legacyVoltageVolts).toBeCloseTo(25.5, 10);
  });

  it('keeps zero unproven and marks only non-zero reported quantities as displayable', () => {
    const zero = deriveBatterySemantics(
      raw({ amperageCentiamps: 0, consumedMah: 0 }),
    );
    expect(zero.current).toEqual({ centiamps: 0, sensorValidity: 'UNPROVEN' });
    expect(zero.consumed).toEqual({ mah: 0, sensorValidity: 'UNPROVEN' });

    const negative = deriveBatterySemantics(raw({ amperageCentiamps: -250 }));
    expect(negative.current).toEqual({
      centiamps: -250,
      sensorValidity: 'REPORTED_NONZERO',
    });
    expect(deriveBatterySemantics(raw()).consumed).toEqual({
      mah: 350,
      sensorValidity: 'REPORTED_NONZERO',
    });
  });

  it('passes configured capacity through as configuration - zero stays a configured zero, never an availability judgment', () => {
    expect(
      deriveBatterySemantics(raw({ configuredCapacityMah: 0 }))
        .configuredCapacityMah,
    ).toBe(0);
    expect(
      deriveBatterySemantics(raw({ configuredCapacityMah: 1500 }))
        .configuredCapacityMah,
    ).toBe(1500);
  });

  it('derives no thresholds, health, percentage, or severity - the output shape contains only verified fields', () => {
    const semantics = deriveBatterySemantics(raw());
    expect(Object.keys(semantics).sort()).toEqual(
      [
        'cellCount',
        'configuredCapacityMah',
        'consumed',
        'current',
        'detection',
        'firmwareState',
        'legacyVoltageVolts',
        'voltageVolts',
      ].sort(),
    );
  });

  it('does not mutate its input (deep-frozen raw compared after the call)', () => {
    const input = Object.freeze(raw()) as MspBatteryState;
    const copy = { ...input };
    deriveBatterySemantics(input);
    expect(input).toEqual(copy);
  });
});
