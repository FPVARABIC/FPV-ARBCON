import {decodeBatteryState} from './decodeBatteryState';
import {MspPayloadReadError} from './MspPayloadReader';

/** Hand-assembled little-endian payload - independent of the decoder's
 * own reader, so these tests fail if the field order/width/signedness
 * ever drifts from the verified 11-byte Betaflight contract
 * (mspCommandSources.ts). */
function payload(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

const GOLDEN = payload([
  4, // cellCount u8
  0xdc, 0x05, // configuredCapacityMah u16le = 1500
  168, // legacyVoltageDecivolts u8 = 16.8V
  0x5e, 0x01, // consumedMah u16le = 350
  0xd2, 0x04, // amperageCentiamps s16le = +1234 (12.34A)
  1, // batteryStateRaw = BATTERY_WARNING
  0x95, 0x06, // voltageCentivolts u16le = 1685 (16.85V)
]);

describe('decodeBatteryState', () => {
  it('decodes the exact 11-byte golden payload with independent expected literals', () => {
    expect(decodeBatteryState(GOLDEN)).toEqual({
      cellCount: 4,
      configuredCapacityMah: 1500,
      legacyVoltageDecivolts: 168,
      consumedMah: 350,
      amperageCentiamps: 1234,
      batteryStateRaw: 1,
      voltageCentivolts: 1685,
    });
  });

  it('decodes current as SIGNED two\'s-complement (negative current, e.g. charging/regen)', () => {
    // -250 (=-2.5A) as two's complement: 0x10000 - 250 = 0xFF06 -> LE 06 FF.
    const bytes = payload([4, 0xdc, 0x05, 168, 0x5e, 0x01, 0x06, 0xff, 0, 0x95, 0x06]);
    expect(decodeBatteryState(bytes).amperageCentiamps).toBe(-250);
  });

  it('covers the signed extremes -32768 and +32767 (the firmware constrains to exactly this range)', () => {
    const min = payload([1, 0, 0, 0, 0, 0, 0x00, 0x80, 0, 0, 0]);
    const max = payload([1, 0, 0, 0, 0, 0, 0xff, 0x7f, 0, 0, 0]);
    expect(decodeBatteryState(min).amperageCentiamps).toBe(-32768);
    expect(decodeBatteryState(max).amperageCentiamps).toBe(32767);
  });

  it('preserves legitimate raw zeros exactly - the decoder never converts zero into an availability judgment', () => {
    const zeros = payload([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(decodeBatteryState(zeros)).toEqual({
      cellCount: 0,
      configuredCapacityMah: 0,
      legacyVoltageDecivolts: 0,
      consumedMah: 0,
      amperageCentiamps: 0,
      batteryStateRaw: 0,
      voltageCentivolts: 0,
    });
  });

  it('passes every verified batteryState_e value (0..4) through untouched - interpretation is not the decoder\'s job', () => {
    for (const raw of [0, 1, 2, 3, 4]) {
      const bytes = payload([4, 0, 0, 0, 0, 0, 0, 0, raw, 0x95, 0x06]);
      expect(decodeBatteryState(bytes).batteryStateRaw).toBe(raw);
    }
  });

  it('preserves an unknown future enum value (e.g. 7) as its raw number', () => {
    const bytes = payload([4, 0, 0, 0, 0, 0, 0, 0, 7, 0x95, 0x06]);
    expect(decodeBatteryState(bytes).batteryStateRaw).toBe(7);
  });

  it('keeps the legacy 0.1V and high-resolution 0.01V voltage fields fully independent (saturated legacy, real high-res)', () => {
    // Legacy saturates at 255 (25.5V) while the u16 field carries 25.70V.
    const bytes = payload([6, 0, 0, 255, 0, 0, 0, 0, 0, 0x0a, 0x0a]);
    const decoded = decodeBatteryState(bytes);
    expect(decoded.legacyVoltageDecivolts).toBe(255);
    expect(decoded.voltageCentivolts).toBe(2570);
  });

  it('covers unsigned upper bounds (cellCount 255, capacity 65535, voltage 65535)', () => {
    const bytes = payload([255, 0xff, 0xff, 0, 0xff, 0xff, 0, 0, 2, 0xff, 0xff]);
    const decoded = decodeBatteryState(bytes);
    expect(decoded.cellCount).toBe(255);
    expect(decoded.configuredCapacityMah).toBe(65535);
    expect(decoded.consumedMah).toBe(65535);
    expect(decoded.voltageCentivolts).toBe(65535);
  });

  it('throws MspPayloadReadError for EVERY truncated length 0 through 10 - all 11 bytes are required at every accepted firmware version', () => {
    for (let length = 0; length <= 10; length++) {
      expect(() => decodeBatteryState(GOLDEN.slice(0, length))).toThrow(MspPayloadReadError);
    }
  });

  it('accepts and ignores trailing bytes beyond the 11-byte contract (forward compatibility, same posture as decodeBoardInfo)', () => {
    const withTrailing = payload([...Array.from(GOLDEN), 0xde, 0xad, 0xbe]);
    expect(decodeBatteryState(withTrailing)).toEqual(decodeBatteryState(GOLDEN));
  });
});
