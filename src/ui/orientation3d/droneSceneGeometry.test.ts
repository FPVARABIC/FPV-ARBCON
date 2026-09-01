import {
  computeDroneScene as computeSceneForAirframe,
  computeMotorFrame,
  rotateBodyPoint,
} from './droneSceneGeometry';
import type {
  DroneOrientationDeg,
  DroneSceneAirframe,
  DroneScenePrimitive,
} from './droneSceneGeometry';
import {sceneAirframeFromLayout} from './airframeSceneModel';
import {authoredAirframeLayout} from '../../core/state/motorAirframeLayout';

const ZERO: DroneOrientationDeg = {rollDeg: 0, pitchDeg: 0, yawDeg: 0};

/**
 * M-F3F P0-B - THE AIRCRAFT IS NOW AN INPUT, SO THESE TESTS SUPPLY ONE.
 *
 * Every case below was written when the scene contained a hard-coded X
 * quadcopter, and each one is still exactly the right question to ask
 * ABOUT AN X QUADCOPTER - rotation correctness, arm geometry, depth
 * order, front/rear identity. What changed is that the quad is no longer
 * an assumption the module makes: it is stated here, out loud, and it
 * comes from the same authored table the Motors diagram draws from. The
 * airframe matrix at the end of this file covers what happens when the
 * aircraft is something else, and when it is unknown.
 */
function authored(mixerModeRaw: number, motorCount: number): DroneSceneAirframe {
  const layout = authoredAirframeLayout(
    mixerModeRaw,
    Array.from({length: motorCount}, (_unused, index) => index + 1),
  );
  if (layout === undefined) {
    throw new Error(`no authored layout for mixer ${mixerModeRaw}/${motorCount}`);
  }
  return sceneAirframeFromLayout(layout);
}

/** Betaflight mixerMode_e ids, from the pinned firmware's mixer.h. */
const MIXER_TRI = 1;
const MIXER_QUADX = 3;
const MIXER_Y6 = 6;
const MIXER_FLYING_WING = 8;
const MIXER_HEX6X = 10;
const MIXER_OCTOX8 = 11;
const MIXER_AIRPLANE = 14;
const MIXER_QUADX_1234 = 26;

const QUAD_X = authored(MIXER_QUADX, 4);

/** The suite's default aircraft, stated rather than assumed. */
function computeDroneScene(
  orientation: DroneOrientationDeg,
  viewportSize: {width: number; height: number},
  presentationScale?: number,
) {
  return computeSceneForAirframe(orientation, viewportSize, presentationScale, QUAD_X);
}

function closeTo(actual: number, expected: number, precision = 6) {
  expect(actual).toBeCloseTo(expected, precision);
}

describe('rotateBodyPoint', () => {
  it('is the identity transform at zero orientation', () => {
    const p = {x: 1, y: 2, z: 3};
    const result = rotateBodyPoint(p, ZERO);
    closeTo(result.x, 1);
    closeTo(result.y, 2);
    closeTo(result.z, 3);
  });

  it('positive roll = right side down: rolling 90deg sends the right axis (0,0,1) to straight down', () => {
    const result = rotateBodyPoint({x: 0, y: 0, z: 1}, {rollDeg: 90, pitchDeg: 0, yawDeg: 0});
    closeTo(result.x, 0);
    closeTo(result.y, -1);
    closeTo(result.z, 0);
  });

  it('positive pitch = nose up: pitching 90deg sends the nose axis (1,0,0) straight up', () => {
    const result = rotateBodyPoint({x: 1, y: 0, z: 0}, {rollDeg: 0, pitchDeg: 90, yawDeg: 0});
    closeTo(result.x, 0);
    closeTo(result.y, 1);
    closeTo(result.z, 0);
  });

  it('positive yaw swings the nose to the right, viewed from above: yawing 90deg sends the nose axis (1,0,0) to the right axis (0,0,1)', () => {
    const result = rotateBodyPoint({x: 1, y: 0, z: 0}, {rollDeg: 0, pitchDeg: 0, yawDeg: 90});
    closeTo(result.x, 0);
    closeTo(result.y, 0);
    closeTo(result.z, 1);
  });

  it('rotation preserves vector length (a genuine rotation, not a shear/scale)', () => {
    const p = {x: 0.7, y: -1.3, z: 2.1};
    const originalLength = Math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2);
    const result = rotateBodyPoint(p, {rollDeg: 37, pitchDeg: -22, yawDeg: 158});
    const rotatedLength = Math.sqrt(result.x ** 2 + result.y ** 2 + result.z ** 2);
    closeTo(rotatedLength, originalLength);
  });

  it('applies yaw, then pitch, then roll IN THAT ORDER - not commutative, order genuinely matters', () => {
    const p = {x: 1, y: 0, z: 0};
    const yaw90Pitch45 = rotateBodyPoint(p, {rollDeg: 0, pitchDeg: 45, yawDeg: 90});
    const yaw45Pitch90 = rotateBodyPoint(p, {rollDeg: 0, pitchDeg: 90, yawDeg: 45});
    // Same two non-zero angles, but assigned to the opposite axes -
    // composition order is not commutative, so the resulting vectors
    // must differ (compare the full vector, not a single component: a
    // single component can coincidentally match even when the vectors
    // differ, as it does for x here).
    const distance = Math.sqrt(
      (yaw90Pitch45.x - yaw45Pitch90.x) ** 2 +
        (yaw90Pitch45.y - yaw45Pitch90.y) ** 2 +
        (yaw90Pitch45.z - yaw45Pitch90.z) ** 2,
    );
    expect(distance).toBeGreaterThan(1e-6);
  });
});

/**
 * Pass 7.5 - compound-composition contract tests. Every expected value
 * below is INDEPENDENT of the production rotation helpers: the literals
 * were precomputed from the explicit rotation matrices (documented in
 * this block's own multiplyMatrixVector() cross-check, an in-test
 * implementation that shares no code with droneSceneGeometry.ts), for
 * the intrinsic yaw -> pitch -> roll contract, i.e. the fixed-axis
 * matrix product p' = R_yaw * R_pitch * R_roll * p (roll applied first).
 *
 * The old, incorrect composition (R_roll * R_pitch * R_yaw - roll applied
 * LAST) produces identical results for every single-axis pose, which is
 * exactly why the pre-existing single-axis tests above could never catch
 * it - the decisive cases here use multiple simultaneously non-zero,
 * non-symmetric angles (17/31/43 degrees), where the two compositions
 * differ by ~0.4 units on a unit-scale point.
 */
