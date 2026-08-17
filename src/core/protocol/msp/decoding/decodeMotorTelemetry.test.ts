import {
  decodeMotorTelemetry,
  MSP_MOTOR_TELEMETRY_MAX_COUNT,
} from './decodeMotorTelemetry';

function u16le(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
}

function u32le(value: number): number[] {
  return [
    value % 256,
    Math.floor(value / 256) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 16777216) % 256,
  ];
}

describe('decodeMotorTelemetry', () => {
  it('decodes every API-1.47 field with its real wire unit', () => {
    const decoded = decodeMotorTelemetry(
      Uint8Array.from([
        2,
        ...u32le(123456),
        ...u16le(125),
        47,
        ...u16le(1680),
        ...u16le(1234),
        ...u16le(56),
        ...u32le(654321),
        ...u16le(10000),
        81,
        ...u16le(1675),
        ...u16le(4321),
        ...u16le(78),
      ]),
    );

    expect(decoded).toEqual({
      motorCount: 2,
      motors: [
        {
          rpm: 123456,
          invalidPercentRaw: 125,
          temperatureCelsius: 47,
          voltageCentivolts: 1680,
          currentCentiamps: 1234,
          consumptionMah: 56,
        },
        {
          rpm: 654321,
          invalidPercentRaw: 10000,
          temperatureCelsius: 81,
          voltageCentivolts: 1675,
          currentCentiamps: 4321,
          consumptionMah: 78,
        },
      ],
    });
  });

  it('accepts zero entries as a truthful empty capability response', () => {
    expect(decodeMotorTelemetry(Uint8Array.from([0]))).toEqual({
      motorCount: 0,
      motors: [],
    });
  });

  it('degrades to the entries that actually arrived instead of throwing', () => {
    // Betaflight reads `count` entries positionally with no validation at all
    // (MSPHelper.js case MSP_MOTOR_TELEMETRY). This is live read-only
    // telemetry on the Motors screen: a short frame must not blank the
    // readings, and must not invent motors either.
    const complete = [
      1,
      ...u32le(1),
      ...u16le(2),
      3,
      ...u16le(4),
      ...u16le(5),
      ...u16le(6),
    ];
    for (let length = 0; length < complete.length; length++) {
      const decoded = decodeMotorTelemetry(Uint8Array.from(complete.slice(0, length)));
      // No entry is fabricated from bytes that never arrived.
      expect(decoded.motors).toHaveLength(0);
      expect(decoded.motorCount).toBe(0);
    }
    // The complete frame still reads.
    expect(decodeMotorTelemetry(Uint8Array.from(complete)).motors).toHaveLength(1);
  });

  it('CLAMPS a count beyond the eight-slot maximum rather than rejecting it', () => {
    // The cap still bounds what we allocate - it is now a clamp, so an
    // implausible declared count costs the operator nothing.
    expect(MSP_MOTOR_TELEMETRY_MAX_COUNT).toBe(8);
    expect(decodeMotorTelemetry(Uint8Array.from([9])).motors).toHaveLength(0);
    const nine = [9, ...new Array(9 * 13).fill(0)];
    expect(decodeMotorTelemetry(Uint8Array.from(nine)).motors).toHaveLength(8);
  });
});
