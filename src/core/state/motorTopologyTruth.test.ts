/**
 * M-B - MotorTopologyTruth.
 *
 * Every wire fixture in this file is HAND-WRITTEN from the pinned
 * firmware's own rules (Betaflight 7348054f, MSP API 1.47) and typed as a
 * plain byte or number vector. None is produced by deriveMotorTopologyTruth,
 * by the mixer reference table, or by any encoder in this repository.
 */

import fs from 'fs';
import path from 'path';

import {
  deriveMotorTopologyTruth,
  MotorTopologyError,
  type MotorTopologyContradiction,
  type MotorTopologyTruth,
} from './motorTopologyTruth';

const QUADX = 3;
const TRI = 1;
const HEX6X = 10;
const OCTOX8 = 11;
const AIRPLANE = 14;
const GIMBAL = 5;
const CUSTOM = 23;
const CUSTOM_TRI = 25;
const NOT_A_MIXER = 99;

/** Eight slots, `enabled` of them carrying a plausible external value and
 * the rest carrying the firmware's zero sentinel. Written as a literal
 * vector, exactly as MSP_MOTOR would put it on the wire. */
function slots(...values: readonly number[]): readonly number[] {
  const padded = [...values];
  while (padded.length < 8) {
    padded.push(0);
  }
  return padded;
}

describe('deriveMotorTopologyTruth - four answers, kept apart', () => {
  it('keeps the mixer expectation and the runtime count as separate fields', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: QUADX,
      runtimeMotorCount: 4,
    });
    expect(truth.expectedMotorCount).toEqual({kind: 'TABLE_FIXED', count: 4});
    expect(truth.runtimeMotorCount).toEqual({kind: 'REPORTED', count: 4});
    expect(truth.contradictions).toEqual([]);
  });

  it('reports every unread frame as NOT_READ and fills nothing in', () => {
    const truth = deriveMotorTopologyTruth({mixerModeRaw: HEX6X});
    expect(truth.runtimeMotorCount).toEqual({kind: 'NOT_READ'});
    expect(truth.observedMotorOutputs).toEqual({kind: 'NOT_READ'});
    expect(truth.telemetryFrameMotorCount).toEqual({kind: 'NOT_READ'});
    // The mixer expectation is still known - it comes from the mode byte.
    expect(truth.expectedMotorCount).toEqual({kind: 'TABLE_FIXED', count: 6});
    expect(truth.contradictions).toEqual([]);
  });

  it('never lets the observed slots redefine the runtime count', () => {
    // A six-motor hex whose outputs are momentarily all disabled.
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: HEX6X,
      runtimeMotorCount: 6,
      motorOutputSlots: slots(),
    });
    expect(truth.runtimeMotorCount).toEqual({kind: 'REPORTED', count: 6});
    if (truth.observedMotorOutputs.kind !== 'OBSERVED') {
      throw new Error('expected an observed frame');
    }
    expect(truth.observedMotorOutputs.observedEnabledSlotCount).toBe(0);
  });

  it('names the observed slot count something that is not a motor count', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: QUADX,
      runtimeMotorCount: 4,
      motorOutputSlots: slots(1000, 1000, 1000, 1000),
    });
    const observed = truth.observedMotorOutputs;
    expect(Object.keys(observed)).not.toContain('runtimeMotorCount');
    expect(Object.keys(observed)).not.toContain('motorCount');
    expect(Object.keys(observed)).toContain('observedEnabledSlotCount');
  });

  it('names the telemetry count for the frame, not for the fleet', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: QUADX,
      runtimeMotorCount: 4,
      telemetryFrameMotorCount: 4,
    });
    expect(truth.telemetryFrameMotorCount).toEqual({kind: 'REPORTED', count: 4});
    expect(Object.keys(truth)).toContain('telemetryFrameMotorCount');
    expect(Object.keys(truth)).not.toContain('numberOfMotorsWithTelemetry');
  });
});

/**
 * P0-B. MSP_MOTOR always returns eight slots. A zero means "not an
 * enabled motor output right now"; it is never a count, and its absence
 * is never a fault.
 */