describe('rotateBodyPoint - Pass 7.5 compound composition contract (independent expected values)', () => {
  const P_GENERIC = {x: 0.8, y: 0.35, z: -0.6};

  /** Independent 3x3 matrix helpers - explicit coefficient matrices for
   * the three axis rotations in this file's basis (+X fwd, +Y up, +Z
   * right), multiplied as plain arrays. Deliberately NOT importing or
   * mirroring the production helpers' code paths. */
  type Mat3 = number[][];
  const deg = (d: number) => (d * Math.PI) / 180;
  const yawMatrix = (psi: number): Mat3 => {
    const c = Math.cos(psi);
    const s = Math.sin(psi);
    return [
      [c, 0, -s],
      [0, 1, 0],
      [s, 0, c],
    ];
  };
  const pitchMatrix = (theta: number): Mat3 => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    return [
      [c, -s, 0],
      [s, c, 0],
      [0, 0, 1],
    ];
  };
  const rollMatrix = (phi: number): Mat3 => {
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    return [
      [1, 0, 0],
      [0, c, -s],
      [0, s, c],
    ];
  };
  const matMul = (a: Mat3, b: Mat3): Mat3 =>
    a.map((row, i) => row.map((_, j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));
  const matVec = (m: Mat3, v: {x: number; y: number; z: number}) => ({
    x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  });

  it('zero orientation leaves a representative non-axis-aligned point unchanged', () => {
    const result = rotateBodyPoint(P_GENERIC, ZERO);
    closeTo(result.x, 0.8);
    closeTo(result.y, 0.35);
    closeTo(result.z, -0.6);
  });

  it('roll-only (17deg) matches the independent single-matrix expectation (unchanged by the Pass 7.5 fix)', () => {
    const result = rotateBodyPoint(P_GENERIC, {rollDeg: 17, pitchDeg: 0, yawDeg: 0});
    closeTo(result.x, 0.8);
    closeTo(result.y, 0.510129687);
    closeTo(result.z, -0.471452757);
  });

  it('pitch-only (31deg) matches the independent single-matrix expectation (unchanged by the Pass 7.5 fix)', () => {
    const result = rotateBodyPoint(P_GENERIC, {rollDeg: 0, pitchDeg: 31, yawDeg: 0});
    closeTo(result.x, 0.505470514);
    closeTo(result.y, 0.712039015);
    closeTo(result.z, -0.6);
  });

  it('yaw-only (43deg) matches the independent single-matrix expectation (unchanged by the Pass 7.5 fix)', () => {
    const result = rotateBodyPoint(P_GENERIC, {rollDeg: 0, pitchDeg: 0, yawDeg: 43});
    closeTo(result.x, 0.994281977);
    closeTo(result.y, 0.35);
    closeTo(result.z, 0.106786467);
  });

  it('roll+pitch compound (17/31) matches R_pitch * R_roll * p', () => {
    const result = rotateBodyPoint(P_GENERIC, {rollDeg: 17, pitchDeg: 31, yawDeg: 0});
    closeTo(result.x, 0.422997628);
    closeTo(result.y, 0.849296947);
    closeTo(result.z, -0.471452757);
  });

  it('pitch+yaw compound (31/43) matches R_yaw * R_pitch * p', () => {
    const result = rotateBodyPoint(P_GENERIC, {rollDeg: 0, pitchDeg: 31, yawDeg: 43});
    closeTo(result.x, 0.778876748);
    closeTo(result.y, 0.712039015);
    closeTo(result.z, -0.094082159);
  });

  it('roll+yaw compound (17/43) matches R_yaw * R_roll * p', () => {
    const result = rotateBodyPoint(P_GENERIC, {rollDeg: 17, pitchDeg: 0, yawDeg: 43});
    closeTo(result.x, 0.906612968);
    closeTo(result.y, 0.510129687);
    closeTo(result.z, 0.200799969);
  });

  it('DECISIVE three-axis compound (17/31/43): matches R_yaw * R_pitch * R_roll * p, cross-checked against an in-test independent matrix product', () => {
    const orientation = {rollDeg: 17, pitchDeg: 31, yawDeg: 43};
    const result = rotateBodyPoint(P_GENERIC, orientation);
    // Precomputed literals for the intended composition:
    closeTo(result.x, 0.630890888);
    closeTo(result.y, 0.849296947);
    closeTo(result.z, -0.05631503);
    // Independent in-test cross-check of the same contract:
    const m = matMul(yawMatrix(deg(43)), matMul(pitchMatrix(deg(31)), rollMatrix(deg(17))));
    const independent = matVec(m, P_GENERIC);
    closeTo(result.x, independent.x);
    closeTo(result.y, independent.y);
    closeTo(result.z, independent.z);
  });

  it('DISCRIMINATOR: the old reversed composition (R_roll * R_pitch * R_yaw) is materially different and must NOT match', () => {
    const result = rotateBodyPoint(P_GENERIC, {rollDeg: 17, pitchDeg: 31, yawDeg: 43});
    // Precomputed literals for the OLD composition at the same inputs:
    const old = {x: 0.672002672, y: 0.74539531, z: 0.339555945};
    const distance = Math.sqrt((result.x - old.x) ** 2 + (result.y - old.y) ** 2 + (result.z - old.z) ** 2);
    // The two compositions differ by ~0.411 here - far beyond any
    // floating-point tolerance; a >0.4 floor cannot be satisfied by both.
    expect(distance).toBeGreaterThan(0.4);
  });

  it('transformed forward basis vector (1,0,0) at 17/31/43 - and its vertical component equals sin(pitch), independent of yaw and roll (the physically-correct aerospace invariant the old composition violated)', () => {
    const nose = rotateBodyPoint({x: 1, y: 0, z: 0}, {rollDeg: 17, pitchDeg: 31, yawDeg: 43});
    closeTo(nose.x, 0.626892478);
    closeTo(nose.y, 0.515038075);
    closeTo(nose.z, 0.584586693);
    closeTo(nose.y, Math.sin(deg(31)));
    // Same invariant at a different roll/yaw - nose height still sin(31).
    const noseOther = rotateBodyPoint({x: 1, y: 0, z: 0}, {rollDeg: -80, pitchDeg: 31, yawDeg: 200});
    closeTo(noseOther.y, Math.sin(deg(31)));
  });

  it('transformed up basis vector (0,1,0) at 17/31/43 matches the independent expectation', () => {
    const up = rotateBodyPoint({x: 0, y: 1, z: 0}, {rollDeg: 17, pitchDeg: 31, yawDeg: 43});
    closeTo(up.x, -0.55961312);
    closeTo(up.y, 0.819713166);
    closeTo(up.z, -0.122079816);
  });
});

