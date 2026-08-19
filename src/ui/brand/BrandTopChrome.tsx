/**
 * THE PERSISTENT BROWSER BRAND CHROME.
 *
 * Rendered once by App.web.tsx, above the navigator, so the official logo
 * stays in the top application chrome on every web route - the desktop
 * browser has the vertical room a phone does not. Android deliberately
 * has no counterpart: there the logo lives on the Start screen only
 * (StartScreen.tsx) and every tool screen keeps its full height for the
 * tool. That split is the product decision, not an accident of platform.
 *
 * Layout: the document is dir="rtl", so the FIRST child of a plain row
 * sits at the RIGHT edge - exactly where the brand mark belongs in the
 * Arabic interface.
 *
 * THE STRIP CARRIES THE NAME, not just the emblem. It used to be the logo
 * alone at 44dp, which meant the browser build never said what the product
 * was called: the emblem was small enough to read as an icon, and the only
 * written name in the app was "FPV-ARBCON" - a repository slug - down on
 * the Start screen. The identity is now one thing in one place, emblem and
 * product name together, at a size that reads as identity rather than
 * decoration. There is still exactly ONE primary brand mark in the chrome.
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {
  WORKSPACE_MAX_WIDTH,
  colors,
  spacing,
  typography,
} from '../theme';
import BrandLogo, {
  BRAND_PRODUCT_NAME,
  BRAND_PRODUCT_TAGLINE,
} from './BrandLogo';

/**
 * Emblem height inside the strip - identity, not an icon. Raised from 56
 * at the owner's request; the Android home lockup moved by the same ratio
 * (StartScreen: 72 -> 86) so the two platforms keep one identity.
 */
const CHROME_LOGO_HEIGHT = 68;

/**
 * THE STRIP SPANS THE WINDOW; THE LOCKUP DOES NOT.
 *
 * The ground still reaches both edges, but the emblem and name now sit
 * on the same rail the Start page's own bands use, so identity and page
 * content share one right edge. Before this the name sat hard against
 * the 1920px viewport edge while the content below it started 378px
 * further in, and that misalignment was a large part of why the page
 * read as an island floating under an unrelated bar.
 */
export default function BrandTopChrome(): React.JSX.Element {
  return (
    <View style={styles.strip} testID="brand-top-chrome">
      <View style={styles.lockup}>
        <BrandLogo height={CHROME_LOGO_HEIGHT} testID="brand-logo" />
        {/* A hairline of accent between mark and word: the lockup reads
            as one designed object rather than an image that happens to
            have text beside it. */}
        <View style={styles.rule} />
        <View style={styles.copy}>
          <Text style={styles.productName} testID="brand-product-name">
            {BRAND_PRODUCT_NAME}
          </Text>
          <Text style={styles.tagline}>{BRAND_PRODUCT_TAGLINE}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.backgroundRaised,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  lockup: {
    width: '100%',
    maxWidth: WORKSPACE_MAX_WIDTH,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  rule: {
    width: 3,
    alignSelf: 'stretch',
    marginVertical: spacing.xs,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  /* NOT `flex: 1`. Given the whole rail to fill, this block stretched to
     1500px and the lockup came apart: the name (ltr) went to the far LEFT
     edge of the window while the tagline (rtl) stayed beside the emblem,
     a third of a screen away from the word it belongs to. Content-sized,
     both lines sit against the emblem where a lockup belongs. */
  copy: {flexShrink: 1, gap: 2},
  productName: {
    ...typography.display,
    color: colors.textPrimary,
    letterSpacing: 0.6,
    // A Latin proper noun inside an RTL document: without this it inherits
    // the paragraph direction and the words reorder. `textAlign` then puts
    // it on the same edge as the Arabic line beneath it.
    writingDirection: 'ltr',
    textAlign: 'right',
  },
  tagline: {
    ...typography.body,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
});
