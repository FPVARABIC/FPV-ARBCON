/**
 * FPV-ARBCON visual system.
 *
 * Deep aviation navy gives the product its own identity without falling
 * back to flat black. Teal is the single interactive accent; blue is
 * reserved for live information and amber/red retain their conventional
 * warning meanings. The three surface levels create hierarchy without
 * gradients or decorative noise.
 */
export const colors = {
  background: '#071820',
  backgroundRaised: '#0A202A',
  surface: '#0D2732',
  surfaceAlt: '#12323E',
  surfaceRaised: '#173C48',
  border: '#28505C',
  borderSoft: '#1C3C47',
  textPrimary: '#F3F8F9',
  textSecondary: '#A7BDC4',
  textMuted: '#6F8B94',
  accent: '#38D6C8',
  accentStrong: '#18B9AC',
  accentSoft: '#123F45',
  accentText: '#032824',
  info: '#63B3FF',
  success: '#59DA91',
  warning: '#F2B94B',
  error: '#FF6868',
  disabled: '#536A72',
  shadow: '#020B0F',
  white: '#FFFFFF',
} as const;

export type ThemeColors = typeof colors;
