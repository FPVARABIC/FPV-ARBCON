/**
 * THE AUTHORED LAYOUTS, CHECKED AGAINST THE FIRMWARE THEY WERE READ FROM.
 *
 * The coordinates in motorAirframeLayout.ts are the firmware's own mixing
 * coefficients re-expressed as positions (x = -roll, y = +pitch). That
 * derivation is only worth anything if it reproduces the firmware's own
 * per-motor labels, so this file transcribes those labels straight out of
 * mixer_init.c @ 7348054f and derives them again from the stored numbers.
 *
 * The transcription below is the COMMENT COLUMN of those tables, nothing
 * else. Where a firmware label is not positional - a tricopter's two front
 * arms are commented RIGHT and LEFT although the same row's pitch term
 * puts them ahead of the centre of mass - the expectation records where
 * the coefficients actually place the motor, and says so.
 */

import {
  BETAFLIGHT_MIXER_REFERENCE_V147,
  findMixerReference,
} from '../firmware-adapters/betaflightMixerReferenceV147';
import {
  authoredAirframeLayout,
  mixerHasAuthoredLayout,
  MIXERS_WITH_AUTHORED_LAYOUT,
  stationOf,
  verificationPositionOf,
} from './motorAirframeLayout';
import type {AirframeStation} from './motorAirframeLayout';
import {
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  MOTOR_TEST_EXPECTED_MIXER_MODE,
} from './motorVerificationModel';

const numbers = (count: number): readonly number[] =>
  Array.from({length: count}, (_, index) => index + 1);

/** mixerMode_e id -> the station each output occupies, motor 1 first. */
const FIRMWARE_STATIONS: ReadonlyArray<
  readonly [number, string, readonly AirframeStation[]]
> = [
  // mixerTricopter[] REAR / RIGHT / LEFT. The two front arms carry
  // pitch -0.666667, which is ahead of the hub, so they derive as front
  // corners - which is where a tricopter's arms actually are.
  [1, 'TRI', ['REAR', 'FRONT_RIGHT', 'FRONT_LEFT']],
  // mixerQuadP[] REAR / RIGHT / LEFT / FRONT.
  [2, 'QUADP', ['REAR', 'RIGHT', 'LEFT', 'FRONT']],
  // mixerQuadX[] REAR_R / FRONT_R / REAR_L / FRONT_L.
  [3, 'QUADX', ['REAR_RIGHT', 'FRONT_RIGHT', 'REAR_LEFT', 'FRONT_LEFT']],
  // mixerBicopter[] LEFT / RIGHT.
  [4, 'BICOPTER', ['LEFT', 'RIGHT']],
  // mixerY6[] REAR / RIGHT / LEFT / UNDER_REAR / UNDER_RIGHT / UNDER_LEFT.
  // Same front-arm note as the tricopter.
  [6, 'Y6', ['REAR', 'FRONT_RIGHT', 'FRONT_LEFT', 'REAR', 'FRONT_RIGHT', 'FRONT_LEFT']],
  // mixerHex6P[] REAR_R / FRONT_R / REAR_L / FRONT_L / FRONT / REAR.
  [7, 'HEX6', ['REAR_RIGHT', 'FRONT_RIGHT', 'REAR_LEFT', 'FRONT_LEFT', 'FRONT', 'REAR']],
  // mixerSingleProp[] via mixers[8]: one motor, no arm.
  [8, 'FLYING_WING', ['CENTRE']],
  // mixerY4[] REAR_TOP / FRONT_R / REAR_BOTTOM / FRONT_L.
  [9, 'Y4', ['REAR', 'FRONT_RIGHT', 'REAR', 'FRONT_LEFT']],
  // mixerHex6X[] REAR_R / FRONT_R / REAR_L / FRONT_L / RIGHT / LEFT.
  [10, 'HEX6X', ['REAR_RIGHT', 'FRONT_RIGHT', 'REAR_LEFT', 'FRONT_LEFT', 'RIGHT', 'LEFT']],
  // mixerOctoX8[] the four corners, then the same four UNDER_.
  [
    11,
    'OCTOX8',
    [
      'REAR_RIGHT',
      'FRONT_RIGHT',
      'REAR_LEFT',
      'FRONT_LEFT',
      'REAR_RIGHT',
      'FRONT_RIGHT',
      'REAR_LEFT',
      'FRONT_LEFT',
    ],
  ],
  // mixerOctoFlatP[] FRONT_L / FRONT_R / REAR_R / REAR_L / FRONT / RIGHT /
  // REAR / LEFT.
  [
    12,
    'OCTOFLATP',
    [
      'FRONT_LEFT',
      'FRONT_RIGHT',
      'REAR_RIGHT',
      'REAR_LEFT',
      'FRONT',
      'RIGHT',
      'REAR',
      'LEFT',
    ],
  ],
  // mixerOctoFlatX[] MIDFRONT_L / FRONT_R / MIDREAR_R / REAR_L / FRONT_L /
  // MIDFRONT_R / REAR_R / MIDREAR_L.
  [
    13,
    'OCTOFLATX',
    [
      'MIDFRONT_LEFT',
      'FRONT_RIGHT',
      'MIDREAR_RIGHT',
      'REAR_LEFT',
      'FRONT_LEFT',
      'MIDFRONT_RIGHT',
      'REAR_RIGHT',
      'MIDREAR_LEFT',
    ],
  ],
  [14, 'AIRPLANE', ['CENTRE']],
  // mixerVtail4[] REAR_R / FRONT_R / REAR_L / FRONT_L.
  [17, 'VTAIL4', ['REAR_RIGHT', 'FRONT_RIGHT', 'REAR_LEFT', 'FRONT_LEFT']],
  // mixerAtail4[] REAR_R / FRONT_R / REAR_L / FRONT_L.
  [22, 'ATAIL4', ['REAR_RIGHT', 'FRONT_RIGHT', 'REAR_LEFT', 'FRONT_LEFT']],
  // mixerQuadX1234[] FRONT_L / FRONT_R / REAR_R / REAR_L.
  [26, 'QUADX_1234', ['FRONT_LEFT', 'FRONT_RIGHT', 'REAR_RIGHT', 'REAR_LEFT']],
  // mixerOctoX8P[] REAR / RIGHT / LEFT / FRONT, then the same four UNDER_.
  [
    27,
    'OCTOX8P',
    ['REAR', 'RIGHT', 'LEFT', 'FRONT', 'REAR', 'RIGHT', 'LEFT', 'FRONT'],
  ],
];

