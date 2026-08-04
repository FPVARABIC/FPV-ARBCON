/**
 * THE PERSISTENT SAVE SURFACE for every editable configurator screen.
 *
 * WHY IT EXISTS. On real hardware the operator selected GPS Sensor on
 * UART6, saw the selection change, and reported that "no visible save
 * action appeared and the configuration could not be applied". The save
 * control did exist - it sat at the very bottom of a ScrollView, below
 * six UART cards, with the bottom tab bar over the last rows. A control
 * you have to go looking for is, for the operator, a control that is not
 * there.
 *
 * This bar is rendered OUTSIDE the scroll view, so it is on screen
 * whenever there is something to act on, at every viewport size.
 *
 * TRUTHFULNESS RULES:
 *  - it appears only when there is a real pending change, so it can never
 *    invite a save that would write nothing;
 *  - it states WHAT is pending, in Arabic, rather than a bare "unsaved";
 *  - when save is unavailable it names the reason instead of rendering a
 *    dead grey button with no explanation;
 *  - it makes no claim about the outcome - the screen still reports the
 *    real read-back verdict after the write.
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../../theme';

export interface StickyActionBarProps {
  /** Nothing renders at all when false. */
  visible: boolean;
  /** One short Arabic line naming what is pending, e.g. "UART6: GPS". */
  summary: string;
  /** Every pending change, one line each. Scrolls if it grows. */
  details?: readonly string[];
  saveLabel: string;
  discardLabel: string;
  onSave: () => void;
  onDiscard: () => void;
  /** When set, save is disabled and this Arabic sentence says why. */
  disabledReason?: string;
  /** Save is in flight - blocks both actions and shows busyLabel. */
  busy?: boolean;
  busyLabel?: string;
  /** Extra bottom padding so the bar clears a bottom tab bar. */
  bottomInset?: number;
  testID?: string;
}

export default function StickyActionBar({
  visible,
  summary,
  details,
  saveLabel,
  discardLabel,
  onSave,
  onDiscard,
  disabledReason,
  busy = false,
  busyLabel,
  bottomInset = 0,
  testID = 'sticky-action-bar',
}: StickyActionBarProps): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!visible) {
    return null;
  }
  const saveBlocked = busy || disabledReason !== undefined;

  return (
    <View
      style={[styles.bar, { paddingBottom: spacing.md + bottomInset }]}
      testID={testID}
      accessibilityRole="toolbar"
    >
      <View style={styles.copy}>
        <Text style={styles.eyebrow} testID={`${testID}-eyebrow`}>
          {t('editing.pendingChanges')}
        </Text>
        <Text style={styles.summary} testID={`${testID}-summary`}>
          {summary}
        </Text>
        {details !== undefined && details.length > 0 ? (
          <ScrollView
            style={styles.details}
            contentContainerStyle={styles.detailsContent}
            testID={`${testID}-details`}
          >
            {details.map(line => (
              <Text key={line} style={styles.detailLine}>
                {line}
              </Text>
            ))}
          </ScrollView>
        ) : null}
        {disabledReason !== undefined ? (
          <Text style={styles.reason} testID={`${testID}-disabled-reason`}>
            {disabledReason}
          </Text>
        ) : null}
      </View>

      <View style={styles.buttons}>
        <Pressable
          disabled={busy}
          onPress={onDiscard}
          accessibilityRole="button"
          accessibilityLabel={discardLabel}
          accessibilityState={{ disabled: busy }}
          style={[styles.secondary, busy && styles.dim]}
          testID={`${testID}-discard`}
        >
          <Text style={styles.secondaryText}>{discardLabel}</Text>
        </Pressable>
        <Pressable
          disabled={saveBlocked}
          onPress={onSave}
          accessibilityRole="button"
          accessibilityLabel={saveLabel}
          accessibilityState={{ disabled: saveBlocked }}
          style={[styles.primary, saveBlocked && styles.dim]}
          testID={`${testID}-save`}
        >
          <Text style={styles.primaryText}>
            {busy && busyLabel !== undefined ? busyLabel : saveLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: 1,
    borderTopColor: colors.accentStrong,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
    // Wide screens get the same envelope the content uses, so the actions
    // stay beside the fields they act on rather than at the far edge.
    width: '100%',
    shadowColor: colors.shadow,
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  copy: { gap: 2 },
  eyebrow: { ...typography.eyebrow, color: colors.accent },
  summary: { ...typography.body, color: colors.textPrimary, fontWeight: '700' },
  details: { maxHeight: 84 },
  detailsContent: { gap: 2 },
  detailLine: { ...typography.caption, color: colors.textSecondary },
  reason: { ...typography.caption, color: colors.warning, marginTop: 2 },
  buttons: { flexDirection: 'row', gap: spacing.sm },
  secondary: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundRaised,
  },
  secondaryText: { ...typography.body, color: colors.textSecondary, fontWeight: '600' },
  primary: {
    flex: 2,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  primaryText: { ...typography.body, color: colors.background, fontWeight: '800' },
  dim: { opacity: 0.45 },
});
