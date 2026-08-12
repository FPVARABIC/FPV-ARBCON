/**
 * MOTOR OUTPUT REORDERING, AGAINST THE FIRMWARE THAT ACTUALLY RUNS IT
 * (PART Z, items 24-29).
 *
 * The audit answer is FIRMWARE AUTHORABLE, read at the pinned commit
 * 79065c96ba0bb5cdc675e67d7093e05dab8b330e rather than inferred from what
 * Betaflight Configurator's dialog looks like:
 *
 *   GET  MSP2_MOTOR_OUTPUT_REORDERING     0x3001  msp.c:1281-1289
 *        writes MAX_SUPPORTED_MOTORS, then that many bytes of
 *        motorConfig()->dev.motorOutputReordering[].
 *
 *   SET  MSP2_SET_MOTOR_OUTPUT_REORDERING 0x3002  msp.c:3555-3569
 *        reads one u8 arraySize, then fills EVERY index up to
 *        MAX_SUPPORTED_MOTORS - taking `value = i` for every index at or
 *        beyond arraySize.
 *
 *   STORAGE  motorDevConfig_t.motorOutputReordering[MAX_SUPPORTED_MOTORS]
 *            (pg/motor.h:78) - a PG field, so it needs an EEPROM write.
 *   APPLIED  only at motor device init (pwm_output_hw.c:213), so a reboot
 *            is required before it means anything.
 *   VALIDATED validateAndfixMotorOutputReordering (dshot.c:431) resets a
 *            duplicate or out-of-range array to identity on the FC side.
 *   ARMED    the SET handler has NO arming guard - unlike
 *            MSP2_SEND_DSHOT_COMMAND immediately below it, which checks
 *            ARMING_FLAG(ARMED). The gate is ours to hold, not the
 *            firmware's.
 *
 * TWO CONSEQUENCES WERE MEASURED AS DEFECTS AND ARE PINNED BELOW: the
 * count is target-dependent, and a short write is destructive.
 */

import {deriveMotorOutputOrder} from './motorOutputReordering';
import {encodeMotorOutputOrder} from '../protocol/msp/encoding/encodeMotorOutputOrder';
import {decodeMotorOutputOrder} from '../protocol/msp/decoding/decodeMotorOutputOrder';
import type {MotorVerificationState} from './motorVerificationModel';

/** Four complete, unambiguous observations: the operator did it all. */
const COMPLETE = {
  entries: [
    {motorNumber: 1, observation: {kind: 'OBSERVED', position: 'REAR_RIGHT'}},
    {motorNumber: 2, observation: {kind: 'OBSERVED', position: 'FRONT_RIGHT'}},
    {motorNumber: 3, observation: {kind: 'OBSERVED', position: 'REAR_LEFT'}},
    {motorNumber: 4, observation: {kind: 'OBSERVED', position: 'FRONT_LEFT'}},
  ],
} as unknown as MotorVerificationState;

/** M1 and M2 swapped in the real world - the case the wizard exists for. */
const SWAPPED = {
  entries: [
    {motorNumber: 1, observation: {kind: 'OBSERVED', position: 'FRONT_RIGHT'}},
    {motorNumber: 2, observation: {kind: 'OBSERVED', position: 'REAR_RIGHT'}},
    {motorNumber: 3, observation: {kind: 'OBSERVED', position: 'REAR_LEFT'}},
    {motorNumber: 4, observation: {kind: 'OBSERVED', position: 'FRONT_LEFT'}},
  ],
} as unknown as MotorVerificationState;