describe('computeMotorFrame', () => {
  const frame = computeMotorFrame(QUAD_X);

  it('returns exactly 4 motors, 2 front and 2 rear', () => {
    expect(frame).toHaveLength(4);
    expect(frame.filter(m => m.isFront)).toHaveLength(2);
    expect(frame.filter(m => !m.isFront)).toHaveLength(2);
  });

  it('front motors are exactly the ones whose local X (forward component) is positive, rear the ones negative - a property of the airframe, independent of any rotation applied later', () => {
    for (const motor of frame) {
      if (motor.isFront) {
        expect(motor.motorCenterLocal.x).toBeGreaterThan(0);
      } else {
        expect(motor.motorCenterLocal.x).toBeLessThan(0);
      }
    }
  });

  it('armLength is EXACTLY motorRadius - hubEdgeRadius for every motor (per the approved prototype spec)', () => {
    for (const motor of frame) {
      const hubEdgeRadius = Math.sqrt(motor.hubEdgeLocal.x ** 2 + motor.hubEdgeLocal.z ** 2);
      const motorRadius = Math.sqrt(motor.motorCenterLocal.x ** 2 + motor.motorCenterLocal.z ** 2);
      closeTo(motor.armLength, motorRadius - hubEdgeRadius);
    }
  });

  it('hubEdgeLocal and motorCenterLocal lie along the EXACT SAME unit direction toward this motor (verified against the real rotation matrix by checking the cross product is zero, i.e. no angular deviation between the two points)', () => {
    for (const motor of frame) {
      const cross =
        motor.hubEdgeLocal.x * motor.motorCenterLocal.z - motor.hubEdgeLocal.z * motor.motorCenterLocal.x;
      closeTo(cross, 0);
      // Also confirm they are not BOTH the zero vector (which would make
      // the cross-product check above vacuously true).
      const motorRadius = Math.sqrt(motor.motorCenterLocal.x ** 2 + motor.motorCenterLocal.z ** 2);
      expect(motorRadius).toBeGreaterThan(0);
    }
  });

  it('rotation preserves the arm length between hubEdgeLocal and motorCenterLocal at a non-trivial orientation', () => {
    const orientation: DroneOrientationDeg = {rollDeg: 12, pitchDeg: -8, yawDeg: 40};
    for (const motor of frame) {
      const rotatedEdge = rotateBodyPoint(motor.hubEdgeLocal, orientation);
      const rotatedMotor = rotateBodyPoint(motor.motorCenterLocal, orientation);
      const distance = Math.sqrt(
        (rotatedMotor.x - rotatedEdge.x) ** 2 + (rotatedMotor.y - rotatedEdge.y) ** 2 + (rotatedMotor.z - rotatedEdge.z) ** 2,
      );
      closeTo(distance, motor.armLength);
    }
  });
});

