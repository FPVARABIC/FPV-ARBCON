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
  | 'BETAFLIGHT_API_1_48';

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
 * API 1.48 keeps the motor-test, telemetry and blocking DShot-command wire
 * contracts used here, but the wider configuration API changed.  It is
 * therefore admitted for the reviewed bench operations only; settings saves
 * remain unavailable until every setter/readback pair has its own 1.48
 * fixtures.
 */
const BETAFLIGHT_API_1_48_CAPABILITIES: readonly MotorFirmwareCapability[] =
  Object.freeze([
    'MOTOR_OUTPUTS_READ',
    'ESC_TELEMETRY_READ',
    'MOTOR_CONFIGURATION_READ',
    'MOTOR_TEST_WRITE',
    'ESC_DIRECTION_WRITE',
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
 * Betaflight APIs 1.46, 1.47 and 1.48 have separate capability sets. INAV,
 * EmuFlight, unknown families, and any other API revision intentionally fail
 * closed for writes until their own adapters and fixtures exist; none is
 * coerced into another revision's semantics.
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
