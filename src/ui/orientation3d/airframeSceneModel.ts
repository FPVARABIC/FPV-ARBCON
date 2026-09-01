/**
 * THE ONE TRANSLATION FROM "WHAT THE BOARD REPORTED" TO "WHAT TO DRAW".
 *
 * =====================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================
 *
 * M-F3F §10 asks for ONE observed-airframe truth and forbids a second
 * conflicting source. `observedAirframeTruth` holds the raw facts - the
 * mixer mode and the runtime motor count, exactly as read - and
 * `authoredAirframeLayout()` is the single table that says what a mixer
 * mode means. This module is the only place that puts those two together
 * for the Setup model, and it invents nothing of its own: every rotor it
 * emits comes from a placement in that table, and the table names the
 * firmware source each row was read from.
 *
 * The Motors diagram reads the SAME table for the same aircraft. That is
 * what makes the two screens agree by construction rather than by two
 * people remembering to keep two lists in step (§30).
 *
 * =====================================================================
 * WHEN IT REFUSES TO ANSWER, AND WHY THAT IS THE POINT
 * =====================================================================
 *
 * `undefined` means "this application cannot say what this aircraft is",
 * and the scene draws no rotors at all rather than a stand-in. There are
 * exactly three ways to get it, and none of them is a failure to try:
 *
 *  1. Nothing has been read. No board, no session, no answer.
 *  2. The mixer mode has no authored layout - CUSTOM, or a mode this
 *     project has not transcribed from the firmware. §17: an unknown
 *     airframe NEVER normalises to a quadcopter.
 *  3. The board reported no runtime motor count, or a count that
 *     CONTRADICTS the layout for its own mixer - eight motors on a board
 *     reporting a tricopter. `authoredAirframeLayout()` already refuses
 *     both, for the reason written at its own definition: a mixer stored
 *     without the restart mixerInit() needs leaves the mixer byte and
 *     the motor count disagreeing, and the drawing is then the wrong
 *     thing to trust. That gate is REUSED here rather than reimplemented
 *     - a second copy of it is a second source (§10).
 *
 * In all three the orientation model still renders - hub, nose arrow,
 * level grid - so the screen keeps doing its actual job while making no
 * claim about the airframe.
 */

import {
  authoredAirframeLayout,
  type AirframeLayout,
} from '../../core/state/motorAirframeLayout';
import type {ObservedAirframe} from '../../core/state/observedAirframeTruth';
import type {DroneSceneAirframe} from './droneSceneGeometry';

/**
 * The scene model for an authored layout.
 *
 * A straight coordinate carry-over: the layout's own planform x/y and
 * deck, with no reinterpretation. If this function ever needed to
 * "adjust" a position it would mean the scene had an opinion about
 * airframes, which is exactly what §10 forbids.
 */
export function sceneAirframeFromLayout(layout: AirframeLayout): DroneSceneAirframe {
  return Object.freeze({
    rotors: Object.freeze(
      layout.placements.map(placement =>
        Object.freeze({x: placement.x, y: placement.y, deck: placement.deck}),
      ),
    ),
    silhouette: layout.silhouette,
  });
}

/**
 * The scene model for what the board reported - or nothing, honestly.
 *
 * See the three refusal cases in this file's own header; each returns
 * `undefined` and none of them substitutes a different aircraft.
 */
export function sceneAirframeFor(
  observed: ObservedAirframe | undefined,
): DroneSceneAirframe | undefined {
  if (observed === undefined || observed.motorCount === undefined) {
    return undefined;
  }
  /* The runtime count, expressed the way the layout gate expects it:
     outputs 1..N. The gate then checks that the mixer's authored layout
     describes exactly that set, so a count that contradicts the mixer
     yields no aircraft - see case 3 in this file's header. */
    const motorNumbers = Array.from(
    {length: observed.motorCount},
    (_unused, index) => index + 1,
  );
  const layout = authoredAirframeLayout(observed.mixerModeRaw, motorNumbers);
  return layout === undefined ? undefined : sceneAirframeFromLayout(layout);
}
