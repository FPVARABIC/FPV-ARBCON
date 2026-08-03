/**
 * THE ORIENTATION MODEL'S APPEARANCE, ONCE.
 *
 * WHY THIS FILE EXISTS. There are two renderers for the same model -
 * Skia on Android, SVG in the browser (see OrientationRenderer.web.tsx for
 * why the browser does not load CanvasKit). The geometry was already
 * shared: both call computeDroneScene() and neither owns any rotation,
 * camera or projection maths. What was NOT shared was the colour/opacity
 * table, and a duplicated one is a real defect waiting to happen: the
 * front/rear colour split (blue nose, red tail) is how the operator reads
 * which way the aircraft is pointing, and two copies of that mapping is
 * two chances for Web to disagree with Android about which end is the
 * front.
 *
 * So the table lives here and both renderers consume it. Each renderer is
 * left with nothing but its own draw calls.
 *
 * The comments below are the original Skia-renderer notes, kept with the
 * values they explain.
 */

import type {DroneSceneMaterial, DroneScenePrimitive} from './droneSceneGeometry';
import {colors} from '../theme';

/** Front motors/props BLUE, rear RED - the SOLE front/back color scheme
 * (per the approved prototype spec). Reuses the existing theme palette's
 * own accent/error colors rather than introducing new ones. */
export const MATERIAL_COLOR: Record<DroneSceneMaterial, string> = {
  // FINAL-POLISH PASS: the central body read as a dark smudge against
  // the dark card, because surfaceAlt is only two steps off the
  // background. Moved one step up the SAME neutral ramp to border - no
  // new colour enters the palette, and the hub still sits below the arms
  // in the hierarchy.
  HUB: colors.border,
  STANDOFF: colors.border,
  // Arms are the shape that communicates the airframe's attitude, so
  // they move from textSecondary to textPrimary - again an existing
  // palette step, now clearly above the hub.
  ARM: colors.textPrimary,
  MOTOR_FRONT: colors.accent,
  MOTOR_REAR: colors.error,
  PROP_RING_FRONT: colors.accent,
  PROP_DISC_FRONT: colors.accent,
  PROP_RING_REAR: colors.error,
  PROP_DISC_REAR: colors.error,
  ARROW: colors.textPrimary,
  LEVEL_GRID: colors.border,
};

/** Faint translucent discs representing the propeller's swept area, per
 * the approved prototype spec - every other material is fully opaque. */
export const TRANSLUCENT_MATERIALS = new Set<DroneSceneMaterial>([
  'PROP_DISC_FRONT',
  'PROP_DISC_REAR',
  'LEVEL_GRID',
]);
export const TRANSLUCENT_OPACITY = 0.18;

/** FINAL-POLISH PASS: the level grid stays deliberately subordinate to
 * the drone. With the model 15% larger and the body/arms brighter, the
 * grid at the shared 0.18 would have competed with it, so it gets its
 * own slightly lower value. Still visible as a horizon, never a
 * co-equal element. */
export const LEVEL_GRID_OPACITY = 0.14;

/** FINAL-POLISH PASS: a hairline stroke on the airframe's own outlines.
 * Fills alone leave the thin arms (ARM_HALF_WIDTH 0.035) and the nose
 * marker reading as slivers once anti-aliasing has had its way with
 * them; stroking the same path with its own colour thickens the
 * silhouette by a measured 1.2px total (0.6px each side) without adding
 * any geometry, glow, shadow or new colour. Deliberately NOT applied to
 * the prop discs (they are meant to be faint) or the level grid (it must
 * stay subordinate).
 *
 * The 0.6px half-width is included in the clipping matrix that sized
 * MODEL_PIXEL_SCALE_FACTOR - see that constant's own comment. */
export const OUTLINE_STROKE_WIDTH = 1.2;
export const OUTLINED_MATERIALS = new Set<DroneSceneMaterial>([
  'HUB',
  'ARM',
  'ARROW',
  'MOTOR_FRONT',
  'MOTOR_REAR',
  'PROP_RING_FRONT',
  'PROP_RING_REAR',
]);

/** STALE per Step 1's OrientationViewState - the model freezes at its
 * last LIVE pose and is dimmed. The pose a renderer is given is always a
 * GENUINE sample: there is no animation, no interpolation and no
 * extrapolation anywhere on the Orientation model path, so a dimmed
 * model is showing the last real sample and nothing else. The
 * "البيانات متأخرة" text label itself is Region 2's own overlay, not a
 * renderer's job. */
export const STALE_OPACITY_MULTIPLIER = 0.45;

/** The per-primitive appearance both renderers draw from. */
export type PrimitiveAppearance = {
  readonly color: string;
  readonly baseOpacity: number;
  readonly outlined: boolean;
};

export function appearanceFor(
  material: DroneScenePrimitive['material'],
): PrimitiveAppearance {
  return {
    color: MATERIAL_COLOR[material],
    baseOpacity:
      material === 'LEVEL_GRID'
        ? LEVEL_GRID_OPACITY
        : TRANSLUCENT_MATERIALS.has(material)
          ? TRANSLUCENT_OPACITY
          : 1,
    outlined: OUTLINED_MATERIALS.has(material),
  };
}

/** The single place the STALE dimming is applied, so the two renderers
 * cannot disagree about how a frozen reading looks. */
export function effectiveOpacity(baseOpacity: number, stale: boolean): number {
  return stale ? baseOpacity * STALE_OPACITY_MULTIPLIER : baseOpacity;
}
