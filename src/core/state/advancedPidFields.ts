/**
 * THE EXPERT TIER'S FIELDS, THEIR BOUNDS, AND WHERE EACH BOUND COMES FROM.
 *
 * =====================================================================
 * WHY A CATALOGUE AND NOT TWENTY SCATTERED CONSTANTS
 * =====================================================================
 *
 * P-E opens roughly two dozen direct tuning fields that P-D left decoded
 * but unreachable. Every one of them has a range the FIRMWARE enforces,
 * and MSP_SET_PID_ADVANCED does not clamp: whatever arrives is stored.
 * A UI range invented here would therefore not be a cosmetic difference -
 * it would be this application writing a value the firmware's own CLI
 * would have refused.
 *
 * So each entry carries its source line. They were read from the pinned
 * Betaflight tree at `src/main/cli/settings.c`, in a checkout whose
 * `msp_protocol.h` declares API_VERSION_MAJOR 1 / API_VERSION_MINOR 49 -
 * the top of the three versions this application speaks. Constants the
 * table references (PID_GAIN_MAX, TPA_MAX, LPF_MAX_HZ, the motor-output
 * and anti-gravity limits) were resolved to their own defining headers
 * rather than assumed.
 *
 * NOTHING IS COPIED. These are numbers and the names of the settings they
 * bound; no firmware code, structure or text is reproduced.
 *
 * =====================================================================
 * WHAT IS DELIBERATELY ABSENT
 * =====================================================================
 *
 * Fields the pinned tree serialises as a literal constant and never reads
 * back (PID_ADVANCED_RESERVED_OFFSETS) are not here, and neither are the
 * three retireable slots - abs control gain, integrated yaw and its relax
 * - which `decodePidAdvancedFull` already classifies by lifetime. A byte
 * that exists on the wire is not by itself a setting.
 */

import type {MspPidAdvanced} from '../protocol/msp/decoding/decodePidAdvancedFull';
import {PID_ADVANCED_OFFSETS} from '../protocol/msp/decoding/decodePidAdvancedFull';

/**
 * The direct expert fields this application will WRITE.
 *
 * Wire units throughout - no scaling, no percent conversion, no "friendly"
 * remapping. The presentation layer names them; this is what goes out.
 */
export interface AdvancedPidDraft {
  /* ---- D Max: the dynamic upper D limit, not a second D ------------ */
  readonly dMaxRoll: number;
  readonly dMaxPitch: number;
  readonly dMaxYaw: number;
  readonly dMaxGain: number;
  readonly dMaxAdvance: number;

  /* ---- Feedforward, beyond the three P-D already edits -------------- */
  readonly feedforwardTransition: number;
  readonly feedforwardSmoothFactor: number;
  readonly feedforwardMaxRateLimit: number;

  /* ---- TPA ---------------------------------------------------------- */
  readonly tpaMode: number;
  readonly tpaRate: number;
  readonly tpaBreakpoint: number;

  /* ---- I-term behaviour and anti-gravity ---------------------------- */
  readonly itermRelax: number;
  readonly itermRelaxType: number;
  readonly itermRelaxCutoff: number;
  readonly itermRotation: number;
  readonly antiGravityGain: number;

  /* ---- The stable remainder of pidProfile_t this screen owns -------- */
  readonly throttleBoost: number;
  readonly thrustLinearization: number;
  readonly vbatSagCompensation: number;
  readonly motorOutputLimit: number;
  readonly angleLimit: number;
  readonly acroTrainerAngleLimit: number;
  readonly rateAccelLimit: number;
  readonly yawRateAccelLimit: number;
  /**
   * SIGNED, and the only signed field here. -1 is not "minus one cell": it
   * is `AUTO_PROFILE_CELL_COUNT_CHANGE`, "always switch to whichever
   * profile matches the detected cell count". 0 is `..._STAY`, meaning
   * automatic switching is off. 1..8 name the cell count THIS profile is
   * for. Presenting it as a plain number would be presenting three
   * different meanings as one scale.
   */
  readonly autoProfileCellCount: number;
}

export type AdvancedPidFieldKey = keyof AdvancedPidDraft;

/**
 * A field's firmware bound, and the line it was read from.
 *
 * `choices` is present exactly where settings.c marks the row MODE_LOOKUP:
 * such a field is an enumeration, and offering a free number for it would
 * invite a value with no meaning.
 */
export interface AdvancedPidBound {
  readonly min: number;
  readonly max: number;
  /** Present for MODE_LOOKUP rows: the raw values the table defines. */
  readonly choices?: readonly number[];
  /** The settings.c row (or the header that defines its constant). */
  readonly source: string;
}

