/**
 * Versioned motor/ESC firmware capability matrix.
 *
 * This is the single answer to the question "may this build WRITE this
 * motor command for the identified flight-controller firmware?".  It is
 * deliberately separate from generic MSP compatibility: being able to
 * exchange MSP frames does not prove that a state-changing command has the
 * same payload or semantics on another firmware family or API revision.
 *
 * A profile is admitted only after both the raw firmware identifier and the
 * exact MSP API revision have been identified.  Unknown/newer firmware stays
 * visible to the rest of the application, but receives no motor write
 * capability until a separately reviewed adapter is added here.
 */

import type {FlightControllerIdentity} from '../protocol/msp/identification/mspIdentificationTypes';

export type MotorFirmwareAdapterId =
  | 'BETAFLIGHT_API_1_46'
  | 'BETAFLIGHT_API_1_47'
  | 'BETAFLIGHT_API_1_48'
  /** API 1.49 and above: reads admitted, every write withheld. See
   *  BETAFLIGHT_API_NEWER_READ_ONLY_CAPABILITIES for why. */
  | 'BETAFLIGHT_API_NEWER_READ_ONLY';

/** Immutable release authorities used to admit the two neighbouring
 * adapters that are not already pinned by the older protocol modules. */
export const BETAFLIGHT_API146_REVIEWED_COMMIT =
  '024f8e13d4e642eb6a380308685b9ea3aa3ef1a2';
export const BETAFLIGHT_API148_REVIEWED_COMMIT =
  'f625a99967cd6ade0a2d83bf9d7e6770d0d1ccd6';

export type MotorFirmwareCapability =
  | 'MOTOR_OUTPUTS_READ'
  | 'ESC_TELEMETRY_READ'
  | 'MOTOR_CONFIGURATION_READ'
  | 'MOTOR_CONFIGURATION_WRITE'
  | 'MOTOR_TEST_WRITE'
  | 'ESC_DIRECTION_WRITE';

export type MotorFirmwareUnsupportedReason =
  | 'FIRMWARE_FAMILY_UNSUPPORTED'
  | 'API_VERSION_UNVERIFIED';

export interface MotorFirmwareIdentitySnapshot {
  readonly firmwareIdentifier: string;
  readonly knownFamily: FlightControllerIdentity['firmware']['knownFamily'];
  readonly apiVersionMajor: number;
  readonly apiVersionMinor: number;
}

export type MotorFirmwareCompatibility =
  | {
      readonly status: 'SUPPORTED';
      readonly adapterId: MotorFirmwareAdapterId;
      readonly identity: MotorFirmwareIdentitySnapshot;
      readonly capabilities: readonly MotorFirmwareCapability[];
    }
  | {
      readonly status: 'UNSUPPORTED';
      readonly reason: MotorFirmwareUnsupportedReason;
      readonly identity: MotorFirmwareIdentitySnapshot;
      readonly capabilities: readonly [];
    };

const BETAFLIGHT_API_1_47_CAPABILITIES: readonly MotorFirmwareCapability[] =
  Object.freeze([
    'MOTOR_OUTPUTS_READ',
    'ESC_TELEMETRY_READ',
    'MOTOR_CONFIGURATION_READ',
    'MOTOR_CONFIGURATION_WRITE',
    'MOTOR_TEST_WRITE',
    'ESC_DIRECTION_WRITE',
  ]);

/**
 * Betaflight 4.5.2 / API 1.46 preserves the reviewed non-3D DShot external
 * value conversion, motor-count/config offsets, telemetry layout and
 * blocking DShot direction command. Its general settings setters are not
 * reused: API 1.46 still carries the historical min-throttle field that was
 * removed after 4.5, so configuration writes require a separate encoder.
 */
const BETAFLIGHT_API_1_46_CAPABILITIES: readonly MotorFirmwareCapability[] =
  Object.freeze([
    'MOTOR_OUTPUTS_READ',
    'ESC_TELEMETRY_READ',
    'MOTOR_CONFIGURATION_READ',
    'MOTOR_TEST_WRITE',
    'ESC_DIRECTION_WRITE',
  ]);

