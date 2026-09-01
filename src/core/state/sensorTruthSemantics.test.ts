/**
 * CONFIGURED, DETECTED AND PRESENT - AND WHAT HAPPENS WHEN THEY DISAGREE.
 *
 * Every input below is built by running the real B-1 decoders over
 * hand-written bytes, so the semantic layer is exercised through the same
 * path a flight controller would drive it through, and no fixture asserts
 * a semantic outcome that a wire fixture did not actually produce.
 *
 * The six lettered scenarios are the six ways the three sources can
 * contradict each other. Each one is a real board configuration somebody
 * could hand us, not an abstract permutation.
 */

import {decodeSensorConfig} from '../protocol/msp/decoding/decodeSensorConfig';
import {decodeSensorConfigActive} from '../protocol/msp/decoding/decodeSensorConfigActive';
import {
  deriveSensorTruth,
  deriveSensorTruthSet,
  sensorPresenceBitIndex,
  sensorsWithContradictions,
  SENSOR_TRUTH_FAMILIES,
  type SensorObservation,
} from './sensorTruthSemantics';
import {STATUS_SENSOR_GPS_BIT} from '../protocol/msp/decoding/decodeStatusEx';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

/** Wire bit positions, spelled out so a fixture reads as a board state. */
const ACC_BIT = 1 << 0;
const BARO_BIT = 1 << 1;
const MAG_BIT = 1 << 2;
const GPS_BIT = 1 << 3;
const RANGEFINDER_BIT = 1 << 4;
const GYRO_BIT = 1 << 5;
const OPTICALFLOW_BIT = 1 << 6;

/**
 * A perfectly ordinary five-inch quad: accelerometer and gyro on an
 * ICM42688P, a DPS310 barometer, no magnetometer, no rangefinder, no
 * optical flow, no GPS.
 *
 *   configured  acc DEFAULT(0), baro DEFAULT(0), mag NONE(1),
 *               rangefinder NONE(0), opticalflow NONE(0)
 *   detected    gyro ICM42688P(13), acc ICM42688P(12), baro DPS310(8),
 *               mag NONE(1), rangefinder NONE(0), opticalflow NONE(0)
 *   present     acc, baro, gyro
 */
const ORDINARY_QUAD: SensorObservation = {
  configured: decodeSensorConfig(bytes(0x00, 0x00, 0x01, 0x00, 0x00)),
  detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x08, 0x01, 0x00, 0x00)),
  presenceMask: ACC_BIT | BARO_BIT | GYRO_BIT,
};

describe('the shape of the answer', () => {
  it('reports all seven families', () => {
    const truth = deriveSensorTruthSet(ORDINARY_QUAD);
    expect(Object.keys(truth).sort()).toEqual(
      [...SENSOR_TRUTH_FAMILIES].sort(),
    );
  });

  it('never returns a health field, under any name', () => {
    // None of the three sources measures whether a sensor works. A
    // derived "healthy" would be a guess dressed as a measurement, and an
    // operator who trusts it arms an aircraft.
    const forbidden = /^(healthy|health|ok|working|good|status|state|fault|faulty|broken)$/i;
    const truthSet = deriveSensorTruthSet(ORDINARY_QUAD);
    for (const family of SENSOR_TRUTH_FAMILIES) {
      const truth = truthSet[family];
      for (const key of Object.keys(truth)) {
        expect(key).not.toMatch(forbidden);
      }
      for (const branch of [truth.configured, truth.detected, truth.present]) {
        for (const key of Object.keys(branch)) {
          expect(key).not.toMatch(forbidden);
        }
      }
    }
  });

  it('takes the presence bit order from the one table that owns it', () => {
    expect({
      ACC: sensorPresenceBitIndex('ACC'),
      BARO: sensorPresenceBitIndex('BARO'),
      MAG: sensorPresenceBitIndex('MAG'),
      GPS: sensorPresenceBitIndex('GPS'),
      RANGEFINDER: sensorPresenceBitIndex('RANGEFINDER'),
      GYRO: sensorPresenceBitIndex('GYRO'),
      OPTICALFLOW: sensorPresenceBitIndex('OPTICALFLOW'),
    }).toEqual({
      ACC: 0,
      BARO: 1,
      MAG: 2,
      GPS: 3,
      RANGEFINDER: 4,
      GYRO: 5,
      OPTICALFLOW: 6,
    });
    expect(1 << sensorPresenceBitIndex('GPS')).toBe(STATUS_SENSOR_GPS_BIT);
  });
});