describe('deriveMotorTopologyTruth - P0-B, the eight output slots', () => {
  it('classifies each of the eight slots as enabled or as the zero sentinel', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: TRI,
      runtimeMotorCount: 3,
      motorOutputSlots: slots(1000, 1000, 1000),
    });
    if (truth.observedMotorOutputs.kind !== 'OBSERVED') {
      throw new Error('expected an observed frame');
    }
    const {slots: read} = truth.observedMotorOutputs;
    expect(read).toHaveLength(8);
    expect(read.slice(0, 3)).toEqual([
      {kind: 'ENABLED', externalValue: 1000},
      {kind: 'ENABLED', externalValue: 1000},
      {kind: 'ENABLED', externalValue: 1000},
    ]);
    expect(read.slice(3)).toEqual(
      Array.from({length: 5}, () => ({kind: 'DISABLED_OR_UNAVAILABLE_SENTINEL'})),
    );
  });

  it('treats eight zeros on a four-motor quad as normal, not as a contradiction', () => {
    // motorIsEnabled() is a single device-wide flag, cleared during ESC
    // passthrough and around blocking DShot commands. While it is clear a
    // perfectly healthy quad reports eight zeros.
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: QUADX,
      runtimeMotorCount: 4,
      motorOutputSlots: slots(),
    });
    expect(truth.contradictions).toEqual([]);
  });

  it('treats fewer enabled slots than motors as normal at every count', () => {
    for (let enabled = 0; enabled <= 4; enabled++) {
      const truth = deriveMotorTopologyTruth({
        mixerModeRaw: QUADX,
        runtimeMotorCount: 4,
        motorOutputSlots: slots(...Array.from({length: enabled}, () => 1000)),
      });
      expect(truth.contradictions).toEqual([]);
    }
  });

  it('reports a hole as a contradiction, because the drivers make one unreachable', () => {
    // The exact vector the specification asked about. All three motor
    // drivers abandon initialisation at the first output they cannot
    // allocate, so an enabled slot after a disabled one cannot happen.
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: QUADX,
      runtimeMotorCount: 4,
      motorOutputSlots: [1200, 1200, 0, 1200, 0, 0, 0, 0],
    });
    if (truth.observedMotorOutputs.kind !== 'OBSERVED') {
      throw new Error('expected an observed frame');
    }
    expect(truth.observedMotorOutputs.enabledSlotsAreContiguousFromZero).toBe(false);
    expect(truth.contradictions).toContain('OBSERVED_ENABLED_SLOTS_NOT_CONTIGUOUS');
  });

  it('reports more enabled slots than motors as a contradiction', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: TRI,
      runtimeMotorCount: 3,
      motorOutputSlots: slots(1000, 1000, 1000, 1000),
    });
    expect(truth.contradictions).toContain('OBSERVED_ENABLED_SLOTS_EXCEED_RUNTIME_COUNT');
  });

  it('refuses a slot vector that is not exactly eight long', () => {
    for (const length of [0, 3, 4, 7, 9, 16]) {
      expect(() =>
        deriveMotorTopologyTruth({
          mixerModeRaw: QUADX,
          motorOutputSlots: Array.from({length}, () => 1000),
        }),
      ).toThrow(MotorTopologyError);
    }
  });

  it('accepts a full eight-motor octocopter frame with no contradiction', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: OCTOX8,
      runtimeMotorCount: 8,
      motorOutputSlots: [1100, 1100, 1100, 1100, 1100, 1100, 1100, 1100],
      telemetryFrameMotorCount: 8,
    });
    expect(truth.contradictions).toEqual([]);
    if (truth.observedMotorOutputs.kind !== 'OBSERVED') {
      throw new Error('expected an observed frame');
    }
    expect(truth.observedMotorOutputs.observedEnabledSlotCount).toBe(8);
    expect(truth.observedMotorOutputs.enabledSlotsAreContiguousFromZero).toBe(true);
  });
});