/**
 * API 1.48 CARRIES THE SAME MOTOR CONTRACT AS 1.47 - not "similar", not
 * "believed compatible": the handlers are the same source text.
 *
 * This entry previously withheld MOTOR_CONFIGURATION_WRITE with the note
 * "the wider configuration API changed ... until every setter/readback pair
 * has its own 1.48 fixtures".  That caution was never grounded in a
 * difference anybody had found, and it cost every Betaflight 4.7 board the
 * ability to change its motor protocol.  The difference was then looked for,
 * directly, in the two firmware trees:
 *
 *   tree A  src/main/msp/msp_protocol.h  API_VERSION_MINOR 47
 *   tree B  src/main/msp/msp_protocol.h  API_VERSION_MINOR 48
 *
 * Every MSP handler on this path is BYTE-FOR-BYTE IDENTICAL between them:
 *
 *   MSP_MOTOR_CONFIG          MSP_SET_MOTOR_CONFIG
 *   MSP_ADVANCED_CONFIG       MSP_SET_ADVANCED_CONFIG
 *   MSP_MIXER_CONFIG          MSP_SET_MIXER_CONFIG
 *   MSP_MOTOR_3D_CONFIG       MSP_SET_MOTOR_3D_CONFIG
 *   MSP_FEATURE_CONFIG        MSP_SET_FEATURE_CONFIG
 *   MSP_MOTOR
 *
 * So are the things those handlers depend on:
 *
 *   - motorProtocolTypes_e (drivers/motor_types.h) - identical, so
 *     DSHOT600 is still 7 and PROSHOT1000 still 8;
 *   - the CLI bounds for max_throttle, min_command, motor_idle and
 *     motor_poles (cli/settings.c) - identical;
 *   - features_e (config/feature.h) - the ONLY change in the whole set:
 *     FEATURE_RX_UDP = 1 << 1 was added on a bit that was previously
 *     unused.  The three bits this app owns are unmoved - MOTOR_STOP
 *     1 << 4, 3D 1 << 12, ESC_SENSOR 1 << 27 - and encodeFeatureConfiguration
 *     starts from the mask the board itself reported and rewrites only
 *     those three, so a bit it has never heard of is carried through
 *     untouched rather than cleared.
 *
 * Betaflight Configurator agrees from the other side: it supports 1.46,
 * 1.47 and 1.48 in a single build with no version branch in any of these
 * parsers or builders, and js/utils/EscProtocols.js - which decides which
 * protocols may be offered - is byte-identical between release 2025.12.2
 * and master, with ReorderPwmProtocols returning its argument unchanged.
 *
 * There is therefore nothing left to gate on, and the write is admitted.
 */
const BETAFLIGHT_API_1_48_CAPABILITIES: readonly MotorFirmwareCapability[] =
  Object.freeze([
    'MOTOR_OUTPUTS_READ',
    'ESC_TELEMETRY_READ',
    'MOTOR_CONFIGURATION_READ',
    'MOTOR_CONFIGURATION_WRITE',
    'MOTOR_TEST_WRITE',
    'ESC_DIRECTION_WRITE',
  ]);

/**
 * API 1.49 AND ABOVE: READ, NEVER WRITE.
 *
 * WHY NOT A WRITE. No published Betaflight source declares API 1.49.
 * Firmware master declares API_VERSION_MINOR 48 and the Configurator's
 * highest constant is API_VERSION_1_48, so the 1.49 setter payloads cannot
 * be read, cannot be compared, and cannot be proven.  A write built from a
 * guess lands on whatever field the new layout puts at that offset, and the
 * readback that follows would report the damage only after it was done.
 * Withheld, and named as unproven rather than as unsupported.
 *
 * WHY STILL A READ. Refusing the read too - which is what falling through
 * to no capabilities did - blocked the Motors screen outright on any board
 * newer than this build, which is both useless to the operator and out of
 * step with every other screen in the app (see betaflightApiFloor.ts: a
 * floor, no ceiling, lenient reading plus verified-only writing).
 *
 * The read is safe to attempt for a reason specific to how these payloads
 * are decoded, not by optimism:
 *
 *   - MspPayloadReader consumes a fixed prefix and IGNORES trailing bytes,
 *     so a longer future payload decodes its known head correctly;
 *   - a payload SHORTER than the prefix throws rather than returning
 *     zeroes, so a genuinely incompatible board fails closed and visibly;
 *   - Betaflight's own practice on this path is to preserve offsets and
 *     append - MSP_MOTOR_CONFIG still ships the dead minthrottle slot as a
 *     structural zero, MSP_ADVANCED_CONFIG still ships gyro_sync_denom and
 *     gyro_use_32khz - so a moved field would be a break with the habit of
 *     the entire reviewed history.
 *
 * That last point is an observed convention, not a guarantee, and the
 * consequence of it being broken is stated plainly: a read could then show
 * a wrong VALUE. It could not change the aircraft, because nothing here may
 * write.
 */
