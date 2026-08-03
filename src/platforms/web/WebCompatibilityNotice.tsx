/**
 * THE BROWSER-COMPATIBILITY NOTICE.
 *
 * Small, dismissible, and shown ONLY when something is genuinely missing -
 * a Chrome/Edge desktop session over HTTPS sees nothing at all. It states
 * which capability is absent and why (unsupported browser vs. plain-HTTP
 * origin), because those two have completely different fixes.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, per docs/WEB_APP_ARCHITECTURE.md: it
 * does not disable the app. Opening a local HEX/BIN/UF2 file and setting up
 * a cloud build need neither Web Serial nor WebUSB, and blocking the whole
 * tool because one transport is unavailable would remove working
 * functionality for no safety benefit. The connection surfaces themselves
 * are what refuse - each at its own point of use, with its own error -
 * rather than this banner refusing on their behalf.
 */

import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../../ui/theme';
import {WEB_ENVIRONMENT_REASON_KEYS, describeWebEnvironment} from './webEnvironment';
import type {WebEnvironmentReport} from './webEnvironment';

export type WebCompatibilityNoticeProps = {
  /** Injectable for tests; production always reads the live browser. */
  readonly report?: WebEnvironmentReport;
};

export function WebCompatibilityNotice({
  report,
}: WebCompatibilityNoticeProps): React.JSX.Element | null {
  const {t} = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  // Read once per mount rather than per render: neither HTTPS nor the
  // presence of navigator.serial can change during a page's lifetime.
  const [resolved] = useState<WebEnvironmentReport>(
    () => report ?? describeWebEnvironment(),
  );

  if (dismissed) {
    return null;
  }
  if (
    resolved.serialUnavailableReason === null &&
    resolved.dfuUnavailableReason === null
  ) {
    return null;
  }

  return (
    <View style={styles.root} testID="web-compatibility-notice">
      <View style={styles.header}>
        <Text style={styles.title}>{t('webPlatform.compatibilityTitle')}</Text>
        <Pressable
          onPress={() => setDismissed(true)}
          testID="web-compatibility-dismiss"
          accessibilityRole="button">
          <Text style={styles.dismiss}>{t('webPlatform.dismiss')}</Text>
        </Pressable>
      </View>
      {resolved.serialUnavailableReason ? (
        <Text style={styles.line} testID="web-compatibility-serial">
          {`${t('webPlatform.serialLabel')} — ${t(
            WEB_ENVIRONMENT_REASON_KEYS[resolved.serialUnavailableReason],
          )}`}
        </Text>
      ) : null}
      {resolved.dfuUnavailableReason ? (
        <Text style={styles.line} testID="web-compatibility-dfu">
          {`${t('webPlatform.dfuLabel')} — ${t(
            WEB_ENVIRONMENT_REASON_KEYS[resolved.dfuUnavailableReason],
          )}`}
        </Text>
      ) : null}
      <Text style={styles.guidance}>{t('webPlatform.guidance')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: colors.warning,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  header: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...typography.sectionTitle,
    color: colors.warning,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  dismiss: {
    ...typography.caption,
    color: colors.textSecondary,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
  },
  line: {
    ...typography.caption,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  guidance: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
});
