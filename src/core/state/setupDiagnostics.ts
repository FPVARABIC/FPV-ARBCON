/**
 * Pass 7.7, Region 4 (التشخيص والجاهزية) - the PURE presentation model.
 * Wire truth in, proven meaning out; no rendering, no hooks, no polling.
 *
 * Truthfulness rules encoded here rather than in the component, so they
 * are directly unit-testable:
 *
 *  - Sensors are only ever "reported as detected" (a set bit in the FC's
 *    own sensor-presence mask). Never "healthy", never a health grade,
 *    and an EMPTY mask is reported as "no sensor reported in this
 *    reading" - never converted into a conclusion about the FC.
 *  - Blockers are REPORTED only from a FRESH reading that actually
 *    carried the arming-disable field. A fresh mask of zero says only
 *    that the FC reported no blocker IN THAT READING - never "ready to
 *    fly". Missing / short / unsupported / stale / failed data all
 *    collapse to UNCONFIRMED: absence of data is never "no problems".
 *  - Unknown blocker bits and unknown sensor bits are preserved
 *    numerically/in hex by decodeArmingBlockers/decodeSensorPresence and
 *    passed through untouched.
 *  - One failed channel is confined to its own field: identity and
 *    compatibility still render when the STATUS_EX channel is dead, and
 *    vice versa.
 */

import type {FlightControllerIdentity, MspFcFamily} from '../protocol';
import type {MspStatusExDiagnostics} from '../protocol';
import {decodeArmingBlockers, decodeSensorPresence} from './armingBlockers';
import type {ArmingBlockerBit, SensorPresenceBit} from './armingBlockers';

/** Structurally identical to the platform layer's
 * AuxTelemetryChannelState - restated here so core stays free of any
 * platform import. */
export type DiagnosticsChannelState = 'ACTIVE' | 'UNSUPPORTED' | 'DECODE_FAILED' | 'DISABLED';

export type DiagnosticsTelemetryStatus = 'UNAVAILABLE' | 'WAITING' | 'FRESH' | 'STALE' | 'ERROR';

/** The single lifecycle verdict Region 4 renders from. */
export type DiagnosticsDataState = 'DISCONNECTED' | 'UNSUPPORTED' | 'UNAVAILABLE' | 'WAITING' | 'ERROR' | 'FRESH' | 'STALE';

export type DiagnosticsCompatibility =
  /** Identification has not settled yet. */
  | 'IDENTIFYING'
  | 'IDENTIFICATION_FAILED'
  /** Exactly BTFL + MSP API exactly 1.47 - this pass's own definition of
   * "identified for API authorization" (§8). */
  | 'BETAFLIGHT_API_1_47'
  /** Identified, but not that exact pair; readings are still shown, and
   * nothing that requires the pinned contract is authorized. */
  | 'OTHER_FIRMWARE_OR_API';

export interface DiagnosticsIdentity {
  readonly boardName: string;
  /** Raw 4-character wire identifier, e.g. "BTFL". */
  readonly firmwareIdentifier: string;
  readonly family: MspFcFamily;
  readonly apiVersionMajor: number;
  readonly apiVersionMinor: number;
}

export type DiagnosticsSensors =
  /** No current reading proves anything about sensor presence. */
  | {readonly kind: 'UNCONFIRMED'}
  /** The FC's own mask for this reading; `bits` may legitimately be
   * empty (nothing reported), which is NOT a health statement. */
  | {readonly kind: 'REPORTED'; readonly bits: readonly SensorPresenceBit[]};

export type DiagnosticsBlockers =
  /** Cannot currently be confirmed (absent field, stale, error,
   * unsupported, disconnected, waiting). */
  | {readonly kind: 'UNCONFIRMED'}
  /** A FRESH reading that carried the field and had no bit set. */
  | {readonly kind: 'NONE_IN_THIS_READING'}
  | {readonly kind: 'REPORTED'; readonly bits: readonly ArmingBlockerBit[]};

export interface SetupDiagnosticsView {
  readonly dataState: DiagnosticsDataState;
  readonly compatibility: DiagnosticsCompatibility;
  /** Present only once identification SUCCEEDED. */
  readonly identity: DiagnosticsIdentity | undefined;
  readonly sensors: DiagnosticsSensors;
  readonly blockers: DiagnosticsBlockers;
}

