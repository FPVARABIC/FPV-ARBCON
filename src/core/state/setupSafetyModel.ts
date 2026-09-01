/**
 * SETUP P1 - the canonical Setup safety model.
 *
 * THE DEFECT THIS FILE EXISTS TO CLOSE. Before P1, SetupScreen derived its
 * arming readiness from two telemetry poll ids - `armed` and
 * `armingBlockers` - that NOTHING in the application ever registers (see
 * MspSessionCoordinator.ts, where both are documented as "a real,
 * intentional placeholder"). `useTelemetryValue` therefore returned
 * UNAVAILABLE for them forever, so the Safety Strip and the top-bar badge
 * were permanently "حالة التسليح غير مؤكدة" - while, on the same screen at
 * the same instant, the FC Tools gate correctly reported "غير متاح:
 * الطائرة مسلّحة" from the real BOXIDS + STATUS_EX path. This module
 * makes that contradiction unrepresentable: there is now exactly ONE
 * armed source and ONE readiness derivation, and both surfaces render it.
 *
 * WIRE TRUTH IN, PROVEN MEANING OUT. Pure: no React, no i18n, no I/O, no
 * clock. Like every other module under src/core it carries no Arabic -
 * it emits i18n KEYS (the convention flashPhaseModel.ts and
 * mspClientErrorCodes.ts already established), and src/i18n/locales/ar.json
 * owns the wording.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: no readiness percentage, no "aircraft
 * healthy", no sensor health (the firmware mask proves DETECTION only),
 * no inference of ARMED from the arming-disable mask, and no latching -
 * a fact that is no longer fresh becomes UNKNOWN rather than lingering as
 * though it were current.
 */

import type {ArmedState, ArmingBlockerBit, SensorPresenceBit} from './armingBlockers';
import {SENSOR_PRESENCE_TOKENS} from './armingBlockers';
import type {
  ArmingBlockReason,
  ArmingBlockSeverity,
  ArmingReadiness,
} from './armingReadiness';
import type {DiagnosticsBlockers, DiagnosticsSensors} from './setupDiagnostics';

/* ------------------------------------------------------------------ *
 * Blocker severity
 * ------------------------------------------------------------------ */

/**
 * Severity per canonical blocker token. The ranking tiers are
 * armingReadiness.ts's own (CRITICAL_DANGER -> ARMING_BLOCKER -> WARNING
 * -> INFO); the assignment below follows the set-site each token was
 * proven at in armingBlockers.ts's header, not a guess about wording:
 *
 *  CRITICAL_DANGER - a live hazard is present or the aircraft could
 *      begin turning props the moment the condition clears:
 *      FAILSAFE / RX_FAILSAFE / BOXFAILSAFE (link or failsafe active),
 *      RUNAWAY_TAKEOFF / CRASH_DETECTED / CRASHFLIP (a flight event
 *      already happened), NOT_DISARMED and ARM_SWITCH (the arm switch is
 *      physically ON).
 *  ARMING_BLOCKER - the ordinary "this is why you cannot arm" set.
 *  WARNING - transient system conditions that clear on their own.
 *  INFO - the link is occupied by a tool the operator opened.
 *
 * BST is intentionally present here even though armingBlockers.ts found
 * no set-site for it: severity is this app's own presentation ranking,
 * not a claim about firmware meaning, and omitting it would make an
 * unmapped-but-known token fall through to the unknown-bit path.
 */
const BLOCKER_SEVERITY: Readonly<Record<string, ArmingBlockSeverity>> = Object.freeze({
  FAILSAFE: 'CRITICAL_DANGER',
  RX_FAILSAFE: 'CRITICAL_DANGER',
  BOXFAILSAFE: 'CRITICAL_DANGER',
  NOT_DISARMED: 'CRITICAL_DANGER',
  ARM_SWITCH: 'CRITICAL_DANGER',
  RUNAWAY_TAKEOFF: 'CRITICAL_DANGER',
  CRASH_DETECTED: 'CRITICAL_DANGER',
  CRASHFLIP: 'CRITICAL_DANGER',

  NO_GYRO: 'ARMING_BLOCKER',
  THROTTLE: 'ARMING_BLOCKER',
  ANGLE: 'ARMING_BLOCKER',
  NOPREARM: 'ARMING_BLOCKER',
  CALIBRATING: 'ARMING_BLOCKER',
  ACC_CALIBRATION: 'ARMING_BLOCKER',
  MOTOR_PROTOCOL: 'ARMING_BLOCKER',
  DSHOT_TELEM: 'ARMING_BLOCKER',
  DSHOT_BITBANG: 'ARMING_BLOCKER',
  GPS: 'ARMING_BLOCKER',
  RESC: 'ARMING_BLOCKER',
  PARALYZE: 'ARMING_BLOCKER',
  REBOOT_REQUIRED: 'ARMING_BLOCKER',
  ALTHOLD: 'ARMING_BLOCKER',
  POSHOLD: 'ARMING_BLOCKER',
  BST: 'ARMING_BLOCKER',

  BOOT_GRACE_TIME: 'WARNING',
  LOAD: 'WARNING',

  CLI: 'INFO',
  CMS_MENU: 'INFO',
  MSP: 'INFO',
});

