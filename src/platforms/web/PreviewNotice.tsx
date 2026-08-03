/**
 * THE PREVIEW BANNER - a label, and nothing more.
 *
 * Shown only in the GitHub Pages preview build, where the Vite flag
 * VITE_FPV_ARBCON_PREVIEW is set (see App.web.tsx, which is the only
 * place that reads it). Its entire job is to stop a preview visitor from
 * mistaking an unverified build for an approved release: every hardware
 * path in this branch is still REQUIRES HARDWARE TEST.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, because the distinction is the whole
 * point of the banner existing at all:
 *
 *   - It does not disable, stub, or intercept the real connection path.
 *     Web Serial and WebUSB behave in the preview exactly as they do in a
 *     local build; an operator with a real board can genuinely connect.
 *   - It does not introduce a demo device, a sample session, or any
 *     synthetic telemetry. There is no code here that could: this file
 *     renders two strings.
 *
 * A banner that quietly degraded the app would be worse than no banner,
 * because it would make the preview lie in the opposite direction -
 * suggesting the hardware paths are broken when they are merely untested.
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, spacing, typography} from '../../ui/theme';

export function PreviewNotice(): React.JSX.Element {
  const {t} = useTranslation();
  return (
    <View style={styles.root} testID="web-preview-notice" accessibilityRole="text">
      <Text style={styles.headline}>{t('webPlatform.previewNotice')}</Text>
      <Text style={styles.detail}>{t('webPlatform.previewDetail')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.accentSoft,
    borderBottomWidth: 2,
    borderBottomColor: colors.accent,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  headline: {
    ...typography.sectionTitle,
    color: colors.accent,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  detail: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
});
