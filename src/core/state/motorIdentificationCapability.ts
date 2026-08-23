/**
 * MAY THE SHIPPED PHYSICAL-IDENTIFICATION MODEL BE APPLIED TO THIS
 * AIRCRAFT AT ALL?
 *
 * WHY THIS EXISTS. `MOTOR_TEST_EXPECTED_CONFIGURATION` describes exactly
 * four outputs on the four arms of a Quad X, and everything built on it
 * inherits that shape: the expected position and rotation shown beside the
 * selected motor, the four physical positions the verification wizard
 * offers, and the output-reorder proposal derived from those answers. Motor
 * CONTROL, by contrast, is already dynamic - the workspace renders a slider
 * per output from the count the flight controller reports.
 *
 * So without a gate the screen would ask an operator to place motors on
 * arms the airframe does not have, and would then offer to WRITE a mapping
 * derived from those answers. That is not a layout problem. It is the app
 * claiming a physical identity it has no model for.
 *
 * WHAT THIS MODULE DOES, AND ALL IT DOES. It answers one question, so the
 * UI has a single place to consult instead of comparing facts at each call
 * site. It performs no I/O, imports no controller and decides nothing about
 * motor commands: an unsupported result withdraws POSITION CLAIMS ONLY.
 * Numbered motor control stays available, because a numbered output is
 * addressable without knowing which arm it drives.
 *
 * THE QUESTION IT USED TO ASK, AND WHY THAT WAS WRONG. It used to ask "did
 * the flight controller report four motors?". M-D's visual inspection found
 * what that misses, on the production path, through the real screen:
 *
 *   FOUR MOTORS IS NOT FOUR CORNERS. QUADP is a plus frame, Y4 has a
 *   coaxial tail pair, VTAIL4 and ATAIL4 put their rear pair somewhere a
 *   corner drawing cannot represent. All four report four motors, and all
 *   four were offered Quad X positions and Quad X rotations.
 *
 *   QUADX_1234 IS WORSE, because it IS an X and the count test could never
 *   have caught it. Its motor 1 sits at the FRONT LEFT where Quad X puts
 *   motor 4. The diagram - already airframe-aware - drew M1 at the front
 *   left while the identity line one region above said REAR RIGHT. The same
 *   screen contradicted itself about the same motor, and an operator
 *   following the words would have reached for the wrong arm.
 *
 * THE QUESTION IT ASKS NOW. Is this aircraft the one the model was written
 * for, and does its authored layout still place every motor where the model
 * expects it? The placement half is asked of `motorAirframeLayout.ts` - the
 * ONE place that knows where an airframe's motors are - so:
 *
 *   - an airframe with no authored layout is unsupported (a hex, a V-tail);
 *   - an airframe whose authored layout DIFFERS from the model is
 *     unsupported (QUADX_1234), rather than being described with the wrong
 *     table;
 *   - QUADX is supported, exactly as before;
 *   - a V-tail or A-tail quad, whose four motors sit at the same four
 *     corners in the same output order but do NOT share the props-out
 *     rotations this model carries, is unsupported. M-E authored their
 *     layouts and that is exactly when the corner comparison stopped being
 *     sufficient on its own; see MOTOR_TEST_EXPECTED_MIXER_MODE.
 *
 * WHAT THIS IS NOT, SINCE M-E. It is not the gate on whether an operator
 * may spin one motor to see which propeller moves. That action needs no
 * position model at all - the operator is looking at the aircraft, not at
 * the screen - and it is available wherever a motor is commandable, on
 * every airframe, drawn or numbered. What this gate governs is the SHIPPED
 * QUAD X EXPECTATION: the expected position and rotation shown beside a
 * motor, the wizard's four-corner questions, and the output-reorder
 * proposal derived from the answers to them. Widening those to other
 * airframes would mean authoring their own expectations, not relaxing a
 * condition here.
 *
 * UNKNOWN IS NOT SUPPORTED. A missing mixer or a missing count is not a
 * Quad X until proven otherwise; treating either as one would restore the
 * exact assumption this module exists to remove.
 *
 * NOT A GENERALISED MODEL. Widening identification beyond the airframes
 * whose layout matches the shipped model is separate work: the wizard's
 * questions, the verification entries and the reorder derivation all
 * encode the same four-corner shape, and widening one without the others
 * would write a mapping to a flight controller from answers about arms
 * that were never asked about. This file only stops the current model from
 * being applied where it does not hold.
 */