/** Blocker tokens whose Arabic description is source-proven
 * (armingBlockers.ts's BLOCKER_TOKENS_WITH_PROVEN_DESCRIPTION excludes
 * BST). Kept as the i18n-key decision point so no screen invents wording. */
const BLOCKER_DESCRIPTION_KEY_PREFIX = 'diagnostics.blockerDescriptions.';

/**
 * A set bit with no mapping at the pinned authority is a REAL blocker the
 * app cannot name. It is never dropped and never renamed; it is shown
 * with its own bit index and hex, and it is deliberately given a
 * blocking severity so that an unknown future firmware bit can never
 * present as anything softer than "you cannot arm".
 */
const UNKNOWN_BLOCKER_SEVERITY: ArmingBlockSeverity = 'ARMING_BLOCKER';

/**
 * Turns the decoder's bit list into the presentation reasons the Safety
 * Strip renders. Order is preserved (bit order); ranking is the
 * renderer's own concern via rankArmingBlockReasons().
 */
export function describeArmingBlockers(
  bits: readonly ArmingBlockerBit[],
): readonly ArmingBlockReason[] {
  return Object.freeze(
    bits.map((bit): ArmingBlockReason => {
      if (bit.kind === 'UNKNOWN') {
        return Object.freeze({
          code: `BIT_${bit.bit}`,
          messageKey: 'diagnostics.blockersUnknownBit',
          messageParams: Object.freeze({bit: bit.bit, hex: bit.hex}),
          severity: UNKNOWN_BLOCKER_SEVERITY,
        });
      }
      const severity = BLOCKER_SEVERITY[bit.token];
      return Object.freeze({
        code: bit.token,
        // A token with no proven Arabic description falls back to the
        // canonical token itself rather than to invented wording.
        messageKey:
          severity === undefined
            ? 'diagnostics.blockerFallback'
            : `${BLOCKER_DESCRIPTION_KEY_PREFIX}${bit.token}`,
        messageParams:
          severity === undefined ? Object.freeze({token: bit.token}) : undefined,
        severity: severity ?? UNKNOWN_BLOCKER_SEVERITY,
      });
    }),
  );
}

/* ------------------------------------------------------------------ *
 * The canonical readiness rule
 * ------------------------------------------------------------------ */

/**
 * THE CRITICAL SAFETY RULE, unchanged in substance from Pass 7.4 but now
 * fed by evidence that actually exists.
 *
 * READY is derivable ONLY from proof on BOTH axes: an authoritative
 * DISARMED, AND a FRESH blocker reading that carried the field and had no
 * bit set. Absent, stale, unsupported or malformed blocker evidence
 * forces UNKNOWN - a stale "no blockers" reading may NEVER be reused to
 * claim READY.
 *
 * ARMED IS CHECKED FIRST and is deliberately not gated on blocker
 * freshness: the armed flag is its own independent ground truth about
 * whether the aircraft is armed RIGHT NOW, and once it is armed the
 * question "why can't I arm" is moot. Both pinned references surface
 * their armed indicator from the armed flag alone (Betaflight
 * Configurator's SetupTab, INAV's arming-flag table), never gated on a
 * separate diagnostics channel. An armed aircraft is therefore never
 * presented as "جاهزة للتسليح".
 *
 * `armed` here is the canonical ArmedState - proven from MSP_BOXIDS plus
 * the packed flight-mode flags (armingBlockers.ts's deriveArmedState),
 * and NEVER inferred from the arming-disable mask. Armed state and
 * arming blockers stay two separate facts.
 *
 * UNKNOWN IS NEVER SOFTENED: it never becomes DISARMED, and it never
 * becomes READY.
 */
