/**
 * Motor read-capability pass - the immutable, purely-derived record of
 * what the FLIGHT CONTROLLER reports about its own motor configuration.
 *
 * PURE. This module performs no I/O, sends no MSP request, holds no
 * session state and starts no timer. It is a value-assembly function over
 * already-decoded payloads, exactly like src/core/state's other derivers.
 *
 * WHAT "STATIC" MEANS HERE, precisely: configuration that cannot change
 * without the operator changing it (and, for most of these, rebooting the
 * FC). It is the opposite of live telemetry. Three categories are
 * therefore DELIBERATELY EXCLUDED:
 *
 *  1. DYNAMIC FC STATE - armed state, battery state, arming-disable
 *     flags, reboot-required state, RPM, ESC temperature, and MSP_MOTOR's
 *     live output values. These change second to second; freezing them
 *     into a "facts" object would invite a caller to trust a stale
 *     safety-relevant value. They belong to their own live readers.
 *
 *  2. SESSION IDENTITY - no session generation or MSP epoch appears in
 *     this type. Facts describe the aircraft, not the connection. Where a
 *     caller needs to know which session a set of facts came from, it
 *     composes the two separately (see MotorStaticFactsBinding below)
 *     rather than smuggling identity into the facts themselves.
 *
 *  3. USER-PROVIDED HARDWARE FACTS - frame name, motor model, KV rating,
 *     ESC model, ESC firmware, battery brand/capacity/C-rating, physical
 *     propeller rotation direction, and mechanical condition. NONE of
 *     these is discoverable over MSP. They are absent from this type by
 *     construction so that nothing in the codebase can present an
 *     operator-supplied claim as if the flight controller had reported
 *     it.
 *
 * TWO DIFFERENT THINGS ARE CALLED "IDENTITY" IN THIS DOMAIN, and this
 * module never lets them share a name:
 *  - `flightControllerIdentity` - WHICH AIRCRAFT (firmware variant,
 *    board, API version). Lives inside the facts.
 *  - `sessionIdentity` - WHICH CONNECTION (physical generation + MSP
 *    epoch). Lives outside the facts, on the binding only.
 *
 * EVERY EXPOSED VALUE IS A DEFENSIVE SNAPSHOT, not a caller-owned
 * reference. `Object.freeze` is shallow, so freezing a facts object that
 * merely points at the caller's decoded identity would leave every nested
 * field writable through the original reference - a "frozen" object whose
 * contents another holder can silently rewrite. Instead each nested
 * object is copied field by field and frozen from the inside out, and
 * every Uint8Array is copied into a newly allocated frozen plain number
 * array (Object.freeze cannot freeze a non-empty typed array, and
 * Readonly<T> is a compile-time annotation with no runtime effect).
 *
 * NO COMPATIBILITY VERDICT IS COMPUTED HERE. Whether a given
 * configuration is acceptable for any particular operation is a separate,
 * safety-gated policy decision that has not been taken. This module
 * answers "what did the FC say", never "is that good enough".
 */

import type {MspApiVersion} from '../protocol/msp/decoding/decodeApiVersion';
import type {MspBoardInfo} from '../protocol/msp/decoding/decodeBoardInfo';
import type {MspAdvancedConfig} from '../protocol/msp/decoding/decodeAdvancedConfig';
import type {MspFeatureConfig} from '../protocol/msp/decoding/decodeFeatureConfig';
import type {MspMixerConfig} from '../protocol/msp/decoding/decodeMixerConfig';
import type {MspMotorConfig} from '../protocol/msp/decoding/decodeMotorConfig';
import type {BoxIdsOwnerIdentity} from '../protocol/msp/identification/BoxIdsAcquisition';
import type {
  FlightControllerIdentity,
  MspFcFamily,
  MspFcVariant,
} from '../protocol/msp/identification/mspIdentificationTypes';

