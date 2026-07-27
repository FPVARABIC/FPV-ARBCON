/**
 * Motor read-capability pass - byte-level tests for the six READ-ONLY
 * motor/mixer decoders, every expectation built from a hand-written
 * Uint8Array rather than from the production encoder, so a decoder bug
 * cannot be masked by a matching encoder bug.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated here: no
 * flight controller, no USB, no ESC, no motor, no LiPo. These are pure
 * byte-array functions.
 */

import {MspPayloadReadError} from './MspPayloadReader';
import {decodeFeatureConfig, FEATURE_3D_BIT} from './decodeFeatureConfig';
import {decodeMixerConfig, MIXER_MODE_QUADX, MIXER_MODE_QUADX_1234} from './decodeMixerConfig';
import {decodeAdvancedConfig, MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2} from './decodeAdvancedConfig';
import {decodeMotorConfig} from './decodeMotorConfig';
import {decodeMotor3dConfig} from './decodeMotor3dConfig';
import {decodeMotorOutputs, MSP_MOTOR_OUTPUT_SLOT_COUNT} from './decodeMotorOutputs';
import {
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_ADVANCED_CONFIG,
  MSP_MOTOR,
  MSP_MOTOR_3D_CONFIG,
  MSP_MOTOR_CONFIG,
} from '../commands/mspCommands';
import * as mspCommandsModule from '../commands/mspCommands';

/**
 * Fixture encoders built on DataView with an EXPLICIT little-endian
 * argument, rather than hand-rolled shift-and-mask arithmetic: the
 * endianness is then stated by the platform API instead of re-derived
 * here, so a test fixture cannot drift from the wire format it is
 * supposed to represent. No production byte writer exists or is added -
 * this pass ships decoders only.
 *
 * DataView.setUint16/setUint32 apply the standard ToUint32 conversion, so
 * a value expressed as a negative JavaScript number still encodes to the
 * correct unsigned bytes.
 */
function littleEndianBytes(byteLength: number, write: (view: DataView) => void): number[] {
  const buffer = new ArrayBuffer(byteLength);
  write(new DataView(buffer));
  return Array.from(new Uint8Array(buffer));
}

const u16 = (value: number): number[] =>
  littleEndianBytes(2, view => view.setUint16(0, value, true));
const u32 = (value: number): number[] =>
  littleEndianBytes(4, view => view.setUint32(0, value, true));

/** Drives the "every truncated length from 0 through minimum-1 throws"
 * requirement for a decoder, rather than spot-checking one short input. */
function expectEveryTruncationRejected(
  decode: (payload: Uint8Array) => unknown,
  fullPayload: number[],
  minimumLength: number,
): void {
  expect(fullPayload.length).toBeGreaterThanOrEqual(minimumLength);
  for (let length = 0; length < minimumLength; length++) {
    const truncated = Uint8Array.from(fullPayload.slice(0, length));
    expect(() => decode(truncated)).toThrow(MspPayloadReadError);
  }
}

describe('motor read-capability command IDs', () => {
  it('match the values verified at Betaflight 2025.12.2', () => {
    expect(MSP_FEATURE_CONFIG).toBe(36);
    expect(MSP_MIXER_CONFIG).toBe(42);
    expect(MSP_ADVANCED_CONFIG).toBe(90);
    expect(MSP_MOTOR).toBe(104);
    expect(MSP_MOTOR_3D_CONFIG).toBe(124);
    expect(MSP_MOTOR_CONFIG).toBe(131);
  });

  it('declares MSP_SET_MOTOR as 214 and still declares NO arming-disable command', () => {
    const commands: Record<string, unknown> = {...mspCommandsModule};
    // SUPERSEDED BY PASS 1B. The read-only pass asserted MSP_SET_MOTOR's
    // ABSENCE here. Pass 1B declares it under explicit authorization, as
    // a constant with pure, unreachable encoding helpers and no caller,
    // so the assertion is inverted to pin its verified value instead of
    // being deleted.
    expect(commands.MSP_SET_MOTOR).toBe(214);

    // NOT superseded: MSP_SET_ARMING_DISABLED is still deliberately
    // absent. It is not an interlock for MSP_SET_MOTOR, and declaring it
    // is a separate decision that has not been taken.
    expect(Object.keys(commands)).not.toContain('MSP_SET_ARMING_DISABLED');
    expect(Object.values(commands)).not.toContain(99);
  });
});