export interface SetupDiagnosticsInput {
  /** Ownership state is ACTIVE. */
  readonly connected: boolean;
  readonly channelState: DiagnosticsChannelState;
  readonly status: DiagnosticsTelemetryStatus;
  /** The decoded value - defined only for FRESH/STALE. */
  readonly value: MspStatusExDiagnostics | undefined;
  readonly identificationStatus: 'IDLE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly identity: FlightControllerIdentity | undefined;
}

const UNCONFIRMED_SENSORS: DiagnosticsSensors = Object.freeze({kind: 'UNCONFIRMED' as const});
const UNCONFIRMED_BLOCKERS: DiagnosticsBlockers = Object.freeze({kind: 'UNCONFIRMED' as const});

/** The Region-3 aux precedence, extended with the two live states.
 * Identical ordering to resolveAuxCardGate() so Region 4 can never
 * disagree with the card grid about the same channel. */
function resolveDataState(input: SetupDiagnosticsInput): DiagnosticsDataState {
  if (!input.connected) {
    return 'DISCONNECTED';
  }
  if (input.channelState === 'UNSUPPORTED') {
    return 'UNSUPPORTED';
  }
  if (input.channelState === 'DECODE_FAILED' || input.channelState === 'DISABLED') {
    return 'ERROR';
  }
  if (input.status === 'UNAVAILABLE') {
    return 'UNAVAILABLE';
  }
  if (input.status === 'WAITING') {
    return 'WAITING';
  }
  if (input.status === 'ERROR') {
    return 'ERROR';
  }
  if (input.value === undefined) {
    // FRESH/STALE without a value cannot happen through the scheduler's
    // own TelemetryValue union; treated as absent data, never invented.
    return 'UNAVAILABLE';
  }
  return input.status === 'STALE' ? 'STALE' : 'FRESH';
}

function resolveCompatibility(input: SetupDiagnosticsInput): DiagnosticsCompatibility {
  if (input.identificationStatus === 'FAILED') {
    return 'IDENTIFICATION_FAILED';
  }
  if (input.identificationStatus !== 'SUCCEEDED' || input.identity === undefined) {
    return 'IDENTIFYING';
  }
  const {firmware, apiVersion} = input.identity;
  const exact =
    firmware.identifier === 'BTFL' && apiVersion.apiVersionMajor === 1 && apiVersion.apiVersionMinor === 47;
  return exact ? 'BETAFLIGHT_API_1_47' : 'OTHER_FIRMWARE_OR_API';
}

export function deriveSetupDiagnostics(input: SetupDiagnosticsInput): SetupDiagnosticsView {
  const dataState = resolveDataState(input);
  const compatibility = resolveCompatibility(input);
  const identity: DiagnosticsIdentity | undefined =
    input.identificationStatus === 'SUCCEEDED' && input.identity !== undefined
      ? Object.freeze({
          boardName: input.identity.board.boardName,
          firmwareIdentifier: input.identity.firmware.identifier,
          family: input.identity.firmware.knownFamily,
          apiVersionMajor: input.identity.apiVersion.apiVersionMajor,
          apiVersionMinor: input.identity.apiVersion.apiVersionMinor,
        })
      : undefined;

  const live = dataState === 'FRESH' || dataState === 'STALE';
  const value = live ? input.value : undefined;

  // A stale sensor mask still proves the FC DETECTED that hardware (the
  // same reasoning GpsCard's presence proof already uses), so sensors are
  // reported for STALE too - the section labels the reading as stale.
  const sensors: DiagnosticsSensors =
    value === undefined
      ? UNCONFIRMED_SENSORS
      : Object.freeze({kind: 'REPORTED' as const, bits: decodeSensorPresence(value.sensorPresenceMask)});

  // Blockers are a MOMENTARY condition: only a FRESH reading that
  // actually carried the field can confirm them.
  const mask = dataState === 'FRESH' ? value?.readiness.armingDisableFlags : undefined;
  let blockers: DiagnosticsBlockers = UNCONFIRMED_BLOCKERS;
  if (mask !== undefined) {
    const bits = decodeArmingBlockers(mask);
    blockers = bits.length === 0 ? Object.freeze({kind: 'NONE_IN_THIS_READING' as const}) : Object.freeze({kind: 'REPORTED' as const, bits});
  }

  return Object.freeze({dataState, compatibility, identity, sensors, blockers});
}
