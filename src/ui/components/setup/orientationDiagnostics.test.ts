/**
 * TEMP — Pass 7.5B pitch/front hardware diagnostics — DO NOT MERGE
 *
 * Proves the diagnostic instrumentation is purely OBSERVATIONAL: every
 * reported value equals the existing production value at its checkpoint,
 * with no additional sign/unit/axis transformation introduced anywhere in
 * the diagnostic layer, and no mutation of any input. Projection
 * expectations are INDEPENDENT literals, precomputed from the documented
 * camera equations (azimuth -140deg, elevation 28deg, distance 6, focal
 * 1.6, pixelScale = minDim * 0.16) outside this codebase - never derived
 * by calling the production helpers.
 */

import {buildOrientationDiagnostics} from './orientationDiagnostics';
import {computeMotorFrame} from '../../orientation3d/droneSceneGeometry';
import {MATERIAL_COLOR} from '../../orientation3d/OrientationRenderer';
import {deriveOrientationViewState} from '../../../core';
import type {MspAttitude, OrientationViewState, TelemetryValue} from '../../../core';
import {colors} from '../../theme';

const VIEWPORT = {width: 260, height: 260};

function freshAttitude(rollDd: number, pitchDd: number, yawDeg: number): TelemetryValue<MspAttitude> {
  return {
    status: 'FRESH',
    value: {rollDecidegrees: rollDd, pitchDecidegrees: pitchDd, yawDegrees: yawDeg},
    updatedAtMs: 1_000,
  };
}

