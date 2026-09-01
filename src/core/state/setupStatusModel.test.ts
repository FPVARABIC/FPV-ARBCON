/**
 * SETUP R9 - the two truth rules that moved out of the renderers.
 *
 * Both exist because compressing a card into a chip is exactly the sort
 * of change that quietly drops a guard: the card had room to explain
 * itself, the chip does not, and a future edit shortening the chip must
 * not be able to take the rule with it.
 *
 *   deriveSetupBatterySummary    - the HW-002 guard: a residual
 *                                  voltage-divider reading never
 *                                  occupies the pack-voltage slot.
 *   isSetupSafetyStripWarranted  - when an alert strip is actually an
 *                                  alert.
 */

import {
  deriveSetupBatterySummary,
  isSetupSafetyStripWarranted,
} from './setupStatusModel';
import type {ArmingReadiness} from './armingReadiness';
import type {MspBatteryState} from '../protocol';
import type {TelemetryValue} from '../protocol';

/** The decoded shape, built field by field rather than off a wire
 * fixture: this module's contract is with the DECODED model, and
 * decodeBatteryState has its own byte-level suite. */
function battery(overrides: Partial<MspBatteryState> = {}): MspBatteryState {
  return {
    cellCount: 4,
    configuredCapacityMah: 1500,
    legacyVoltageDecivolts: 164,
    consumedMah: 480,
    amperageCentiamps: 320,
    batteryStateRaw: 0,
    voltageCentivolts: 1642,
    ...overrides,
  } as MspBatteryState;
}

const fresh = (value: MspBatteryState): TelemetryValue<MspBatteryState> => ({
  status: 'FRESH',
  value,
  updatedAtMs: 1,
});
const stale = (value: MspBatteryState): TelemetryValue<MspBatteryState> => ({
  status: 'STALE',
  value,
  updatedAtMs: 1,
  ageMs: 9000,
});

describe('the battery summary keeps the HW-002 guard', () => {
  it('reports a proven pack with its canonical high-resolution voltage', () => {
    const summary = deriveSetupBatterySummary(fresh(battery()));
    expect(summary).toEqual({
      kind: 'MEASURED',
      voltageVolts: 16.42,
      cellCount: 4,
      firmwareState: 'OK',
      amps: 3.2,
      consumedMah: 480,
      stale: false,
    });
  });

  /**
   * THE FIELD CASE THIS EXISTS FOR. A real board reported ~0.17 V with
   * no pack attached, and the card printed "0.17 V" in its primary
   * value slot - a number that reads as a live pack voltage and is not
   * one. The discriminator is the FIRMWARE'S OWN (cellCount 0 is
   * Betaflight's verified "battery not detected"), never an
   * app-invented minimum-voltage threshold.
   */
  it('routes a not-detected pack to NO_PACK while still carrying the real reading', () => {
    const summary = deriveSetupBatterySummary(
      fresh(battery({cellCount: 0, voltageCentivolts: 17})),
    );
    expect(summary).toEqual({
      kind: 'NO_PACK',
      rawVoltageVolts: 0.17,
      firmwareState: 'OK',
      stale: false,
    });
  });

  it('routes the firmware own NOT_PRESENT enum to NO_PACK even with cells reported', () => {
    // Both halves of the discriminator, independently.
    const summary = deriveSetupBatterySummary(
      fresh(battery({batteryStateRaw: 3})),
    );
    expect(summary.kind).toBe('NO_PACK');
  });

  /**
   * MSP_BATTERY_STATE cannot tell a residual register from a board with
   * no current meter fitted, so a zero is WITHHELD rather than printed
   * as "0.00 A". The renderer then omits the row entirely.
   */
  it('withholds a zero current and a zero consumption instead of reporting them', () => {
    const summary = deriveSetupBatterySummary(
      fresh(battery({amperageCentiamps: 0, consumedMah: 0})),
    );
    expect(summary).toMatchObject({kind: 'MEASURED', amps: undefined, consumedMah: undefined});
  });

  it('carries staleness rather than freezing a stale reading as live', () => {
    expect(deriveSetupBatterySummary(stale(battery()))).toMatchObject({
      kind: 'MEASURED',
      stale: true,
    });
    expect(
      deriveSetupBatterySummary(stale(battery({cellCount: 0}))),
    ).toMatchObject({kind: 'NO_PACK', stale: true});
  });

  it.each([
    ['UNAVAILABLE', {status: 'UNAVAILABLE'} as TelemetryValue<MspBatteryState>],
    ['WAITING', {status: 'WAITING'} as TelemetryValue<MspBatteryState>],
    [
      'ERROR',
      {status: 'ERROR', error: new Error('x')} as TelemetryValue<MspBatteryState>,
    ],
  ])('keeps %s as its own state, never as a zero reading', (kind, telemetry) => {
    const summary = deriveSetupBatterySummary(telemetry);
    expect(summary).toEqual({kind});
    // Nothing numeric leaks out of a state that proves nothing.
    expect(JSON.stringify(summary)).not.toMatch(/\d/);
  });

  it('preserves an unrecognised firmware state rather than degrading it to OK', () => {
    const summary = deriveSetupBatterySummary(
      fresh(battery({batteryStateRaw: 99})),
    );
    expect(summary).toMatchObject({
      kind: 'MEASURED',
      firmwareState: {kind: 'UNKNOWN', raw: 99},
    });
  });
});

describe('an alert strip is warranted only by a real problem', () => {
  const readiness = (value: ArmingReadiness): ArmingReadiness => value;

  it('raises the strip while the aircraft is ARMED', () => {
    expect(isSetupSafetyStripWarranted(readiness({status: 'ARMED'}))).toBe(true);
  });

  it('raises the strip when the firmware is refusing to arm', () => {
    expect(
      isSetupSafetyStripWarranted(
        readiness({
          status: 'BLOCKED',
          reasons: [
            {
              code: 'THROTTLE',
              severity: 'ARMING_BLOCKER',
              messageKey: 'diagnostics.blockerDescriptions.THROTTLE',
            },
          ],
        } as ArmingReadiness),
      ),
    ).toBe(true);
  });

  /**
   * THE WHOLE POINT. On a board that answers everything else correctly,
   * "arming state not confirmed" is the NORMAL reading whenever the
   * BOXIDS mapping has not settled. A permanent 74px warning for a
   * normal reading teaches operators to ignore the strip - which is the
   * one outcome a safety surface must never produce.
   */
  it('does NOT raise the strip for a steady READY or an unconfirmed state', () => {
    expect(isSetupSafetyStripWarranted(readiness({status: 'READY'}))).toBe(false);
    for (const cause of [
      'ARMED_UNPROVEN',
      'BLOCKERS_UNCONFIRMED',
      'BLOCKERS_MALFORMED',
    ] as const) {
      expect(
        isSetupSafetyStripWarranted(readiness({status: 'UNKNOWN', cause})),
      ).toBe(false);
    }
  });

  it('is a presentation question only - it reinterprets no readiness value', () => {
    /* Stated as an assertion so the predicate cannot grow into a second
       safety derivation: it reads `status` and nothing else, so it
       cannot disagree with the object every other Setup surface
       renders. */
    const blocked = readiness({
      status: 'BLOCKED',
      reasons: [],
    } as unknown as ArmingReadiness);
    expect(isSetupSafetyStripWarranted(blocked)).toBe(true);
    expect(blocked.status).toBe('BLOCKED');
  });
});