describe('deriveMotorTopologyTruth - named contradictions', () => {
  const contradictionsFor = (
    truth: MotorTopologyTruth,
  ): readonly MotorTopologyContradiction[] => truth.contradictions;

  it('flags a mixer id outside the pinned table and assumes nothing about it', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: NOT_A_MIXER,
      runtimeMotorCount: 4,
    });
    expect(contradictionsFor(truth)).toContain('MIXER_MODE_NOT_IN_PINNED_TABLE');
    expect(truth.mixer).toBeUndefined();
    expect(truth.family).toBe('UNKNOWN');
    expect(truth.expectedMotorCount).toEqual({kind: 'UNKNOWN'});
    expect(truth.expectedServoCount).toEqual({kind: 'UNKNOWN'});
    expect(truth.layoutKnown).toBe(false);
  });

  it('flags a runtime count above the firmware maximum', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: OCTOX8,
      runtimeMotorCount: 9,
    });
    expect(contradictionsFor(truth)).toContain('RUNTIME_COUNT_EXCEEDS_FIRMWARE_MAXIMUM');
  });

  it('flags a runtime count that disagrees with a fixed mixer table count', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: QUADX,
      runtimeMotorCount: 6,
    });
    expect(contradictionsFor(truth)).toContain('RUNTIME_COUNT_DISAGREES_WITH_MIXER_TABLE');
  });

  it('flags motors reported for a mixer that drives none', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: GIMBAL,
      runtimeMotorCount: 4,
    });
    expect(contradictionsFor(truth)).toContain('RUNTIME_COUNT_NONZERO_FOR_MOTORLESS_MIXER');
  });

  it('flags a telemetry frame count that disagrees with the runtime count', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: QUADX,
      runtimeMotorCount: 4,
      telemetryFrameMotorCount: 3,
    });
    expect(contradictionsFor(truth)).toContain(
      'TELEMETRY_FRAME_COUNT_DISAGREES_WITH_RUNTIME_COUNT',
    );
  });

  it('never disagrees with a custom mixer, which has no table count to disagree with', () => {
    for (const count of [0, 1, 3, 5, 8]) {
      const truth = deriveMotorTopologyTruth({
        mixerModeRaw: CUSTOM_TRI,
        runtimeMotorCount: count,
      });
      expect(contradictionsFor(truth)).not.toContain(
        'RUNTIME_COUNT_DISAGREES_WITH_MIXER_TABLE',
      );
    }
  });

  it('emits no contradiction for a mixer whose servos this app does not model', () => {
    // A missing Servos screen is a product gap, not the board contradicting
    // itself, and it must never appear in this channel.
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: AIRPLANE,
      runtimeMotorCount: 1,
      motorOutputSlots: slots(1000),
    });
    expect(truth.expectedServoCount).toEqual({kind: 'TABLE_FIXED', count: 6});
    expect(truth.contradictions).toEqual([]);
    expect(JSON.stringify(truth.contradictions)).not.toContain('SERVO');
  });

  it('rejects a negative or fractional count rather than normalising it', () => {
    expect(() =>
      deriveMotorTopologyTruth({mixerModeRaw: QUADX, runtimeMotorCount: -1}),
    ).toThrow(MotorTopologyError);
    expect(() =>
      deriveMotorTopologyTruth({mixerModeRaw: QUADX, telemetryFrameMotorCount: 2.5}),
    ).toThrow(MotorTopologyError);
    expect(() => deriveMotorTopologyTruth({mixerModeRaw: 1.5})).toThrow(MotorTopologyError);
  });
});

describe('deriveMotorTopologyTruth - custom mixers', () => {
  it.each([CUSTOM, 24, CUSTOM_TRI])(
    'marks mixer %i as runtime-derived and unreadable over MSP',
    mixerModeRaw => {
      const truth = deriveMotorTopologyTruth({mixerModeRaw, runtimeMotorCount: 4});
      expect(truth.expectedMotorCount).toEqual({kind: 'CUSTOM_RUNTIME_DERIVED'});
      expect(truth.customMixer).toEqual({
        kind: 'RUNTIME_DERIVED_NOT_READABLE_OVER_MSP',
      });
    },
  );

  it('marks every non-custom mixer as NOT_APPLICABLE', () => {
    for (const mixerModeRaw of [TRI, QUADX, HEX6X, OCTOX8, AIRPLANE, GIMBAL]) {
      expect(deriveMotorTopologyTruth({mixerModeRaw}).customMixer).toEqual({
        kind: 'NOT_APPLICABLE',
      });
    }
  });

  it('accepts a custom mixer that derived zero motors', () => {
    // `mmix reset` zeroes all eight rows, so the next boot derives 0 -
    // including for CUSTOM_TRI, whose dead table row says 3.
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: CUSTOM_TRI,
      runtimeMotorCount: 0,
      motorOutputSlots: slots(),
    });
    expect(truth.runtimeMotorCount).toEqual({kind: 'REPORTED', count: 0});
    expect(truth.contradictions).toEqual([]);
  });
});

/**
 * The topology model must never grow a rotation-direction field. A mixer
 * mode does not determine which way a propeller turns, and
 * yaw_motors_reversed is a PID sign flip rather than an output remap.
 */
