/**
 * The status/notice surface — danger, warning, success, info and the
 * hardware-verification notice — in ONE component.
 *
 * The audit counted this box hand-rolled in essentially every screen
 * (seven near-identical success tints alone). Consolidating it is not
 * cosmetic: a safety-relevant warning must be recognisable as the same
 * object wherever it appears, and its icon is part of that recognition.
 *
 * `hardware` is deliberately its own variant, not a themed 'info': the
 * "this was proven in software, not on a real aircraft" semantics are
 * load-bearing in this product and keep their established accent-tinted
 * look.
 *
 * THE TITLE IS NOT THIS COMPONENT'S BUSINESS, AND THAT IS THE POINT.
 * The variant fixes the LOOK; the words come from the call site, which
 * takes them from `hardwareVerification.title` /
 * `hardwareVerification.behaviourTitle` in ar.json. The operator used to
 * read the literal English `REQUIRES HARDWARE TEST` here — our own
 * review vocabulary, rendered inside an Arabic-first product on nine
 * screens. The warning was never the problem and has not been weakened;
 * only the language it speaks has changed. See docs/DESIGN_SYSTEM.md.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {Icon} from '../../icons';
import type {IconName} from '../../icons';
import {colors, radii, spacing, typography} from '../../theme';

export type NoticeVariant =
  | 'danger'
  | 'warning'
  | 'success'
  | 'info'
  | 'hardware';

export interface NoticeBoxProps {
  variant: NoticeVariant;
  /** Optional bold first line. */
  title?: string;
  /** Body text, or arbitrary content for composite notices. */
  children: React.ReactNode;
  testID?: string;
}

interface VariantSpec {
  bg: string;
  border: string;
  fg: string;
  icon: IconName;
}

const VARIANTS: Record<NoticeVariant, VariantSpec> = {
  danger: {
    bg: colors.errorSoft,
    border: colors.error,
    fg: colors.error,
    icon: 'octagon-alert',
  },
  warning: {
    bg: colors.warningSoft,
    border: colors.warning,
    fg: colors.warning,
    icon: 'triangle-alert',
  },
  success: {
    bg: colors.successSoft,
    border: colors.success,
    fg: colors.success,
    icon: 'circle-check',
  },
  info: {
    bg: colors.infoSoft,
    border: colors.info,
    fg: colors.info,
    icon: 'info',
  },
  hardware: {
    bg: colors.accentSoft,
    border: colors.accentStrong,
    fg: colors.accentText,
    icon: 'wrench',
  },
};

export function NoticeBox({
  variant,
  title,
  children,
  testID,
}: NoticeBoxProps): React.JSX.Element {
  const spec = VARIANTS[variant];
  const body =
    typeof children === 'string' ? (
      <Text style={[typography.body, styles.bodyText, {color: spec.fg}]}>
        {children}
      </Text>
    ) : (
      children
    );
  return (
    <View
      style={[styles.box, {backgroundColor: spec.bg, borderColor: spec.border}]}
      accessibilityRole={variant === 'danger' ? 'alert' : undefined}
      testID={testID}>
      <View style={styles.iconSlot}>
        <Icon name={spec.icon} size={20} color={spec.fg} />
      </View>
      <View style={styles.textColumn}>
        {title ? (
          <Text style={[typography.bodyStrong, styles.bodyText, {color: spec.fg}]}>
            {title}
          </Text>
        ) : null}
        {body}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  iconSlot: {
    // Optically centre the icon against the first text line
    // (lineHeight 26 vs icon 20).
    paddingTop: 3,
  },
  textColumn: {
    flex: 1,
    gap: 2,
  },
  bodyText: {
    textAlign: 'right',
    writingDirection: 'rtl',
  },
});