describe('buildOrientationDiagnostics - observational fidelity', () => {
  it('reports raw decoded values unchanged and converts decidegrees to degrees exactly (no sign change on roll, pitch, or yaw)', () => {
    const attitude = freshAttitude(123, -271, 184);
    const view = deriveOrientationViewState(attitude);
    const snap = buildOrientationDiagnostics(attitude, view, VIEWPORT, 1_087);

    expect(snap.raw).toEqual({rollDecidegrees: 123, pitchDecidegrees: -271, yawDegrees: 184});
    expect(snap.converted).toEqual({rawRollDeg: 12.3, rawPitchDeg: -27.1, rawYawDeg: 184});
    expect(snap.ageMs).toBe(87);
    expect(snap.status).toBe('FRESH');
  });

  it('render values exactly match the OrientationViewState the renderer consumes - the diagnostic layer adds no pitch/roll/yaw transformation of its own', () => {
    const attitude = freshAttitude(-450, 310, 43);
    const view = deriveOrientationViewState(attitude);
    const snap = buildOrientationDiagnostics(attitude, view, VIEWPORT);

    if (view.status !== 'LIVE') {
      throw new Error('expected LIVE view state');
    }
    expect(snap.render).toEqual({
      renderRollDeg: view.rollDeg,
      renderPitchDeg: view.pitchDeg,
      renderYawDeg: view.yawDeg,
    });
    if (!snap.render) {
      throw new Error('expected render values on a LIVE snapshot');
    }
    // Signs at both polarities are preserved end-to-end (production offset
    // is zero, so converted === render here - divergence would expose a
    // diagnostic-layer transformation).
    expect(snap.render.renderRollDeg).toBe(-45);
    expect(snap.render.renderPitchDeg).toBe(31);
    expect(snap.converted).toEqual({rawRollDeg: -45, rawPitchDeg: 31, rawYawDeg: 43});
  });

  it('model front identity matches the actual geometry and renderer material map (front = local +X = theme accent/blue; rear = theme error/red)', () => {
    const attitude = freshAttitude(0, 0, 0);
    const snap = buildOrientationDiagnostics(attitude, deriveOrientationViewState(attitude), VIEWPORT);

    expect(snap.modelFrontAxis).toBe('+X');
    expect(snap.frontMotors).toBe('BLUE PAIR');
    for (const motor of computeMotorFrame()) {
      expect(motor.isFront).toBe(motor.motorCenterLocal.x > 0);
    }
    expect(MATERIAL_COLOR.MOTOR_FRONT).toBe(colors.accent);
    expect(MATERIAL_COLOR.MOTOR_REAR).toBe(colors.error);
  });

  it('projected-front metrics match the production camera - centre projects exactly to the viewport centre at ANY orientation, and the zero-orientation front delta matches independent literals', () => {
    const attitudeZero = freshAttitude(0, 0, 0);
    const snapZero = buildOrientationDiagnostics(attitudeZero, deriveOrientationViewState(attitudeZero), VIEWPORT);
    expect(snapZero.projectedFront).toBeDefined();
    expect(snapZero.projectedFront!.centre.x).toBeCloseTo(130, 6);
    expect(snapZero.projectedFront!.centre.y).toBeCloseTo(130, 6);
    // Independent literals for the unit-forward point at zero orientation:
    expect(snapZero.projectedFront!.frontScreenDeltaX).toBeCloseTo(-6.408257454, 6);
    expect(snapZero.projectedFront!.frontScreenDeltaY).toBeCloseTo(-3.585384298, 6);
    expect(snapZero.projectedFront!.frontRiseFromZero).toBeCloseTo(0, 6);

    const attitudeCompound = freshAttitude(170, 310, 43);
    const snapCompound = buildOrientationDiagnostics(
      attitudeCompound,
      deriveOrientationViewState(attitudeCompound),
      VIEWPORT,
    );
    // Origin projection is orientation-invariant (the model centre is the
    // rotation fixed point) - still exactly the viewport centre.
    expect(snapCompound.projectedFront!.centre.x).toBeCloseTo(130, 6);
    expect(snapCompound.projectedFront!.centre.y).toBeCloseTo(130, 6);
  });

  it('frontRiseFromZero isolates pitch: at pitch-only +31deg it equals the independent literal, and is NEGATIVE (front point rises on screen under the current production convention)', () => {
    const attitude = freshAttitude(0, 310, 0);
    const snap = buildOrientationDiagnostics(attitude, deriveOrientationViewState(attitude), VIEWPORT);
    expect(snap.projectedFront!.frontRiseFromZero).toBeCloseTo(-4.427683751, 6);
    expect(snap.projectedFront!.frontRiseFromZero).toBeLessThan(0);
  });

  it('does not mutate the telemetry input or the orientation view-model output (deep-frozen inputs, value-compared after the call)', () => {
    const attitude: TelemetryValue<MspAttitude> = Object.freeze({
      status: 'FRESH',
      value: Object.freeze({rollDecidegrees: 123, pitchDecidegrees: -271, yawDegrees: 184}),
      updatedAtMs: 1_000,
    }) as TelemetryValue<MspAttitude>;
    const view = Object.freeze(deriveOrientationViewState(attitude)) as OrientationViewState;
    const attitudeCopy = JSON.parse(JSON.stringify(attitude));
    const viewCopy = JSON.parse(JSON.stringify(view));

    buildOrientationDiagnostics(attitude, view, VIEWPORT, 2_000);

    expect(JSON.parse(JSON.stringify(attitude))).toEqual(attitudeCopy);
    expect(JSON.parse(JSON.stringify(view))).toEqual(viewCopy);
  });

  it('STALE telemetry is marked STALE, retains the last raw/converted/render values, and reports the scheduler own ageMs', () => {
    const attitude: TelemetryValue<MspAttitude> = {
      status: 'STALE',
      value: {rollDecidegrees: 40, pitchDecidegrees: 20, yawDegrees: 90},
      updatedAtMs: 1_000,
      ageMs: 850,
    };
    const view = deriveOrientationViewState(attitude);
    const snap = buildOrientationDiagnostics(attitude, view, VIEWPORT, 99_999);

    expect(snap.status).toBe('STALE');
    expect(snap.ageMs).toBe(850);
    expect(snap.raw).toEqual({rollDecidegrees: 40, pitchDecidegrees: 20, yawDegrees: 90});
    expect(snap.render).toEqual({renderRollDeg: 4, renderPitchDeg: 2, renderYawDeg: 90});
    expect(snap.projectedFront).toBeDefined();
  });

  it('WAITING / ERROR / UNAVAILABLE are represented safely with no value fields', () => {
    for (const attitude of [
      {status: 'WAITING'} as TelemetryValue<MspAttitude>,
      {status: 'ERROR', error: new Error('x')} as TelemetryValue<MspAttitude>,
      {status: 'UNAVAILABLE'} as TelemetryValue<MspAttitude>,
    ]) {
      const view = deriveOrientationViewState(attitude);
      const snap = buildOrientationDiagnostics(attitude, view, VIEWPORT, 5_000);
      expect(snap.status).toBe(attitude.status);
      expect(snap.raw).toBeUndefined();
      expect(snap.converted).toBeUndefined();
      expect(snap.render).toBeUndefined();
      expect(snap.projectedFront).toBeUndefined();
      expect(snap.ageMs).toBeUndefined();
    }
  });
});
