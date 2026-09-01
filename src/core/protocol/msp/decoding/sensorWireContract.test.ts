/**
 * THE SENSOR WIRE CONTRACT, PROVED AGAINST HAND-WRITTEN BYTES.
 *
 * Every fixture in this file was typed out from the firmware serializer
 * at revision 7348054f268f0058574719c134e9f149565bb8ea, byte by byte.
 * None of them was produced by running our own encoder and feeding the
 * result to our own decoder - that proves only that two of our functions
 * agree with each other, which they would also do if both were wrong in
 * the same direction. Where an encoder is under test, the expected bytes
 * are likewise written out longhand.
 *
 * The fixtures are chosen to be DISCRIMINATING rather than realistic: a
 * value repeated across fields cannot catch a field swap, so every
 * fixture below uses values that name different parts in different
 * positions.
 */

import {
  decodeSensorConfig,
  NOT_AVAILABLE_IN_THIS_CONTRACT,
  SENSOR_CONFIG_CONTRACT_BYTES,
} from './decodeSensorConfig';
import {
  decodeSensorAlignment,
  gyroIndicesFromBitmask,
  modelSensorAlignment,
  SENSOR_ALIGNMENT_PAYLOAD_BYTES,
} from './decodeSensorAlignment';
import {
  decodeSensorConfigActive,
  SENSOR_NOT_AVAILABLE,
} from './decodeSensorConfigActive';
import {decodeGyroSensorActive} from './decodeGyroSensorActive';
import {decodeAccTrim} from './decodeAccTrim';
import {decodeCompassConfig} from './decodeCompassConfig';
import {
  modelSensorHardware,
  sensorHardwareDefaultIndex,
  sensorHardwareNoneIndex,
} from './sensorHardwareCatalog';
import {decodeStatusEx, STATUS_SENSOR_GPS_BIT} from './decodeStatusEx';
import {
  encodeSensorConfig,
  sensorConfigContractFor,
  sensorConfigWriteFrom,
} from '../encoding/encodeSensorConfig';
import {encodeSensorAlignment} from '../encoding/encodeSensorAlignment';
import {encodeAccTrim} from '../encoding/encodeAccTrim';
import {encodeCompassConfig} from '../encoding/encodeCompassConfig';
import {SENSOR_PRESENCE_TOKENS} from '../../../state/armingBlockers';
import {
  MSP_SENSOR_CONFIG,
  MSP_SET_SENSOR_CONFIG,
  MSP_SENSOR_ALIGNMENT,
  MSP_SET_SENSOR_ALIGNMENT,
  MSP_COMPASS_CONFIG,
  MSP_SET_COMPASS_CONFIG,
  MSP_ACC_TRIM,
  MSP_SET_ACC_TRIM,
  MSP_SONAR_ALTITUDE,
  MSP2_SENSOR_CONFIG_ACTIVE,
  MSP2_GYRO_SENSOR_ACTIVE,
} from '../commands/mspCommands';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const list = (payload: Uint8Array): number[] => Array.from(payload);

describe('MSP sensor command numbers', () => {
  it('match the firmware protocol headers at API 1.47', () => {
    expect({
      MSP_SENSOR_CONFIG,
      MSP_SET_SENSOR_CONFIG,
      MSP_SENSOR_ALIGNMENT,
      MSP_SET_SENSOR_ALIGNMENT,
      MSP_COMPASS_CONFIG,
      MSP_SET_COMPASS_CONFIG,
      MSP_SET_ACC_TRIM,
      MSP_ACC_TRIM,
      MSP_SONAR_ALTITUDE,
      MSP2_SENSOR_CONFIG_ACTIVE,
      MSP2_GYRO_SENSOR_ACTIVE,
    }).toEqual({
      MSP_SENSOR_CONFIG: 96,
      MSP_SET_SENSOR_CONFIG: 97,
      MSP_SENSOR_ALIGNMENT: 126,
      MSP_SET_SENSOR_ALIGNMENT: 220,
      MSP_COMPASS_CONFIG: 133,
      MSP_SET_COMPASS_CONFIG: 224,
      // The SET is the LOWER opcode here, which is the reverse of the
      // usual arrangement and is easy to transpose.
      MSP_SET_ACC_TRIM: 239,
      MSP_ACC_TRIM: 240,
      MSP_SONAR_ALTITUDE: 58,
      MSP2_SENSOR_CONFIG_ACTIVE: 0x300a,
      MSP2_GYRO_SENSOR_ACTIVE: 0x300d,
    });
  });
});

/* ================================================================ *
 * THE HARDWARE CATALOG
 * ================================================================ */

