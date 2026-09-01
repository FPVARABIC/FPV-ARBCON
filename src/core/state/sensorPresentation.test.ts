/**
 * THE SENSOR PRESENTATION LAYER: KEYS ONLY, AND A VOCABULARY THAT
 * CANNOT GROW A HEALTH SCORE.
 *
 * This module decides what an operator is told about a sensor. It emits
 * i18n keys and never Arabic, so the assertions here are about keys and
 * about numbers - the two things that can be wrong without a translator
 * noticing.
 *
 * SENSORS B-4 §6 is the reason for the last describe block: "no fake
 * health" is a rule that a later pass could break in one line, so the
 * rule is a test rather than a comment.
 */

import fs from 'fs';
import path from 'path';

import {
  ACC_TRIM_LIMIT,
  DECLINATION_DECIDEGREE_LIMIT,
  SENSOR_DISPLAY_ORDER,
  accTrimText,
  calibrationBlock,
  calibrationOutcomeSeverity,
  declinationDegreesText,
  describeCalibrationOutcome,
  describeConfigured,
  describeDetected,
  describeHeadline,
  describeMismatchPair,
  describePresent,
  editableHardwareFamilies,
  elapsedSecondsText,
  hardwareOptions,
  parseDeclinationDegrees,
  sensorFamilyLabelKey,
  sensorRowVisible,
  LIVE_VECTOR_UNIT_KEYS,
} from './sensorPresentation';
import {deriveSensorTruth} from './sensorTruthSemantics';
import {decodeSensorConfig} from '../protocol/msp/decoding/decodeSensorConfig';
import {decodeSensorConfigActive} from '../protocol/msp/decoding/decodeSensorConfigActive';

const PRESENT_ACC = 1;
const PRESENT_MAG = 4;
const PRESENT_GYRO = 32;

function truthOf(
  family: Parameters<typeof deriveSensorTruth>[0],
  options: {
    configuredBytes?: number[];
    detectedBytes?: number[];
    presenceMask?: number;
  } = {},
) {
  return deriveSensorTruth(family, {
    configured:
      options.configuredBytes === undefined
        ? undefined
        : decodeSensorConfig(Uint8Array.from(options.configuredBytes)),
    detected:
      options.detectedBytes === undefined
        ? undefined
        : decodeSensorConfigActive(Uint8Array.from(options.detectedBytes)),
    presenceMask: options.presenceMask,
  });
}

describe('the three answers each get their own sentence', () => {
  it('a DEFAULT configuration is named as such, not resolved into a part', () => {
    const truth = truthOf('ACC', {configuredBytes: [0, 0, 0]});
    expect(describeConfigured(truth).key).toBe('sensorsScreen.configured.default');
  });

  it('a family NONE is disabled by configuration, and the headline agrees', () => {
    const truth = truthOf('ACC', {configuredBytes: [1, 0, 0], presenceMask: PRESENT_ACC});
    expect(describeConfigured(truth).key).toBe('sensorsScreen.configured.disabled');
    expect(describeHeadline(truth).key).toBe('sensorsScreen.headline.disabled');
  });

  it('an unknown index carries its raw number into the phrase parameters', () => {
    const truth = truthOf('BARO', {configuredBytes: [0, 99, 0]});
    const phrase = describeConfigured(truth);
    expect(phrase.key).toBe('sensorsScreen.hardware.unknown');
    expect(phrase.params).toEqual({raw: 99});
  });

  it('presence and detection are separate phrases even when they agree', () => {
    const truth = truthOf('ACC', {
      configuredBytes: [0, 0, 0],
      detectedBytes: [2, 2, 3, 4, 0, 0],
      presenceMask: PRESENT_ACC,
    });
    expect(describeDetected(truth).key).toBe('sensorsScreen.hardware.part');
    expect(describePresent(truth).key).toBe('sensorsScreen.present.yes');
  });

  it('a mismatch pair names the stored value AND the found one', () => {
    const truth = truthOf('ACC', {
      configuredBytes: [2, 0, 0],
      detectedBytes: [2, 5, 3, 4, 0, 0],
      presenceMask: PRESENT_ACC,
    });
    const pair = describeMismatchPair(truth);
    expect(pair).toBeDefined();
    expect(pair?.stored.key).toBe('sensorsScreen.hardware.part');
    expect(pair?.found.key).toBe('sensorsScreen.hardware.part');
    expect(pair?.stored.params).not.toEqual(pair?.found.params);
  });

  it('a family with nothing to say is not given a row', () => {
    // Never read, never detected, never reported present.
    expect(sensorRowVisible(truthOf('OPTICALFLOW'))).toBe(false);
    expect(
      sensorRowVisible(truthOf('GYRO', {presenceMask: PRESENT_GYRO})),
    ).toBe(true);
  });

  it('the display order is fixed, so the page never reshuffles between reads', () => {
    expect([...SENSOR_DISPLAY_ORDER]).toEqual([...SENSOR_DISPLAY_ORDER].slice());
    expect(SENSOR_DISPLAY_ORDER.length).toBeGreaterThan(0);
    for (const family of SENSOR_DISPLAY_ORDER) {
      expect(sensorFamilyLabelKey(family)).toBe(`sensorsScreen.family.${family}`);
    }
  });
});