/* ------------------------------------------------------------------ *
 * Immutable snapshot types.
 *
 * These deliberately MIRROR the existing identification types rather
 * than reusing them: MspApiVersion, MspFcVariant and MspBoardInfo are
 * mutable interfaces owned by the decoding layer, and re-exporting them
 * through a type that promises immutability would be a promise this
 * module cannot keep. Each snapshot below carries the same information
 * with readonly members, and with typed-array fields replaced by frozen
 * plain byte arrays.
 * ------------------------------------------------------------------ */

/** Immutable mirror of MspApiVersion. */
export interface MotorStaticFactsApiVersionSnapshot {
  readonly mspProtocolVersion: number;
  readonly apiVersionMajor: number;
  readonly apiVersionMinor: number;
}

/** Immutable mirror of MspFcVariant. */
export interface MotorStaticFactsFirmwareSnapshot {
  readonly identifier: string;
  readonly knownFamily: MspFcFamily;
}

/**
 * Immutable mirror of MspBoardInfo. Field for field identical, except
 * that `signature` and `trailingBytes` become frozen plain byte arrays -
 * a Uint8Array cannot be frozen while it has elements, so exposing one
 * would hand every caller a writable window into the snapshot.
 *
 * The optional members stay optional and are copied only when the
 * decoder actually produced them, so an absent field stays absent rather
 * than becoming an own key holding `undefined`.
 */
export interface MotorStaticFactsBoardSnapshot {
  readonly boardIdentifier: string;
  readonly hardwareRevision: number;
  readonly boardType: number;
  readonly targetCapabilities: number;
  readonly targetName: string;
  readonly boardName: string;
  readonly manufacturerId: string;
  /** Frozen copy of MspBoardInfo.signature, byte for byte, in order. */
  readonly signature: ReadonlyArray<number>;
  readonly mcuTypeId: number;
  readonly configurationState?: number;
  readonly gyroSampleRateHz?: number;
  readonly configurationProblems?: number;
  readonly spiRegisteredDeviceCount?: number;
  readonly i2cRegisteredDeviceCount?: number;
  /** Frozen copy of MspBoardInfo.trailingBytes, byte for byte, in order. */
  readonly trailingBytes: ReadonlyArray<number>;
}

/**
 * WHICH AIRCRAFT. Exactly the three identity categories the existing
 * FlightControllerIdentity supplies - no category invented, none
 * omitted - each one an immutable snapshot.
 */
export interface MotorStaticFactsFlightControllerIdentity {
  readonly apiVersion: MotorStaticFactsApiVersionSnapshot;
  readonly firmware: MotorStaticFactsFirmwareSnapshot;
  readonly board: MotorStaticFactsBoardSnapshot;
}

/**
 * WHICH CONNECTION. Structurally the composite MSP session identity this
 * codebase already uses - physical generation plus MSP epoch - taken by
 * Pick from its defining module so the two can never drift apart.
 *
 * Deliberately NOT named after BoxIds: that pairing is the codebase's
 * general "one activation of one physical session" key (see
 * FcToolsController's own generation + epoch composition), and the motor
 * domain has nothing to do with flight-mode box identifiers. This alias
 * exists so the public motor API never speaks BoxIds terminology.
 */
export type MotorStaticFactsSessionIdentity = Pick<
  BoxIdsOwnerIdentity,
  'physicalGeneration' | 'mspEpoch'
>;

/**
 * The FC-observable motor configuration, assembled from already-decoded
 * responses. Every field traces to exactly one wire field; nothing is
 * inferred, defaulted, renamed or interpreted.
 */