describe('sensor hardware catalog, pinned to API 1.47', () => {
  it('names barometer index 10 LPS22DF, not VIRTUAL', () => {
    // THE P0. betaflight-configurator's barometer list at the 2026.6.1
    // tag has eleven entries ending VIRTUAL at index 10, and its 1.47
    // fix-up block never edits that list. The firmware has
    // BARO_2SMPB_02B = 9, BARO_LPS22DF = 10, BARO_VIRTUAL = 11. Copying
    // the client would tell an operator with a real LPS22DF fitted that
    // their barometer is simulated.
    expect([
      modelSensorHardware('BARO', 9).modelled,
      modelSensorHardware('BARO', 10).modelled,
      modelSensorHardware('BARO', 11).modelled,
    ]).toEqual(['BARO_2SMPB_02B', 'BARO_LPS22DF', 'BARO_VIRTUAL']);
  });

  it('puts NONE before DEFAULT on the gyro list and after it everywhere else', () => {
    // gyroHardware_e is GYRO_NONE = 0, GYRO_DEFAULT = 1. Every other
    // family is the other way round. A single shared "0 means default"
    // rule reports a gyro-less board as running the default gyro.
    expect({
      gyro0: modelSensorHardware('GYRO', 0),
      gyro1: modelSensorHardware('GYRO', 1),
      acc0: modelSensorHardware('ACC', 0),
      acc1: modelSensorHardware('ACC', 1),
    }).toEqual({
      gyro0: {raw: 0, modelled: 'GYRO_NONE', kind: 'NONE'},
      gyro1: {raw: 1, modelled: 'GYRO_DEFAULT', kind: 'DEFAULT'},
      acc0: {raw: 0, modelled: 'ACC_DEFAULT', kind: 'DEFAULT'},
      acc1: {raw: 1, modelled: 'ACC_NONE', kind: 'NONE'},
    });
  });

  it('keeps the gyro and accelerometer lists apart past index 2', () => {
    // gyroHardware_e carries GYRO_L3GD20 at index 3, which has no
    // accelerometer counterpart, so every later entry is offset by one.
    // The same byte names two different parts.
    expect([
      modelSensorHardware('GYRO', 4).modelled,
      modelSensorHardware('ACC', 4).modelled,
    ]).toEqual(['GYRO_MPU6000', 'ACC_MPU6500']);
  });

  it('gives the rangefinder and optical flow families no DEFAULT at all', () => {
    // rangefinderType_e and opticalflowType_e both start at NONE = 0 and
    // have no auto-detect value. The firmware says so beside the byte:
    // "no RANGEFINDER_DEFAULT value".
    expect({
      rangefinderNone: sensorHardwareNoneIndex('RANGEFINDER'),
      rangefinderDefault: sensorHardwareDefaultIndex('RANGEFINDER'),
      opticalflowNone: sensorHardwareNoneIndex('OPTICALFLOW'),
      opticalflowDefault: sensorHardwareDefaultIndex('OPTICALFLOW'),
    }).toEqual({
      rangefinderNone: 0,
      rangefinderDefault: undefined,
      opticalflowNone: 0,
      opticalflowDefault: undefined,
    });
  });

  it('models an index this revision does not define as UNKNOWN, never as DEFAULT or NONE', () => {
    // OPTICALFLOW_UPT1 = 2 arrives on the 1.49 line. At 1.47 the byte has
    // no meaning, and inventing one - in either direction - would either
    // hide a sensor or invent one.
    expect(modelSensorHardware('OPTICALFLOW', 2)).toEqual({
      raw: 2,
      modelled: 'UNKNOWN(2)',
      kind: 'UNKNOWN',
    });
    expect(modelSensorHardware('MAG', 200)).toEqual({
      raw: 200,
      modelled: 'UNKNOWN(200)',
      kind: 'UNKNOWN',
    });
  });
});

/* ================================================================ *
 * MSP_SENSOR_CONFIG (96)
 * ================================================================ */