describe('authored airframe layouts', () => {
  it.each(FIRMWARE_STATIONS)(
    'mixer %i (%s) places every motor where the firmware table says',
    (mixerId, _name, stations) => {
      const found = authoredAirframeLayout(mixerId, numbers(stations.length));
      expect(found).toBeDefined();
      const derived = found?.placements.map(placement => stationOf(placement));
      expect(derived).toEqual(stations);
    },
  );

  it('covers exactly the mixers the transcription above lists', () => {
    expect([...MIXERS_WITH_AUTHORED_LAYOUT]).toEqual(
      FIRMWARE_STATIONS.map(([mixerId]) => mixerId),
    );
  });

  it('matches the reference table motor count for every authored mixer', () => {
    for (const [mixerId, name, stations] of FIRMWARE_STATIONS) {
      const reference = findMixerReference(mixerId);
      expect(reference?.firmwareName).toBe(name);
      expect(reference?.motorCountStrategy).toEqual({
        kind: 'TABLE_FIXED',
        count: stations.length,
      });
    }
  });

  it('marks a servo role exactly where the firmware table says useServo', () => {
    for (const [mixerId, , stations] of FIRMWARE_STATIONS) {
      const found = authoredAirframeLayout(mixerId, numbers(stations.length));
      const reference = findMixerReference(mixerId);
      expect(found?.servoRole !== undefined).toBe(reference?.tableUseServo);
    }
  });

  it('names a station and a deck that together identify one motor', () => {
    for (const [, name, stations] of FIRMWARE_STATIONS) {
      const found = authoredAirframeLayout(
        FIRMWARE_STATIONS.find(row => row[1] === name)?.[0],
        numbers(stations.length),
      );
      const seen = new Set(
        found?.placements.map(placement => `${stationOf(placement)}:${placement.deck}`),
      );
      expect(seen.size).toBe(stations.length);
    }
  });

  it('flags coaxial aircraft, and only coaxial aircraft', () => {
    const coaxial = FIRMWARE_STATIONS.filter(([mixerId, , stations]) => {
      const found = authoredAirframeLayout(mixerId, numbers(stations.length));
      return found?.coaxial === true;
    }).map(([, name]) => name);
    // Y6, Y4, OCTOX8 and OCTOX8P are the four the firmware marks with an
    // UNDER_ prefix; nothing else stacks rotors.
    expect(coaxial).toEqual(['Y6', 'Y4', 'OCTOX8', 'OCTOX8P']);
  });
});