describe('an ordinary quad produces no contradictions', () => {
  it('agrees on every family', () => {
    expect(sensorsWithContradictions(deriveSensorTruthSet(ORDINARY_QUAD))).toEqual(
      [],
    );
  });

  it('keeps DEFAULT and the detected part side by side rather than merging them', () => {
    // "Detect it for me" plus "an ICM42688P was found" is agreement. The
    // setting stays the setting because a later write needs the setting,
    // not the outcome.
    const acc = deriveSensorTruth('ACC', ORDINARY_QUAD);
    expect(acc.configured).toEqual({kind: 'DEFAULT'});
    expect(acc.detected).toEqual({
      kind: 'DETECTED',
      hardware: {raw: 12, modelled: 'ACC_ICM42688P', kind: 'KNOWN'},
    });
    expect(acc.contradictions).toEqual([]);
  });

  it('treats a deliberately disabled magnetometer as configuration, not as a fault', () => {
    const mag = deriveSensorTruth('MAG', ORDINARY_QUAD);
    expect(mag.configured).toEqual({kind: 'DISABLED_BY_CONFIGURATION'});
    expect(mag.detected).toEqual({kind: 'NONE_DETECTED'});
    expect(mag.present).toEqual({kind: 'ABSENT'});
    expect(mag.contradictions).toEqual([]);
  });
});

describe('sources this protocol simply does not have', () => {
  it('says the gyro has no configured byte instead of inventing one', () => {
    // MSP_SENSOR_CONFIG carries acc, baro, mag, rangefinder and optical
    // flow. There is no gyro byte at this revision, in either direction.
    const gyro = deriveSensorTruth('GYRO', ORDINARY_QUAD);
    expect(gyro.configured).toEqual({kind: 'NOT_AVAILABLE_IN_THIS_CONTRACT'});
    expect(gyro.detected).toEqual({
      kind: 'DETECTED',
      hardware: {raw: 13, modelled: 'GYRO_ICM42688P', kind: 'KNOWN'},
    });
    expect(gyro.present).toEqual({kind: 'PRESENT'});
  });

  it('says GPS has neither a configured nor a detected byte', () => {
    const gps = deriveSensorTruth('GPS', ORDINARY_QUAD);
    expect(gps.configured).toEqual({kind: 'NOT_AVAILABLE_IN_THIS_CONTRACT'});
    expect(gps.detected).toEqual({kind: 'NOT_AVAILABLE_IN_THIS_CONTRACT'});
    expect(gps.present).toEqual({kind: 'ABSENT'});
    expect(gps.contradictions).toEqual([]);
  });

  it('separates "the frame was too short" from "the board said none"', () => {
    // A three-byte MSP_SENSOR_CONFIG does not mean "no rangefinder"; it
    // means the board never answered the question.
    const shortFrame: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x00, 0x00, 0x01)),
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x08, 0x01, 0x00, 0x00)),
    };
    expect(deriveSensorTruth('RANGEFINDER', shortFrame).configured).toEqual({
      kind: 'NOT_AVAILABLE_IN_THIS_CONTRACT',
    });
    expect(deriveSensorTruth('MAG', shortFrame).configured).toEqual({
      kind: 'DISABLED_BY_CONFIGURATION',
    });
  });

  it('separates "not read yet" from every answer a board can give', () => {
    const nothingRead = deriveSensorTruthSet({});
    for (const family of SENSOR_TRUTH_FAMILIES) {
      expect(nothingRead[family]).toEqual({
        family,
        configured: {kind: 'NOT_OBSERVED'},
        detected: {kind: 'NOT_OBSERVED'},
        present: {kind: 'NOT_OBSERVED'},
        contradictions: [],
      });
    }
  });
});

/* ================================================================ *
 * THE SIX CONTRADICTIONS
 * ================================================================ */

describe('scenario A - configured off, but the board reports it present', () => {
  it('names the disagreement without calling either side wrong', () => {
    // Somebody set mag_hardware to MAG_NONE, and the firmware still
    // counts the magnetometer subsystem as available. One of those two
    // statements is stale; nothing here can tell which.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x00, 0x00, 0x01, 0x00, 0x00)),
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x08, 0x09, 0x00, 0x00)),
      presenceMask: ACC_BIT | BARO_BIT | MAG_BIT | GYRO_BIT,
    };
    const mag = deriveSensorTruth('MAG', observation);
    expect(mag.configured).toEqual({kind: 'DISABLED_BY_CONFIGURATION'});
    expect(mag.present).toEqual({kind: 'PRESENT'});
    expect(mag.contradictions).toContain('CONFIGURED_OFF_BUT_REPORTED_PRESENT');
  });
});