describe('decodeSensorConfig', () => {
  // acc=4, baro=3, mag=2, rangefinder=1, opticalflow=1. Every position
  // holds a different number so a field swap cannot pass, and byte 0's
  // value names a DIFFERENT part on the gyro list than on the acc list.
  const FIVE_BYTE = bytes(0x04, 0x03, 0x02, 0x01, 0x01);

  it('MSP_SENSOR_CONFIG byte 0 is ACC, never gyro', () => {
    // The firmware's own comment above this handler claims byte 0 is the
    // gyro. The five sbufWriteU8 calls underneath it write acc, baro,
    // mag, rangefinder, opticalflow - no gyro anywhere. Executable code
    // is the contract. Read with the gyro table, byte 0 would come back
    // as GYRO_MPU6000 instead of ACC_MPU6500.
    const decoded = decodeSensorConfig(FIVE_BYTE);
    expect(decoded.acc).toEqual({
      raw: 4,
      modelled: 'ACC_MPU6500',
      kind: 'KNOWN',
    });
    expect(Object.keys(decoded)).not.toContain('gyro');
  });

  it('decodes all five fields of the full contract in firmware order', () => {
    const decoded = decodeSensorConfig(FIVE_BYTE);
    expect({
      acc: decoded.acc.modelled,
      baro: decoded.baro.modelled,
      mag: decoded.mag.modelled,
      rangefinder:
        decoded.rangefinder === NOT_AVAILABLE_IN_THIS_CONTRACT
          ? decoded.rangefinder
          : decoded.rangefinder.modelled,
      opticalflow:
        decoded.opticalflow === NOT_AVAILABLE_IN_THIS_CONTRACT
          ? decoded.opticalflow
          : decoded.opticalflow.modelled,
      contract: decoded.contract,
      trailingByteCount: decoded.trailingByteCount,
    }).toEqual({
      acc: 'ACC_MPU6500',
      baro: 'BARO_MS5611',
      mag: 'MAG_HMC5883',
      rangefinder: 'RANGEFINDER_HCSR04',
      opticalflow: 'OPTICALFLOW_MT',
      contract: 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW',
      trailingByteCount: 0,
    });
  });

  it('marks the optical-flow field typed-absent on a four-byte frame', () => {
    const decoded = decodeSensorConfig(bytes(0x04, 0x03, 0x02, 0x01));
    expect(decoded.opticalflow).toBe(NOT_AVAILABLE_IN_THIS_CONTRACT);
    expect(decoded.rangefinder).not.toBe(NOT_AVAILABLE_IN_THIS_CONTRACT);
    expect(decoded.contract).toBe('ACC_BARO_MAG_RANGEFINDER');
  });

  it('marks both trailing fields typed-absent on a three-byte frame, never zero', () => {
    // A three-byte answer does not mean "no rangefinder". It means the
    // board never said. RANGEFINDER_NONE here would be a configuration
    // the flight controller never stated.
    const decoded = decodeSensorConfig(bytes(0x04, 0x03, 0x02));
    expect({
      rangefinder: decoded.rangefinder,
      opticalflow: decoded.opticalflow,
      contract: decoded.contract,
    }).toEqual({
      rangefinder: NOT_AVAILABLE_IN_THIS_CONTRACT,
      opticalflow: NOT_AVAILABLE_IN_THIS_CONTRACT,
      contract: 'ACC_BARO_MAG',
    });
  });

  it('refuses a two-byte frame as truncation rather than padding it', () => {
    expect(() => decodeSensorConfig(bytes(0x04, 0x03))).toThrow(
      /at least 3 bytes/,
    );
  });

  it('still decodes the five known fields when a newer firmware appends one', () => {
    const decoded = decodeSensorConfig(bytes(0x04, 0x03, 0x02, 0x01, 0x01, 0x07));
    expect({
      acc: decoded.acc.raw,
      contract: decoded.contract,
      trailingByteCount: decoded.trailingByteCount,
    }).toEqual({
      acc: 4,
      contract: 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW',
      trailingByteCount: 1,
    });
  });

  it('reads a configured barometer of 10 as LPS22DF', () => {
    const decoded = decodeSensorConfig(bytes(0x00, 0x0a, 0x00));
    expect(decoded.baro).toEqual({
      raw: 10,
      modelled: 'BARO_LPS22DF',
      kind: 'KNOWN',
    });
  });

  it('reads a configured rangefinder of 0 as NONE, not DEFAULT', () => {
    const decoded = decodeSensorConfig(bytes(0x00, 0x00, 0x00, 0x00));
    expect(decoded.rangefinder).toEqual({
      raw: 0,
      modelled: 'RANGEFINDER_NONE',
      kind: 'NONE',
    });
  });
});

