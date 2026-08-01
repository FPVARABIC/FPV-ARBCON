import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../../theme';
import type { ValidationLogEntry } from './connectionTypes';

interface Props {
  entries: ValidationLogEntry[];
  expanded: boolean;
  onToggle: () => void;
  onClear: () => void;
}

/** No Intl/toLocaleTimeString dependency - Hermes on Android is not
 * guaranteed to ship full ICU data, so timestamps are formatted by hand. */
function formatLogTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}`;
}

export default function ValidationLog({
  entries,
  expanded,
  onToggle,
  onClear,
}: Props): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <View style={styles.container}>
      <Pressable
        testID="usb-log-toggle"
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={
          expanded ? t('validationLog.collapse') : t('validationLog.expand')
        }
        style={styles.headerRow}
      >
        <Text style={styles.title}>{t('validationLog.title')}</Text>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded ? (
        <View>
          <View style={styles.toolbarRow}>
            <Pressable
              testID="usb-log-clear"
              onPress={onClear}
              accessibilityRole="button"
              accessibilityLabel={t('accessibility.clearLog')}
              style={styles.clearButton}
            >
              <Text style={styles.clearButtonText}>
                {t('validationLog.clear')}
              </Text>
            </Pressable>
          </View>

          {entries.length === 0 ? (
            <Text style={styles.emptyText}>{t('validationLog.empty')}</Text>
          ) : (
            <ScrollView style={styles.list} nestedScrollEnabled>
              {entries.map(entry => (
                <View key={entry.id} style={styles.entryRow}>
                  <Text style={styles.entryTimestamp}>
                    {formatLogTimestamp(entry.timestamp)}
                  </Text>
                  <Text style={styles.entryMessage}>
                    {t(entry.messageKey, entry.params)}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
  },
  chevron: {
    ...typography.body,
    color: colors.textSecondary,
  },
  toolbarRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.md,
  },
  clearButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  clearButtonText: {
    ...typography.caption,
    color: colors.accent,
  },
  emptyText: {
    ...typography.caption,
    color: colors.textSecondary,
    padding: spacing.md,
  },
  list: {
    maxHeight: 220,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  entryRow: {
    flexDirection: 'row',
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  entryTimestamp: {
    ...typography.mono,
    color: colors.textSecondary,
    writingDirection: 'ltr',
    marginEnd: spacing.sm,
  },
  entryMessage: {
    ...typography.caption,
    color: colors.textPrimary,
    flexShrink: 1,
  },
});
