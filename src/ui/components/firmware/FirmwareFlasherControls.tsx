import React from 'react';
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import {colors, radii, spacing, typography} from '../../theme';

export function FirmwareSection({
  title,
  caption,
  children,
  testID,
}: {
  readonly title: string;
  readonly caption?: string;
  readonly children: React.ReactNode;
  readonly testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.section} testID={testID}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {caption ? <Text style={styles.sectionCaption}>{caption}</Text> : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

export function FirmwareButton({
  title,
  onPress,
  disabled = false,
  tone = 'primary',
  testID,
}: {
  readonly title: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly tone?: 'primary' | 'secondary' | 'danger';
  readonly testID?: string;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      testID={testID}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        tone === 'secondary' && styles.buttonSecondary,
        tone === 'danger' && styles.buttonDanger,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}>
      <Text style={[styles.buttonText, tone === 'secondary' && styles.buttonTextSecondary]}>{title}</Text>
    </Pressable>
  );
}

export function FirmwareToggle({
  label,
  detail,
  value,
  onValueChange,
  disabled = false,
  warning = false,
  testID,
}: {
  readonly label: string;
  readonly detail?: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly disabled?: boolean;
  readonly warning?: boolean;
  readonly testID?: string;
}): React.JSX.Element {
  return (
    <View style={[styles.toggleRow, warning && styles.toggleWarning, disabled && styles.disabled]}>
      <View style={styles.toggleCopy}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {detail ? <Text style={styles.toggleDetail}>{detail}</Text> : null}
      </View>
      <Switch
        testID={testID}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{false: colors.disabled, true: warning ? colors.warning : colors.accentStrong}}
        thumbColor={value ? colors.white : colors.textSecondary}
      />
    </View>
  );
}

export function FirmwareChoice<T extends string>({
  value,
  choices,
  onChange,
  disabled = false,
  testIDPrefix,
}: {
  readonly value: T;
  readonly choices: readonly {readonly value: T; readonly label: string}[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  readonly testIDPrefix?: string;
}): React.JSX.Element {
  return (
    <View style={styles.choiceWrap}>
      {choices.map(choice => {
        const selected = choice.value === value;
        return (
          <Pressable
            key={choice.value}
            accessibilityRole="radio"
            accessibilityState={{selected, disabled}}
            testID={testIDPrefix ? `${testIDPrefix}-${choice.value}` : undefined}
            disabled={disabled}
            onPress={() => onChange(choice.value)}
            style={({pressed}) => [
              styles.choice,
              selected && styles.choiceSelected,
              disabled && styles.disabled,
              pressed && !disabled && styles.pressed,
            ]}>
            <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{choice.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function FirmwareProgress({
  percent,
  label,
}: {
  readonly percent: number;
  readonly label: string;
}): React.JSX.Element {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <View style={styles.progressBlock}>
      <View style={styles.progressLabels}>
        <Text style={styles.progressLabel}>{label}</Text>
        <Text style={styles.progressPercent}>{safePercent}%</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, {width: `${safePercent}%`}]} />
      </View>
    </View>
  );
}

export function FirmwareNotice({
  title,
  text,
  tone = 'info',
}: {
  readonly title: string;
  readonly text: string;
  readonly tone?: 'info' | 'warning' | 'success' | 'error';
}): React.JSX.Element {
  return (
    <View style={[
      styles.notice,
      tone === 'warning' && styles.noticeWarning,
      tone === 'success' && styles.noticeSuccess,
      tone === 'error' && styles.noticeError,
    ]}>
      <Text style={[
        styles.noticeTitle,
        tone === 'warning' && styles.noticeTitleWarning,
        tone === 'success' && styles.noticeTitleSuccess,
        tone === 'error' && styles.noticeTitleError,
      ]}>{title}</Text>
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.lg,
    gap: 5,
  },
  sectionTitle: {...typography.title, color: colors.textPrimary},
  sectionCaption: {...typography.caption, color: colors.textSecondary},
  sectionBody: {gap: spacing.md, paddingTop: spacing.sm},
  button: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.accent,
  },
  buttonSecondary: {backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border},
  buttonDanger: {backgroundColor: colors.error},
  buttonText: {...typography.sectionTitle, color: colors.accentText, textAlign: 'center'},
  buttonTextSecondary: {color: colors.textPrimary},
  disabled: {opacity: 0.45},
  pressed: {opacity: 0.72},
  toggleRow: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
  },
  toggleWarning: {borderWidth: 1, borderColor: '#6E5524'},
  toggleCopy: {flex: 1, gap: 2},
  toggleLabel: {...typography.sectionTitle, color: colors.textPrimary},
  toggleDetail: {...typography.caption, color: colors.textSecondary},
  choiceWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  choice: {
    minHeight: 39,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  choiceSelected: {backgroundColor: colors.accentSoft, borderColor: colors.accent},
  choiceText: {...typography.caption, color: colors.textSecondary, fontWeight: '700'},
  choiceTextSelected: {color: colors.accent},
  progressBlock: {gap: 7},
  progressLabels: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md},
  progressLabel: {...typography.caption, color: colors.textSecondary, flex: 1},
  progressPercent: {...typography.caption, color: colors.accent, fontWeight: '800'},
  progressTrack: {height: 8, borderRadius: 4, backgroundColor: colors.surfaceRaised, overflow: 'hidden'},
  progressFill: {height: 8, borderRadius: 4, backgroundColor: colors.accent},
  notice: {padding: spacing.md, borderRadius: radii.md, backgroundColor: '#102B3C', gap: 3},
  noticeWarning: {backgroundColor: '#382C17'},
  noticeSuccess: {backgroundColor: '#123326'},
  noticeError: {backgroundColor: '#3B2023'},
  noticeTitle: {...typography.sectionTitle, color: colors.info},
  noticeTitleWarning: {color: colors.warning},
  noticeTitleSuccess: {color: colors.success},
  noticeTitleError: {color: colors.error},
  noticeText: {...typography.caption, color: colors.textSecondary},
});