describe('motorTopologyTruth - the source carries no invented direction', () => {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const code = (file: string): string =>
    fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');

  const FILES = [
    'src/core/state/motorTopologyTruth.ts',
    'src/core/firmware-adapters/betaflightMixerReferenceV147.ts',
    'src/core/state/motorTestCommandVector.ts',
  ];

  it.each([
    ['a rotation-direction field', /\b(rotation|spin)Direction\w*\s*[:(=]/i],
    ['a CW or CCW literal', /'(CW|CCW|CLOCKWISE|COUNTER_?CLOCKWISE)'/i],
    ['a props-out claim', /\bprops?(Out|In|Direction)\b/i],
    ['a reversed-motor claim of its own', /\breversedMotors?\b/i],
    ['a health field', /\bhealth\w*\s*[:(=]/i],
    ['an is-ok predicate', /\bis(Ok|Healthy|Good)\w*\s*[:(=]/i],
    ['a verdict literal', /'(HEALTHY|UNHEALTHY|FAULTY|GOOD|BAD|OK)'/],
    ['a score', /\bscore\w*\s*[:(=]/i],
  ])('no file in the topology core declares %s', (_label, pattern) => {
    for (const file of FILES) {
      expect(code(file)).not.toMatch(pattern);
    }
  });

  it('exposes no rotation direction on the derived truth at runtime', () => {
    const truth = deriveMotorTopologyTruth({
      mixerModeRaw: QUADX,
      runtimeMotorCount: 4,
      motorOutputSlots: slots(1000, 1000, 1000, 1000),
    });
    const serialised = JSON.stringify(truth);
    expect(serialised).not.toMatch(/\bCW\b|\bCCW\b|clockwise/i);
    expect(Object.keys(truth).join(' ')).not.toMatch(/direction/i);
  });
});

/**
 * ARCHITECTURE COLLISION. The topology core is pure: it must not reach
 * the interface, the shipping motor-test controller, or the telemetry
 * presentation layer. A single import in the wrong direction would make
 * this model impossible to test in isolation and would let a UI concern
 * decide what an airframe is.
 */
describe('motorTopologyTruth - architecture collision', () => {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const FILES = [
    'src/core/state/motorTopologyTruth.ts',
    'src/core/firmware-adapters/betaflightMixerReferenceV147.ts',
    'src/core/state/motorTestCommandVector.ts',
  ];

  const importsOf = (file: string): readonly string[] => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return [...source.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)';/gm)].map(
      match => match[1],
    );
  };

  it.each(FILES)('%s imports nothing outside src/core', file => {
    for (const specifier of importsOf(file)) {
      expect(specifier.startsWith('.')).toBe(true);
      const resolved = path.resolve(path.dirname(path.join(ROOT, file)), specifier);
      expect(resolved.startsWith(path.join(ROOT, 'src/core'))).toBe(true);
    }
  });

  it.each(FILES)('%s imports no interface, controller or presentation module', file => {
    const forbidden = [
      /(^|\/)react($|\/)/i,
      /react-native/i,
      /\/ui\//i,
      /MotorsScreen/i,
      /MotorWorkspace/i,
      /MotorAirframeDiagram/i,
      /motorTestController/i,
      /motorTestCapabilit/i,
      /Presentation/i,
      /i18n/i,
      /platforms\//i,
    ];
    for (const specifier of importsOf(file)) {
      for (const pattern of forbidden) {
        expect(specifier).not.toMatch(pattern);
      }
    }
  });

  it.each(FILES)('%s holds no clock, no randomness and no global state', file => {
    const source = fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
    expect(source).not.toMatch(/\bDate\.now\b|\bnew Date\b|\bMath\.random\b/);
    expect(source).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
    // MODULE-LEVEL mutable bindings only: a `let` at column zero is state
    // that survives between calls. Locals inside a function are fine and
    // are indented, so the anchor is the whole check.
    expect(source).not.toMatch(/^(let|var)\s/m);
  });

  it('does not import the shipping motor-test vector module', () => {
    // M-B leaves betaflightMotorVectorsV147 and the controller exactly as
    // they are; the new core neither reads them nor is read by them.
    for (const file of FILES) {
      for (const specifier of importsOf(file)) {
        expect(specifier).not.toMatch(/betaflightMotorVectorsV147/);
      }
    }
  });
});