export interface MotorStaticFacts {
  /** WHICH AIRCRAFT - never the connection. An immutable snapshot of the
   * existing identification path (MSP_FC_VARIANT + MSP_API_VERSION +
   * MSP_BOARD_INFO), and the ONLY place an API version appears: read it
   * as `facts.flightControllerIdentity.apiVersion`. There is deliberately
   * no second copy that could disagree with this one. */
  readonly flightControllerIdentity: MotorStaticFactsFlightControllerIdentity;
  /** MSP_MIXER_CONFIG offset 0 - raw mixerMode_e. */
  readonly mixerModeRaw: number;
  /** MSP_MIXER_CONFIG offset 1. The FC's STORED CONFIGURATION FLAG only:
   * it does NOT prove actual physical motor rotation direction, does NOT
   * prove the propellers are installed props-out, and is NOT a
   * mechanical-condition claim. */
  readonly yawMotorsReversedConfigured: boolean;
  /** MSP_MOTOR_CONFIG offset 6 - the ONLY authority for motor count.
   * MSP_MOTOR always returns eight slots, so its non-zero entries are
   * never a count. */
  readonly motorCount: number;
  /** MSP_MOTOR_CONFIG offset 7. */
  readonly motorPoleCount: number;
  /** MSP_ADVANCED_CONFIG offset 3 - raw motorProtocolTypes_e. */
  readonly motorProtocolRaw: number;
  /** MSP_ADVANCED_CONFIG offset 6 - hundredths of a percent (550 ==
   * 5.5%). Configuration only; no motor command may be derived from it. */
  readonly motorIdleRaw: number;
  /** MSP_FEATURE_CONFIG bit 12 - the single authority for 3D state. */
  readonly feature3dEnabled: boolean;
  /** MSP_MOTOR_CONFIG offset 8, carried under the firmware's OWN field
   * name (`useDshotTelemetry`, msp.c:1454 @ BETAFLIGHT_2025_12_2_COMMIT)
   * and unreinterpreted. Raw: 0 is ambiguous between "disabled" and "not
   * compiled into this firmware build", and this module resolves nothing. */
  readonly dshotTelemetryRaw: number;
}

/**
 * Everything assembleMotorStaticFacts needs, named so a caller cannot
 * accidentally pass the wrong decoded structure positionally.
 *
 * There is no separate apiVersion member: the API version reaches the
 * facts only through flightControllerIdentity, which already carries it,
 * so no second value exists to disagree.
 */
export interface MotorStaticFactsInput {
  readonly flightControllerIdentity: FlightControllerIdentity;
  readonly mixerConfig: MspMixerConfig;
  readonly motorConfig: MspMotorConfig;
  readonly advancedConfig: MspAdvancedConfig;
  readonly featureConfig: MspFeatureConfig;
}

/**
 * Copies a decoded typed array into a newly allocated, frozen plain
 * number array. Byte order and every byte value are preserved exactly;
 * only the storage changes, because a Uint8Array with elements cannot be
 * frozen and would otherwise stay writable through the snapshot.
 */
function snapshotBytes(bytes: Uint8Array): ReadonlyArray<number> {
  return Object.freeze(Array.from(bytes));
}

function snapshotApiVersion(apiVersion: MspApiVersion): MotorStaticFactsApiVersionSnapshot {
  return Object.freeze({
    mspProtocolVersion: apiVersion.mspProtocolVersion,
    apiVersionMajor: apiVersion.apiVersionMajor,
    apiVersionMinor: apiVersion.apiVersionMinor,
  });
}

function snapshotFirmware(firmware: MspFcVariant): MotorStaticFactsFirmwareSnapshot {
  return Object.freeze({
    identifier: firmware.identifier,
    knownFamily: firmware.knownFamily,
  });
}