/**
 * settings.c rows, at the pinned tree. `PID_GAIN_MAX` is 250
 * (flight/pid.h), `TPA_MAX` 100 and the anti-gravity ceiling
 * `ITERM_ACCELERATOR_GAIN_MAX` 250 (both flight/pid.h), and the motor
 * output limit spans MOTOR_OUTPUT_LIMIT_PERCENT_MIN..MAX = 1..100
 * (drivers/motor_types.h).
 */
export const ADVANCED_PID_BOUNDS: Readonly<Record<AdvancedPidFieldKey, AdvancedPidBound>> =
  Object.freeze({
    dMaxRoll: {min: 0, max: 250, source: 'settings.c d_max_roll {0, PID_GAIN_MAX}'},
    dMaxPitch: {min: 0, max: 250, source: 'settings.c d_max_pitch {0, PID_GAIN_MAX}'},
    dMaxYaw: {min: 0, max: 250, source: 'settings.c d_max_yaw {0, PID_GAIN_MAX}'},
    dMaxGain: {min: 0, max: 100, source: 'settings.c PARAM_NAME_D_MAX_GAIN {0, 100}'},
    dMaxAdvance: {min: 0, max: 200, source: 'settings.c PARAM_NAME_D_MAX_ADVANCE {0, 200}'},

    feedforwardTransition: {
      min: 0,
      max: 100,
      source: 'settings.c PARAM_NAME_FEEDFORWARD_TRANSITION {0, 100}',
    },
    feedforwardSmoothFactor: {
      min: 0,
      max: 95,
      source: 'settings.c PARAM_NAME_FEEDFORWARD_SMOOTH_FACTOR {0, 95}',
    },
    feedforwardMaxRateLimit: {
      min: 0,
      max: 200,
      source: 'settings.c PARAM_NAME_FEEDFORWARD_MAX_RATE_LIMIT {0, 200}',
    },

    /* PD and D always exist; PDS is behind USE_WING, so it is NOT offered
       as a choice - a build without it would store a mode it does not
       implement. A board already reporting 2 keeps reporting 2; this is
       the list of values this application may SEND. */
    tpaMode: {
      min: 0,
      max: 1,
      choices: [0, 1],
      source: 'settings.c PARAM_NAME_TPA_MODE lookup {PD, D, [PDS behind USE_WING]}',
    },
    tpaRate: {min: 0, max: 100, source: 'settings.c PARAM_NAME_TPA_RATE {0, TPA_MAX}'},
    tpaBreakpoint: {
      min: 1000,
      max: 2000,
      source: 'settings.c PARAM_NAME_TPA_BREAKPOINT {PWM_RANGE_MIN, PWM_RANGE_MAX}',
    },

    itermRelax: {
      min: 0,
      max: 4,
      choices: [0, 1, 2, 3, 4],
      source: 'settings.c PARAM_NAME_ITERM_RELAX lookup {OFF, RP, RPY, RP_INC, RPY_INC}',
    },
    itermRelaxType: {
      min: 0,
      max: 1,
      choices: [0, 1],
      source: 'settings.c PARAM_NAME_ITERM_RELAX_TYPE lookup {GYRO, SETPOINT}',
    },
    itermRelaxCutoff: {
      min: 1,
      max: 50,
      source: 'settings.c PARAM_NAME_ITERM_RELAX_CUTOFF {1, 50}',
    },
    itermRotation: {
      min: 0,
      max: 1,
      choices: [0, 1],
      source: 'settings.c iterm_rotation lookup TABLE_OFF_ON',
    },
    antiGravityGain: {
      min: 0,
      max: 250,
      source: 'settings.c PARAM_NAME_ANTI_GRAVITY_GAIN {ITERM_ACCELERATOR_GAIN_OFF, _MAX}',
    },

    throttleBoost: {min: 0, max: 100, source: 'settings.c PARAM_NAME_THROTTLE_BOOST {0, 100}'},
    thrustLinearization: {min: 0, max: 150, source: 'settings.c thrust_linear {0, 150}'},
    vbatSagCompensation: {
      min: 0,
      max: 150,
      source: 'settings.c PARAM_NAME_VBAT_SAG_COMPENSATION {0, 150}',
    },
    motorOutputLimit: {
      min: 1,
      max: 100,
      source: 'settings.c PARAM_NAME_MOTOR_OUTPUT_LIMIT {PERCENT_MIN, PERCENT_MAX}',
    },
    angleLimit: {min: 10, max: 80, source: 'settings.c PARAM_NAME_ANGLE_LIMIT {10, 80}'},
    acroTrainerAngleLimit: {
      min: 10,
      max: 80,
      source: 'settings.c acro_trainer_angle_limit {10, 80}',
    },
    rateAccelLimit: {min: 0, max: 500, source: 'settings.c PARAM_NAME_ACC_LIMIT {0, 500}'},
    yawRateAccelLimit: {
      min: 0,
      max: 500,
      source: 'settings.c PARAM_NAME_ACC_LIMIT_YAW {0, 500}',
    },
    /* The lower bound is a NAMED SENTINEL, not a magnitude - see the
       field's own note above. MAX_AUTO_DETECT_CELL_COUNT is 8
       (sensors/battery.h), and AUTO_PROFILE_CELL_COUNT_CHANGE is -1 in the
       same header's enum. */
    autoProfileCellCount: {
      min: -1,
      max: 8,
      choices: Object.freeze([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]),
      source:
        'settings.c auto_profile_cell_count VAR_INT8 ' +
        '{AUTO_PROFILE_CELL_COUNT_CHANGE, MAX_AUTO_DETECT_CELL_COUNT}',
    },
  } as const);

