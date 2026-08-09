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
  // Darkened from #71808D (4.06:1 on white — below AA for the 13px
  // captions it labels). 5.3:1 on white, 5.0:1 on the paper background,
  // 4.7:1 on backgroundRaised, while staying a step lighter than
  // textSecondary so the muted rank survives.
  textMuted: '#5E6D7A',
  accent: '#5EEAD4',
  accentStrong: '#0B6E7D',
  accentSoft: '#DDF8F3',
  accentText: '#082D35',
  // Darkened from #147DA3, which sat at 4.67:1 on white and failed AA on
  // the infoSoft tint. 5.99:1 on white, 5.2:1 on infoSoft, and white text
  // on an info fill clears AA too.
  info: '#106B8C',
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

  /**
   * The OFF track of a switch. Deliberately NOT surfaceAlt: settings rows
   * are themselves surfaceAlt on several screens, so an OFF switch drawn
   * in surfaceAlt vanished into its own row (seen in a browser on the
   * Ports screen). This reads against white cards AND tinted rows while
   * staying quiet next to the deep-teal ON state.
   */
  switchTrackOff: '#E0DBCD',

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