function snapshotBoard(board: MspBoardInfo): MotorStaticFactsBoardSnapshot {
  return Object.freeze({
    boardIdentifier: board.boardIdentifier,
    hardwareRevision: board.hardwareRevision,
    boardType: board.boardType,
    targetCapabilities: board.targetCapabilities,
    targetName: board.targetName,
    boardName: board.boardName,
    manufacturerId: board.manufacturerId,
    signature: snapshotBytes(board.signature),
    mcuTypeId: board.mcuTypeId,
    // Conditional spreads, not unconditional assignment: an optional
    // field the firmware never sent must stay ABSENT, not become an own
    // key holding undefined.
    ...(board.configurationState !== undefined
      ? {configurationState: board.configurationState}
      : {}),
    ...(board.gyroSampleRateHz !== undefined ? {gyroSampleRateHz: board.gyroSampleRateHz} : {}),
    ...(board.configurationProblems !== undefined
      ? {configurationProblems: board.configurationProblems}
      : {}),
    ...(board.spiRegisteredDeviceCount !== undefined
      ? {spiRegisteredDeviceCount: board.spiRegisteredDeviceCount}
      : {}),
    ...(board.i2cRegisteredDeviceCount !== undefined
      ? {i2cRegisteredDeviceCount: board.i2cRegisteredDeviceCount}
      : {}),
    trailingBytes: snapshotBytes(board.trailingBytes),
  });
}

/** Frozen from the inside out: every child is already frozen by the time
 * its parent is, so no unfrozen object is ever reachable from the
 * result. */
function snapshotFlightControllerIdentity(
  identity: FlightControllerIdentity,
): MotorStaticFactsFlightControllerIdentity {
  return Object.freeze({
    apiVersion: snapshotApiVersion(identity.apiVersion),
    firmware: snapshotFirmware(identity.firmware),
    board: snapshotBoard(identity.board),
  });
}

/**
 * Pure projection - no validation, no policy, no defaults. Every value is
 * copied straight from the decoded response that owns it.
 *
 * The result is a complete defensive snapshot, frozen from the inside
 * out: no caller-owned object, array or typed array is reachable through
 * it. These facts are read by safety-relevant code later, and a shared
 * mutable object would let one holder silently rewrite another holder's
 * view of the aircraft.
 */
export function assembleMotorStaticFacts(input: MotorStaticFactsInput): MotorStaticFacts {
  return Object.freeze({
    flightControllerIdentity: snapshotFlightControllerIdentity(input.flightControllerIdentity),
    mixerModeRaw: input.mixerConfig.mixerModeRaw,
    yawMotorsReversedConfigured: input.mixerConfig.yawMotorsReversedConfigured,
    motorCount: input.motorConfig.motorCount,
    motorPoleCount: input.motorConfig.motorPoleCount,
    motorProtocolRaw: input.advancedConfig.motorProtocolRaw,
    motorIdleRaw: input.advancedConfig.motorIdleRaw,
    feature3dEnabled: input.featureConfig.feature3dEnabled,
    dshotTelemetryRaw: input.motorConfig.dshotTelemetryRaw,
  });
}

/**
 * The COMPOSED form for callers that need to know which physical session
 * produced a set of facts. Session identity stays OUTSIDE the facts
 * object deliberately - see this file's own doc comment - and both
 * members are named for what they actually are, so
 * `binding.sessionIdentity` can never be confused with
 * `binding.facts.flightControllerIdentity`.
 *
 * Not generic: the binding accepts only the two-field composite session
 * identity, so a bare number or an unrelated object is a compile error
 * rather than an opaque payload nobody can interpret.
 */
export interface MotorStaticFactsBinding {
  readonly sessionIdentity: MotorStaticFactsSessionIdentity;
  readonly facts: MotorStaticFacts;
}

export function bindMotorStaticFacts(
  sessionIdentity: MotorStaticFactsSessionIdentity,
  facts: MotorStaticFacts,
): MotorStaticFactsBinding {
  return Object.freeze({
    // Projected field by field, not stored by reference: a caller that
    // keeps mutating its own session key must not be able to rewrite
    // which session a set of facts was recorded against.
    sessionIdentity: Object.freeze({
      physicalGeneration: sessionIdentity.physicalGeneration,
      mspEpoch: sessionIdentity.mspEpoch,
    }),
    facts,
  });
}
