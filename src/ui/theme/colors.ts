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

  /**
   * The soft status surfaces. Before these existed, every screen
   * hand-mixed its own tint (seven near-identical success greens, four
   * warning creams, two error pinks were counted across src/ui) — one
   * token per meaning, used by NoticeBox and any status-tinted row.
   */
  successSoft: '#E8F8F1',
  warningSoft: '#FFF7E7',
  errorSoft: '#FFF0F2',
  infoSoft: '#E3F1F8',

  /**
   * Control definition. `border` (#D4D0C6) reads as a hairline on the
   * warm paper background, which is why fields looked faint; interactive
   * surfaces draw with borderStrong instead. Deliberately one step —
   * NOT black — the goal is solid, not noisy.
   */
  borderStrong: '#B8B29F',

  /** Interaction states for the shared controls. Hover is one shade off
   * the resting surface, pressed is two — perceptible on the warm
   * palette without inventing a new hue. */
  accentHover: '#4FE0C8',
  accentPressed: '#3BD2B9',
  surfaceHover: '#F7F5EF',
  surfacePressed: '#EFECE3',
  errorHover: '#B23847',
  errorPressed: '#A43241',
} as const;

export type ThemeColors = typeof colors;