describe('decodeFeatureConfig (MSP_FEATURE_CONFIG, 4 bytes)', () => {
  it('decodes the u32 mask little-endian', () => {
    const decoded = decodeFeatureConfig(Uint8Array.from(u32(0x0000_1000)));
    expect(decoded.enabledFeaturesRaw).toBe(0x0000_1000);
  });

  it('pins FEATURE_3D to bit 12 by VALUE, not just by symbol', () => {
    // Asserted against literals so a change to how the constant is
    // written (2 ** 12 vs 1 << 12) can never silently move the bit.
    expect(FEATURE_3D_BIT).toBe(4096);
    expect(FEATURE_3D_BIT).toBe(0x0000_1000);
    expect(decodeFeatureConfig(Uint8Array.from(u32(0x0000_1000))).feature3dEnabled).toBe(true);
    expect(decodeFeatureConfig(Uint8Array.from(u32(0x0000_0800))).feature3dEnabled).toBe(false);
    expect(decodeFeatureConfig(Uint8Array.from(u32(0x0000_2000))).feature3dEnabled).toBe(false);
  });

  it('reports FEATURE_3D from bit 12 only', () => {
    expect(decodeFeatureConfig(Uint8Array.from(u32(FEATURE_3D_BIT))).feature3dEnabled).toBe(true);
    // Every other bit set, bit 12 clear -> still false. Bit 12 is set in
    // an all-ones mask, so subtracting the flag's value clears exactly
    // that one bit and nothing else.
    const allBitsExcept3d = 0xffff_ffff - FEATURE_3D_BIT;
    expect(decodeFeatureConfig(Uint8Array.from(u32(allBitsExcept3d))).feature3dEnabled).toBe(false);
    expect(decodeFeatureConfig(Uint8Array.from(u32(0))).feature3dEnabled).toBe(false);
  });

  it('preserves masks above 0x7fffffff as UNSIGNED', () => {
    const decoded = decodeFeatureConfig(Uint8Array.from(u32(0xffff_ffff)));
    expect(decoded.enabledFeaturesRaw).toBe(4_294_967_295);
    expect(decoded.enabledFeaturesRaw).toBeGreaterThan(0x7fffffff);
    // The high bit must not flip the 3D determination either.
    expect(decoded.feature3dEnabled).toBe(true);

    const highBitOnly = decodeFeatureConfig(Uint8Array.from(u32(0x8000_0000)));
    expect(highBitOnly.enabledFeaturesRaw).toBe(2_147_483_648);
    expect(highBitOnly.feature3dEnabled).toBe(false);
  });

  it('rejects every truncated length', () => {
    expectEveryTruncationRejected(decodeFeatureConfig, u32(0x1234_5678), 4);
  });

  it('ignores trailing bytes', () => {
    const decoded = decodeFeatureConfig(Uint8Array.from([...u32(FEATURE_3D_BIT), 9, 9, 9]));
    expect(decoded.enabledFeaturesRaw).toBe(FEATURE_3D_BIT);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(decodeFeatureConfig(Uint8Array.from(u32(0))))).toBe(true);
  });
});

describe('decodeMixerConfig (MSP_MIXER_CONFIG, 2 bytes)', () => {
  it('decodes mixer mode and the reversed-yaw byte at their exact offsets', () => {
    const decoded = decodeMixerConfig(Uint8Array.from([MIXER_MODE_QUADX, 1]));
    expect(decoded.mixerModeRaw).toBe(3);
    expect(decoded.yawMotorsReversedConfigured).toBe(true);
    expect(decoded.yawMotorsReversedRaw).toBe(1);
  });

  it('keeps MIXER_QUADX (3) and MIXER_QUADX_1234 (26) DISTINCT', () => {
    expect(MIXER_MODE_QUADX).toBe(3);
    expect(MIXER_MODE_QUADX_1234).toBe(26);
    expect(MIXER_MODE_QUADX).not.toBe(MIXER_MODE_QUADX_1234);
    expect(decodeMixerConfig(Uint8Array.from([26, 0])).mixerModeRaw).toBe(26);
    // Decoding 26 must never be normalised into 3.
    expect(decodeMixerConfig(Uint8Array.from([26, 0])).mixerModeRaw).not.toBe(MIXER_MODE_QUADX);
  });

  it('treats yawMotorsReversedConfigured 0 as false and preserves any non-0/1 raw byte', () => {
    expect(decodeMixerConfig(Uint8Array.from([3, 0])).yawMotorsReversedConfigured).toBe(false);
    const odd = decodeMixerConfig(Uint8Array.from([3, 7]));
    expect(odd.yawMotorsReversedConfigured).toBe(true);
    expect(odd.yawMotorsReversedRaw).toBe(7);
  });

  it('rejects every truncated length', () => {
    expectEveryTruncationRejected(decodeMixerConfig, [3, 1], 2);
  });

  it('ignores trailing bytes and returns a frozen object', () => {
    const decoded = decodeMixerConfig(Uint8Array.from([3, 1, 0xaa]));
    expect(decoded.mixerModeRaw).toBe(3);
    expect(Object.isFrozen(decoded)).toBe(true);
  });
});

