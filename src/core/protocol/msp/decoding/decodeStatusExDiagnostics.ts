/**
 * Pass 7.7 - the SINGLE MSP_STATUS_EX decode used by the one existing
 * FC-status poll. Region 4 needs the readiness tail (arming-disable
 * flags, sensor mask, flight-mode bits) that decodeStatusEx()
 * deliberately stopped at; rather than registering a second STATUS_EX
 * poll (explicitly forbidden), the EXISTING poll's decoder is extended
 * here by composition:
 *
 *   decodeStatusEx()           - the unchanged 13-byte fixed prefix
 *   flightModeFlagsLow32       - offset 6, u32 LE, previously skipped
 *   decodeStatusExReadiness()  - the bounded OPTIONAL tail
 *
 * decodeStatusEx() still throws MspPayloadReadError for a frame shorter
 * than the fixed prefix (a genuinely malformed response), while every
 * tail field remains optional: a valid shorter payload simply decodes to
 * fewer readiness fields, never to invented ones.
 *
 * flightModeFlagsLow32 is read UNSIGNED (readU32LE) because JavaScript's
 * bitwise operators are signed-32-bit; every consumer tests its bits
 * arithmetically (armingBlockers.ts).
 */

import {decodeStatusEx} from './decodeStatusEx';
import type {MspStatusExCompact} from './decodeStatusEx';
import {decodeStatusExReadiness} from './decodeStatusExReadiness';
import type {MspStatusExReadiness} from './decodeStatusExReadiness';
import {MspPayloadReader} from './MspPayloadReader';

/** msp.c @ BETAFLIGHT_API147_COMMIT: the packed active-flight-mode bits
 * (low 32) start at payload offset 6. */
const FLIGHT_MODE_FLAGS_OFFSET = 6;

export interface MspStatusExDiagnostics extends MspStatusExCompact {
  /** Packed ACTIVE-box bits, low 32, unsigned. Their meaning requires the
   * MSP_BOXIDS mapping (packFlightModeFlags, msp_box.c:402-418) - the
   * bit positions are configuration dependent and are never guessed. */
  readonly flightModeFlagsLow32: number;
  /** The bounded optional tail; every field independently optional. */
  readonly readiness: MspStatusExReadiness;
}

export function decodeStatusExDiagnostics(payload: Uint8Array): MspStatusExDiagnostics {
  const compact = decodeStatusEx(payload);
  const reader = new MspPayloadReader(payload.subarray(FLIGHT_MODE_FLAGS_OFFSET));
  const flightModeFlagsLow32 = reader.readU32LE();
  return {...compact, flightModeFlagsLow32, readiness: decodeStatusExReadiness(payload)};
}