export const ADVANCED_PID_FIELD_KEYS: readonly AdvancedPidFieldKey[] = Object.freeze(
  Object.keys(ADVANCED_PID_BOUNDS) as AdvancedPidFieldKey[],
);

/** The draft these fields start from: exactly what the board reported. */
export function createAdvancedPidDraft(advanced: MspPidAdvanced): AdvancedPidDraft {
  return Object.freeze({
    dMaxRoll: advanced.dMax[0],
    dMaxPitch: advanced.dMax[1],
    dMaxYaw: advanced.dMax[2],
    dMaxGain: advanced.dMaxGain,
    dMaxAdvance: advanced.dMaxAdvance,
    feedforwardTransition: advanced.feedforwardTransition,
    feedforwardSmoothFactor: advanced.feedforwardSmoothFactor,
    feedforwardMaxRateLimit: advanced.feedforwardMaxRateLimit,
    tpaMode: advanced.tpaMode,
    tpaRate: advanced.tpaRate,
    tpaBreakpoint: advanced.tpaBreakpoint,
    itermRelax: advanced.itermRelax,
    itermRelaxType: advanced.itermRelaxType,
    itermRelaxCutoff: advanced.itermRelaxCutoff,
    itermRotation: advanced.itermRotation,
    antiGravityGain: advanced.antiGravityGain,
    throttleBoost: advanced.throttleBoost,
    thrustLinearization: advanced.thrustLinearization,
    vbatSagCompensation: advanced.vbatSagCompensation,
    motorOutputLimit: advanced.motorOutputLimit,
    angleLimit: advanced.angleLimit,
    acroTrainerAngleLimit: advanced.acroTrainerAngleLimit,
    rateAccelLimit: advanced.rateAccelLimit,
    yawRateAccelLimit: advanced.yawRateAccelLimit,
    autoProfileCellCount: advanced.autoProfileCellCount,
  });
}

export function advancedPidDraftsEqual(a: AdvancedPidDraft, b: AdvancedPidDraft): boolean {
  return ADVANCED_PID_FIELD_KEYS.every(key => a[key] === b[key]);
}

/**
 * The fields whose values differ from the board's, by key.
 *
 * The save path needs this for the same reason validation does: a field
 * nobody touched is not this screen's business, even when the byte on the
 * board is outside the range the firmware would accept today.
 */
export function movedAdvancedFields(
  stored: AdvancedPidDraft,
  draft: AdvancedPidDraft,
): readonly AdvancedPidFieldKey[] {
  return ADVANCED_PID_FIELD_KEYS.filter(key => stored[key] !== draft[key]);
}

/**
 * CHANGE-SCOPED VALIDATION, for the reason `pidTuningModel` spells out at
 * its own bound check: holding a field the operator never touched to a
 * range would let one stored byte make the WHOLE screen unsaveable. A
 * board can carry a value this application has no business judging - but
 * the moment an operator moves one, it must land inside the firmware's own
 * bound, because MSP_SET_PID_ADVANCED does not clamp and will store
 * whatever arrives.
 *
 * With no stored draft to compare against there is no "unchanged" to
 * exempt, so every field is bounded - the stricter reading, which is the
 * right default when in doubt.
 */
export function invalidAdvancedFields(
  draft: AdvancedPidDraft,
  stored?: AdvancedPidDraft,
): readonly AdvancedPidFieldKey[] {
  return ADVANCED_PID_FIELD_KEYS.filter(key => {
    if (stored !== undefined && stored[key] === draft[key]) return false;
    const bound = ADVANCED_PID_BOUNDS[key];
    const value = draft[key];
    if (!Number.isInteger(value)) return true;
    if (bound.choices !== undefined) return !bound.choices.includes(value);
    return value < bound.min || value > bound.max;
  });
}

