/**
 * One setting inside a card: NAME + explanation + control, as a single
 * intentional structure instead of ad-hoc stacks.
 *
 * On wide layouts the control sits opposite the text (the text column
 * keeps a readable width); on narrow layouts the control drops below the
 * text at full width. The caller passes `wide` from its layout tier —
 * this component deliberately holds no window hooks, so it lays out
 * identically under tests and inside virtualized parents.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {colors, spacing, typography} from '../../theme';

export interface SettingRowProps {
  title: string;
  description?: string;
  /** The control: ToggleSwitch, Stepper, SelectField trigger, Button… */
  children: React.ReactNode;
  /** Side-by-side text/control when true; stacked when false. */
  wide?: boolean;
  /** Draw a hairline above (rows after the first inside a card). */
  divider?: boolean;
  testID?: string;
}

export function SettingRow({
  title,
  description,
  children,
  wide = false,
  divider = false,
  testID,
}: SettingRowProps): React.JSX.Element {
  return (
    <View
      style={[
        styles.row,
        wide ? styles.rowWide : styles.rowStacked,
        divider && styles.divider,
      ]}
      testID={testID}>
      <View style={[styles.textColumn, wide && styles.textColumnWide]}>
        <Text style={styles.title}>{title}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      <View style={wide ? styles.controlWide : styles.controlStacked}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  rowStacked: {},
  rowWide: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  divider: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  textColumn: {
    gap: 2,
  },
  textColumnWide: {
    flex: 1,
    // Never let the text column collapse under a wide control.
    minWidth: 200,
  },
  title: {
    ...typography.bodyStrong,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  description: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  controlWide: {
    flexShrink: 0,
    alignItems: 'flex-end',
  },
  controlStacked: {
    alignItems: 'stretch',
  },
});