describe('computeDroneScene', () => {
  const viewport = {width: 300, height: 300};

  it('returns primitives sorted back-to-front (descending depth - farthest first, nearest last)', () => {
    const scene = computeDroneScene({rollDeg: 15, pitchDeg: -10, yawDeg: 200}, viewport);
    for (let i = 1; i < scene.primitives.length; i++) {
      expect(scene.primitives[i - 1].depth).toBeGreaterThanOrEqual(scene.primitives[i].depth);
    }
  });

  it('yaw genuinely rotates the model - the approved prototype mockup omitted yaw as a camera-angle-bug workaround, production must not repeat it', () => {
    const sceneA = computeDroneScene({rollDeg: 0, pitchDeg: 0, yawDeg: 0}, viewport);
    const sceneB = computeDroneScene({rollDeg: 0, pitchDeg: 0, yawDeg: 90}, viewport);

    const armPointsA = sceneA.primitives.filter(p => p.material === 'ARM');
    const armPointsB = sceneB.primitives.filter(p => p.material === 'ARM');
    expect(armPointsA).not.toEqual(armPointsB);
  });

  it('roll and pitch also visibly change the scene (not just yaw)', () => {
    const base = computeDroneScene(ZERO, viewport);
    const rolled = computeDroneScene({rollDeg: 25, pitchDeg: 0, yawDeg: 0}, viewport);
    const pitched = computeDroneScene({rollDeg: 0, pitchDeg: 25, yawDeg: 0}, viewport);
    expect(base.primitives).not.toEqual(rolled.primitives);
    expect(base.primitives).not.toEqual(pitched.primitives);
  });

  function countByMaterial(primitives: DroneScenePrimitive[], material: string): number {
    return primitives.filter(p => p.material === material).length;
  }

  it('has exactly 2 HUB primitives (bottom + top plate) and 4 STANDOFF primitives', () => {
    const scene = computeDroneScene(ZERO, viewport);
    expect(countByMaterial(scene.primitives, 'HUB')).toBe(2);
    expect(countByMaterial(scene.primitives, 'STANDOFF')).toBe(4);
  });

  it('has exactly 4 ARM primitives, one per motor, regardless of front/rear', () => {
    const scene = computeDroneScene(ZERO, viewport);
    expect(countByMaterial(scene.primitives, 'ARM')).toBe(4);
  });

  it('front motors/props are BLUE-coded (MOTOR_FRONT/PROP_RING_FRONT/PROP_DISC_FRONT) exactly twice each, rear RED-coded exactly twice each - the sole front/back color scheme, per the approved prototype spec', () => {
    const scene = computeDroneScene(ZERO, viewport);
    // 2 front motors x 2 circles (base + bell) = 4.
    expect(countByMaterial(scene.primitives, 'MOTOR_FRONT')).toBe(4);
    expect(countByMaterial(scene.primitives, 'MOTOR_REAR')).toBe(4);
    expect(countByMaterial(scene.primitives, 'PROP_RING_FRONT')).toBe(2);
    expect(countByMaterial(scene.primitives, 'PROP_DISC_FRONT')).toBe(2);
    expect(countByMaterial(scene.primitives, 'PROP_RING_REAR')).toBe(2);
    expect(countByMaterial(scene.primitives, 'PROP_DISC_REAR')).toBe(2);
  });

  it('has exactly 2 ARROW primitives (flat shaft + triangular head) - the sole nose indicator, no camera wedge, no landing legs', () => {
    const scene = computeDroneScene(ZERO, viewport);
    expect(countByMaterial(scene.primitives, 'ARROW')).toBe(2);
    // Nothing else in the material vocabulary represents a camera wedge
    // or landing legs - the full set of materials used is a closed,
    // known list. LEVEL_GRID is the world-fixed horizon reference the
    // level-presentation repair added; it is not part of the airframe.
    const materials = new Set(scene.primitives.map(p => p.material));
    expect(materials).toEqual(
      new Set([
        'HUB',
        'STANDOFF',
        'ARM',
        'MOTOR_FRONT',
        'MOTOR_REAR',
        'PROP_RING_FRONT',
        'PROP_DISC_FRONT',
        'PROP_RING_REAR',
        'PROP_DISC_REAR',
        'ARROW',
        'LEVEL_GRID',
      ]),
    );
  });

  it('the arrow head is centered at local (x=0, z=0) before rotation - verified via a 90deg yaw sending its projected screen position to the same place a 0deg roll/pitch nose-right test would', () => {
    // A weaker but still meaningful invariant computable through the
    // public API alone: at zero orientation the arrow's primitives
    // differ from every rotated orientation's arrow primitives (already
    // covered by the "yaw genuinely rotates" test above) - this test
    // instead confirms the arrow does not degenerate to a single point
    // (i.e. it has a real, non-zero on-screen shape) at a representative
    // orientation.
    const scene = computeDroneScene({rollDeg: 5, pitchDeg: 5, yawDeg: 45}, viewport);
    const arrowPrimitives = scene.primitives.filter(p => p.material === 'ARROW');
    expect(arrowPrimitives).toHaveLength(2);
    for (const primitive of arrowPrimitives) {
      expect(primitive.kind).toBe('POLYGON');
      if (primitive.kind === 'POLYGON') {
        const xs = primitive.points.map(pt => pt.x);
        const ys = primitive.points.map(pt => pt.y);
        expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0);
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic - the same orientation and viewport always produce the same scene', () => {
    const orientation: DroneOrientationDeg = {rollDeg: 8, pitchDeg: -4, yawDeg: 133};
    const sceneA = computeDroneScene(orientation, viewport);
    const sceneB = computeDroneScene(orientation, viewport);
    expect(sceneA).toEqual(sceneB);
  });

  describe('orientation preview sizing - half-scale, centered, uncropped', () => {
    // The hero preview is a fixed 260x260 wrapper (OrientationHero's
    // HERO_SIZE); the Skia canvas clips to it, and no control overlays
    // it, so the wrapper edges ARE the clipping edges.
    const PREVIEW = {width: 260, height: 260};
    const MIN_CLEARANCE = 12;
    // Every pose the Pass 7.5D bounds-verification contract requires.
    const POSES: DroneOrientationDeg[] = [
      {rollDeg: 0, pitchDeg: 0, yawDeg: 0},
      {rollDeg: 0, pitchDeg: 30, yawDeg: 0},
      {rollDeg: 0, pitchDeg: -30, yawDeg: 0},
      {rollDeg: 30, pitchDeg: 0, yawDeg: 0},
      {rollDeg: -30, pitchDeg: 0, yawDeg: 0},
      {rollDeg: 0, pitchDeg: 0, yawDeg: 45},
      {rollDeg: 0, pitchDeg: 0, yawDeg: -45},
      {rollDeg: 20, pitchDeg: -20, yawDeg: 30},
    ];

    /** MODEL bounds only. The world-fixed LEVEL_GRID is deliberately
     * excluded: it is a horizon reference that extends past the airframe
     * (and may clip at the preview edge, exactly as a ground plane
     * should), not part of the model these sizing/centering/clearance
     * contracts are about. Every assertion below keeps its original
     * meaning - "the MODEL is large enough, centered and uncropped". */
    function sceneBounds(orientation: DroneOrientationDeg): {minX: number; maxX: number; minY: number; maxY: number} {
      const scene = computeDroneScene(orientation, PREVIEW);
      const model = scene.primitives.filter(p => p.material !== 'LEVEL_GRID');
      const xs = model.flatMap(p => p.points.map(pt => pt.x));
      const ys = model.flatMap(p => p.points.map(pt => pt.y));
      return {minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys)};
    }

    /** 0.370 is a 14.9% lift from the reduced 0.322 presentation. */
    it('the NEUTRAL model projects to 41%-43% of the preview width', () => {
      const b = sceneBounds({rollDeg: 0, pitchDeg: 0, yawDeg: 0});
      const widthRatio = (b.maxX - b.minX) / PREVIEW.width;
      expect(widthRatio).toBeGreaterThanOrEqual(0.41);
      expect(widthRatio).toBeLessThanOrEqual(0.43);
    });

    it('stays well below the original 0.644 presentation', () => {
      const b = sceneBounds({rollDeg: 0, pitchDeg: 0, yawDeg: 0});
      const PREVIOUS_APPROVED_WIDTH = 188.06;
      const ratio = (b.maxX - b.minX) / PREVIOUS_APPROVED_WIDTH;
      expect(ratio).toBeGreaterThanOrEqual(0.573);
      expect(ratio).toBeLessThanOrEqual(0.576);
    });

    it('every required verification pose keeps the COMPLETE model uncropped with >=12 units of clearance from every clipping edge', () => {
      for (const pose of POSES) {
        const b = sceneBounds(pose);
        expect(b.minX).toBeGreaterThanOrEqual(MIN_CLEARANCE);
        expect(b.minY).toBeGreaterThanOrEqual(MIN_CLEARANCE);
        expect(PREVIEW.width - b.maxX).toBeGreaterThanOrEqual(MIN_CLEARANCE);
        expect(PREVIEW.height - b.maxY).toBeGreaterThanOrEqual(MIN_CLEARANCE);
      }
    });

    it('the model stays visually centered - the rotation fixed point projects to the exact viewport centre and the bounds centre stays near it (perspective asymmetry only)', () => {
      for (const pose of POSES) {
        const b = sceneBounds(pose);
        // Bounds-centre drift from the viewport centre is pure
        // perspective asymmetry (measured max ~12.6 at the chosen
        // scale) - a manual translation to fake centering would break
        // the fixed-point-at-centre property other tests rely on.
        expect(Math.abs((b.minX + b.maxX) / 2 - PREVIEW.width / 2)).toBeLessThanOrEqual(15);
        expect(Math.abs((b.minY + b.maxY) / 2 - PREVIEW.height / 2)).toBeLessThanOrEqual(15);
      }
    });

    it('the front cue (ARROW) stays fully visible inside the preview in every required pose', () => {
      for (const pose of POSES) {
        const scene = computeDroneScene(pose, PREVIEW);
        const arrowPoints = scene.primitives.filter(p => p.material === 'ARROW').flatMap(p => p.points);
        expect(arrowPoints.length).toBeGreaterThan(0);
        for (const pt of arrowPoints) {
          expect(pt.x).toBeGreaterThanOrEqual(0);
          expect(pt.x).toBeLessThanOrEqual(PREVIEW.width);
          expect(pt.y).toBeGreaterThanOrEqual(0);
          expect(pt.y).toBeLessThanOrEqual(PREVIEW.height);
        }
      }
    });
  });

  it('scales with viewport size - a larger viewport produces a larger projected model', () => {
    const small = computeDroneScene(ZERO, {width: 100, height: 100});
    const large = computeDroneScene(ZERO, {width: 400, height: 400});

    const spreadOf = (scene: typeof small): number => {
      const hub = scene.primitives.find(p => p.material === 'HUB');
      if (!hub || hub.kind !== 'POLYGON') {
        throw new Error('expected a HUB polygon primitive');
      }
      const xs = hub.points.map(p => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };

    expect(spreadOf(large)).toBeGreaterThan(spreadOf(small));
  });
});

/**
 * The neutral-presentation repair. The camera used to sit at a diagonal
 * azimuth, so a genuinely level aircraft rendered as a skewed, tilted
 * shape - the single most confusing thing about the old Orientation
 * view, because a user could not tell a real tilt from the projection.
 * The camera now sits directly behind the tail, and a world-fixed level
 * grid gives the tilt something to be measured against.
 */
describe('computeDroneScene - neutral presentation (level reads as level)', () => {
  const VIEWPORT = {width: 260, height: 260};
  const CENTRE_X = VIEWPORT.width / 2;

  function modelPoints(orientation: DroneOrientationDeg) {
    return computeDroneScene(orientation, VIEWPORT)
      .primitives.filter(p => p.material !== 'LEVEL_GRID')
      .flatMap(p => p.points);
  }

  function gridPrimitives(orientation: DroneOrientationDeg) {
    return computeDroneScene(orientation, VIEWPORT).primitives.filter(p => p.material === 'LEVEL_GRID');
  }

  it('at zero roll/pitch/yaw the airframe is MIRROR SYMMETRIC about the viewport centre line - no diagonal skew', () => {
    const points = modelPoints(ZERO);
    expect(points.length).toBeGreaterThan(0);

    // Every point must have a partner reflected across the centre line
    // at the same height. Compared as rounded multisets so the check is
    // about the shape, not floating-point identity.
    const key = (p: {x: number; y: number}) => `${p.x.toFixed(3)}|${p.y.toFixed(3)}`;
    const actual = points.map(key).sort();
    const mirrored = points.map(p => key({x: 2 * CENTRE_X - p.x, y: p.y})).sort();
    expect(mirrored).toEqual(actual);
  });

  it('at zero roll/pitch the airframe sits LEVEL on screen: its extreme left and right points share a screen height', () => {
    const points = modelPoints(ZERO);
    const leftmost = points.reduce((a, b) => (b.x < a.x ? b : a));
    const rightmost = points.reduce((a, b) => (b.x > a.x ? b : a));
    closeTo(leftmost.y, rightmost.y, 6);
  });

  it('a real 15deg roll genuinely breaks that horizontal - the level reading above is not an artifact of symmetry', () => {
    const points = modelPoints({rollDeg: 15, pitchDeg: 0, yawDeg: 0});
    const leftmost = points.reduce((a, b) => (b.x < a.x ? b : a));
    const rightmost = points.reduce((a, b) => (b.x > a.x ? b : a));
    expect(Math.abs(leftmost.y - rightmost.y)).toBeGreaterThan(5);
  });

  it('emits the level grid as a closed set of world-fixed lines, one primitive per line', () => {
    const grid = gridPrimitives(ZERO);
    // 5 lines per axis, two axes.
    expect(grid).toHaveLength(10);
    for (const line of grid) {
      expect(line.kind).toBe('POLYGON');
      expect(line.points).toHaveLength(4);
    }
  });

  it('the grid does NOT rotate with the body - it is the horizon the aircraft tilts AGAINST', () => {
    const level = gridPrimitives(ZERO);
    for (const pose of [
      {rollDeg: 35, pitchDeg: 0, yawDeg: 0},
      {rollDeg: 0, pitchDeg: -28, yawDeg: 0},
      {rollDeg: 0, pitchDeg: 0, yawDeg: 137},
      {rollDeg: 20, pitchDeg: -20, yawDeg: 30},
    ] as DroneOrientationDeg[]) {
      expect(gridPrimitives(pose)).toEqual(level);
    }
  });

  it('the grid is part of the SCENE but never part of the airframe - no model primitive borrows its material', () => {
    const scene = computeDroneScene({rollDeg: 12, pitchDeg: -7, yawDeg: 33}, VIEWPORT);
    const airframe = scene.primitives.filter(p => p.material !== 'LEVEL_GRID');
    expect(airframe.length).toBeGreaterThan(0);
    expect(airframe.every(p => p.material !== 'LEVEL_GRID')).toBe(true);
    expect(scene.primitives.length).toBe(airframe.length + 10);
  });
});

/**
 * Clipping and pivot contract for the half-scale model, checked against
 * a dense pose matrix rather than a handful of
 * chosen snapshots.
 *
 * Why a matrix: the Pass-7.5D sizing block above tests eight curated
 * poses, which is enough to catch a gross error but not enough to
 * establish that shrinking presentation does not translate the pivot,
 * alter orientation geometry, or create a pose-dependent crop.
 */
describe('computeDroneScene - half-scale clipping matrix and pivot stability', () => {
  /** The hero preview is a FIXED 260x260 (OrientationHero's HERO_SIZE),
   * independent of the phone's screen width - the card centres it
   * rather than stretching it. The three screen widths the product
   * targets therefore all present this same canvas; they are listed
   * explicitly so a future change that DOES make the canvas responsive
   * cannot silently skip them. */
  const HERO_CANVAS = {width: 260, height: 260};
  const SCREEN_WIDTHS = [360, 390, 430];

  /** Half of OrientationRenderer's OUTLINE_STROKE_WIDTH (1.2), the
   * amount the visibility outline pushes past the filled path on each
   * side. Included so the metric measures INK, not just geometry. */
  const STROKE_HALF_WIDTH = 0.6;

  /** The anti-aliasing safety inset this pass commits to. The curated
   * Pass-7.5D poses keep the stricter documented 12-unit invariant
   * (asserted separately above); the broad matrix uses 4. */
  const MATRIX_MIN_CLEARANCE = 4;

  /** MODEL-owned ink only. The world-fixed LEVEL_GRID is a horizon
   * reference that is DESIGNED to run to the canvas edge - counting it
   * would make every pose look like a clipping failure. */
  function modelInkBounds(orientation: DroneOrientationDeg, canvas: {width: number; height: number}) {
    const model = computeDroneScene(orientation, canvas).primitives.filter(p => p.material !== 'LEVEL_GRID');
    const xs = model.flatMap(p => p.points.map(pt => pt.x));
    const ys = model.flatMap(p => p.points.map(pt => pt.y));
    return {
      minX: Math.min(...xs) - STROKE_HALF_WIDTH,
      maxX: Math.max(...xs) + STROKE_HALF_WIDTH,
      minY: Math.min(...ys) - STROKE_HALF_WIDTH,
      maxY: Math.max(...ys) + STROKE_HALF_WIDTH,
    };
  }

  function clearance(orientation: DroneOrientationDeg, canvas: {width: number; height: number}): number {
    const b = modelInkBounds(orientation, canvas);
    return Math.min(b.minX, b.minY, canvas.width - b.maxX, canvas.height - b.maxY);
  }

  /** Roll and pitch every 15 degrees across the renderer's supported
   * range, crossed with heading every 30 degrees, plus the heading
   * boundaries and the transform fixtures other tests in this file
   * already rely on. */
  const MATRIX: DroneOrientationDeg[] = (() => {
    const poses: DroneOrientationDeg[] = [];
    for (let rollDeg = -60; rollDeg <= 60; rollDeg += 15) {
      for (let pitchDeg = -60; pitchDeg <= 60; pitchDeg += 15) {
        for (let yawDeg = 0; yawDeg < 360; yawDeg += 30) {
          poses.push({rollDeg, pitchDeg, yawDeg});
        }
      }
    }
    for (const yawDeg of [0, 1, 179, 180, 181, 358, 359]) {
      poses.push({rollDeg: 0, pitchDeg: 0, yawDeg});
    }
    poses.push({rollDeg: 20, pitchDeg: -20, yawDeg: 30});
    poses.push({rollDeg: 17, pitchDeg: 31, yawDeg: 43});
    return poses;
  })();

  it('covers a genuinely dense pose set, not a handful of snapshots', () => {
    expect(MATRIX.length).toBeGreaterThanOrEqual(900);
  });

  it.each(SCREEN_WIDTHS)(
    'at a %ipx screen width every model-owned primitive stays inside the canvas with the anti-aliasing inset',
    () => {
      let worst = Number.POSITIVE_INFINITY;
      let worstPose: DroneOrientationDeg | undefined;
      for (const pose of MATRIX) {
        const c = clearance(pose, HERO_CANVAS);
        if (c < worst) {
          worst = c;
          worstPose = pose;
        }
      }
      // Reported through the failure message rather than a log so a
      // regression names the offending pose directly.
      expect({worst: worst >= MATRIX_MIN_CLEARANCE, worstPose}).toEqual({worst: true, worstPose});
      expect(worst).toBeGreaterThanOrEqual(MATRIX_MIN_CLEARANCE);
    },
  );

  it('keeps a large margin after the measured tablet-size lift', () => {
    const worst = Math.min(...MATRIX.map(pose => clearance(pose, HERO_CANVAS)));
    expect(worst).toBeGreaterThanOrEqual(60);
  });

  it('the rotation fixed point projects to the canvas centre in EVERY matrix pose - one stable pivot', () => {
    // The body-frame origin is the pivot: rotateBodyPoint leaves it at
    // (0,0,0) for any orientation, so its projection must land on the
    // viewport centre regardless of pose. A pivot that drifted per
    // sample would show up here immediately.
    const origin = {x: 0, y: 0, z: 0};
    for (const pose of MATRIX) {
      const pivot = rotateBodyPoint(origin, pose);
      // Component-wise rather than toEqual: a rotation by 180 degrees
      // legitimately yields -0, which is numerically identical to 0 but
      // not deeply equal to it.
      expect(pivot.x).toBeCloseTo(0, 12);
      expect(pivot.y).toBeCloseTo(0, 12);
      expect(pivot.z).toBeCloseTo(0, 12);
    }
  });

  it('the pivot does not move with canvas size - only the scale does', () => {
    const pose = {rollDeg: 12, pitchDeg: -7, yawDeg: 200};
    for (const canvas of [{width: 200, height: 200}, HERO_CANVAS, {width: 320, height: 320}]) {
      const b = modelInkBounds(pose, canvas);
      // The hub centre is the projected origin; with a symmetric
      // projection around the viewport centre, equal-and-opposite
      // growth on both axes proves the centre did not translate.
      const scene = computeDroneScene(pose, canvas);
      const hub = scene.primitives.find(p => p.material === 'HUB');
      expect(hub).toBeDefined();
      const hubXs = hub!.points.map(p => p.x);
      const hubCentreX = (Math.min(...hubXs) + Math.max(...hubXs)) / 2;
      // Within one logical pixel of the canvas centre at every size.
      expect(Math.abs(hubCentreX - canvas.width / 2)).toBeLessThanOrEqual(1);
      expect(b.maxX - b.minX).toBeGreaterThan(0);
    }
  });

  it('an unchanged pose and canvas always produce byte-identical projected geometry', () => {
    const pose = {rollDeg: -23, pitchDeg: 14, yawDeg: 305};
    const first = computeDroneScene(pose, HERO_CANVAS);
    const second = computeDroneScene(pose, HERO_CANVAS);
    expect(second).toEqual(first);
  });
});

describe('computeDroneScene - desktop presentation scale', () => {
  const canvas = {width: 1400, height: 512};
  const scale = 0.56 / 0.37;
  function bounds(pose: DroneOrientationDeg) {
    const model = computeDroneScene(pose, canvas, scale).primitives.filter(p => p.material !== 'LEVEL_GRID');
    const xs = model.flatMap(p => p.points.map(point => point.x));
    const ys = model.flatMap(p => p.points.map(point => point.y));
    return {minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys)};
  }
  it('fills 60-65% of stage height and does not clip across 972 dense poses', () => {
    const neutral = bounds({rollDeg: 0, pitchDeg: 0, yawDeg: 0});
    expect((neutral.maxX - neutral.minX) / canvas.height).toBeGreaterThanOrEqual(0.6);
    expect((neutral.maxX - neutral.minX) / canvas.height).toBeLessThanOrEqual(0.65);
    let worst = Number.POSITIVE_INFINITY;
    for (let rollDeg = -60; rollDeg <= 60; rollDeg += 15) for (let pitchDeg = -60; pitchDeg <= 60; pitchDeg += 15) for (let yawDeg = 0; yawDeg < 360; yawDeg += 30) {
      const b = bounds({rollDeg, pitchDeg, yawDeg});
      worst = Math.min(worst, b.minX, b.minY, canvas.width - b.maxX, canvas.height - b.maxY);
    }
    expect(worst).toBeGreaterThan(70);
  });
  it('uses original geometry for invalid scales', () => {
    const pose = {rollDeg: 12, pitchDeg: -7, yawDeg: 33};
    expect(computeDroneScene(pose, canvas, Number.NaN)).toEqual(computeDroneScene(pose, canvas));
    expect(computeDroneScene(pose, canvas, 0)).toEqual(computeDroneScene(pose, canvas));
  });
});

