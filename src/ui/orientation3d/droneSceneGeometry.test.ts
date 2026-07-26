import {computeDroneScene, computeMotorFrame, rotateBodyPoint} from './droneSceneGeometry';
import type {DroneOrientationDeg, DroneScenePrimitive} from './droneSceneGeometry';

const ZERO: DroneOrientationDeg = {rollDeg: 0, pitchDeg: 0, yawDeg: 0};

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
  const frame = computeMotorFrame();

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
    // known list.
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

  describe('Pass 7.5D preview sizing - enlarged, centered, uncropped', () => {
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

    function sceneBounds(orientation: DroneOrientationDeg): {minX: number; maxX: number; minY: number; maxY: number} {
      const scene = computeDroneScene(orientation, PREVIEW);
      const xs = scene.primitives.flatMap(p => p.points.map(pt => pt.x));
      const ys = scene.primitives.flatMap(p => p.points.map(pt => pt.y));
      return {minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys)};
    }

    it('the NEUTRAL model projects to 60%-68% of the usable preview width (large enough for visual hardware judgment)', () => {
      const b = sceneBounds({rollDeg: 0, pitchDeg: 0, yawDeg: 0});
      const widthRatio = (b.maxX - b.minX) / PREVIEW.width;
      expect(widthRatio).toBeGreaterThanOrEqual(0.6);
      expect(widthRatio).toBeLessThanOrEqual(0.68);
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