describe('scenario B - configured on, but nothing was detected', () => {
  it('reports it when the request was DEFAULT', () => {
    // baro_hardware is BARO_DEFAULT ("go and find one") and boot probing
    // came back with BARO_NONE. The most common real fault on a board
    // with a dead barometer.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x00, 0x00, 0x01, 0x00, 0x00)),
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x01, 0x01, 0x00, 0x00)),
      presenceMask: ACC_BIT | GYRO_BIT,
    };
    const baro = deriveSensorTruth('BARO', observation);
    expect(baro.configured).toEqual({kind: 'DEFAULT'});
    expect(baro.detected).toEqual({kind: 'NONE_DETECTED'});
    expect(baro.contradictions).toEqual(['CONFIGURED_ON_BUT_NONE_DETECTED']);
  });

  it('reports it when a specific part was pinned', () => {
    // baro_hardware pinned to BARO_DPS310 (8), nothing found.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x00, 0x08, 0x01, 0x00, 0x00)),
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x01, 0x01, 0x00, 0x00)),
      presenceMask: ACC_BIT | GYRO_BIT,
    };
    const baro = deriveSensorTruth('BARO', observation);
    expect(baro.configured).toEqual({
      kind: 'PINNED',
      hardware: {raw: 8, modelled: 'BARO_DPS310', kind: 'KNOWN'},
    });
    expect(baro.contradictions).toEqual(['CONFIGURED_ON_BUT_NONE_DETECTED']);
  });
});

describe('scenario C - detected at boot, but not reported present now', () => {
  it('names it', () => {
    // A DPS310 answered its ID register at startup and the firmware does
    // not count the barometer subsystem as available. Something changed
    // between boot and now, or one of the two reports is stale.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x00, 0x00, 0x01, 0x00, 0x00)),
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x08, 0x01, 0x00, 0x00)),
      presenceMask: ACC_BIT | GYRO_BIT,
    };
    const baro = deriveSensorTruth('BARO', observation);
    expect(baro.detected).toEqual({
      kind: 'DETECTED',
      hardware: {raw: 8, modelled: 'BARO_DPS310', kind: 'KNOWN'},
    });
    expect(baro.present).toEqual({kind: 'ABSENT'});
    expect(baro.contradictions).toEqual(['DETECTED_BUT_NOT_REPORTED_PRESENT']);
  });
});

describe('scenario D - present, on a firmware built without that sensor', () => {
  it('keeps 0xFF as its own fact rather than folding it into "none"', () => {
    // The optical-flow byte is SENSOR_NOT_AVAILABLE, which means the
    // firmware has no optical-flow support compiled in at all - and the
    // status mask has the optical-flow bit set. Those cannot both be
    // true, and collapsing 0xFF into NONE_DETECTED would hide it.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x00, 0x00, 0x01, 0x00, 0x00)),
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x08, 0x01, 0x00, 0xff)),
      presenceMask: ACC_BIT | BARO_BIT | GYRO_BIT | OPTICALFLOW_BIT,
    };
    const flow = deriveSensorTruth('OPTICALFLOW', observation);
    expect(flow.detected).toEqual({kind: 'NOT_SUPPORTED_BY_FIRMWARE_BUILD'});
    expect(flow.present).toEqual({kind: 'PRESENT'});
    // TWO disagreements, both real, both listed. On a build with no
    // optical-flow support the configured byte comes back as
    // OPTICALFLOW_NONE, so this board is ALSO configured off while
    // reporting present. Reporting only the first would leave an operator
    // fixing one of two problems.
    expect(flow.contradictions).toEqual([
      'CONFIGURED_OFF_BUT_REPORTED_PRESENT',
      'REPORTED_PRESENT_BUT_FIRMWARE_HAS_NO_SUPPORT',
    ]);
  });
});

describe('scenario E - a specific part was pinned and a different one was found', () => {
  it('names both sides', () => {
    // acc_hardware pinned to ACC_MPU6000 (3); an ACC_ICM42688P (12) is
    // what actually answered. The board is running hardware the operator
    // did not ask for.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x03, 0x00, 0x01, 0x00, 0x00)),
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x08, 0x01, 0x00, 0x00)),
      presenceMask: ACC_BIT | BARO_BIT | GYRO_BIT,
    };
    const acc = deriveSensorTruth('ACC', observation);
    expect(acc.configured).toEqual({
      kind: 'PINNED',
      hardware: {raw: 3, modelled: 'ACC_MPU6000', kind: 'KNOWN'},
    });
    expect(acc.detected).toEqual({
      kind: 'DETECTED',
      hardware: {raw: 12, modelled: 'ACC_ICM42688P', kind: 'KNOWN'},
    });
    expect(acc.contradictions).toEqual([
      'CONFIGURED_DEVICE_DIFFERS_FROM_DETECTED',
    ]);
  });

  it('never raises it for the gyro, which has no configured byte to compare', () => {
    // This matters more than it looks. The gyro and accelerometer enums
    // are NOT parallel - raw 4 is MPU6000 on one and MPU6500 on the other
    // - so a comparison that reached the gyro by borrowing the
    // accelerometer's configured byte would report a mismatch on a
    // perfectly ordinary board.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x04, 0x00, 0x01, 0x00, 0x00)),
      detected: decodeSensorConfigActive(bytes(0x04, 0x04, 0x08, 0x01, 0x00, 0x00)),
      presenceMask: ACC_BIT | BARO_BIT | GYRO_BIT,
    };
    expect(deriveSensorTruth('GYRO', observation).contradictions).toEqual([]);
    expect(deriveSensorTruth('ACC', observation).contradictions).toEqual([]);
  });
});

