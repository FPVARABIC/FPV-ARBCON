/**
 * WHAT THIS APPLICATION ASKED AN ESC TO BECOME - AND NOTHING MORE.
 *
 * THE THIRD DIRECTION CONCEPT, KEPT APART FROM THE OTHER TWO:
 *
 *   EXPECTED   an airframe TEMPLATE says M3 should turn clockwise.
 *              An app constant. Not a reading, not a measurement.
 *   COMMANDED  this session sent a DShot spin-direction setting to an ESC
 *              and the flight controller accepted the request. THIS FILE.
 *   OBSERVED   a person watched the motor turn and said which way.
 *              `MotorObservation.direction`, and the only physical truth.
 *
 * WHY COMMANDED IS NOT A READING. The audited MSP surface has no command
 * that reports ESC spin direction: the setting is saved inside the ESC,
 * `MSP2_SEND_DSHOT_COMMAND` carries commands outward and returns nothing,
 * and a search of the pinned firmware for a spin-direction read finds
 * none. So the only thing this application can ever know about an ESC's
 * direction is what it asked for. A record here means "we asked, and the
 * request was accepted" - never "the ESC is now set this way", and never
 * "the motor now turns this way".
 *
 * WHY NORMAL/REVERSED IS NOT CW/CCW. `DSHOT_CMD_SPIN_DIRECTION_1` and
 * `_2` select which of an ESC's two stored directions is active. Which
 * physical rotation that produces also depends on how the three motor
 * phases are wired, so the same command on two identically-configured
 * ESCs can turn their motors opposite ways. The two vocabularies are
 * therefore deliberately NOT convertible here, and this module offers no
 * function that would let a caller compare a target with an observation.
 *
 * LIFETIME. The log is bound BY REFERENCE to one session token and is
 * memory-only: never written to disk, never keyed by a board identifier,
 * and dropped whole when the session it belongs to is replaced. A command
 * sent over one connection says nothing about the aircraft on the next.
 */

import type {DshotEscDirection} from '../protocol/msp/encoding/encodeDshotEscDirection';

/**
 * How the flight controller answered. There is no third, happier state:
 * an acceptance is still only an acceptance.
 */
export type MotorDirectionCommandStatus =
  /** The request was accepted and processed. Not a physical claim. */
  | 'ACKNOWLEDGED'
  /** The outcome is genuinely unknown - it may or may not have landed. */
  | 'UNCONFIRMED';

export interface MotorDirectionCommandRecord {
  readonly motorNumber: number;
  /** What was ASKED FOR. Never described as the ESC's current state. */
  readonly target: DshotEscDirection;
  readonly status: MotorDirectionCommandStatus;
}

export interface MotorDirectionCommandLog {
  /** The session this log belongs to, by reference. */
  readonly sessionToken: object | undefined;
  readonly records: readonly MotorDirectionCommandRecord[];
}

export const EMPTY_DIRECTION_COMMAND_LOG: MotorDirectionCommandLog =
  Object.freeze({sessionToken: undefined, records: Object.freeze([])});

/** Starts (or restarts) the log for one exact session. */
export function beginDirectionCommandLog(
  sessionToken: object,
): MotorDirectionCommandLog {
  return Object.freeze({sessionToken, records: Object.freeze([])});
}

/**
 * Records ONE command outcome against ONE motor.
 *
 * Rejected - by returning the log unchanged - when the caller's session
 * token is not this log's. A record minted under a replaced session must
 * never appear as evidence under the new one.
 *
 * A later command for the same motor REPLACES the earlier record, because
 * the later one is what was most recently asked for. Records for other
 * motors are untouched: a command aimed at M3 is not evidence about M2.
 */
export function recordDirectionCommand(
  log: MotorDirectionCommandLog,
  sessionToken: object,
  record: MotorDirectionCommandRecord,
): MotorDirectionCommandLog {
  if (log.sessionToken === undefined || log.sessionToken !== sessionToken) {
    return log;
  }
  if (!Number.isInteger(record.motorNumber) || record.motorNumber < 1) {
    return log;
  }
  const records = log.records.filter(
    entry => entry.motorNumber !== record.motorNumber,
  );
  records.push(Object.freeze({...record}));
  records.sort((left, right) => left.motorNumber - right.motorNumber);
  return Object.freeze({
    sessionToken: log.sessionToken,
    records: Object.freeze(records),
  });
}

/** The most recent command for one motor, or undefined if none was sent. */
export function directionCommandFor(
  log: MotorDirectionCommandLog,
  motorNumber: number,
): MotorDirectionCommandRecord | undefined {
  return log.records.find(entry => entry.motorNumber === motorNumber);
}

/**
 * Forgets what this application asked for. It does NOT ask an ESC to
 * revert anything, and callers must not present it as if it did - the
 * ESC keeps whatever it was last told, and this app cannot read that
 * back to check.
 */
export function clearDirectionCommands(
  log: MotorDirectionCommandLog,
): MotorDirectionCommandLog {
  return Object.freeze({
    sessionToken: log.sessionToken,
    records: Object.freeze([]),
  });
}
