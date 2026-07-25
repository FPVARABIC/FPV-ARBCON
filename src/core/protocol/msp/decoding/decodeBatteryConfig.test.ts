import {CURRENT_METER_SOURCE, decodeBatteryConfig} from './decodeBatteryConfig';
import {MspPayloadReadError} from './MspPayloadReader';

/** Hand-assembled little-endian payload - independent of the decoder's
 * own reader (verified MSP_BATTERY_CONFIG 7-byte mandatory prefix,
 * mspCommandSources.ts). */
function payload(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

const GOLDEN = payload([
  33, // min cell voltage u8 = 3.3V
  43, // max cell voltage u8 = 4.3V
  35, // warning cell voltage u8 = 3.5V
  0xdc, 0x05, // configured capacity u16le = 1500 mAh
  1, // voltageMeterSource
  1, // currentMeterSource = ADC
]);

describe('decodeBatteryConfig', () => {
  it('decodes the exact 7-byte mandatory prefix with independent expected literals', () => {
    expect(decodeBatteryConfig(GOLDEN)).toEqual({
      minCellVoltageDecivolts: 33,
      maxCellVoltageDecivolts: 43,
      warningCellVoltageDecivolts: 35,
      configuredCapacityMah: 1500,
      voltageMeterSourceRaw: 1,
      currentMeterSourceRaw: 1,
    });
  });

  it('matches the verified currentMeterSource_e enum exactly (current.h:26-33)', () => {
    expect(CURRENT_METER_SOURCE).toEqual({NONE: 0, ADC: 1, VIRTUAL: 2, ESC: 3, MSP: 4});
  });

  it('passes every verified currentMeterSource value 0..4 through untouched - qualification is not the decoder\'s job', () => {
    for (const raw of [0, 1, 2, 3, 4]) {
      const bytes = payload([33, 43, 35, 0xdc, 0x05, 1, raw]);
      expect(decodeBatteryConfig(bytes).currentMeterSourceRaw).toBe(raw);
    }
  });

  it('preserves an unknown future meter-source value (e.g. 9) as its raw number', () => {
    const bytes = payload([33, 43, 35, 0xdc, 0x05, 1, 9]);
    expect(decodeBatteryConfig(bytes).currentMeterSourceRaw).toBe(9);
  });

  it('covers capacity extremes 0, 20000 (bat_capacity CLI max) and the raw u16 ceiling 65535 verbatim', () => {
    // Range VALIDATION (0 < capacity <= 20000) belongs to
    // batteryChargeEstimate.ts - the decoder reports the wire value.
    const zero = payload([33, 43, 35, 0x00, 0x00, 1, 1]);
    const cliMax = payload([33, 43, 35, 0x20, 0x4e, 1, 1]);
    const rawMax = payload([33, 43, 35, 0xff, 0xff, 1, 1]);
    expect(decodeBatteryConfig(zero).configuredCapacityMah).toBe(0);
    expect(decodeBatteryConfig(cliMax).configuredCapacityMah).toBe(20000);
    expect(decodeBatteryConfig(rawMax).configuredCapacityMah).toBe(65535);
  });

  it('throws MspPayloadReadError for EVERY truncated length 0 through 6 - all 7 mandatory bytes are required', () => {
    for (let length = 0; length <= 6; length++) {
      expect(() => decodeBatteryConfig(GOLDEN.slice(0, length))).toThrow(MspPayloadReadError);
    }
  });

  it('accepts and ignores the trailing high-resolution cell voltages (3x u16) and any further bytes', () => {
    const withTrailing = payload([...Array.from(GOLDEN), 0x4a, 0x01, 0xae, 0x01, 0x5e, 0x01, 0xff]);
    expect(decodeBatteryConfig(withTrailing)).toEqual(decodeBatteryConfig(GOLDEN));
  });
});