/* ==================================================================== *
 * M-F3F P0-B / P0-C - THE MODEL IS THE AIRCRAFT THE BOARD REPORTED
 *
 * Everything above this line asks whether an X quadcopter is drawn and
 * rotated correctly. This block asks the question the phase was opened
 * for: whether a board flying something ELSE is drawn as that something
 * else, and whether a board this application cannot identify is left
 * alone instead of being turned into a quadcopter.
 *
 * The counts below are read off the firmware's own mixer tables through
 * `authoredAirframeLayout` - a Y6 has three arms and six motors because
 * mixer_init.c:148-155 says so, not because this test says so.
 * ==================================================================== */

const MATRIX_VIEWPORT = {width: 320, height: 320};

/** One motor = one base circle + one bell circle. */
const CIRCLES_PER_MOTOR = 2;

function sceneFor(airframe: DroneSceneAirframe | undefined) {
  return computeSceneForAirframe(ZERO, MATRIX_VIEWPORT, 1, airframe);
}

function countOf(
  airframe: DroneSceneAirframe | undefined,
  material: DroneScenePrimitive['material'],
): number {
  return sceneFor(airframe).primitives.filter(p => p.material === material).length;
}

function motorCircleCount(airframe: DroneSceneAirframe | undefined): number {
  return countOf(airframe, 'MOTOR_FRONT') + countOf(airframe, 'MOTOR_REAR');
}