export function deriveSetupArmingReadiness(
  armed: ArmedState,
  blockers: DiagnosticsBlockers,
): ArmingReadiness {
  if (armed === 'UNKNOWN') {
    return {status: 'UNKNOWN', cause: 'ARMED_UNPROVEN'};
  }
  if (armed === 'ARMED') {
    return {status: 'ARMED'};
  }
  // Authoritatively DISARMED from here on.
  if (blockers.kind === 'MALFORMED') {
    return {status: 'UNKNOWN', cause: 'BLOCKERS_MALFORMED'};
  }
  if (blockers.kind === 'UNCONFIRMED') {
    return {status: 'UNKNOWN', cause: 'BLOCKERS_UNCONFIRMED'};
  }
  if (blockers.kind === 'NONE_IN_THIS_READING') {
    return {status: 'READY'};
  }
  const reasons = [...describeArmingBlockers(blockers.bits)];
  // A REPORTED verdict always carries at least one bit (setupDiagnostics
  // emits NONE_IN_THIS_READING for an empty mask), so an empty reason
  // list would mean evidence was dropped between the decoder and here.
  // Refuse to present that as READY.
  if (reasons.length === 0) {
    return {status: 'UNKNOWN', cause: 'BLOCKERS_UNCONFIRMED'};
  }
  return {status: 'BLOCKED', reasons};
}

/* ------------------------------------------------------------------ *
 * Safety flags (RXLOSS / FAILSAFE / BOXFAILSAFE / reboot required)
 * ------------------------------------------------------------------ */

/**
 * A momentary firmware condition, with absence of proof kept distinct
 * from proof of absence. UNKNOWN is not a soft INACTIVE: a caller may
 * never render UNKNOWN as "all clear".
 */
export type SetupSafetyFlagState = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';

/** The three link/failsafe facts, each from its own verified bit of the
 * arming-disable mask (runtime_config.h:42-72 @ the pinned authority):
 * FAILSAFE = 1<<1, RX_FAILSAFE = 1<<2, BOXFAILSAFE = 1<<4. They stay
 * SEPARATE facts - collapsing them into one vague "receiver problem"
 * loses the distinction between a lost link, an active failsafe stage
 * and an operator-thrown failsafe switch. */
export interface SetupSafetyFlags {
  readonly rxLoss: SetupSafetyFlagState;
  readonly failsafe: SetupSafetyFlagState;
  readonly boxFailsafe: SetupSafetyFlagState;
}

const UNKNOWN_FLAGS: SetupSafetyFlags = Object.freeze({
  rxLoss: 'UNKNOWN',
  failsafe: 'UNKNOWN',
  boxFailsafe: 'UNKNOWN',
});

function flagFrom(
  blockers: DiagnosticsBlockers,
  token: string,
): SetupSafetyFlagState {
  if (blockers.kind === 'REPORTED') {
    return blockers.bits.some(bit => bit.kind === 'KNOWN' && bit.token === token)
      ? 'ACTIVE'
      : 'INACTIVE';
  }
  // A FRESH reading that carried the field with no bit set proves every
  // one of these conditions is currently absent.
  return blockers.kind === 'NONE_IN_THIS_READING' ? 'INACTIVE' : 'UNKNOWN';
}

/**
 * Derives the three link/failsafe facts from the SAME blocker evidence
 * the readiness derivation uses - no second decode, no second poll, and
 * no possibility of the strip and the warnings disagreeing.
 *
 * UNCONFIRMED and MALFORMED both yield UNKNOWN: a stale or inconsistent
 * frame may not keep an old failsafe warning visible as if it were
 * current, and may not be read as an all-clear either.
 */
export function deriveSetupSafetyFlags(
  blockers: DiagnosticsBlockers,
): SetupSafetyFlags {
  if (blockers.kind === 'UNCONFIRMED' || blockers.kind === 'MALFORMED') {
    return UNKNOWN_FLAGS;
  }
  return Object.freeze({
    rxLoss: flagFrom(blockers, 'RX_FAILSAFE'),
    failsafe: flagFrom(blockers, 'FAILSAFE'),
    boxFailsafe: flagFrom(blockers, 'BOXFAILSAFE'),
  });
}

