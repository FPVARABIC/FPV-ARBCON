/**
 * The cover photograph at the top of a flight style's card and corner.
 *
 * NOTHING IS EVER STRETCHED. The frame declares one ratio for every card
 * so the index reads as a single shelf, and the photograph is scaled
 * uniformly inside it - `cover` or `contain`, never a squeeze.
 *
 * WHICH OF THE TWO IS PER IMAGE, AND IT IS MEASURED. `cover` fills the
 * band and crops what falls outside; `contain` fits the whole picture and
 * leaves space beside it. Cropping is right for a photograph already the
 * frame's shape, and wrong for a cut-out product shot whose propellers
 * reach the edges - a 16:9 crop of a square photo throws away 44% of its
 * height. The decision per style, with the numbers behind it, is in
 * heroFit.ts.
 *
 * The step CAPTURES elsewhere in the corner take a third position and
 * carry their own true pixel size, because a screenshot cropped even
 * slightly can lose the very number its caption promises.
 *
 * A MISSING PHOTOGRAPH IS A DESIGNED STATE, NOT AN ERROR. Until an
 * owner-supplied cover is registered for a style, this renders a tinted
 * panel carrying that style's own name. It never falls back to another
 * style's photograph, and it never invents artwork to stand in for one.
 */
import React from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import type {ImageSourcePropType} from 'react-native';

import {colors, radii, spacing, typography} from '../theme';
import {HERO_FITTED_BACKGROUND} from './heroFit';
import type {HeroFit} from './heroFit';

/** Wide enough to read as a cover band, short enough to stay above the fold. */
const COVER_RATIO = 16 / 9;

export function StyleCover({
  source,
  fit = 'cover',
  titleAr,
  titleEn,
  rounded = true,
  testID,
}: {
  readonly source: ImageSourcePropType | undefined;
  /** Measured per photograph - see heroFit.ts. */
  readonly fit?: HeroFit;
  readonly titleAr: string;
  readonly titleEn: string;
  /** False when the cover sits flush at the top of a full-bleed screen. */
  readonly rounded?: boolean;
  readonly testID?: string;
}): React.JSX.Element {
  if (source === undefined) {
    return (
      <View
        style={[styles.frame, rounded && styles.rounded, styles.fallback]}
        testID={testID === undefined ? undefined : `${testID}-fallback`}>
        <Text style={styles.fallbackEn}>{titleEn}</Text>
        <Text style={styles.fallbackAr}>{titleAr}</Text>
      </View>
    );
  }
  return (
    <View
      style={[
        styles.frame,
        rounded && styles.rounded,
        /* A fitted photograph keeps the white it was shot on, so the
           space beside it reads as part of the picture, not as a gap. */
        fit === 'contain' && styles.fittedFrame,
      ]}
      testID={testID}>
      <Image
        source={source}
        style={styles.image}
        resizeMode={fit}
        accessible
        accessibilityLabel={`صورة ${titleAr}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: COVER_RATIO,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
  },
  rounded: {borderRadius: radii.lg},
  fittedFrame: {backgroundColor: HERO_FITTED_BACKGROUND},
  image: {width: '100%', height: '100%'},
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    paddingHorizontal: spacing.lg,
  },
  /* Latin, so it declares ltr rather than inheriting the page's rtl. */
  fallbackEn: {
    ...typography.eyebrow,
    color: colors.accentStrong,
    writingDirection: 'ltr',
  },
  fallbackAr: {...typography.sectionTitle, color: colors.textSecondary},
});
