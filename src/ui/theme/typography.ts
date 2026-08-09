import type { TextStyle } from 'react-native';

export const typography: Record<string, TextStyle> = {
  display: { fontSize: 27, lineHeight: 37, fontWeight: '800' },
  title: { fontSize: 20, lineHeight: 29, fontWeight: '800' },
  sectionTitle: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 23, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 20, fontWeight: '400' },
  eyebrow: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  mono: { fontFamily: 'monospace', fontSize: 14, lineHeight: 21 },
};
