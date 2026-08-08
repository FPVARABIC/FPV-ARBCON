import {colors} from './colors';

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map(channel => Number.parseInt(channel, 16) / 255)
    .map(channel =>
      channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );
  if (channels === undefined || channels.length !== 3) {
    throw new Error(`Invalid six-digit colour: ${hex}`);
  }
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('FPV-ARBCON light visual identity', () => {
  it.each([
    ['primary copy', colors.textPrimary, colors.background],
    ['secondary copy', colors.textSecondary, colors.background],
    ['teal links', colors.accentStrong, colors.white],
    ['teal actions', colors.accentText, colors.accent],
    ['danger actions', colors.white, colors.error],
    ['warning copy', colors.warning, colors.white],
    ['error copy', colors.error, colors.white],
  ])('keeps %s at WCAG AA contrast', (_name, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
