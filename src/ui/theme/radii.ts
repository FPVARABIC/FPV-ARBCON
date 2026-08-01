export const radii = {
  none: 0,
  sm: 10,
  md: 16,
  lg: 22,
  pill: 999,
} as const;

export type ThemeRadii = typeof radii;
