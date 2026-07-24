/**
 * Pass 7.4, Step 1 - pure orientation view-model logic for Setup Region 2
 * (the live 3D orientation hero). Zero React/RN/3D-library dependency,
 * same convention as every other file under src/core - this is what lets
 * roll/pitch/yaw math, offset application, and stale-freeze behavior be
 * unit-tested without a GPU or WebGL context (per this pass's own
 * "Testing strategy" instruction).
 *
 * Pipeline (per the approved design): MSP Attitude -> Orientation View
 * Model (this file) -> 3D Renderer Adapter (Step 2) -> Setup UI. This
 * file owns ONLY the first arrow - it has no rendering logic of its own,
 * and the Step 2 renderer is REQUIRED to consume rollDeg/pitchDeg/yawDeg
 * from OrientationViewState exactly as given here rather than re-deriving
 * or re-transforming them.
 *
 * FIXED EULER ORDER (a real, stated decision, not left implicit): the
 * renderer must compose rotations intrinsically in yaw -> pitch -> roll
 * order - apply the yaw rotation (about the body's own vertical/up axis)
 * first, then pitch (about the resulting lateral/right axis), then roll
 * (about the resulting forward axis). This is the standard aerospace
 * Tait-Bryan ZYX convention, matching how Betaflight's own imu.c composes
 * its attitude estimate. Deliberately described by AXIS MEANING (up/
 * right/forward) here rather than by letter (X/Y/Z) - this file does no
 * rotation math of its own and does not own a coordinate system; the
 * actual renderer (droneSceneGeometry.ts) is the one place that assigns
 * concrete letters to these axes and must be treated as authoritative for
 * them (it uses +Y=up and +Z=right, NOT the classic aerospace X-forward/
 * Y-right/Z-down labeling an earlier draft of this comment mistakenly
 * used). This is stated once, here, specifically so Step 2 never has to
 * invent its own ad-hoc transform order.
 *
 * SIGN CONVENTION (adopted, NOT independently re-verified against
 * firmware source this pass - unlike the decidegree/whole-degree unit
 * split, which Pass 7.0 DID verify directly against imu.h/imu.c): positive
 * roll = right, positive pitch = nose up. This matches Betaflight
 * Configurator's own published attitude-indicator convention. Flagged
 * explicitly so it can be confirmed against real hardware during manual
 * Setup screen testing rather than silently trusted.
 */

import type {MspAttitude, TelemetryValue} from '../protocol';

export type OrientationViewOffset = {
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
};

export type OrientationViewState =
  | {status: 'WAITING'}
  | {status: 'LIVE'; rollDeg: number; pitchDeg: number; yawDeg: number}
  | {status: 'STALE'; rollDeg: number; pitchDeg: number; yawDeg: number; ageMs: number}
  | {status: 'ERROR'};

const ZERO_OFFSET: OrientationViewOffset = {rollDeg: 0, pitchDeg: 0, yawDeg: 0};

/** Roll/pitch are bank/tilt angles - best represented signed in (-180,
 * 180], matching decodeAttitude's own signed wire representation and
 * this file's own describeOrientationForAccessibility()'s left/right-
 * relative wording (e.g. "5 degrees left" reads far more naturally than
 * "355 degrees"). NOT used for yaw - see normalizeHeadingDegrees below. */
function normalizeSignedDegrees(deg: number): number {
  let normalized = deg % 360;
  if (normalized <= -180) {
    normalized += 360;
  }
  if (normalized > 180) {
    normalized -= 360;
  }
  return normalized;
}

/** Yaw is a compass heading, conventionally always shown in [0, 360) -
 * matching decodeAttitude's own doc comment (firmware itself normalizes
 * yaw to [0, 3600) decidegrees before the /10 conversion) and the
 * design spec's own accessibility example ("heading 274 degrees", never
 * a signed heading). Deliberately a SEPARATE function from
 * normalizeSignedDegrees above - collapsing them would silently turn a
 * heading like 350 degrees into -10 degrees, which is correct for a
 * bank angle but wrong for a heading readout. */