const BETAFLIGHT_API_NEWER_READ_ONLY_CAPABILITIES: readonly MotorFirmwareCapability[] =
  Object.freeze([
    'MOTOR_OUTPUTS_READ',
    'ESC_TELEMETRY_READ',
    'MOTOR_CONFIGURATION_READ',
  ]);

const NO_MOTOR_CAPABILITIES: readonly [] = Object.freeze([]);

function snapshotIdentity(
  identity: FlightControllerIdentity,
): MotorFirmwareIdentitySnapshot {
  return Object.freeze({
    firmwareIdentifier: identity.firmware.identifier,
    knownFamily: identity.firmware.knownFamily,
    apiVersionMajor: identity.apiVersion.apiVersionMajor,
    apiVersionMinor: identity.apiVersion.apiVersionMinor,
  });
}

/**
 * Resolves the exact reviewed adapter for an identified controller.
 *
 * Betaflight APIs 1.46, 1.47 and 1.48 have separate capability sets; 1.49
 * and above share one read-only set.  INAV, EmuFlight, unknown families and
 * any OLDER revision intentionally fail closed entirely until their own
 * adapters and fixtures exist; none is coerced into another revision's
 * semantics.
 *
 * Note the asymmetry, which is deliberate: an api revision BELOW the
 * reviewed range is a contract this app once had to read and no longer
 * does, while one ABOVE it is a contract that extends the reviewed one by
 * Betaflight's own append-only habit. The first is refused outright; the
 * second is read and never written.
 */
export function resolveMotorFirmwareCompatibility(
  identity: FlightControllerIdentity,
): MotorFirmwareCompatibility {
  const snapshot = snapshotIdentity(identity);
  if (snapshot.firmwareIdentifier !== 'BTFL') {
    return Object.freeze({
      status: 'UNSUPPORTED' as const,
      reason: 'FIRMWARE_FAMILY_UNSUPPORTED' as const,
      identity: snapshot,
      capabilities: NO_MOTOR_CAPABILITIES,
    });
  }
  if (snapshot.apiVersionMajor === 1 && snapshot.apiVersionMinor === 46) {
    return Object.freeze({
      status: 'SUPPORTED' as const,
      adapterId: 'BETAFLIGHT_API_1_46' as const,
      identity: snapshot,
      capabilities: BETAFLIGHT_API_1_46_CAPABILITIES,
    });
  }
  if (snapshot.apiVersionMajor === 1 && snapshot.apiVersionMinor === 47) {
    return Object.freeze({
      status: 'SUPPORTED' as const,
      adapterId: 'BETAFLIGHT_API_1_47' as const,
      identity: snapshot,
      capabilities: BETAFLIGHT_API_1_47_CAPABILITIES,
    });
  }
  if (snapshot.apiVersionMajor === 1 && snapshot.apiVersionMinor === 48) {
    return Object.freeze({
      status: 'SUPPORTED' as const,
      adapterId: 'BETAFLIGHT_API_1_48' as const,
      identity: snapshot,
      capabilities: BETAFLIGHT_API_1_48_CAPABILITIES,
    });
  }
  if (snapshot.apiVersionMajor === 1 && snapshot.apiVersionMinor >= 49) {
    return Object.freeze({
      status: 'SUPPORTED' as const,
      adapterId: 'BETAFLIGHT_API_NEWER_READ_ONLY' as const,
      identity: snapshot,
      capabilities: BETAFLIGHT_API_NEWER_READ_ONLY_CAPABILITIES,
    });
  }
  return Object.freeze({
    status: 'UNSUPPORTED' as const,
    reason: 'API_VERSION_UNVERIFIED' as const,
    identity: snapshot,
    capabilities: NO_MOTOR_CAPABILITIES,
  });
}

export function motorFirmwareSupports(
  compatibility: MotorFirmwareCompatibility,
  capability: MotorFirmwareCapability,
): boolean {
  return compatibility.status === 'SUPPORTED'
    ? compatibility.capabilities.includes(capability)
    : false;
}