/**
 * Reboot-required, from MSP_STATUS_EX's own readiness tail (bit 0 of
 * configState, decodeStatusExReadiness.ts) - the SAME frame Setup already
 * polls, so this costs no new command and no new poll.
 *
 * @param rebootRequired the decoded field; `undefined` when the frame's
 *        optional tail ended before it.
 * @param dataState the STATUS_EX lifecycle verdict. Only a FRESH reading
 *        may assert either answer: a stale frame must not leave the
 *        warning glowing as though it were current, and must not be read
 *        as "no reboot needed" either.
 */
export function deriveSetupRebootRequired(
  rebootRequired: boolean | undefined,
  dataState: string,
  malformedTail: boolean,
): SetupSafetyFlagState {
  if (dataState !== 'FRESH' || malformedTail || rebootRequired === undefined) {
    return 'UNKNOWN';
  }
  return rebootRequired ? 'ACTIVE' : 'INACTIVE';
}

/* ------------------------------------------------------------------ *
 * Sensor detection
 * ------------------------------------------------------------------ */

/**
 * DETECTION, never health. The firmware mask is `sensors(SENSOR_x)` -
 * it proves the FC found the hardware, and says nothing about whether it
 * is working correctly. There is deliberately no HEALTHY/UNHEALTHY member
 * and no per-sensor grade: no MSP command in this app's model reports
 * sensor health.
 */
export type SetupSensorState = 'DETECTED' | 'NOT_DETECTED' | 'UNKNOWN';

export type SetupUnknownSensorBit = Extract<SensorPresenceBit, {kind: 'UNKNOWN'}>;

export interface SetupSensorEntry {
  /** Canonical upstream token: GYRO, ACC, BARO, MAG, GPS, RANGEFINDER,
   * OPTICALFLOW. */
  readonly token: string;
  readonly state: SetupSensorState;
}

export interface SetupSensorSummary {
  readonly entries: readonly SetupSensorEntry[];
  /** Set bits above the pinned mapping, preserved verbatim rather than
   * discarded - a future firmware sensor must not vanish silently. The
   * type is narrowed to the UNKNOWN arm so a renderer can read `.hex`
   * without re-proving what this field already guarantees. */
  readonly unknownBits: readonly SetupUnknownSensorBit[];
  /** True when no current reading proves anything at all; every entry is
   * then UNKNOWN. */
  readonly unconfirmed: boolean;
}

/**
 * Presentation order, chosen for the operator rather than for the wire:
 * the two sensors an aircraft cannot fly without come first, then the
 * optional ones. The wire bit order (ACC first) is preserved inside
 * decodeSensorPresence and is not disturbed by this ordering.
 */
const SENSOR_PRESENTATION_ORDER: readonly string[] = Object.freeze([
  'GYRO',
  'ACC',
  'BARO',
  'MAG',
  'GPS',
  'RANGEFINDER',
  'OPTICALFLOW',
]);

export function deriveSetupSensorSummary(
  sensors: DiagnosticsSensors,
): SetupSensorSummary {
  if (sensors.kind === 'UNCONFIRMED') {
    return Object.freeze({
      entries: Object.freeze(
        SENSOR_PRESENTATION_ORDER.map(token =>
          Object.freeze({token, state: 'UNKNOWN' as const}),
        ),
      ),
      unknownBits: Object.freeze([]),
      unconfirmed: true,
    });
  }
  const detected = new Set(
    sensors.bits
      .filter(bit => bit.kind === 'KNOWN')
      .map(bit => (bit as {token: string}).token),
  );
  return Object.freeze({
    entries: Object.freeze(
      SENSOR_PRESENTATION_ORDER.map(token =>
        Object.freeze({
          token,
          state: (detected.has(token) ? 'DETECTED' : 'NOT_DETECTED') as SetupSensorState,
        }),
      ),
    ),
    unknownBits: Object.freeze(
      sensors.bits.filter(
        (bit): bit is SetupUnknownSensorBit => bit.kind === 'UNKNOWN',
      ),
    ),
    unconfirmed: false,
  });
}

/** Guards the presentation order against drift from the decoder's own
 * token list: every canonical token must appear exactly once. */
export const SETUP_SENSOR_TOKENS: readonly string[] = SENSOR_PRESENTATION_ORDER;
export const SETUP_SENSOR_TOKENS_MATCH_DECODER: boolean =
  SENSOR_PRESENTATION_ORDER.length === SENSOR_PRESENCE_TOKENS.length &&
  SENSOR_PRESENCE_TOKENS.every(token => SENSOR_PRESENTATION_ORDER.includes(token));