function normalizeHeadingDegrees(deg: number): number {
  const normalized = deg % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function toViewDegrees(
  attitude: MspAttitude,
  offset: OrientationViewOffset,
): {rollDeg: number; pitchDeg: number; yawDeg: number} {
  // Roll/pitch: decidegrees -> whole degrees (/10). Yaw: already whole
  // degrees on the wire (Pass 7.0's own verified finding) - do NOT
  // re-divide it.
  return {
    rollDeg: normalizeSignedDegrees(attitude.rollDecidegrees / 10 - offset.rollDeg),
    pitchDeg: normalizeSignedDegrees(attitude.pitchDecidegrees / 10 - offset.pitchDeg),
    yawDeg: normalizeHeadingDegrees(attitude.yawDegrees - offset.yawDeg),
  };
}

/**
 * Maps a raw MSP_ATTITUDE TelemetryValue + the current view offset (Pass
 * 7.1's SetupUiSessionState.orientationViewOffset - reset only, never
 * mutated here) to the four-state OrientationViewState Region 2 renders.
 *
 * UNAVAILABLE vs WAITING (a stated decision, per this session's own
 * design-review question): TelemetryValue's UNAVAILABLE (no scheduler
 * exists yet for this session) and WAITING (scheduler exists, first
 * dispatch hasn't settled) are deliberately COLLAPSED into a single
 * OrientationViewState{status:'WAITING'} here. Both mean exactly the same
 * thing to a user looking at Region 2 - "no orientation data to draw
 * yet" - and neither has a different correct rendering. The *reason* for
 * the wait (ownership not yet ACTIVE, vs. identify() occupying the MSP
 * queue for up to ~1s per Step 0.5's own confirmed finding) is
 * diagnostic story that belongs to Region 1's connection-state row,
 * which already exists to carry it - duplicating it into Region 2 would
 * violate the Unified Notice Model's "one concern per channel" principle
 * and leak an MspSessionCoordinator implementation detail across the
 * isolation boundary this view model exists to enforce.
 *
 * STALE freezes at the last LIVE roll/pitch/yaw (the offset-adjusted
 * values, not raw telemetry) and is derived directly from the underlying
 * TelemetryValue's own STALE variant - this function never computes
 * staleness itself, it only relays what MspTelemetryScheduler already
 * decided (see that file's own doc comment on why getValue() is a stable
 * cache lookup).
 *
 * The offset is applied uniformly to BOTH what Region 2's 3D model shows
 * AND what its plain-numeric roll/pitch/heading readouts show (a single
 * OrientationViewState feeds both) - a stated decision: the design's own
 * one-time hint text draws the line at "view (whatever Region 2
 * displays) vs FC calibration (an actual MSP trim command)", not at "3D
 * model vs numeric text". Showing the 3D pose as visually level while
 * the adjacent numeric readout still said "5 degrees" would be a worse,
 * self-contradictory user experience than the alternative.
 */
export function deriveOrientationViewState(
  telemetry: TelemetryValue<MspAttitude>,
  offset: OrientationViewOffset = ZERO_OFFSET,
): OrientationViewState {
  switch (telemetry.status) {
    case 'UNAVAILABLE':
    case 'WAITING':
      return {status: 'WAITING'};
    case 'FRESH':
      return {status: 'LIVE', ...toViewDegrees(telemetry.value, offset)};
    case 'STALE':
      return {status: 'STALE', ...toViewDegrees(telemetry.value, offset), ageMs: telemetry.ageMs};
    case 'ERROR':
      return {status: 'ERROR'};
  }
}

/**
 * Accessibility text alternative for Region 2's 3D model (per this
 * pass's own explicit accessibility requirement) - e.g. "ميلان 4 درجات
 * لليسار، ارتفاع المقدمة درجتان، الاتجاه 274 درجة" ("tilted 4 degrees to
 * the left, nose raised 2 degrees, heading 274 degrees"). Returns
 * undefined for WAITING/ERROR - there is no orientation to describe, and
 * the screen-reader-visible text elsewhere (a "waiting for data"/"error"
 * label) already covers those states without this function duplicating
 * it.
 */
export function describeOrientationForAccessibility(state: OrientationViewState): string | undefined {
  if (state.status !== 'LIVE' && state.status !== 'STALE') {
    return undefined;
  }

  const roll = Math.round(state.rollDeg);
  const pitch = Math.round(state.pitchDeg);
  const yaw = Math.round(state.yawDeg);

  const rollText = roll === 0 ? 'بدون ميل جانبي' : `ميلان ${Math.abs(roll)} درجة ${roll > 0 ? 'لليمين' : 'لليسار'}`;
  const pitchText =
    pitch === 0 ? 'المقدمة أفقية' : `${pitch > 0 ? 'ارتفاع المقدمة' : 'انخفاض المقدمة'} ${Math.abs(pitch)} درجة`;
  const yawText = `الاتجاه ${yaw} درجة`;

  return `${rollText}، ${pitchText}، ${yawText}`;
}