describe('layouts deliberately not authored', () => {
  /** Mixers the firmware knows and this project draws as a numbered list,
   *  with the reason it cannot be drawn. */
  const NOT_AUTHORED: ReadonlyArray<readonly [number, string]> = [
    [5, 'GIMBAL'],
    [15, 'HELI_120_CCPM'],
    [16, 'HELI_90_DEG'],
    // mixerHex6H[] gives RIGHT and LEFT { roll 0, pitch 0 } - two motors
    // at the origin with no arm and therefore no position.
    [18, 'HEX6H'],
    [19, 'PPM_TO_SERVO'],
    // mixerDualcopter[] puts both motors at the origin too.
    [20, 'DUALCOPTER'],
    // mixers[21] is { 1, true, NULL } - a motor count with no motor table.
    [21, 'SINGLECOPTER'],
    [23, 'CUSTOM'],
    [24, 'CUSTOM_AIRPLANE'],
    [25, 'CUSTOM_TRI'],
  ];

  it.each(NOT_AUTHORED)('mixer %i (%s) has no layout', mixerId => {
    expect(mixerHasAuthoredLayout(mixerId)).toBe(false);
  });

  it('accounts for every mixer the reference table knows', () => {
    const accounted = new Set<number>([
      ...MIXERS_WITH_AUTHORED_LAYOUT,
      ...NOT_AUTHORED.map(([mixerId]) => mixerId),
    ]);
    for (const row of BETAFLIGHT_MIXER_REFERENCE_V147) {
      expect(accounted.has(row.mixerId)).toBe(true);
    }
  });

  it('draws nothing for an unknown mixer id', () => {
    expect(authoredAirframeLayout(250, [1, 2, 3])).toBeUndefined();
    expect(mixerHasAuthoredLayout(250)).toBe(false);
    /* AND SUBSTITUTES NOTHING FOR IT.
       Mutation testing found this: the case above uses a three-motor
       list, which the count comparison rejects on its own, so a fallback
       that quietly handed back the Quad X layout went unnoticed. The
       counts match here, and every authored layout size is tried, so
       there is no shape an unknown mixer could be given by accident. */
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect([count, authoredAirframeLayout(250, numbers(count))]).toEqual([
        count,
        undefined,
      ]);
    }
  });
});

describe('a layout is only used for the aircraft it describes', () => {
  it('refuses a mixer whose runtime motor count disagrees', () => {
    // A QUADX byte with six reported motors: the mixer changed without the
    // reboot mixerInit() needs, and neither figure may be drawn.
    expect(authoredAirframeLayout(3, numbers(6))).toBeUndefined();
    expect(authoredAirframeLayout(10, numbers(4))).toBeUndefined();
  });

  it('refuses an unread mixer and an unread count', () => {
    expect(authoredAirframeLayout(undefined, numbers(4))).toBeUndefined();
    expect(authoredAirframeLayout(3, [])).toBeUndefined();
  });

  it('refuses a motor list that is not 1..N', () => {
    expect(authoredAirframeLayout(3, [1, 2, 3, 5])).toBeUndefined();
  });
});

describe('rotation direction is structurally absent', () => {
  it('no placement carries a direction, on any authored layout', () => {
    for (const [mixerId, , stations] of FIRMWARE_STATIONS) {
      const found = authoredAirframeLayout(mixerId, numbers(stations.length));
      for (const placement of found?.placements ?? []) {
        expect(Object.keys(placement).sort()).toEqual(['deck', 'motorNumber', 'x', 'y']);
      }
    }
  });
});

describe('the Quad X verification model and the QUADX layout agree', () => {
  it('places the model motors on the model corners', () => {
    const found = authoredAirframeLayout(MOTOR_TEST_EXPECTED_MIXER_MODE, numbers(4));
    const derived = found?.placements.map(placement => ({
      motorNumber: placement.motorNumber,
      position: verificationPositionOf(placement),
    }));
    expect(derived).toEqual(
      MOTOR_TEST_EXPECTED_CONFIGURATION.map(entry => ({
        motorNumber: entry.motorNumber,
        position: entry.position,
      })),
    );
  });

  it('gives a V-tail the same four corners, which is why the mixer is also checked', () => {
    const vtail = authoredAirframeLayout(17, numbers(4));
    const quadx = authoredAirframeLayout(3, numbers(4));
    const corners = (rows: typeof vtail): string =>
      (rows?.placements ?? [])
        .map(placement => `${placement.motorNumber}:${verificationPositionOf(placement)}`)
        .join('|');
    expect(corners(vtail)).toBe(corners(quadx));
    expect(17).not.toBe(MOTOR_TEST_EXPECTED_MIXER_MODE);
  });

  it('gives no corner name to a coaxial motor', () => {
    const octo = authoredAirframeLayout(11, numbers(8));
    for (const placement of octo?.placements ?? []) {
      expect(verificationPositionOf(placement)).toBeUndefined();
    }
  });
});