describe('scenario F - a detection result that reads as DEFAULT', () => {
  it('surfaces it rather than quietly reinterpreting it', () => {
    // The firmware never writes a DEFAULT index into detectedSensors[] -
    // DEFAULT means "go and look" and by the time that array is filled
    // the looking is over. A byte that models as DEFAULT here is
    // therefore evidence of a fault somewhere upstream, and rewriting it
    // to NONE_DETECTED would destroy that evidence.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x00, 0x00, 0x01, 0x00, 0x00)),
      // baro byte 0 = BARO_DEFAULT, which no working 1.47 board produces.
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x00, 0x01, 0x00, 0x00)),
      presenceMask: ACC_BIT | BARO_BIT | GYRO_BIT,
    };
    const baro = deriveSensorTruth('BARO', observation);
    expect(baro.detected).toEqual({
      kind: 'REPORTED_DEFAULT',
      hardware: {raw: 0, modelled: 'BARO_DEFAULT', kind: 'DEFAULT'},
    });
    expect(baro.contradictions).toEqual(['DETECTION_REPORTED_A_DEFAULT_VALUE']);
  });

  it('reads a gyro byte of 0 as NONE rather than as DEFAULT', () => {
    // The mirror image, and the reason the two cases cannot share a rule.
    // On the gyro list 0 is GYRO_NONE, so a gyro-less board is reported
    // as gyro-less rather than as "running the default gyro".
    const observation: SensorObservation = {
      detected: decodeSensorConfigActive(bytes(0x00, 0x01, 0x01, 0x01, 0x00, 0x00)),
    };
    expect(deriveSensorTruth('GYRO', observation).detected).toEqual({
      kind: 'NONE_DETECTED',
    });
  });
});

describe('unknown hardware indices', () => {
  it('stay UNKNOWN through the semantic layer instead of collapsing to DEFAULT or NONE', () => {
    // OPTICALFLOW_UPT1 = 2 exists on the 1.49 line and not at 1.47. A
    // board reporting it is configured for a real sensor we cannot name;
    // calling it NONE would hide a fitted part, and calling it DEFAULT
    // would invent a setting.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x00, 0x00, 0x01, 0x00, 0x02)),
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x08, 0x01, 0x00, 0x02)),
      presenceMask: ACC_BIT | BARO_BIT | GYRO_BIT | OPTICALFLOW_BIT,
    };
    const flow = deriveSensorTruth('OPTICALFLOW', observation);
    expect(flow.configured).toEqual({
      kind: 'PINNED',
      hardware: {raw: 2, modelled: 'UNKNOWN(2)', kind: 'UNKNOWN'},
    });
    expect(flow.detected).toEqual({
      kind: 'DETECTED',
      hardware: {raw: 2, modelled: 'UNKNOWN(2)', kind: 'UNKNOWN'},
    });
    // The two agree, so an unknown index produces no false mismatch.
    expect(flow.contradictions).toEqual([]);
  });
});

describe('several disagreements at once', () => {
  it('lists every family that has one, in a fixed order', () => {
    // A rangefinder pinned to MTF01 (4) with nothing found, and a GPS bit
    // set on a board whose GPS this protocol cannot describe.
    const observation: SensorObservation = {
      configured: decodeSensorConfig(bytes(0x00, 0x00, 0x01, 0x04, 0x00)),
      detected: decodeSensorConfigActive(bytes(0x0d, 0x0c, 0x01, 0x01, 0x00, 0x00)),
      presenceMask: ACC_BIT | GYRO_BIT | GPS_BIT | RANGEFINDER_BIT,
    };
    const flagged = sensorsWithContradictions(deriveSensorTruthSet(observation));
    expect(flagged.map(entry => entry.family)).toEqual(['BARO', 'RANGEFINDER']);
    expect(flagged.map(entry => [entry.family, ...entry.contradictions])).toEqual([
      ['BARO', 'CONFIGURED_ON_BUT_NONE_DETECTED'],
      ['RANGEFINDER', 'CONFIGURED_ON_BUT_NONE_DETECTED'],
    ]);
    // The GPS bit is set and produces nothing to say, because this
    // protocol offers no configured or detected byte to disagree with it.
    expect(deriveSensorTruth('GPS', observation).present).toEqual({
      kind: 'PRESENT',
    });
    expect(deriveSensorTruth('GPS', observation).contradictions).toEqual([]);
  });
});
