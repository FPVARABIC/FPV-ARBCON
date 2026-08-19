/**
 * The cover photograph at the top of a flight style's card and corner.
 *
 * ASPECT RATIO IS NEVER GUESSED. The frame declares a fixed ratio and the
 * photograph fills it with `resizeMode="cover"`, so the image is scaled
 * uniformly - it is never stretched to fit a box of the wrong shape. A
 * cover photo is a band across the top of a card, so filling that band
 * and letting the edges fall outside is the correct trade; `contain`
 * would letterbox a landscape photo inside a wide frame and leave two
 * grey bars, which reads as a broken asset rather than a design.
 *
 * The step CAPTURES elsewhere in the corner take the opposite decision
 * and carry their own true pixel size, because a screenshot cropped even
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

/** Wide enough to read as a cover band, short enough to stay above the fold. */
const COVER_RATIO = 16 / 9;

export function StyleCover({
  source,
  titleAr,
  titleEn,
  rounded = true,
  testID,
}: {
  readonly source: ImageSourcePropType | undefined;
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
    <View style={[styles.frame, rounded && styles.rounded]} testID={testID}>
      <Image
        source={source}
        style={styles.image}
        resizeMode="cover"
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