describe('the numbers are the firmware\'s numbers', () => {
  it('declination is decidegrees in and degrees out, signed, to one place', () => {
    expect(declinationDegreesText(-50)).toBe('-5.0');
    expect(declinationDegreesText(0)).toBe('0.0');
    expect(declinationDegreesText(295)).toBe('29.5');
  });

  it('a typed declination round-trips back to decidegrees', () => {
    expect(parseDeclinationDegrees('-5.0')).toBe(-50);
    expect(parseDeclinationDegrees('29.5')).toBe(295);
  });

  it('a declination past the firmware limit is refused rather than clamped', () => {
    expect(DECLINATION_DECIDEGREE_LIMIT).toBe(300);
    expect(parseDeclinationDegrees('30.1')).toBeUndefined();
    expect(parseDeclinationDegrees('-30.1')).toBeUndefined();
    expect(parseDeclinationDegrees('not a number')).toBeUndefined();
  });

  it('the accelerometer trim is a plain signed integer with the firmware limit', () => {
    expect(ACC_TRIM_LIMIT).toBe(300);
    expect(accTrimText(-300)).toBe('-300');
    expect(accTrimText(0)).toBe('0');
  });

  it('elapsed time is whole seconds and never a percentage', () => {
    expect(elapsedSecondsText(0)).toBe('0');
    expect(elapsedSecondsText(1_999)).toBe('1');
    expect(elapsedSecondsText(-5)).toBe('0');
  });

  it('the accelerometer has no unit the wire can prove, so it is labelled raw counts', () => {
    expect(LIVE_VECTOR_UNIT_KEYS.GYRO).toBe('sensorsScreen.unit.degreesPerSecond');
    expect(LIVE_VECTOR_UNIT_KEYS.ACC).toBe('sensorsScreen.unit.rawCounts');
    expect(LIVE_VECTOR_UNIT_KEYS.MAG).toBe('sensorsScreen.unit.rawCounts');
  });
});

describe('what may be edited follows the board\'s own frame', () => {
  it('a three-byte contract offers three families, a five-byte one offers five', () => {
    expect([...editableHardwareFamilies('ACC_BARO_MAG')]).toEqual(['ACC', 'BARO', 'MAG']);
    expect([...editableHardwareFamilies('ACC_BARO_MAG_RANGEFINDER')]).toEqual([
      'ACC',
      'BARO',
      'MAG',
      'RANGEFINDER',
    ]);
    expect(editableHardwareFamilies('ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW')).toHaveLength(5);
  });

  it('an unknown value the board already holds is offered back, and no other unknown is', () => {
    const offered = hardwareOptions('BARO', 99);
    expect(offered.some(option => option.raw === 99)).toBe(true);
    // 98 is not the board's value and is not modelled: it must not appear.
    expect(offered.some(option => option.raw === 98)).toBe(false);
  });

  it('every offered option carries a key, never a bare number, for its label', () => {
    for (const option of hardwareOptions('ACC', 0)) {
      expect(option.label.key.startsWith('sensorsScreen.')).toBe(true);
    }
  });
});

