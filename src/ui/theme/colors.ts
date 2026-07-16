/**
 * Restrained, dark, technical palette - one accent color plus clear status
 * colors. Deliberately has no gradients, glow, or decorative treatments;
 * every color here is used directly by a real screen element.
 */
export const colors = {
  background: '#0E1116',
  surface: '#161B22',
  surfaceAlt: '#1C2128',
  border: '#2A313C',
  textPrimary: '#E6EDF3',
  textSecondary: '#8B949E',
  accent: '#4C8DFF',
  success: '#3FB950',
  warning: '#D29922',
  error: '#F85149',
  disabled: '#484F58',
} as const;

export type ThemeColors = typeof colors;