describe('decodeAdvancedConfig (MSP_ADVANCED_CONFIG, 20 bytes)', () => {
  /** Every field a distinguishable value, so a swapped pair of offsets
   * cannot pass. */
  const FULL = [
    1, // 0  deprecated gyro sync denom
    4, // 1  pid_process_denom
    1, // 2  useContinuousUpdate
    MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2, // 3 motorProtocol
    ...u16(480), // 4  motorPwmRate
    ...u16(550), // 6  motorIdle == 5.5%
    0, // 8  deprecated gyro_use_32kHz
    2, // 9  motorInversion
    0, // 10 deprecated gyro_to_use
    1, // 11 gyro_high_fsr
    32, // 12 gyroMovementCalibrationThreshold
    ...u16(125), // 13 gyroCalibrationDuration
    ...u16(0xfff6), // 15 gyro_offset_yaw == -10 signed
    1, // 17 checkOverflow
    9, // 18 debug_mode
    60, // 19 DEBUG_COUNT
  ];

  it('is exactly 20 bytes and decodes every field at its verified offset', () => {
    expect(FULL).toHaveLength(20);
    const decoded = decodeAdvancedConfig(Uint8Array.from(FULL));
    expect(decoded).toEqual({
      deprecatedGyroSyncDenom: 1,
      pidProcessDenom: 4,
      useContinuousUpdate: 1,
      motorProtocolRaw: 7,
      motorPwmRate: 480,
      motorIdleRaw: 550,
      deprecatedGyroUse32kHz: 0,
      motorInversionRaw: 2,
      deprecatedGyroToUse: 0,
      gyroHighFsr: 1,
      gyroMovementCalibrationThreshold: 32,
      gyroCalibrationDuration: 125,
      gyroYawOffset: -10,
      checkOverflow: 1,
      debugMode: 9,
      debugModeCount: 60,
    });
  });

  it('decodes gyroYawOffset as SIGNED - the whole negative range, not 65535-relative', () => {
    const at = (raw: number) => {
      const [low, high] = u16(raw);
      const bytes = [...FULL];
      bytes[15] = low;
      bytes[16] = high;
      return decodeAdvancedConfig(Uint8Array.from(bytes)).gyroYawOffset;
    };
    expect(at(0x0000)).toBe(0);
    expect(at(0x0001)).toBe(1);
    expect(at(0x7fff)).toBe(32767);
    expect(at(0x8000)).toBe(-32768);
    expect(at(0xffff)).toBe(-1);
    expect(at(0xfff6)).toBe(-10);
  });

  it('maps raw motor protocol 7 to DSHOT600 at the pinned tag, and stores it raw', () => {
    expect(MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2).toBe(7);
    const decoded = decodeAdvancedConfig(Uint8Array.from(FULL));
    expect(decoded.motorProtocolRaw).toBe(MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2);
    // A different protocol stays a different raw number - never coerced.
    const pwm = [...FULL];
    pwm[3] = 0;
    expect(decodeAdvancedConfig(Uint8Array.from(pwm)).motorProtocolRaw).toBe(0);
  });

  it('keeps motor idle RAW (550 == 5.5%) and derives no pulse from it', () => {
    const decoded = decodeAdvancedConfig(Uint8Array.from(FULL));
    expect(decoded.motorIdleRaw).toBe(550);
    // The decoded object exposes the raw hundredths-of-a-percent value and
    // nothing throttle-shaped: no field here is, or could be mistaken
    // for, a motor command value.
    expect(Object.keys(decoded)).not.toContain('idlePulse');
    expect(Object.keys(decoded)).not.toContain('pulseValue');
    expect(Object.values(decoded)).not.toContain(1000);
  });

  it('rejects every truncated length', () => {
    expectEveryTruncationRejected(decodeAdvancedConfig, FULL, 20);
  });

  it('ignores trailing bytes and returns a frozen object', () => {
    const decoded = decodeAdvancedConfig(Uint8Array.from([...FULL, 1, 2, 3, 4]));
    expect(decoded.debugModeCount).toBe(60);
    expect(Object.isFrozen(decoded)).toBe(true);
  });
});