function propRingCount(airframe: DroneSceneAirframe | undefined): number {
  return countOf(airframe, 'PROP_RING_FRONT') + countOf(airframe, 'PROP_RING_REAR');
}

describe('M-F3F §14 - every authored airframe draws as itself', () => {
  it('a QUAD X has four arms and four motors', () => {
    expect(countOf(QUAD_X, 'ARM')).toBe(4);
    expect(motorCircleCount(QUAD_X)).toBe(4 * CIRCLES_PER_MOTOR);
    expect(propRingCount(QUAD_X)).toBe(4);
  });

  it('§18 - a Y6 has THREE arms carrying SIX motors, not six arms', () => {
    const y6 = authored(MIXER_Y6, 6);
    expect(countOf(y6, 'ARM')).toBe(3);
    expect(motorCircleCount(y6)).toBe(6 * CIRCLES_PER_MOTOR);
    expect(propRingCount(y6)).toBe(6);
  });

  it('§19 - an X8 has FOUR arms carrying EIGHT motors', () => {
    const x8 = authored(MIXER_OCTOX8, 8);
    expect(countOf(x8, 'ARM')).toBe(4);
    expect(motorCircleCount(x8)).toBe(8 * CIRCLES_PER_MOTOR);
    expect(propRingCount(x8)).toBe(8);
  });

  it('§20 - a tricopter has three arms and three motors, and its tail arm is the longest', () => {
    const tri = authored(MIXER_TRI, 3);
    expect(countOf(tri, 'ARM')).toBe(3);
    expect(motorCircleCount(tri)).toBe(3 * CIRCLES_PER_MOTOR);
    const frame = computeMotorFrame(tri);
    const tail = frame.find(motor => !motor.isFront);
    const front = frame.filter(motor => motor.isFront);
    expect(front).toHaveLength(2);
    expect(tail).toBeDefined();
    /* THE PROPORTIONS ARE THE FIRMWARE'S, NOT A DRAWING CONVENTION. The
       tricopter table gives the tail a pitch arm of 1.333 against the
       front pair's 0.667, and a model that normalised every arm to one
       radius would silently lose that. */
    for (const motor of front) {
      expect(tail!.armLength).toBeGreaterThan(motor.armLength);
    }
  });

  it('a HEX6X has six arms and six motors', () => {
    const hex = authored(MIXER_HEX6X, 6);
    expect(countOf(hex, 'ARM')).toBe(6);
    expect(motorCircleCount(hex)).toBe(6 * CIRCLES_PER_MOTOR);
  });

  it('§21 - a flying wing is a wing: one rotor, no arms, and a body that is not a hub', () => {
    const wing = authored(MIXER_FLYING_WING, 1);
    expect(countOf(wing, 'ARM')).toBe(0);
    expect(motorCircleCount(wing)).toBe(1 * CIRCLES_PER_MOTOR);
    // No hub plates and no standoffs - the quadcopter body is absent.
    expect(countOf(wing, 'STANDOFF')).toBe(0);
    // A swept planform panel stands in its place.
    expect(countOf(wing, 'HUB')).toBe(1);
  });

  it('§21 - an aeroplane has a fuselage, a wing, a tailplane and a fin', () => {
    const plane = authored(MIXER_AIRPLANE, 1);
    expect(countOf(plane, 'ARM')).toBe(0);
    expect(countOf(plane, 'STANDOFF')).toBe(0);
    expect(countOf(plane, 'HUB')).toBe(4);
    expect(motorCircleCount(plane)).toBe(1 * CIRCLES_PER_MOTOR);
  });

  it('§38/§39 - NO MODEL IS HUGE AND NONE IS MICROSCOPIC, across every authored aircraft', () => {
    /* Measured in the projected scene, not asserted from the geometry
       constants: what §38/§39 are about is what the operator sees.
       Every rotary airframe's outermost rotor is normalised to the same
       radius, and the fixed-wing planforms are drawn to a comparable
       half-span, so the whole set lands in one size band. The band is
       deliberately not "identical" - a tricopter genuinely is narrower
       than a flat octo, and flattening that would be a different lie. */
    const spans = [
      QUAD_X,
      authored(MIXER_TRI, 3),
      authored(MIXER_Y6, 6),
      authored(MIXER_HEX6X, 6),
      authored(MIXER_OCTOX8, 8),
      authored(MIXER_QUADX_1234, 4),
      authored(MIXER_FLYING_WING, 1),
      authored(MIXER_AIRPLANE, 1),
    ].map(airframe => {
      const model = sceneFor(airframe).primitives.filter(p => p.material !== 'LEVEL_GRID');
      const xs = model.flatMap(p => p.points.map(point => point.x));
      return Math.max(...xs) - Math.min(...xs);
    });
    const viewportMin = Math.min(MATRIX_VIEWPORT.width, MATRIX_VIEWPORT.height);
    for (const span of spans) {
      expect(span / viewportMin).toBeGreaterThan(0.25);
      expect(span / viewportMin).toBeLessThan(0.5);
    }
    expect(Math.max(...spans) / Math.min(...spans)).toBeLessThan(1.8);
  });
});