describe('a calibration block explains itself', () => {
  it('an absent sensor blocks calibration, and says which fact blocks it', () => {
    expect(calibrationBlock(truthOf('MAG', {presenceMask: PRESENT_ACC}), false)).toBe(
      'SENSOR_NOT_PRESENT',
    );
  });

  it('a sensor disabled by configuration is its own block, not a missing sensor', () => {
    expect(
      calibrationBlock(
        truthOf('MAG', {configuredBytes: [0, 0, 1], presenceMask: PRESENT_MAG}),
        false,
      ),
    ).toBe('DISABLED_BY_CONFIGURATION');
  });

  it('a busy screen blocks calibration without claiming anything about the sensor', () => {
    const truth = truthOf('ACC', {configuredBytes: [0, 0, 0], presenceMask: PRESENT_ACC});
    expect(calibrationBlock(truth, true)).toBe('BUSY');
    expect(calibrationBlock(truth, false)).toBeUndefined();
  });

  it('the two success sentences are per sensor; every other outcome describes the observation', () => {
    expect(describeCalibrationOutcome('ACCELEROMETER', 'SUCCEEDED').key).toBe(
      'sensorsScreen.calibration.outcome.SUCCEEDED.ACCELEROMETER',
    );
    expect(describeCalibrationOutcome('MAGNETOMETER', 'SUCCEEDED').key).toBe(
      'sensorsScreen.calibration.outcome.SUCCEEDED.MAGNETOMETER',
    );
    expect(describeCalibrationOutcome('MAGNETOMETER', 'LINK_LOST').key).toBe(
      'sensorsScreen.calibration.outcome.LINK_LOST',
    );
  });

  it('an unconfirmed completion is informational, never an attention-grabbing failure', () => {
    expect(calibrationOutcomeSeverity('COMPLETION_UNCONFIRMED')).toBe('INFORMATION');
    expect(calibrationOutcomeSeverity('TIMED_OUT')).toBe('INFORMATION');
    expect(calibrationOutcomeSeverity('OBSERVATION_CANCELLED')).toBe('INFORMATION');
    expect(calibrationOutcomeSeverity('SUCCEEDED')).toBe('SUCCESS');
    expect(calibrationOutcomeSeverity('REFUSED_ARMED')).toBe('ATTENTION');
  });
});

/* ================================================================== *
 * §6 - THE RULE THAT CANNOT BE RE-ADDED QUIETLY
 * ================================================================== */

describe('no sensor surface may grow a health verdict', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const FILES = [
    'src/core/state/sensorPresentation.ts',
    'src/core/state/sensorTruthSemantics.ts',
    'src/ui/screens/SensorsScreen.tsx',
  ];

  /**
   * The vocabulary a health verdict needs. Each one is a WORD a later
   * pass would reach for while adding "is this sensor OK" - which is the
   * question the firmware never answers and this application therefore
   * never asks. Configured, detected and present are three facts; a
   * fourth value derived from them would be an opinion.
   */
  const FORBIDDEN: readonly {readonly name: string; readonly pattern: RegExp}[] = [
    {name: 'a health field or function', pattern: /\bhealth\w*\s*[:(=]/i},
    {name: 'an is-ok predicate', pattern: /\b(is|sensor)Ok\w*\s*[:(=]/i},
    {name: 'a verdict literal', pattern: /'(HEALTHY|UNHEALTHY|FAULTY|GOOD|BAD|OK)'/},
    {name: 'a score', pattern: /\bscore\w*\s*[:(=]/i},
  ];

  /** CODE only. A comment saying "there is deliberately no health verdict
   *  here" is the rule being explained, not the rule being broken - so
   *  comments are stripped before the check rather than counted by it. */
  function code(file: string): string {
    return fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
  }

  it.each(FILES.map(file => [file] as const))(
    '%s declares no health verdict, predicate or score',
    file => {
      const source = code(file);
      const found = FORBIDDEN.filter(rule => rule.pattern.test(source)).map(
        rule => rule.name,
      );
      expect(`${file}: ${found.join(', ')}`).toBe(`${file}: `);
    },
  );

  it('the guard would object to a health field, so it is not decoration', () => {
    const offending = "const truth = {family, health: 'GOOD', score: 3};";
    expect(FORBIDDEN.filter(rule => rule.pattern.test(offending)).length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('the truth model exposes exactly three answers plus contradictions, and nothing derived', () => {
    const truth = truthOf('ACC', {
      configuredBytes: [0, 0, 0],
      detectedBytes: [2, 2, 3, 4, 0, 0],
      presenceMask: PRESENT_ACC,
    });
    expect(Object.keys(truth).sort()).toEqual([
      'configured',
      'contradictions',
      'detected',
      'family',
      'present',
    ]);
  });

  it('the Arabic vocabulary a sensor state may use is the closed list, and nothing else', () => {
    const ar = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src/i18n/locales/ar.json'), 'utf8'),
    ) as {sensorsScreen: {headline: Record<string, string>; present: Record<string, string>}};
    const allowed = [
      'مضبوط',
      'مكتشف',
      'حاضر',
      'غير موجود',
      'معطّل',
      'غير معروف',
      'لا توجد قراءة',
      'اكتُشف عند الإقلاع، لكنه غير حاضر الآن',
      'المستشعر حاضر، لكن نوع العتاد غير معروف لهذا الإصدار',
      'معطّل من الإعدادات',
    ];
    for (const sentence of Object.values(ar.sensorsScreen.headline)) {
      expect([sentence, allowed.some(word => sentence.includes(word))]).toEqual([
        sentence,
        true,
      ]);
    }
    for (const sentence of Object.values(ar.sensorsScreen.present)) {
      expect([sentence, allowed.some(word => sentence.includes(word))]).toEqual([
        sentence,
        true,
      ]);
    }
  });
});