describe('decodeMotorConfig (MSP_MOTOR_CONFIG, 10 bytes)', () => {
  const FULL = [
    ...u16(0), // 0 deprecated former min throttle
    ...u16(2000), // 2 maxthrottle
    ...u16(1000), // 4 mincommand
    4, // 6 motorCount
    14, // 7 motorPoleCount
    1, // 8 dshot telemetry raw
    0, // 9 esc sensor raw
  ];

  it('is exactly 10 bytes and decodes every field at its verified offset', () => {
    expect(FULL).toHaveLength(10);
    expect(decodeMotorConfig(Uint8Array.from(FULL))).toEqual({
      deprecatedMinThrottle: 0,
      maxThrottle: 2000,
      minCommand: 1000,
      motorCount: 4,
      motorPoleCount: 14,
      dshotTelemetryRaw: 1,
      escSensorRaw: 0,
    });
  });

  it('names the removed first field as deprecated - it is never a throttle', () => {
    const decoded = decodeMotorConfig(Uint8Array.from(FULL));
    expect(decoded.deprecatedMinThrottle).toBe(0);
    expect(Object.keys(decoded)).not.toContain('minThrottle');
  });

  it('is the ONLY source of motor count', () => {
    const six = [...FULL];
    six[6] = 6;
    expect(decodeMotorConfig(Uint8Array.from(six)).motorCount).toBe(6);
  });

  it('rejects every truncated length', () => {
    expectEveryTruncationRejected(decodeMotorConfig, FULL, 10);
  });

  it('ignores trailing bytes and returns a frozen object', () => {
    const decoded = decodeMotorConfig(Uint8Array.from([...FULL, 0xff]));
    expect(decoded.escSensorRaw).toBe(0);
    expect(Object.isFrozen(decoded)).toBe(true);
  });
});

describe('decodeMotor3dConfig (MSP_MOTOR_3D_CONFIG, 6 bytes)', () => {
  const FULL = [...u16(1406), ...u16(1514), ...u16(1460)];

  it('is exactly 6 bytes and decodes all three u16 values in order', () => {
    expect(FULL).toHaveLength(6);
    expect(decodeMotor3dConfig(Uint8Array.from(FULL))).toEqual({
      deadband3dLow: 1406,
      deadband3dHigh: 1514,
      neutral3d: 1460,
    });
  });

  it('exposes NO 3D-enabled flag - these values never determine 3D state', () => {
    const decoded = decodeMotor3dConfig(Uint8Array.from(FULL));
    expect(Object.keys(decoded)).not.toContain('feature3dEnabled');
    expect(Object.keys(decoded)).not.toContain('enabled');
    // Even a fully-populated, very "3D-looking" payload says nothing
    // about whether the feature is on; only MSP_FEATURE_CONFIG does.
    expect(Object.keys(decoded)).toEqual(['deadband3dLow', 'deadband3dHigh', 'neutral3d']);
  });

  it('rejects every truncated length', () => {
    expectEveryTruncationRejected(decodeMotor3dConfig, FULL, 6);
  });

  it('ignores trailing bytes and returns a frozen object', () => {
    const decoded = decodeMotor3dConfig(Uint8Array.from([...FULL, 7, 7]));
    expect(decoded.neutral3d).toBe(1460);
    expect(Object.isFrozen(decoded)).toBe(true);
  });
});

describe('decodeMotorOutputs (MSP_MOTOR, 16 bytes)', () => {
  const FULL = [
    ...u16(1000),
    ...u16(1150),
    ...u16(0),
    ...u16(2000),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
  ];

  it('always decodes exactly eight u16 values, zeros included', () => {
    expect(MSP_MOTOR_OUTPUT_SLOT_COUNT).toBe(8);
    expect(FULL).toHaveLength(16);
    const decoded = decodeMotorOutputs(Uint8Array.from(FULL));
    expect(decoded.values).toHaveLength(8);
    expect(decoded.values).toEqual([1000, 1150, 0, 2000, 0, 0, 0, 0]);
  });

  it('treats zero as a legal value, never as "absent"', () => {
    const allZero = decodeMotorOutputs(Uint8Array.from(new Array(16).fill(0)));
    expect(allZero.values).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(allZero.values).toHaveLength(8);
  });

  it('exposes NO motor count - the non-zero entry count is not one', () => {
    const decoded = decodeMotorOutputs(Uint8Array.from(FULL));
    expect(Object.keys(decoded)).toEqual(['values']);
    expect(Object.keys(decoded)).not.toContain('motorCount');
    // Three non-zero entries here, on a four-motor airframe: proof that
    // counting non-zero values would give the wrong answer.
    expect(decoded.values.filter(value => value !== 0)).toHaveLength(3);
  });

  it('rejects every truncated length', () => {
    expectEveryTruncationRejected(decodeMotorOutputs, FULL, 16);
  });

  it('ignores trailing bytes and returns frozen, defensively immutable data', () => {
    const decoded = decodeMotorOutputs(Uint8Array.from([...FULL, 0xde, 0xad]));
    expect(decoded.values).toHaveLength(8);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.values)).toBe(true);
    // Non-strict mode silently ignores writes to a frozen array, so the
    // stored data is asserted afterwards rather than the throw.
    try {
      (decoded.values as number[])[0] = 1234;
    } catch {
      // frozen array in strict mode - equally acceptable
    }
    expect(decoded.values[0]).toBe(1000);
  });
});