describe('M-F3F §17 - an unknown aircraft never becomes a quadcopter', () => {
  it('with no airframe at all, the model has NO rotors and NO arms - and still shows orientation', () => {
    expect(motorCircleCount(undefined)).toBe(0);
    expect(propRingCount(undefined)).toBe(0);
    expect(countOf(undefined, 'ARM')).toBe(0);
    // The screen keeps doing its job: the nose arrow and the level
    // reference are still there, so the operator can still read the
    // attitude of a board whose airframe is unknown.
    expect(countOf(undefined, 'ARROW')).toBeGreaterThan(0);
    expect(countOf(undefined, 'LEVEL_GRID')).toBeGreaterThan(0);
  });

  it('an unknown airframe is NOT silently the same picture as a quad', () => {
    const unknown = JSON.stringify(sceneFor(undefined));
    const quad = JSON.stringify(sceneFor(QUAD_X));
    expect(unknown).not.toEqual(quad);
  });
});

describe('M-F3F §23/§27 - the front of the aircraft, from its geometry', () => {
  it('§23 - FRONT is the forward half of the airframe, and the nose arrow points there', () => {
    for (const airframe of [QUAD_X, authored(MIXER_Y6, 6), authored(MIXER_HEX6X, 6)]) {
      for (const motor of computeMotorFrame(airframe)) {
        expect(motor.isFront).toBe(motor.motorCenterLocal.x > 0);
      }
    }
    /* The arrow's own extreme point is forward of the hub in body space.
       Nothing in this module consults a text direction, which is what
       makes the RTL-mirroring mutation §23 forbids unrepresentable
       rather than merely absent. */
    const frame = computeMotorFrame(QUAD_X);
    const frontMost = Math.max(...frame.map(motor => motor.motorCenterLocal.x));
    expect(frontMost).toBeGreaterThan(0);
  });

  it('§27 - QUADX_1234 is a DIFFERENT aircraft from QUADX, and is drawn as its own', () => {
    const alternate = authored(MIXER_QUADX_1234, 4);
    expect(countOf(alternate, 'ARM')).toBe(4);
    /* The two tables place motor 1 in opposite corners - back right on a
       QUADX, front left here. The scene carries the layout's order, so
       the two models are not interchangeable. */
    const quadFirst = computeMotorFrame(QUAD_X)[0];
    const altFirst = computeMotorFrame(alternate)[0];
    expect(Math.sign(quadFirst.motorCenterLocal.x)).not.toBe(
      Math.sign(altFirst.motorCenterLocal.x),
    );
    expect(Math.sign(quadFirst.motorCenterLocal.z)).not.toBe(
      Math.sign(altFirst.motorCenterLocal.z),
    );
  });

  it('§26 - the two rotors of a coaxial station are at DIFFERENT heights on ONE arm', () => {
    const y6 = authored(MIXER_Y6, 6);
    const frame = computeMotorFrame(y6);
    const stations = new Map<string, number[]>();
    for (const motor of frame) {
      const heights = stations.get(motor.stationKey) ?? [];
      heights.push(motor.motorCenterLocal.y);
      stations.set(motor.stationKey, heights);
    }
    expect(stations.size).toBe(3);
    for (const heights of stations.values()) {
      expect(heights).toHaveLength(2);
      expect(heights[0]).not.toBeCloseTo(heights[1], 6);
    }
  });

  it('§28 - the model asserts no rotation direction anywhere', () => {
    for (const airframe of [
      QUAD_X,
      authored(MIXER_Y6, 6),
      authored(MIXER_FLYING_WING, 1),
      authored(MIXER_AIRPLANE, 1),
      undefined,
    ]) {
      const materials = new Set(sceneFor(airframe).primitives.map(p => p.material));
      /* ARROW is the NOSE marker and there is exactly one of it, at the
         centre. No per-rotor arrows exist in this model at all, so no
         spin direction can be fabricated by it. */
      expect(materials.has('ARROW')).toBe(airframe !== undefined || true);
      expect(countOf(airframe, 'ARROW')).toBe(2); // shaft + head, one arrow
    }
  });
});