/**
 * The same draft, read straight from the MSP_PID_ADVANCED payload.
 *
 * WHY NOT ALWAYS GO THROUGH `decodePidAdvancedFull`: that decoder needs the
 * API contract, because the contract decides the LIFETIME of three
 * retireable slots and nothing else. Not one field in this draft is one of
 * them, and `PID_ADVANCED_OFFSETS` is a single table that does not move
 * between the three versions this application speaks - so a draft can be
 * built from the bytes without threading a contract through every caller
 * that only wants to edit a tune.
 *
 * The widths match the decoder's, field for field: the three accel/anti-
 * gravity/breakpoint values are u16, the rest u8.
 */
export function createAdvancedPidDraftFromRaw(payload: Uint8Array): AdvancedPidDraft {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const o = PID_ADVANCED_OFFSETS;
  const u16 = (offset: number): number => view.getUint16(offset, true);
  return Object.freeze({
    dMaxRoll: payload[o.dMaxRoll],
    dMaxPitch: payload[o.dMaxPitch],
    dMaxYaw: payload[o.dMaxYaw],
    dMaxGain: payload[o.dMaxGain],
    dMaxAdvance: payload[o.dMaxAdvance],
    feedforwardTransition: payload[o.feedforwardTransition],
    feedforwardSmoothFactor: payload[o.feedforwardSmoothFactor],
    feedforwardMaxRateLimit: payload[o.feedforwardMaxRateLimit],
    tpaMode: payload[o.tpaMode],
    tpaRate: payload[o.tpaRate],
    tpaBreakpoint: u16(o.tpaBreakpoint),
    itermRelax: payload[o.itermRelax],
    itermRelaxType: payload[o.itermRelaxType],
    itermRelaxCutoff: payload[o.itermRelaxCutoff],
    itermRotation: payload[o.itermRotation],
    antiGravityGain: u16(o.antiGravityGain),
    throttleBoost: payload[o.throttleBoost],
    thrustLinearization: payload[o.thrustLinearization],
    vbatSagCompensation: payload[o.vbatSagCompensation],
    motorOutputLimit: payload[o.motorOutputLimit],
    angleLimit: payload[o.angleLimit],
    acroTrainerAngleLimit: payload[o.acroTrainerAngleLimit],
    rateAccelLimit: u16(o.rateAccelLimit),
    yawRateAccelLimit: u16(o.yawRateAccelLimit),
    // SIGNED: -1 is the "always follow the detected cell count" sentinel,
    // and reading this byte unsigned would turn it into 255.
    autoProfileCellCount: view.getInt8(o.autoProfileCellCount),
  });
}

/**
 * Patch a draft into a CLONE of the board's own payload.
 *
 * The clone matters: MSP_PID_ADVANCED carries roughly sixty bytes this
 * screen does not own, and the only safe way to write the ones it does is
 * to return every other byte exactly as it arrived.
 */
export function patchAdvancedPidDraft(payload: Uint8Array, draft: AdvancedPidDraft): void {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const o = PID_ADVANCED_OFFSETS;
  const u16 = (offset: number, value: number): void => view.setUint16(offset, value, true);
  payload[o.dMaxRoll] = draft.dMaxRoll;
  payload[o.dMaxPitch] = draft.dMaxPitch;
  payload[o.dMaxYaw] = draft.dMaxYaw;
  payload[o.dMaxGain] = draft.dMaxGain;
  payload[o.dMaxAdvance] = draft.dMaxAdvance;
  payload[o.feedforwardTransition] = draft.feedforwardTransition;
  payload[o.feedforwardSmoothFactor] = draft.feedforwardSmoothFactor;
  payload[o.feedforwardMaxRateLimit] = draft.feedforwardMaxRateLimit;
  payload[o.tpaMode] = draft.tpaMode;
  payload[o.tpaRate] = draft.tpaRate;
  u16(o.tpaBreakpoint, draft.tpaBreakpoint);
  payload[o.itermRelax] = draft.itermRelax;
  payload[o.itermRelaxType] = draft.itermRelaxType;
  payload[o.itermRelaxCutoff] = draft.itermRelaxCutoff;
  payload[o.itermRotation] = draft.itermRotation;
  u16(o.antiGravityGain, draft.antiGravityGain);
  payload[o.throttleBoost] = draft.throttleBoost;
  payload[o.thrustLinearization] = draft.thrustLinearization;
  payload[o.vbatSagCompensation] = draft.vbatSagCompensation;
  payload[o.motorOutputLimit] = draft.motorOutputLimit;
  payload[o.angleLimit] = draft.angleLimit;
  payload[o.acroTrainerAngleLimit] = draft.acroTrainerAngleLimit;
  u16(o.rateAccelLimit, draft.rateAccelLimit);
  u16(o.yawRateAccelLimit, draft.yawRateAccelLimit);
  // setInt8, to match the getInt8 above: -1 must go out as 0xFF, which is
  // what the firmware's own int8_t field reads back as -1.
  view.setInt8(o.autoProfileCellCount, draft.autoProfileCellCount);
}
