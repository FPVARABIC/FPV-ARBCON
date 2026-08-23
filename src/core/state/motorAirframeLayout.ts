/**
 * M-D §24 - THIS APPLICATION'S OWN AIRFRAME LAYOUTS.
 *
 * WHAT THIS FIXES. MotorAirframeDiagram gated its drawing on the MOTOR
 * COUNT: any airframe reporting four motors got the Quad X picture, with
 * the Quad X corner assignment on it. Four motors is not four corners,
 * and five different mixers were being drawn as a Quad X:
 *
 *   QUADP        a plus frame - arms at 0/90/180/270, not at the corners
 *   Y4           two arms and a coaxial tail pair
 *   VTAIL4       a V tail; the rear pair is not where the drawing put it
 *   ATAIL4       an A tail, likewise
 *   QUADX_1234   an X, but numbered differently - see below
 *
 * QUADX_1234 IS THE INSTRUCTIVE ONE, because it is a genuine X and the
 * count test could never have caught it. From mixer_init.c @ 7348054f,
 * reading each table in motor-output order:
 *
 *   mixerQuadX[]      (line 84)    mixerQuadX1234[]  (line 243)
 *     output 0  REAR_R              output 0  FRONT_L
 *     output 1  FRONT_R             output 1  FRONT_R
 *     output 2  REAR_L              output 2  REAR_R
 *     output 3  FRONT_L             output 3  REAR_L
 *
 * Motor 1 is at the BACK RIGHT on one and the FRONT LEFT on the other.
 * Drawing the second with the first's assignment puts every number in the
 * wrong place - and an operator who spins motor 1 to find it, sees the
 * back-right propeller move, and believes the drawing, concludes their
 * motor order is wrong and starts "fixing" a correct aircraft.
 *
 * WHAT A LAYOUT MAY CONTAIN, AND WHAT IT MAY NOT.
 *
 *  - It maps a MOTOR NUMBER to a PLACE ON THE FRAME. That is all.
 *  - IT CARRIES NO ROTATION DIRECTION. Not CW, not CCW, not props-out.
 *    M-A established that actual propeller rotation is not readable as
 *    authoritative truth over MSP, and a mixer mode does not determine it
 *    either. There is no field for it here and a test enforces that.
 *  - IT CARRIES NO PHYSICAL PIN. Which timer output drives which motor is
 *    the output-reordering question, and it is answered elsewhere.
 *  - NOTHING HERE IS COPIED. The positions are this project's own, checked
 *    against the firmware tables quoted above. No Betaflight SVG, GLTF,
 *    stylesheet or coordinate set was consulted or reused.
 *
 * ADDING A MIXER MEANS AUTHORING AND CHECKING A LAYOUT. It does not mean
 * relaxing a condition. Everything absent from this file is drawn as a
 * numbered list, which is a correct answer rather than a degraded one.
 */

import {
  MIXER_MODE_QUADX,
  MIXER_MODE_QUADX_1234,
} from '../protocol/msp/decoding/decodeMixerConfig';
import type {MotorPhysicalPosition} from './motorVerificationModel';

/** One motor's place on the frame. Deliberately not named a "node": it is
 *  a claim about an aircraft, not about a drawing. */
export interface MotorAirframePlacement {
  /** MSP output slot, 1-based. Never reordered for a right-to-left
   *  interface - see motorAirframeRtl in the diagram's own tests. */
  readonly motorNumber: number;
  readonly position: MotorPhysicalPosition;
}

/**
 * The layouts this project has authored and checked, by mixer id.
 *
 * Both are quoted from mixer_init.c @ 7348054f in the header above. They
 * are the only two, and the shortness of this list is the point.
 */
const AUTHORED: ReadonlyMap<number, readonly MotorAirframePlacement[]> = new Map<
  number,
  readonly MotorAirframePlacement[]
>([
  [
    // mixerQuadX[] - mixer_init.c:84-89.
    MIXER_MODE_QUADX,
    Object.freeze([
      Object.freeze({motorNumber: 1, position: 'REAR_RIGHT' as const}),
      Object.freeze({motorNumber: 2, position: 'FRONT_RIGHT' as const}),
      Object.freeze({motorNumber: 3, position: 'REAR_LEFT' as const}),
      Object.freeze({motorNumber: 4, position: 'FRONT_LEFT' as const}),
    ]),
  ],
  [
    // mixerQuadX1234[] - mixer_init.c:243-248. Note this is NOT the row
    // above with the numbers shuffled by an editor: it is the firmware's
    // own second table, and it exists precisely because some builds
    // number their arms clockwise from the front left.
    MIXER_MODE_QUADX_1234,
    Object.freeze([
      Object.freeze({motorNumber: 1, position: 'FRONT_LEFT' as const}),
      Object.freeze({motorNumber: 2, position: 'FRONT_RIGHT' as const}),
      Object.freeze({motorNumber: 3, position: 'REAR_RIGHT' as const}),
      Object.freeze({motorNumber: 4, position: 'REAR_LEFT' as const}),
    ]),
  ],
]);

/**
 * The authored layout for a mixer, IF it matches the aircraft in front of
 * us.
 *
 * Returns undefined - meaning "draw a numbered list" - when:
 *   - the mixer id is unknown or has no authored layout;
 *   - the runtime motor count is not yet known;
 *   - the running firmware reported a DIFFERENT number of motors than the
 *     layout describes. A four-place drawing cannot represent a machine
 *     that reported six, and the mixer byte is not the authority on that
 *     count - MSP_MOTOR_CONFIG is.
 *
 * The last condition is the one that matters in practice: a mixer changed
 * without the reboot mixerInit() needs leaves the mixer byte and the motor
 * count disagreeing, and the drawing is the wrong thing to trust.
 */
export function authoredAirframeLayout(
  mixerModeRaw: number | undefined,
  motorNumbers: readonly number[],
): readonly MotorAirframePlacement[] | undefined {
  if (mixerModeRaw === undefined || motorNumbers.length === 0) {
    return undefined;
  }
  const layout = AUTHORED.get(mixerModeRaw);
  if (layout === undefined || layout.length !== motorNumbers.length) {
    return undefined;
  }
  // The layout describes motors 1..N; the caller's list must be the same
  // set. A mismatch means one of the two was built from something other
  // than the runtime count, and drawing either would be a guess.
  const expected = layout.map(placement => placement.motorNumber).join(',');
  if (expected !== [...motorNumbers].join(',')) {
    return undefined;
  }
  return layout;
}

/** Whether a mixer has an authored layout at all, independent of any
 *  particular aircraft. Used by tests and by the presentation layer's
 *  own gate; callers deciding what to DRAW should use
 *  authoredAirframeLayout, which also checks the count. */
export function mixerHasAuthoredLayout(mixerModeRaw: number | undefined): boolean {
  return mixerModeRaw !== undefined && AUTHORED.has(mixerModeRaw);
}

/** Every mixer id this file draws. Exported so the reference model's own
 *  claim can be checked against the artwork that actually exists, rather
 *  than the two lists drifting apart. */
export const MIXERS_WITH_AUTHORED_LAYOUT: readonly number[] = Object.freeze(
  [...AUTHORED.keys()].sort((left, right) => left - right),
);