describe('encodeSensorConfig', () => {
  it('builds the three-byte frame exactly', () => {
    expect(
      list(encodeSensorConfig('ACC_BARO_MAG', {acc: 4, baro: 3, mag: 2})),
    ).toEqual([0x04, 0x03, 0x02]);
  });

  it('builds the four-byte frame exactly', () => {
    expect(
      list(
        encodeSensorConfig('ACC_BARO_MAG_RANGEFINDER', {
          acc: 4,
          baro: 3,
          mag: 2,
          rangefinder: 1,
        }),
      ),
    ).toEqual([0x04, 0x03, 0x02, 0x01]);
  });

  it('builds the five-byte frame exactly', () => {
    expect(
      list(
        encodeSensorConfig('ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW', {
          acc: 4,
          baro: 3,
          mag: 2,
          rangefinder: 1,
          opticalflow: 1,
        }),
      ),
    ).toEqual([0x04, 0x03, 0x02, 0x01, 0x01]);
  });

  it('refuses to silently drop a value the chosen frame cannot carry', () => {
    // The caller believes it is configuring a rangefinder. A three-byte
    // frame cannot say so, and dropping the value would leave the caller
    // believing it after the board acknowledged a frame that never
    // mentioned one.
    expect(() =>
      encodeSensorConfig('ACC_BARO_MAG', {
        acc: 4,
        baro: 3,
        mag: 2,
        rangefinder: 1,
      }),
    ).toThrow(/no rangefinder byte/);
  });

  it('refuses a frame shape whose field the caller did not supply', () => {
    expect(() =>
      encodeSensorConfig('ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW', {
        acc: 4,
        baro: 3,
        mag: 2,
        rangefinder: 1,
      }),
    ).toThrow(/carries opticalflow/);
  });

  it('refuses a value outside a single byte', () => {
    expect(() =>
      encodeSensorConfig('ACC_BARO_MAG', {acc: 256, baro: 0, mag: 0}),
    ).toThrow(/must be an integer in 0\.\.255/);
    expect(() =>
      encodeSensorConfig('ACC_BARO_MAG', {acc: 1.5, baro: 0, mag: 0}),
    ).toThrow(/must be an integer in 0\.\.255/);
  });

  it('never chooses a frame shape by itself - the shape comes from what the board answered', () => {
    const threeByteBoard = decodeSensorConfig(bytes(0x04, 0x03, 0x02));
    const fiveByteBoard = decodeSensorConfig(bytes(0x04, 0x03, 0x02, 0x01, 0x01));
    expect([
      sensorConfigContractFor(threeByteBoard),
      sensorConfigContractFor(fiveByteBoard),
    ]).toEqual(['ACC_BARO_MAG', 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW']);
    expect(SENSOR_CONFIG_CONTRACT_BYTES.ACC_BARO_MAG).toBe(3);
  });

  it('carries absent fields across as absent, so only the matching frame validates', () => {
    const threeByteBoard = decodeSensorConfig(bytes(0x04, 0x03, 0x02));
    const write = sensorConfigWriteFrom(threeByteBoard);
    expect(write).toEqual({acc: 4, baro: 3, mag: 2});
    expect(list(encodeSensorConfig('ACC_BARO_MAG', write))).toEqual([
      0x04, 0x03, 0x02,
    ]);
  });
});

/* ================================================================ *
 * MSP_SENSOR_ALIGNMENT (126) / MSP_SET_SENSOR_ALIGNMENT (220)
 * ================================================================ */

describe('decodeSensorAlignment', () => {
  // gyro CW90, acc CW90, mag ALIGN_CUSTOM, detected flags 0b11 (two gyros
  // found), enabled bitmask 0b01 (one gyro running), custom angles
  // +100 / -900 / +1800 decidegrees.
  const READ_FRAME = bytes(
    0x02, 0x02, 0x09, 0x03, 0x01, 0x64, 0x00, 0x7c, 0xfc, 0x08, 0x07,
  );

  it('decodes all eleven bytes of the API-1.47 read frame', () => {
    const decoded = decodeSensorAlignment(READ_FRAME);
    expect({
      gyro: decoded.gyro.modelled,
      acc: decoded.acc.modelled,
      mag: decoded.mag.modelled,
      magKind: decoded.mag.kind,
      gyroDetectedFlagsRaw: decoded.gyroDetectedFlagsRaw,
      gyroEnabledBitmaskRaw: decoded.gyroEnabledBitmaskRaw,
      magCustom: decoded.magCustom,
      accMirrorsGyro: decoded.accMirrorsGyro,
    }).toEqual({
      gyro: 'CW90_DEG',
      acc: 'CW90_DEG',
      mag: 'ALIGN_CUSTOM',
      magKind: 'CUSTOM',
      gyroDetectedFlagsRaw: 0b11,
      gyroEnabledBitmaskRaw: 0b01,
      magCustom: {
        rollDecidegrees: 100,
        pitchDecidegrees: -900,
        yawDecidegrees: 1800,
      },
      accMirrorsGyro: true,
    });
  });

  it('reads byte 3 as DETECTED flags and byte 4 as the ENABLED bitmask', () => {
    // These are two different fields with two different meanings, and the
    // fixture deliberately gives them different values. Reading byte 4 as
    // the detected flags would report one gyro found on a board that
    // found two.
    const decoded = decodeSensorAlignment(READ_FRAME);
    expect(gyroIndicesFromBitmask(decoded.gyroDetectedFlagsRaw)).toEqual([0, 1]);
    expect(gyroIndicesFromBitmask(decoded.gyroEnabledBitmaskRaw)).toEqual([0]);
  });

  it('reads the custom magnetometer angles as signed decidegrees', () => {
    // sensorAlignment_t is int16_t[3], "values are in DECIDEGREES, and
    // should be limited to +/- 3600". Read unsigned, -900 comes back as
    // 64636 - a magnetometer rotated 6463.6 degrees.
    const decoded = decodeSensorAlignment(READ_FRAME);
    expect(decoded.magCustom.pitchDecidegrees).toBe(-900);
    expect(decoded.magCustom.pitchDecidegrees).toBeLessThan(0);
  });

  it('keeps the decidegrees integral rather than converting to degrees', () => {
    const decoded = decodeSensorAlignment(READ_FRAME);
    for (const value of Object.values(decoded.magCustom)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('refuses a ten-byte frame, because pre-1.47 byte 4 is a different field', () => {
    // Below API 1.47 this command answered with seven bytes whose byte 4
    // was gyro_to_use, a selection INDEX, not an enable BITMASK. Reading
    // an index as a mask silently changes which gyros a board runs.
    expect(() =>
      decodeSensorAlignment(READ_FRAME.slice(0, 10)),
    ).toThrow(/needs 11 bytes at API 1\.47/);
    expect(SENSOR_ALIGNMENT_PAYLOAD_BYTES).toBe(11);
  });

  it('reports when the accelerometer byte does not mirror the gyro byte', () => {
    // The firmware writes byte 0 twice today. That is an implementation
    // detail of one revision, not a protocol guarantee, so the second
    // byte is measured rather than assumed.
    const divergent = bytes(
      0x02, 0x04, 0x09, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    );
    const decoded = decodeSensorAlignment(divergent);
    expect({
      gyro: decoded.gyro.modelled,
      acc: decoded.acc.modelled,
      accMirrorsGyro: decoded.accMirrorsGyro,
    }).toEqual({
      gyro: 'CW90_DEG',
      acc: 'CW270_DEG',
      accMirrorsGyro: false,
    });
  });

  it('models the alignment enum without inventing values', () => {
    expect([
      modelSensorAlignment(0),
      modelSensorAlignment(1),
      modelSensorAlignment(9),
      modelSensorAlignment(10),
    ]).toEqual([
      {raw: 0, modelled: 'ALIGN_DEFAULT', kind: 'DEFAULT'},
      {raw: 1, modelled: 'CW0_DEG', kind: 'ROTATION'},
      {raw: 9, modelled: 'ALIGN_CUSTOM', kind: 'CUSTOM'},
      {raw: 10, modelled: 'UNKNOWN(10)', kind: 'UNKNOWN'},
    ]);
  });
});

describe('encodeSensorAlignment', () => {
  it('builds the four-byte frame with the enabled bitmask at offset 3', () => {
    expect(
      list(
        encodeSensorAlignment({
          magAlignmentRaw: 9,
          gyroEnabledBitmaskRaw: 0b01,
        }),
      ),
    ).toEqual([0x00, 0x00, 0x09, 0x01]);
  });

  it('builds the ten-byte frame with signed custom angles', () => {
    expect(
      list(
        encodeSensorAlignment({
          magAlignmentRaw: 9,
          gyroEnabledBitmaskRaw: 0b01,
          magCustomDecidegrees: {
            rollDecidegrees: 100,
            pitchDecidegrees: -900,
            yawDecidegrees: 1800,
          },
        }),
      ),
    ).toEqual([0x00, 0x00, 0x09, 0x01, 0x64, 0x00, 0x7c, 0xfc, 0x08, 0x07]);
  });

  it('does not let a decoded READ be echoed back as a WRITE', () => {
    // THE ASYMMETRY, STATED AS A TEST. On the read, byte 3 is the
    // DETECTED gyro flags and byte 4 is the ENABLED bitmask. On the
    // write, byte 3 IS the enabled bitmask. Our fixture board found two
    // gyros and runs one. A naive echo of the read frame therefore puts
    // 0b11 into the enable mask and starts the second gyro.
    const observed = decodeSensorAlignment(
      bytes(0x02, 0x02, 0x09, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00),
    );
    const correct = encodeSensorAlignment({
      magAlignmentRaw: observed.mag.raw,
      gyroEnabledBitmaskRaw: observed.gyroEnabledBitmaskRaw,
    });
    expect(correct[3]).toBe(0b01);
    // What an echo of the read's own byte 3 would have sent instead:
    expect(observed.gyroDetectedFlagsRaw).toBe(0b11);
    expect(correct[3]).not.toBe(observed.gyroDetectedFlagsRaw);
  });

  it('zeroes the two bytes the firmware reads and discards', () => {
    const frame = encodeSensorAlignment({
      magAlignmentRaw: 2,
      gyroEnabledBitmaskRaw: 3,
    });
    expect([frame[0], frame[1]]).toEqual([0, 0]);
  });

  it('refuses custom angles outside the +/-3600 decidegree limit', () => {
    expect(() =>
      encodeSensorAlignment({
        magAlignmentRaw: 9,
        gyroEnabledBitmaskRaw: 1,
        magCustomDecidegrees: {
          rollDecidegrees: 3601,
          pitchDecidegrees: 0,
          yawDecidegrees: 0,
        },
      }),
    ).toThrow(/\+\/-3600/);
    expect(() =>
      encodeSensorAlignment({
        magAlignmentRaw: 9,
        gyroEnabledBitmaskRaw: 1,
        magCustomDecidegrees: {
          rollDecidegrees: 0,
          pitchDecidegrees: -3601,
          yawDecidegrees: 0,
        },
      }),
    ).toThrow(/\+\/-3600/);
  });

  it('accepts the exact limits', () => {
    const frame = encodeSensorAlignment({
      magAlignmentRaw: 9,
      gyroEnabledBitmaskRaw: 1,
      magCustomDecidegrees: {
        rollDecidegrees: 3600,
        pitchDecidegrees: -3600,
        yawDecidegrees: 0,
      },
    });
    expect(list(frame).slice(4, 8)).toEqual([0x10, 0x0e, 0xf0, 0xf1]);
  });

  it('refuses a byte outside 0..255', () => {
    expect(() =>
      encodeSensorAlignment({magAlignmentRaw: 300, gyroEnabledBitmaskRaw: 1}),
    ).toThrow(/must be an integer in 0\.\.255/);
  });
});

/* ================================================================ *
 * MSP2_SENSOR_CONFIG_ACTIVE (0x300A)
 * ================================================================ */

describe('decodeSensorConfigActive', () => {
  // gyro 18, acc 17, baro 10, mag 9, rangefinder 0, opticalflow 0xFF.
  // 18 and 17 are the SAME physical part (IIM42653) at different indices
  // on the two lists - the clearest possible demonstration that the acc
  // and gyro enums are not interchangeable.
  const FRAME = bytes(0x12, 0x11, 0x0a, 0x09, 0x00, 0xff);

  it('decodes six bytes in sensorIndex_e order, each with its own family table', () => {
    const decoded = decodeSensorConfigActive(FRAME);
    expect({
      gyro: decoded.gyro === SENSOR_NOT_AVAILABLE ? decoded.gyro : decoded.gyro.modelled,
      acc: decoded.acc === SENSOR_NOT_AVAILABLE ? decoded.acc : decoded.acc.modelled,
      baro: decoded.baro === SENSOR_NOT_AVAILABLE ? decoded.baro : decoded.baro.modelled,
      mag: decoded.mag === SENSOR_NOT_AVAILABLE ? decoded.mag : decoded.mag.modelled,
      rangefinder:
        decoded.rangefinder === SENSOR_NOT_AVAILABLE
          ? decoded.rangefinder
          : decoded.rangefinder.modelled,
      opticalflow: decoded.opticalflow,
      trailingByteCount: decoded.trailingByteCount,
    }).toEqual({
      gyro: 'GYRO_IIM42653',
      acc: 'ACC_IIM42653',
      baro: 'BARO_LPS22DF',
      mag: 'MAG_IST8310',
      rangefinder: 'RANGEFINDER_NONE',
      opticalflow: SENSOR_NOT_AVAILABLE,
      trailingByteCount: 0,
    });
  });

  it('treats 0xFF as "this build has no such sensor", not as a hardware index', () => {
    const decoded = decodeSensorConfigActive(FRAME);
    expect(decoded.opticalflow).toBe(SENSOR_NOT_AVAILABLE);
  });

  it('reads a bare board correctly even though "nothing found" is 0 on three fields and 1 on three others', () => {
    // detectedSensors[] is initialised to
    //   { GYRO_NONE, ACC_NONE, BARO_NONE, MAG_NONE,
    //     RANGEFINDER_NONE, OPTICALFLOW_NONE }
    // and those constants are 0, 1, 1, 1, 0, 0. One shared rule would
    // report half of this board as fitted.
    const bare = bytes(0x00, 0x01, 0x01, 0x01, 0x00, 0x00);
    const decoded = decodeSensorConfigActive(bare);
    const kinds = [
      decoded.gyro,
      decoded.acc,
      decoded.baro,
      decoded.mag,
      decoded.rangefinder,
      decoded.opticalflow,
    ].map(value => (value === SENSOR_NOT_AVAILABLE ? value : value.kind));
    expect(kinds).toEqual(['NONE', 'NONE', 'NONE', 'NONE', 'NONE', 'NONE']);
  });

  it('names the same byte differently for the gyro and the accelerometer', () => {
    const decoded = decodeSensorConfigActive(
      bytes(0x04, 0x04, 0x01, 0x01, 0x00, 0x00),
    );
    expect([
      decoded.gyro === SENSOR_NOT_AVAILABLE ? decoded.gyro : decoded.gyro.modelled,
      decoded.acc === SENSOR_NOT_AVAILABLE ? decoded.acc : decoded.acc.modelled,
    ]).toEqual(['GYRO_MPU6000', 'ACC_MPU6500']);
  });

  it('refuses a five-byte frame as truncation', () => {
    expect(() => decodeSensorConfigActive(FRAME.slice(0, 5))).toThrow(
      /needs 6 bytes/,
    );
  });

  it('records a seventh byte rather than dropping it silently', () => {
    const decoded = decodeSensorConfigActive(bytes(0x12, 0x11, 0x0a, 0x09, 0x00, 0x01, 0x03));
    expect(decoded.trailingByteCount).toBe(1);
  });
});

/* ================================================================ *
 * MSP2_GYRO_SENSOR_ACTIVE (0x300D)
 * ================================================================ */

describe('decodeGyroSensorActive', () => {
  it('decodes a dual-gyro board from a count byte and two hardware bytes', () => {
    const decoded = decodeGyroSensorActive(bytes(0x02, 0x12, 0x13));
    expect(decoded).toEqual({
      kind: 'REPORTED',
      declaredCount: 2,
      gyros: [
        {raw: 0x12, modelled: 'GYRO_IIM42653', kind: 'KNOWN'},
        {raw: 0x13, modelled: 'GYRO_ICM45605', kind: 'KNOWN'},
      ],
      trailingByteCount: 0,
    });
  });

  it('treats an empty payload as "no gyro support in this build", not as a count of zero', () => {
    // The whole handler body sits inside #ifdef USE_GYRO with no #else,
    // so a build without gyro support writes nothing at all.
    expect(decodeGyroSensorActive(new Uint8Array(0))).toEqual({
      kind: 'NOT_AVAILABLE_IN_THIS_CONTRACT',
    });
  });

  it('reads an empty slot as GYRO_NONE, because the gyro list starts at NONE', () => {
    const decoded = decodeGyroSensorActive(bytes(0x02, 0x12, 0x00));
    expect(decoded.kind === 'REPORTED' && decoded.gyros[1]).toEqual({
      raw: 0,
      modelled: 'GYRO_NONE',
      kind: 'NONE',
    });
  });

  it('refuses a count that promises more bytes than arrived', () => {
    // Returning the one slot that fitted would report a two-gyro board as
    // a one-gyro board.
    expect(() => decodeGyroSensorActive(bytes(0x02, 0x12))).toThrow(
      /declared 2 gyro slot\(s\) but only 1 byte/,
    );
  });

  it('records bytes past the declared count', () => {
    const decoded = decodeGyroSensorActive(bytes(0x01, 0x12, 0x99));
    expect(decoded.kind === 'REPORTED' && decoded.trailingByteCount).toBe(1);
  });
});

/* ================================================================ *
 * MSP_ACC_TRIM (240) / MSP_SET_ACC_TRIM (239)
 * ================================================================ */

describe('decodeAccTrim', () => {
  it('reads pitch first and roll second', () => {
    // flightDynamicsTrims_def_t declares roll as its FIRST member and
    // pitch second; the MSP handler writes pitch first. Transcribing the
    // struct order swaps a drone's trim axes.
    expect(decodeAccTrim(bytes(0x64, 0x00, 0xc8, 0x00))).toEqual({
      pitch: 100,
      roll: 200,
      trailingByteCount: 0,
    });
  });

  it('reads negative trims as negative', () => {
    // 0xFF9C = 65436 unsigned, -100 signed. 0xFF38 = 65336, -200.
    expect(decodeAccTrim(bytes(0x9c, 0xff, 0x38, 0xff))).toEqual({
      pitch: -100,
      roll: -200,
      trailingByteCount: 0,
    });
  });

  it('refuses a three-byte frame, because a missing roll is not a roll of zero', () => {
    expect(() => decodeAccTrim(bytes(0x64, 0x00, 0xc8))).toThrow(/needs 4 bytes/);
  });

  it('stays correct when a newer firmware appends a field', () => {
    expect(decodeAccTrim(bytes(0x64, 0x00, 0xc8, 0x00, 0x00, 0x00))).toEqual({
      pitch: 100,
      roll: 200,
      trailingByteCount: 2,
    });
  });

  it('covers the whole signed 16-bit boundary', () => {
    // The u16-to-int16 reinterpretation, at the four values that break
    // every naive implementation.
    expect(decodeAccTrim(bytes(0x00, 0x00, 0xff, 0x7f))).toMatchObject({
      pitch: 0,
      roll: 32767,
    });
    expect(decodeAccTrim(bytes(0x00, 0x80, 0xff, 0xff))).toMatchObject({
      pitch: -32768,
      roll: -1,
    });
  });
});

describe('encodeAccTrim', () => {
  it('writes pitch first and roll second', () => {
    expect(list(encodeAccTrim({pitch: 100, roll: 200}))).toEqual([
      0x64, 0x00, 0xc8, 0x00,
    ]);
  });

  it('writes negative trims in two-s-complement bytes', () => {
    expect(list(encodeAccTrim({pitch: -100, roll: -200}))).toEqual([
      0x9c, 0xff, 0x38, 0xff,
    ]);
  });

  it('accepts the exact CLI limits and refuses one step past them', () => {
    // The MSP handler does NOT clamp - it stores whatever arrives. The
    // {-300, 300} range lives only in the CLI settings table, so this
    // encoder is the only thing standing between an operator and an
    // illegal trim.
    expect(list(encodeAccTrim({pitch: 300, roll: -300}))).toEqual([
      0x2c, 0x01, 0xd4, 0xfe,
    ]);
    expect(() => encodeAccTrim({pitch: 301, roll: 0})).toThrow(/\+\/-300/);
    expect(() => encodeAccTrim({pitch: 0, roll: -301})).toThrow(/\+\/-300/);
  });

  it('refuses a fractional trim rather than rounding one', () => {
    expect(() => encodeAccTrim({pitch: 10.5, roll: 0})).toThrow(/whole number/);
  });
});

/* ================================================================ *
 * MSP_COMPASS_CONFIG (133) / MSP_SET_COMPASS_CONFIG (224)
 * ================================================================ */

describe('decodeCompassConfig', () => {
  it('reads a western declination as a negative number of decidegrees', () => {
    // 0xFFCE = 65486 unsigned, -50 signed: -5.0 degrees.
    expect(decodeCompassConfig(bytes(0xce, 0xff))).toEqual({
      magDeclinationDecidegrees: -50,
      trailingByteCount: 0,
    });
  });

  it('keeps the wire unit, without dividing into degrees', () => {
    // The reference client divides by ten inside its parser and carries a
    // float from there. Dividing at the wire layer loses the exact stored
    // value and puts a float where a frame gets rebuilt later.
    const decoded = decodeCompassConfig(bytes(0xce, 0xff));
    expect(Number.isInteger(decoded.magDeclinationDecidegrees)).toBe(true);
    expect(Object.keys(decoded)).not.toContain('magDeclinationDegrees');
  });

  it('reads the positive limit', () => {
    expect(decodeCompassConfig(bytes(0x2c, 0x01)).magDeclinationDecidegrees).toBe(
      300,
    );
  });

  it('refuses a one-byte frame', () => {
    expect(() => decodeCompassConfig(bytes(0xce))).toThrow(/needs 2 bytes/);
  });

  it('stays correct when a newer firmware appends a field', () => {
    expect(decodeCompassConfig(bytes(0xce, 0xff, 0x07))).toEqual({
      magDeclinationDecidegrees: -50,
      trailingByteCount: 1,
    });
  });
});

describe('encodeCompassConfig', () => {
  it('writes a negative declination in two-s-complement bytes', () => {
    expect(list(encodeCompassConfig({magDeclinationDecidegrees: -50}))).toEqual([
      0xce, 0xff,
    ]);
  });

  it('accepts the exact CLI limits and refuses one step past them', () => {
    expect(list(encodeCompassConfig({magDeclinationDecidegrees: 300}))).toEqual([
      0x2c, 0x01,
    ]);
    expect(list(encodeCompassConfig({magDeclinationDecidegrees: -300}))).toEqual([
      0xd4, 0xfe,
    ]);
    expect(() => encodeCompassConfig({magDeclinationDecidegrees: 301})).toThrow(
      /\+\/-300/,
    );
  });

  it('refuses a fractional declination rather than rounding one', () => {
    expect(() => encodeCompassConfig({magDeclinationDecidegrees: -50.5})).toThrow(
      /whole number/,
    );
  });
});

/* ================================================================ *
 * CROSS-CONTRACT: THE STATUS SENSOR MASK
 * ================================================================ */

describe('the MSP_STATUS_EX sensor mask bit order', () => {
  it('is ACC, BARO, MAG, GPS, RANGEFINDER, GYRO, OPTICALFLOW - not sensors_e order', () => {
    // The firmware repacks its internal enum before putting it on the
    // wire: `sensors(SENSOR_ACC) | sensors(SENSOR_BARO) << 1 |
    // sensors(SENSOR_MAG) << 2 | sensors(SENSOR_GPS) << 3 |
    // sensors(SENSOR_RANGEFINDER) << 4 | sensors(SENSOR_GYRO) << 5 |
    // sensors(SENSOR_OPTICALFLOW) << 6`. The internal sensors_e is a
    // different order entirely - GYRO is 1<<0 there and 1<<5 here - so
    // reading the wire with the internal enum reports a board's
    // accelerometer state as its gyro state.
    expect(SENSOR_PRESENCE_TOKENS).toEqual([
      'ACC',
      'BARO',
      'MAG',
      'GPS',
      'RANGEFINDER',
      'GYRO',
      'OPTICALFLOW',
    ]);
  });

  it('agrees with the GPS bit the status decoder already publishes', () => {
    expect(1 << SENSOR_PRESENCE_TOKENS.indexOf('GPS')).toBe(STATUS_SENSOR_GPS_BIT);
  });

  it('survives a round trip through the real status decoder', () => {
    // A hand-written MSP_STATUS_EX prefix with only the gyro bit set
    // (1 << 5 = 0x20). Anything that read the mask with sensors_e order
    // would see the accelerometer.
    const statusEx = bytes(
      0xe8, 0x03, // cycle time 1000us
      0x00, 0x00, // i2c errors
      0x20, 0x00, // sensor mask: GYRO only
      0x00, 0x00, 0x00, 0x00, // flight mode flags
      0x00, // pid profile
      0x0a, 0x00, // cpu load 10%
    );
    const mask = decodeStatusEx(statusEx).sensorPresenceMask;
    expect(mask & (1 << SENSOR_PRESENCE_TOKENS.indexOf('GYRO'))).not.toBe(0);
    expect(mask & (1 << SENSOR_PRESENCE_TOKENS.indexOf('ACC'))).toBe(0);
  });
});
