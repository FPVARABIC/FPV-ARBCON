/**
 * THE BROWSER'S ORIENTATION RENDERER - SVG, not CanvasKit.
 *
 * SAME MODEL, SAME MATHS, DIFFERENT BRUSH. This file is the exact
 * counterpart of OrientationRenderer.tsx: it calls the same
 * computeDroneScene(), consumes the same already-depth-sorted primitive
 * list, and paints it with the same shared colour/opacity table from
 * orientationAppearance.ts. It contains no rotation maths, no camera
 * maths, no geometry constants and no colour decisions of its own - all
 * of that is covered GPU-free by droneSceneGeometry.test.ts and is
 * identical on both platforms by construction.
 *
 * WHY NOT SKIA ON WEB. @shopify/react-native-skia's browser build works
 * by downloading and instantiating CanvasKit-WASM - about 7.8 MB before
 * a single frame is drawn. This app's model is 38 flat polygons that are
 * already projected to 2D by the time any renderer sees them; there is
 * nothing left for a GPU scene graph to do. Making an operator download
 * a WASM canvas engine to draw 38 polygons - on a page they may have
 * opened to flash firmware in a hurry - is the wrong trade. SVG draws
 * the same polygons natively.
 *
 * WHY PLAIN <svg> AND NOT react-native-svg. react-native-web renders to
 * the DOM through React DOM, so SVG elements are ordinary JSX here. A
 * react-native-svg dependency would add a package to the Android build
 * that nothing on Android uses.
 *
 * The painter's-algorithm ordering is preserved for free: SVG paints in
 * document order and computeDroneScene() already returns farthest-first,
 * which is the same contract the Skia renderer relies on.
 */

import React, {useMemo} from 'react';
import {View} from 'react-native';

import {computeDroneScene} from './droneSceneGeometry';
import type {DroneOrientationDeg, DroneScenePrimitive} from './droneSceneGeometry';
import {orientationLatencyTracker} from './orientationLatencyDebugLog';
import type {OrientationLatencySampleIdentity} from './orientationLatencyDebugLog';
import {orientationRenderObserver} from './orientationRenderObserver';
import {
  OUTLINE_STROKE_WIDTH,
  appearanceFor,
  effectiveOpacity,
} from './orientationAppearance';

/** The SVG `points` attribute for one polygon. */
function toPointsAttribute(points: DroneScenePrimitive['points']): string {
  return points.map(point => `${point.x},${point.y}`).join(' ');
}

export type OrientationRendererProps = {
  orientation: DroneOrientationDeg;
  width: number;
  height: number;
  /** True while Region 2 is showing a STALE (frozen) reading. */
  stale?: boolean;
  /** Development-only diagnostics: which genuine sample this pose came
   * from. Never affects what is drawn - the pose alone decides that. */
  sampleIdentity?: OrientationLatencySampleIdentity;
  presentationScale?: number;
};

/**
 * One build per genuine pose. Memoized for the same reason the Skia
 * renderer memoizes: telemetry arrives ~4.5 times per second while React
 * may re-render this subtree far more often, and rebuilding 38 polygons'
 * worth of point strings on every unrelated render is pure waste.
 */
function buildDrawables(
  orientation: DroneOrientationDeg,
  width: number,
  height: number,
  presentationScale: number,
) {
  const scene = computeDroneScene(orientation, {width, height}, presentationScale);
  return scene.primitives.map(primitive => ({
    points: toPointsAttribute(primitive.points),
    ...appearanceFor(primitive.material),
  }));
}

export function OrientationRenderer({
  orientation,
  width,
  height,
  stale = false,
  sampleIdentity,
  presentationScale = 1,
}: OrientationRendererProps): React.JSX.Element {
  const {rollDeg, pitchDeg, yawDeg} = orientation;
  const sessionToken = sampleIdentity?.sessionToken;
  const sampleSeq = sampleIdentity?.sampleSeq;

  // Depends on the POSE, not on the sample identity: two consecutive
  // samples reporting an identical attitude must reuse the built scene
  // rather than rebuild an identical one. Same rule as Android.
  const drawables = useMemo(
    () => buildDrawables({rollDeg, pitchDeg, yawDeg}, width, height, presentationScale),
    [rollDeg, pitchDeg, yawDeg, width, height, presentationScale],
  );

  // Checkpoint F: the pose THIS renderer was handed, recorded before any
  // identity gate below - "the SVG received a changed orientation prop"
  // must stay provable even for a sample with no sequence number.
  orientationRenderObserver.noteRendererPose({rollDeg, pitchDeg, yawDeg});

  if (sessionToken !== undefined && sampleSeq !== undefined) {
    const identity = {sessionToken, sampleSeq};
    orientationLatencyTracker.noteRendererSample(identity);
    orientationLatencyTracker.noteSceneBuilt(identity);
  }

  return (
    <View style={{width, height}} testID="orientation-renderer">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        // The model is decoration for the numeric attitude readout that
        // sits beside it; screen readers must not announce 38 polygons.
        aria-hidden="true"
        focusable="false"
        /* eslint-disable-next-line react-native/no-inline-styles -- this
           is a DOM <svg>, not a React Native component: StyleSheet.create
           produces a class-name registry id that a real SVG element
           cannot consume. An inline DOM style is the correct form here.
           `display: block` removes the inline-element baseline gap that
           would otherwise add a few stray pixels under the model. */
        style={{display: 'block'}}>
        {drawables.map((drawable, index) => {
          const opacity = effectiveOpacity(drawable.baseOpacity, stale);
          // The scene is rebuilt in the same deterministic primitive
          // order every render (see computeDroneScene()'s own doc
          // comment), so a plain index is a stable, correct key here.
          // The optional outline is a SECOND draw of the SAME polygon -
          // no extra geometry is built for it.
          return (
            <React.Fragment key={index}>
              <polygon points={drawable.points} fill={drawable.color} fillOpacity={opacity} />
              {drawable.outlined && (
                <polygon
                  points={drawable.points}
                  fill="none"
                  stroke={drawable.color}
                  strokeOpacity={opacity}
                  strokeWidth={OUTLINE_STROKE_WIDTH}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
            </React.Fragment>
          );
        })}
      </svg>
    </View>
  );
}