describe('firmware fact 1: the FC reports MAX_SUPPORTED_MOTORS, not motorCount', () => {
  it('decodes the 8-entry payload an ordinary target sends', () => {
    const payload = Uint8Array.from([8, 0, 1, 2, 3, 4, 5, 6, 7]);
    expect(decodeMotorOutputOrder(payload).values).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('THE MEASURED DEFECT: an 8-output target used to be told to redo its work', () => {
    // Before: length !== 4 returned WRONG_OUTPUT_COUNT, which the panel
    // rendered as "complete the four observations first" - to an operator
    // who had. The feature was unreachable on that hardware.
    const eight = deriveMotorOutputOrder([0, 1, 2, 3, 4, 5, 6, 7], COMPLETE);
    expect(eight.kind).toBe('READY');
  });

  it('works on a 4-output target too, unchanged', () => {
    expect(deriveMotorOutputOrder([0, 1, 2, 3], COMPLETE)).toEqual({
      kind: 'READY',
      values: [0, 1, 2, 3],
    });
  });

  it('still refuses an array shorter than the observed quad', () => {
    expect(deriveMotorOutputOrder([0, 1, 2], COMPLETE)).toEqual({
      kind: 'INCOMPLETE',
      reason: 'WRONG_OUTPUT_COUNT',
    });
  });
});

describe('firmware fact 2: a short write resets the tail to identity', () => {
  it('carries outputs 5..8 through EXACTLY as the FC reported them', () => {
    // A non-identity tail the operator set up elsewhere and never touched.
    const current = [0, 1, 2, 3, 7, 6, 5, 4];
    const derived = deriveMotorOutputOrder(current, SWAPPED);
    expect(derived.kind).toBe('READY');
    if (derived.kind !== 'READY') return;
    expect(derived.values.slice(4)).toEqual([7, 6, 5, 4]);
  });

  it('emits a FULL-LENGTH payload, so the firmware never reaches its reset branch', () => {
    const derived = deriveMotorOutputOrder([0, 1, 2, 3, 7, 6, 5, 4], SWAPPED);
    if (derived.kind !== 'READY') throw new Error(derived.kind);
    const wire = encodeMotorOutputOrder(derived.values);
    // msp.c:3557 reads this first byte as arraySize; every index at or
    // beyond it is overwritten with `value = i`. Eight means none are.
    expect(wire[0]).toBe(8);
    expect(wire).toHaveLength(9);
  });

  it('does swap the two outputs it was actually asked to swap', () => {
    const derived = deriveMotorOutputOrder([0, 1, 2, 3, 7, 6, 5, 4], SWAPPED);
    if (derived.kind !== 'READY') throw new Error(derived.kind);
    // M1 was observed at FRONT_RIGHT and M2 at REAR_RIGHT, so the
    // resources behind slots 1 and 2 trade places and nothing else moves.
    expect(derived.values.slice(0, 4)).toEqual([1, 0, 2, 3]);
  });
});

describe('PART J: the permutation is validated BEFORE any I/O', () => {
  it('every index appears exactly once', () => {
    const derived = deriveMotorOutputOrder([0, 1, 2, 3, 4, 5, 6, 7], SWAPPED);
    if (derived.kind !== 'READY') throw new Error(derived.kind);
    expect(new Set(derived.values).size).toBe(derived.values.length);
  });

  it('no motor is dropped: the result is a rearrangement of the input', () => {
    const current = [3, 2, 1, 0, 4, 5, 6, 7];
    const derived = deriveMotorOutputOrder(current, SWAPPED);
    if (derived.kind !== 'READY') throw new Error(derived.kind);
    expect([...derived.values].sort((a, b) => a - b)).toEqual(
      [...current].sort((a, b) => a - b),
    );
  });

  it('a duplicate observed position is rejected, not silently resolved', () => {
    const duplicated = {
      entries: [
        {motorNumber: 1, observation: {kind: 'OBSERVED', position: 'REAR_RIGHT'}},
        {motorNumber: 2, observation: {kind: 'OBSERVED', position: 'REAR_RIGHT'}},
        {motorNumber: 3, observation: {kind: 'OBSERVED', position: 'REAR_LEFT'}},
        {motorNumber: 4, observation: {kind: 'OBSERVED', position: 'FRONT_LEFT'}},
      ],
    } as unknown as MotorVerificationState;
    expect(deriveMotorOutputOrder([0, 1, 2, 3], duplicated)).toEqual({
      kind: 'INCOMPLETE',
      reason: 'DUPLICATE_POSITION',
    });
  });

  it('a missing observation is rejected', () => {
    const partial = {
      entries: [
        {motorNumber: 1, observation: {kind: 'OBSERVED', position: 'REAR_RIGHT'}},
        {motorNumber: 2, observation: undefined},
      ],
    } as unknown as MotorVerificationState;
    expect(deriveMotorOutputOrder([0, 1, 2, 3], partial)).toEqual({
      kind: 'INCOMPLETE',
      reason: 'MISSING_OBSERVATION',
    });
  });

  it('an FC array that is itself not a permutation is refused up front', () => {
    // validateAndfixMotorOutputReordering would reset this on the FC side;
    // the app does not send it in the first place.
    expect(deriveMotorOutputOrder([0, 0, 1, 2], COMPLETE)).toEqual({
      kind: 'INCOMPLETE',
      reason: 'WRONG_OUTPUT_COUNT',
    });
  });

  it('the encoder is the second gate, and it also refuses a duplicate', () => {
    expect(() => encodeMotorOutputOrder([0, 0, 1, 2])).toThrow(
      /unique physical output indices/,
    );
  });

  it('the encoder refuses an index the firmware cannot address', () => {
    expect(() => encodeMotorOutputOrder([0, 1, 2, 99])).toThrow(
      /invalid physical output index/,
    );
  });
});

describe('PART Z: no FAKE reorder path exists anywhere else', () => {
  it('exactly ONE site puts the reorder command on the wire', () => {
    // Naming the constant is not authorship - three barrels re-export it,
    // and this file's own header quotes it. What matters is DISPATCH: a
    // request() call carrying it. A UI-side or second writer shows up here.
    const {readFileSync, readdirSync, statSync} = require('fs');
    const {join} = require('path');
    const root = join(__dirname, '..', '..');
    const dispatchers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(path) || /\.test\.tsx?$/.test(path)) continue;
        const source = readFileSync(path, 'utf8') as string;
        if (/\.request\(\s*MSP2_SET_MOTOR_OUTPUT_REORDERING/.test(source)) {
          dispatchers.push(path.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(dispatchers).toEqual([
      'platforms/react-native/protocol/MotorConfigurationController.ts',
    ]);
  });

  it('no UI file names the reorder command at all', () => {
    const {readFileSync, readdirSync, statSync} = require('fs');
    const {join} = require('path');
    const uiRoot = join(__dirname, '..', '..', 'ui');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(path) || /\.test\.tsx?$/.test(path)) continue;
        const source = readFileSync(path, 'utf8') as string;
        if (source.includes('MSP2_SET_MOTOR_OUTPUT_REORDERING')) {
          offenders.push(path.slice(uiRoot.length + 1));
        }
      }
    };
    walk(uiRoot);
    expect(offenders).toEqual([]);
  });
});
