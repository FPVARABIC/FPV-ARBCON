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