/* ------------------------------------------------------------------ *
 * Warning model (P1 foundation - not yet a rendered region)
 * ------------------------------------------------------------------ */

export type SetupWarningSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

/** Which screen owns the remedy. Setup never becomes the owner of a
 * configuration action merely because it can see the condition. */
export type SetupWarningOwner =
  | 'SETUP'
  | 'RECEIVER'
  | 'FAILSAFE'
  | 'POWER'
  | 'SENSORS';

export type SetupWarningId =
  | 'FC_DISCONNECTED'
  | 'FC_RECOVERING'
  | 'ARMED'
  | 'ARMING_BLOCKED'
  | 'REBOOT_REQUIRED'
  | 'RX_LOSS'
  | 'FAILSAFE'
  | 'BOX_FAILSAFE'
  | 'RECEIVER_SIGNAL_UNAVAILABLE'
  | 'BATTERY_WARNING'
  | 'BATTERY_CRITICAL';

export interface SetupWarning {
  readonly id: SetupWarningId;
  readonly severity: SetupWarningSeverity;
  readonly messageKey: string;
  readonly owner: SetupWarningOwner;
}

export interface SetupWarningInput {
  readonly connected: boolean;
  readonly recovering: boolean;
  readonly armed: ArmedState;
  readonly readinessStatus: 'ARMED' | 'READY' | 'BLOCKED' | 'UNKNOWN';
  readonly flags: SetupSafetyFlags;
  readonly rebootRequired: SetupSafetyFlagState;
  /** True only when the receiver channel currently proves it cannot
   * deliver a reading - never inferred from an RSSI value. */
  readonly receiverSignalUnavailable: boolean;
  /** The firmware's own battery enum, when a current reading proves one. */
  readonly batteryState: 'OK' | 'WARNING' | 'CRITICAL' | 'NOT_PRESENT' | 'INIT' | undefined;
}

const WARNING_KEY_PREFIX = 'setupWarnings.';

/**
 * The P1 warning list, in severity-then-declaration order. Every entry is
 * produced ONLY from a fact this module already proved; nothing here
 * polls, guesses or scores.
 *
 * Deliberately ABSENT from P1 (recorded, not forgotten): the live Motors
 * test-session warning (the shared predicate is pull-only and a reactive
 * seam belongs to Motors), speculative GPS warnings, heuristic sensor
 * warnings, and any aggregate readiness score.
 */
export function deriveSetupWarnings(
  input: SetupWarningInput,
): readonly SetupWarning[] {
  const warnings: SetupWarning[] = [];
  const push = (
    id: SetupWarningId,
    severity: SetupWarningSeverity,
    owner: SetupWarningOwner,
  ) => {
    warnings.push(
      Object.freeze({id, severity, messageKey: `${WARNING_KEY_PREFIX}${id}`, owner}),
    );
  };

  if (!input.connected) {
    push('FC_DISCONNECTED', 'CRITICAL', 'SETUP');
    // Nothing below can be proven about an aircraft this app is not
    // talking to; every other condition would be a stale claim.
    return Object.freeze(warnings);
  }
  if (input.recovering) {
    push('FC_RECOVERING', 'WARNING', 'SETUP');
  }
  if (input.armed === 'ARMED') {
    push('ARMED', 'CRITICAL', 'SETUP');
  }
  if (input.flags.rxLoss === 'ACTIVE') {
    push('RX_LOSS', 'CRITICAL', 'RECEIVER');
  }
  if (input.flags.failsafe === 'ACTIVE') {
    push('FAILSAFE', 'CRITICAL', 'FAILSAFE');
  }
  if (input.flags.boxFailsafe === 'ACTIVE') {
    push('BOX_FAILSAFE', 'CRITICAL', 'FAILSAFE');
  }
  if (input.batteryState === 'CRITICAL') {
    push('BATTERY_CRITICAL', 'CRITICAL', 'POWER');
  } else if (input.batteryState === 'WARNING') {
    push('BATTERY_WARNING', 'WARNING', 'POWER');
  }
  if (input.readinessStatus === 'BLOCKED') {
    push('ARMING_BLOCKED', 'WARNING', 'SETUP');
  }
  if (input.rebootRequired === 'ACTIVE') {
    push('REBOOT_REQUIRED', 'WARNING', 'SETUP');
  }
  if (input.receiverSignalUnavailable) {
    push('RECEIVER_SIGNAL_UNAVAILABLE', 'WARNING', 'RECEIVER');
  }
  return Object.freeze(warnings);
}
