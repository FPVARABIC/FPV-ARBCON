import type { TextStyle } from 'react-native';

export const typography: Record<string, TextStyle> = {
  display: { fontSize: 24, lineHeight: 32, fontWeight: '800' },
  title: { fontSize: 19, lineHeight: 27, fontWeight: '800' },
  sectionTitle: { fontSize: 15, lineHeight: 22, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 21, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 18, fontWeight: '400' },
  eyebrow: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  mono: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
};
