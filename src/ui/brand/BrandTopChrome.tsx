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

import {colors, spacing, typography} from '../theme';
import BrandLogo, {BRAND_PRODUCT_NAME} from './BrandLogo';

/** Emblem height inside the strip - identity, not an icon. */
const CHROME_LOGO_HEIGHT = 56;

export default function BrandTopChrome(): React.JSX.Element {
  return (
    <View style={styles.strip} testID="brand-top-chrome">
      <BrandLogo height={CHROME_LOGO_HEIGHT} testID="brand-logo" />
      <Text style={styles.productName} testID="brand-product-name">
        {BRAND_PRODUCT_NAME}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    backgroundColor: colors.backgroundRaised,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  productName: {
    ...typography.title,
    color: colors.textPrimary,
    letterSpacing: 0.4,
    // A Latin proper noun inside an RTL document: without this it inherits
    // the paragraph direction and the words reorder.
    writingDirection: 'ltr',
  },
});
