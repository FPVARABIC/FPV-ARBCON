import type {TextStyle} from 'react-native';

export const typography: Record<string, TextStyle> = {
  title: {fontSize: 18, fontWeight: '700'},
  sectionTitle: {fontSize: 14, fontWeight: '600'},
  body: {fontSize: 14, fontWeight: '400'},
  caption: {fontSize: 12, fontWeight: '400'},
  mono: {fontFamily: 'monospace', fontSize: 13},
};
