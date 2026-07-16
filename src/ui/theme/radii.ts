/**
 * Kept small on purpose - square or lightly rounded technical panels, not
 * ornamental cards.
 */
export const radii = {
  none: 0,
  sm: 4,
  md: 6,
} as const;

export type ThemeRadii = typeof radii;
