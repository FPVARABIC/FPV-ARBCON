/**
 * Pass 7.4, Step 2 - the "Actual 3D Library" stage of the pipeline (MSP
 * Attitude -> Orientation View Model -> Renderer Interface -> Actual 3D
 * Library -> Setup UI). Deliberately a THIN, DUMB consumer of
 * droneSceneGeometry.ts's computeDroneScene() output: this file contains
 * no rotation math, no camera math, no geometry constants of its own -
 * only a material->color lookup and Skia draw calls. That is exactly why
 * this file does not need (and per this pass's own testing strategy,
 * does not get) its own unit tests - every piece of logic worth testing
 * already has GPU-free coverage in droneSceneGeometry.test.ts, and what
 * remains here (do these Skia primitives visually look right) can only
 * be verified by eye on a real device/simulator, not by Jest.
 *
 * @shopify/react-native-skia chosen per Step 0's own investigation
 * (react-native-webgl confirmed deprecated; expo-gl requires the full
 * Expo module system this project does not otherwise use). Skia itself
 * has no true 3D scene/camera system - the "3D" here is entirely
 * droneSceneGeometry.ts's own hand-rolled rotation + perspective
 * projection + painter's-algorithm depth sort; this component only
 * paints the resulting 2D polygons in the order it's given them.
 *
 * WHY THIS FILE HAS NO MOUNT TEST OF ITS OWN (actually attempted, not
 * just assumed): jest.config.js wires up @shopify/react-native-skia's
 * own official jestSetup.js mock (Canvas becomes a plain RN View, no
 * native module required), but that mock's Skia.Path API is itself built
 * from a real CanvasKit instance (`Mock(CanvasKit)` in the package's own
 * mock/index.ts) - without one, Skia.Path.Make() throws immediately
 * ("Cannot read properties of undefined (reading 'PathBuilder')"),
 * confirmed by actually running it, not inferred. Wiring a real
 * CanvasKit-WASM instance into Jest (the `canvaskit-wasm` package, async
 * WASM instantiation) is real additional complexity/fragility for a
 * component with no logic of its own to protect - exactly the case this
 * pass's own instruction carves out ("only the isolation boundary is
 * mandatory, library choice is Step 0's job"). Screen-level tests (Step
 * 5/6) should jest.mock() this module directly rather than attempt to
 * mount it for real - the isolation boundary (droneSceneGeometry.ts) is
 * what makes that safe to do.
 */

import React, {useMemo} from 'react';
import {StyleSheet, View} from 'react-native';
import {Canvas, Path, Skia} from '@shopify/react-native-skia';
import type {SkPath} from '@shopify/react-native-skia';

import {computeDroneScene} from './droneSceneGeometry';
import type {DroneOrientationDeg, DroneScenePrimitive, DroneSceneMaterial} from './droneSceneGeometry';
import {colors} from '../theme';

/** Front motors/props BLUE, rear RED - the SOLE front/back color scheme
 * (per the approved prototype spec). Reuses the existing theme palette's
 * own accent/error colors rather than introducing new ones. */
export const MATERIAL_COLOR: Record<DroneSceneMaterial, string> = {
  HUB: colors.surfaceAlt,
  STANDOFF: colors.border,
  ARM: colors.textSecondary,
  MOTOR_FRONT: colors.accent,
  MOTOR_REAR: colors.error,
  PROP_RING_FRONT: colors.accent,
  PROP_DISC_FRONT: colors.accent,
  PROP_RING_REAR: colors.error,
  PROP_DISC_REAR: colors.error,
  ARROW: colors.textPrimary,
};

/** Faint translucent discs representing the propeller's swept area, per
 * the approved prototype spec - every other material is fully opaque. */
const TRANSLUCENT_MATERIALS = new Set<DroneSceneMaterial>(['PROP_DISC_FRONT', 'PROP_DISC_REAR']);
const TRANSLUCENT_OPACITY = 0.18;

/** STALE per Step 1's OrientationViewState - the model freezes at its
 * last LIVE pose (the caller simply stops updating `orientation`) and is
 * dimmed here, never faked/interpolated. The "البيانات متأخرة" text
 * label itself is Region 2's own overlay, not this renderer's job. */
const STALE_OPACITY_MULTIPLIER = 0.45;

function toSkPath(points: DroneScenePrimitive['points']): SkPath {
  const path = Skia.Path.Make();
  const [first, ...rest] = points;
  if (!first) {
    return path;
  }
  path.moveTo(first.x, first.y);
  for (const point of rest) {
    path.lineTo(point.x, point.y);
  }
  path.close();
  return path;
}

export type OrientationRendererProps = {
  orientation: DroneOrientationDeg;
  width: number;
  height: number;
  /** True while Region 2 is showing a STALE (frozen) reading. */
  stale?: boolean;
};

export function OrientationRenderer({
  orientation,
  width,
  height,
  stale = false,
}: OrientationRendererProps): React.JSX.Element {
  const {rollDeg, pitchDeg, yawDeg} = orientation;
  const scene = useMemo(
    () => computeDroneScene({rollDeg, pitchDeg, yawDeg}, {width, height}),
    [rollDeg, pitchDeg, yawDeg, width, height],
  );

  return (
    <View style={{width, height}} testID="orientation-renderer">
      <Canvas style={StyleSheet.absoluteFill}>
        {scene.primitives.map((primitive, index) => {
          const baseOpacity = TRANSLUCENT_MATERIALS.has(primitive.material) ? TRANSLUCENT_OPACITY : 1;
          const opacity = stale ? baseOpacity * STALE_OPACITY_MULTIPLIER : baseOpacity;
          // The scene is fully rebuilt in the same deterministic
          // primitive order every render (see computeDroneScene()'s own
          // doc comment), so a plain index is a stable, correct key here.
          return (
            <Path key={index} path={toSkPath(primitive.points)} color={MATERIAL_COLOR[primitive.material]} opacity={opacity} />
          );
        })}
      </Canvas>
    </View>
  );
}
