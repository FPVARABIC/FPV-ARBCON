/**
 * TEMP — Pass 7.5B pitch/front hardware diagnostics — DO NOT MERGE
 *
 * Pure, observational snapshot builder for the temporary on-screen XYZ
 * diagnostics panel (TempXyzDiagnosticsPanel.tsx). Reports — WITHOUT
 * modifying — the exact values already flowing through the production
 * pipeline at three checkpoints:
 *   1. RAW:    decodeAttitude()'s wire values (decidegrees / degrees),
 *              straight off the TelemetryValue snapshot.
 *   2. CONVERTED: the plain unit conversion (roll/pitch ÷10, yaw as-is)
 *              BEFORE any display offset — recomputed here from the raw
 *              values by the same arithmetic deriveOrientationViewState()
 *              uses, so any divergence between this and RENDER exposes
 *              exactly what the offset/normalization layer contributed.
 *   3. RENDER: the OrientationViewState values the renderer actually
 *              consumes (offset-adjusted + normalized) — passed in, never
 *              recomputed, so this column is the ground truth of what the
 *              model was told to do.
 * Plus the projected-front screen metric derived from the UNCHANGED
 * production camera/geometry (computeFrontProjectionDiagnostics(),
 * droneSceneGeometry.ts — see its doc for the screen-Y sign convention).
 *
 * This module must never mutate its inputs and must introduce no sign,
 * unit, axis, or camera change of its own — enforced by
 * orientationDiagnostics.test.ts.
 */

import {computeFrontProjectionDiagnostics} from '../../orientation3d/droneSceneGeometry';
import type {FrontProjectionDiagnostics} from '../../orientation3d/droneSceneGeometry';
import type {MspAttitude, OrientationViewState, TelemetryValue} from '../../../core';

export type OrientationDiagnosticsSnapshot = {
  status: 'FRESH' | 'STALE' | 'WAITING' | 'ERROR' | 'UNAVAILABLE';
  /** STALE: the scheduler's own ageMs. FRESH: nowMs - updatedAtMs when a
   * nowMs was supplied. Otherwise undefined. */
  ageMs?: number;
  raw?: {rollDecidegrees: number; pitchDecidegrees: number; yawDegrees: number};
  converted?: {rawRollDeg: number; rawPitchDeg: number; rawYawDeg: number};
  render?: {renderRollDeg: number; renderPitchDeg: number; renderYawDeg: number};
  /** Confirmed from droneSceneGeometry.ts: front motors are exactly the
   * ones with local X > 0 (computeMotorFrame().isFront), the nose arrow
   * points toward +X, and OrientationRenderer's MATERIAL_COLOR maps
   * MOTOR_FRONT to the theme accent (blue) — verified by test, not
   * assumed. */
  modelFrontAxis: '+X';
  frontMotors: 'BLUE PAIR';
  projectedFront?: FrontProjectionDiagnostics;
};

export function buildOrientationDiagnostics(
  attitude: TelemetryValue<MspAttitude>,
  orientationView: OrientationViewState,
  viewportSize: {width: number; height: number},
  nowMs?: number,
): OrientationDiagnosticsSnapshot {
  const snapshot: OrientationDiagnosticsSnapshot = {
    status: attitude.status,
    modelFrontAxis: '+X',
    frontMotors: 'BLUE PAIR',
  };

  if (attitude.status === 'FRESH' || attitude.status === 'STALE') {
    const {rollDecidegrees, pitchDecidegrees, yawDegrees} = attitude.value;
    snapshot.raw = {rollDecidegrees, pitchDecidegrees, yawDegrees};
    snapshot.converted = {
      rawRollDeg: rollDecidegrees / 10,
      rawPitchDeg: pitchDecidegrees / 10,
      rawYawDeg: yawDegrees,
    };
    snapshot.ageMs =
      attitude.status === 'STALE'
        ? attitude.ageMs
        : nowMs !== undefined
          ? Math.max(0, nowMs - attitude.updatedAtMs)
          : undefined;
  }

  if (orientationView.status === 'LIVE' || orientationView.status === 'STALE') {
    snapshot.render = {
      renderRollDeg: orientationView.rollDeg,
      renderPitchDeg: orientationView.pitchDeg,
      renderYawDeg: orientationView.yawDeg,
    };
    snapshot.projectedFront = computeFrontProjectionDiagnostics(
      {rollDeg: orientationView.rollDeg, pitchDeg: orientationView.pitchDeg, yawDeg: orientationView.yawDeg},
      viewportSize,
    );
  }

  return snapshot;
}
