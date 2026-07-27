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
 *     flags, reboot-required state, and MSP_MOTOR's live output values.
 *     These change second to second; freezing them into a "facts" object
 *     would invite a caller to trust a stale safety-relevant value. They
 *     belong to their own live readers.
 *
 *  2. SESSION IDENTITY - no sessionId, generation or MSP epoch appears in
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
 * NO COMPATIBILITY VERDICT IS COMPUTED HERE. Whether a given
 * configuration is acceptable for any particular operation is a separate,
 * safety-gated policy decision that has not been taken. This module
 * answers "what did the FC say", never "is that good enough".
 */

import type {MspApiVersion} from '../protocol/msp/decoding/decodeApiVersion';
import type {MspAdvancedConfig} from '../protocol/msp/decoding/decodeAdvancedConfig';
import type {MspFeatureConfig} from '../protocol/msp/decoding/decodeFeatureConfig';
import type {MspMixerConfig} from '../protocol/msp/decoding/decodeMixerConfig';
import type {MspMotorConfig} from '../protocol/msp/decoding/decodeMotorConfig';
import type {FlightControllerIdentity} from '../protocol/msp/identification/mspIdentificationTypes';

/**
 * The FC-observable motor configuration, assembled from already-decoded
 * responses. Every field traces to exactly one wire field; nothing is
 * inferred, defaulted or interpreted.
 */
export interface MotorStaticFacts {
  /** From the existing identification path (MSP_FC_VARIANT +
   * MSP_API_VERSION + MSP_BOARD_INFO), reused rather than re-derived. */
  readonly identity: FlightControllerIdentity;
  /** From MSP_API_VERSION, carried explicitly because motor schemas are
   * API-version-sensitive and a reader must be able to see which version
   * produced these facts. */
  readonly apiVersion: MspApiVersion;
  /** MSP_MIXER_CONFIG offset 0 - raw mixerMode_e. */
  readonly mixerModeRaw: number;
  /** MSP_MIXER_CONFIG offset 1 - FC configuration only. NOT evidence of
   * physical propeller direction. */
  readonly yawMotorsReversed: boolean;
  /** MSP_MOTOR_CONFIG offset 6 - the ONLY authority for motor count. */
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
  /** MSP_MOTOR_CONFIG offset 8 - raw; 0 is ambiguous between "disabled"
   * and "not compiled into this firmware". */
  readonly bidirectionalDshotRaw: number;
}

/**
 * Everything assembleMotorStaticFacts needs, named so a caller cannot
 * accidentally pass the wrong decoded structure positionally.
 */
export interface MotorStaticFactsInput {
  readonly identity: FlightControllerIdentity;
  readonly apiVersion: MspApiVersion;
  readonly mixerConfig: MspMixerConfig;
  readonly motorConfig: MspMotorConfig;
  readonly advancedConfig: MspAdvancedConfig;
  readonly featureConfig: MspFeatureConfig;
}

/**
 * Pure projection - no validation, no policy, no defaults. Every value is
 * copied straight from the decoded response that owns it.
 *
 * The result is frozen: these facts are read by safety-relevant code
 * later, and a shared mutable object would let one reader silently
 * rewrite another reader's view of the aircraft.
 */
export function assembleMotorStaticFacts(input: MotorStaticFactsInput): MotorStaticFacts {
  return Object.freeze({
    identity: input.identity,
    apiVersion: input.apiVersion,
    mixerModeRaw: input.mixerConfig.mixerModeRaw,
    yawMotorsReversed: input.mixerConfig.yawMotorsReversed,
    motorCount: input.motorConfig.motorCount,
    motorPoleCount: input.motorConfig.motorPoleCount,
    motorProtocolRaw: input.advancedConfig.motorProtocolRaw,
    motorIdleRaw: input.advancedConfig.motorIdleRaw,
    feature3dEnabled: input.featureConfig.feature3dEnabled,
    bidirectionalDshotRaw: input.motorConfig.dshotTelemetryRaw,
  });
}

/**
 * The COMPOSED form for callers that need to know which physical session
 * produced a set of facts. Identity stays outside the facts object
 * deliberately - see this file's own doc comment.
 *
 * `identity` is intentionally typed as an unconstrained generic rather
 * than importing a concrete session key: src/core must not depend on the
 * React Native session layer, so the platform supplies whatever
 * generation/epoch type it already owns.
 */
export interface MotorStaticFactsBinding<TSessionIdentity> {
  readonly identity: TSessionIdentity;
  readonly facts: MotorStaticFacts;
}

export function bindMotorStaticFacts<TSessionIdentity>(
  identity: TSessionIdentity,
  facts: MotorStaticFacts,
): MotorStaticFactsBinding<TSessionIdentity> {
  return Object.freeze({identity, facts});
}
