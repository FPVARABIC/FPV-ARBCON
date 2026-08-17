import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {colors, noticeSurface, radii, spacing, typography} from '../../theme';
import {ToggleSwitch} from '../controls';

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

/**
 * `size` is the hierarchy control.
 *
 *   'block'   - spans its container. Reserved for the one action a step
 *               exists to perform.
 *   'compact' - sized to its own label. Everything else: supporting
 *               actions, tools, cancel.
 *
 * Before this existed every action rendered as the same full-width 46px
 * slab, so a reversible download and an irreversible write to a flight
 * controller looked identical and read as a wall of bars on a desktop
 * viewport. The default stays 'block' so existing callers are unchanged.
 */
export function FirmwareButton({
  title,
  onPress,
  disabled = false,
  tone = 'primary',
  size = 'block',
  testID,
}: {
  readonly title: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly tone?: 'primary' | 'secondary' | 'danger';
  readonly size?: 'block' | 'compact';
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
        size === 'compact' && styles.buttonCompact,
        tone === 'secondary' && styles.buttonSecondary,
        tone === 'danger' && styles.buttonDanger,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}>
      <Text
        style={[
          styles.buttonText,
          size === 'compact' && styles.buttonTextCompact,
          tone === 'secondary' && styles.buttonTextSecondary,
          tone === 'danger' && styles.buttonTextDanger,
        ]}>
        {title}
      </Text>
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
      <ToggleSwitch
        testID={testID}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        accessibilityLabel={label}
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
    /* The 'block' variant, and full width ON PURPOSE: this is the flash
       action, the one thing the step exists to do. It was full width by
       ACCIDENT before - the parent column stretches any child that says
       nothing - which is indistinguishable from intent when you read it.
       Stated explicitly so the discipline test can tell the two apart;
       `buttonCompact` overrides it for every supporting action. */
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.accent,
  },
  /** Sized to its label, never stretched. Still a 44px+ touch target. */
  buttonCompact: {
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingHorizontal: spacing.lg,
  },
  buttonSecondary: {backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border},
  buttonDanger: {backgroundColor: colors.error},
  buttonText: {...typography.sectionTitle, color: colors.accentText, textAlign: 'center'},
  buttonTextCompact: {...typography.bodyStrong},
  buttonTextSecondary: {color: colors.textPrimary},
  buttonTextDanger: {color: colors.white},
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
  toggleWarning: {borderWidth: 1, borderColor: colors.warning},
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
  choiceTextSelected: {color: colors.accentStrong},
  progressBlock: {gap: 7},
  progressLabels: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md},
  progressLabel: {...typography.caption, color: colors.textSecondary, flex: 1},
  progressPercent: {...typography.caption, color: colors.accentStrong, fontWeight: '700'},
  progressTrack: {height: 8, borderRadius: 4, backgroundColor: colors.surfaceRaised, overflow: 'hidden'},
  progressFill: {height: 8, borderRadius: 4, backgroundColor: colors.accent},
  notice: {...noticeSurface, backgroundColor: colors.infoSoft, gap: 3},
  noticeWarning: {backgroundColor: colors.warningSoft},
  noticeSuccess: {backgroundColor: colors.successSoft},
  noticeError: {backgroundColor: colors.errorSoft},
  noticeTitle: {...typography.sectionTitle, color: colors.info},
  noticeTitleWarning: {color: colors.warning},
  noticeTitleSuccess: {color: colors.success},
  noticeTitleError: {color: colors.error},
  noticeText: {...typography.caption, color: colors.textSecondary},
});
