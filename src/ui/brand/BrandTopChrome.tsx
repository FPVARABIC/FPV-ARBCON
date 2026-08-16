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
 * Arabic interface. The strip is deliberately shallow (the logo, nothing
 * else): it identifies the product without competing with the screens,
 * and exactly ONE primary brand mark exists in the chrome.
 */

import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors, spacing} from '../theme';
import BrandLogo from './BrandLogo';

/** Emblem height inside the strip - recognizable without dominating. */
const CHROME_LOGO_HEIGHT = 44;

export default function BrandTopChrome(): React.JSX.Element {
  return (
    <View style={styles.strip} testID="brand-top-chrome">
      <BrandLogo height={CHROME_LOGO_HEIGHT} testID="brand-logo" />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    backgroundColor: colors.backgroundRaised,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
});