import {authoredAirframeLayout, verificationPositionOf} from './motorAirframeLayout';
import {
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  MOTOR_TEST_EXPECTED_MIXER_MODE,
} from './motorVerificationModel';

/** How many outputs the shipped physical-identification model describes. */
export const MOTOR_IDENTIFICATION_MODEL_OUTPUT_COUNT =
  MOTOR_TEST_EXPECTED_CONFIGURATION.length;

export type MotorIdentificationCapability =
  /**
   * This aircraft's authored layout places every motor where the shipped
   * model expects it, so the model's four physical positions may be
   * offered. This is still an EXPECTATION about an airframe, never a
   * measurement - it says the model MAY apply, not that the aircraft is
   * wired the way the model describes.
   */
  | {readonly kind: 'SUPPORTED'}
  /** No airframe has been read from the flight controller yet. */
  | {readonly kind: 'UNSUPPORTED'; readonly reason: 'AIRFRAME_UNKNOWN'}
  /** No usable output count has been read from the flight controller yet. */
  | {readonly kind: 'UNSUPPORTED'; readonly reason: 'MOTOR_COUNT_UNKNOWN'}
  /**
   * Both were read, and this aircraft is not the airframe the model
   * describes - either no layout has been authored for it, or its layout
   * places the motors somewhere else. `motorCount` is carried for the
   * message; it is a fact about the aircraft, not the reason.
   */
  | {
      readonly kind: 'UNSUPPORTED';
      readonly reason: 'AIRFRAME_NOT_THE_MODEL';
      readonly mixerModeRaw: number;
      readonly motorCount: number;
    };

/** The model's own placement, as a comparable string. */
function placementSignature(
  placements: readonly {
    readonly motorNumber: number;
    readonly position: string;
  }[],
): string {
  return [...placements]
    .sort((left, right) => left.motorNumber - right.motorNumber)
    .map(placement => `${placement.motorNumber}:${placement.position}`)
    .join('|');
}

const MODEL_SIGNATURE = placementSignature(MOTOR_TEST_EXPECTED_CONFIGURATION);

/**
 * Total and pure.
 *
 * `mixerModeRaw` is MSP_MIXER_CONFIG offset 0 as the flight controller
 * reported it, or undefined when nothing has been read. `motorNumbers` is
 * the 1..N list the runtime count produced - the SAME list the workspace
 * renders sliders for, so control and identification can never disagree
 * about how many motors exist.
 */
export function evaluateMotorIdentificationCapability(
  mixerModeRaw: number | undefined,
  motorNumbers: readonly number[],
): MotorIdentificationCapability {
  if (motorNumbers.length === 0) {
    // A zero, negative or fractional count never becomes a motor number, so
    // an empty list is the single "no usable count" answer. It must not be
    // allowed to coincide with the model by accident.
    return Object.freeze({
      kind: 'UNSUPPORTED' as const,
      reason: 'MOTOR_COUNT_UNKNOWN' as const,
    });
  }
  if (mixerModeRaw === undefined) {
    return Object.freeze({
      kind: 'UNSUPPORTED' as const,
      reason: 'AIRFRAME_UNKNOWN' as const,
    });
  }
  const layout = authoredAirframeLayout(mixerModeRaw, motorNumbers);
  // Both conditions are load-bearing and neither implies the other. The
  // mixer must be the one the model was written for, because a V-tail
  // occupies the same four corners with different rotations; and the
  // authored layout must still agree with the model, so that editing one
  // table without the other closes this gate rather than mis-claiming.
  const placed =
    layout === undefined
      ? undefined
      : layout.placements.map(placement => ({
          motorNumber: placement.motorNumber,
          position: verificationPositionOf(placement) ?? 'NOT_A_CORNER',
        }));
  if (
    placed === undefined ||
    mixerModeRaw !== MOTOR_TEST_EXPECTED_MIXER_MODE ||
    placementSignature(placed) !== MODEL_SIGNATURE
  ) {
    return Object.freeze({
      kind: 'UNSUPPORTED' as const,
      reason: 'AIRFRAME_NOT_THE_MODEL' as const,
      mixerModeRaw,
      motorCount: motorNumbers.length,
    });
  }
  return Object.freeze({kind: 'SUPPORTED' as const});
}
