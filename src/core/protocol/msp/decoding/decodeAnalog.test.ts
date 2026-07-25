import {decodeAnalog} from './decodeAnalog';
import {MspPayloadReadError} from './MspPayloadReader';

/** Hand-assembled little-endian payload - independent of the decoder's
 * own reader, so these tests fail if the field order/width/signedness
 * ever drifts from the verified 9-byte MSP_ANALOG contract
 * (mspCommandSources.ts, proven identical at API 1.46 and 1.48). */
function payload(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

const GOLDEN = payload([
  168, // legacy vbat u8 = 16.8V
  0x5e, 0x01, // mAh drawn u16le = 350
  0x1c, 0x02, // rssi u16le = 540 (of 0..1023)
  0xd2, 0x04, // amperage s16le = +1234 (12.34A)
  0x95, 0x06, // vbat u16le = 1685 (16.85V)
]);

describe('decodeAnalog', () => {
  it('decodes the exact 9-byte golden payload with independent expected literals', () => {
    expect(decodeAnalog(GOLDEN)).toEqual({
      legacyVoltageDecivolts: 168,
      consumedMah: 350,
      rssi: 540,
      amperageCentiamps: 1234,
      voltageCentivolts: 1685,
    });
  });

  it("decodes amperage as SIGNED two's-complement (negative current)", () => {
    // -250 (=-2.5A): 0x10000 - 250 = 0xFF06 -> LE 06 FF.
    const bytes = payload([168, 0x5e, 0x01, 0x1c, 0x02, 0x06, 0xff, 0x95, 0x06]);
    expect(decodeAnalog(bytes).amperageCentiamps).toBe(-250);
  });

  it('covers the RSSI wire extremes 0 and 1023 (RSSI_MAX_VALUE) verbatim - zero passes through untouched', () => {
    // The 0-is-ambiguous judgment belongs to auxTelemetrySemantics.ts,
    // never to the decoder.
    const zero = payload([168, 0, 0, 0x00, 0x00, 0, 0, 0x95, 0x06]);
    const max = payload([168, 0, 0, 0xff, 0x03, 0, 0, 0x95, 0x06]);
    expect(decodeAnalog(zero).rssi).toBe(0);
    expect(decodeAnalog(max).rssi).toBe(1023);
  });

  it('preserves legitimate raw zeros exactly across every field', () => {
    expect(decodeAnalog(payload([0, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({
      legacyVoltageDecivolts: 0,
      consumedMah: 0,
      rssi: 0,
      amperageCentiamps: 0,
      voltageCentivolts: 0,
    });
  });

  it('throws MspPayloadReadError for EVERY truncated length 0 through 8 - all 9 bytes are mandatory', () => {
    for (let length = 0; length <= 8; length++) {
      expect(() => decodeAnalog(GOLDEN.slice(0, length))).toThrow(MspPayloadReadError);
    }
  });

  it('accepts and ignores trailing bytes beyond the 9-byte contract (forward compatibility)', () => {
    const withTrailing = payload([...Array.from(GOLDEN), 0xde, 0xad]);
    expect(decodeAnalog(withTrailing)).toEqual(decodeAnalog(GOLDEN));
  });
});
