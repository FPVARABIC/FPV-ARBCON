/**
 * FPV-ARBCON visual system.
 *
 * Warm aviation paper, deep ink and turquoise are shared with the wider
 * FPVARABIC family. This configurator keeps its own denser, instrument-like
 * hierarchy while using the same calm light surfaces and clear teal actions.
 */
export const colors = {
  background: '#FAF8F3',
  backgroundRaised: '#F3F0E8',
  surface: '#FFFFFF',
  surfaceAlt: '#F2F0EA',
  surfaceRaised: '#E9F7F4',
  border: '#D4D0C6',
  borderSoft: '#E6E1D7',
  textPrimary: '#152232',
  textSecondary: '#526171',
  textMuted: '#71808D',
  accent: '#5EEAD4',
  accentStrong: '#0B6E7D',
  accentSoft: '#DDF8F3',
  accentText: '#082D35',
  info: '#147DA3',
  success: '#16765A',
  warning: '#95610A',
  error: '#BF3D4B',
  disabled: '#B7B5AE',
  shadow: '#152232',
  white: '#FFFFFF',
} as const;

export type ThemeColors = typeof colors;
