/**
 * THE CONNECTION, RENDERED WHERE THE OPERATOR PRESSED.
 *
 * Two pieces, and the split is the design:
 *
 *   HomeConnectStatus  an INLINE strip under the two Home cards. It is
 *                      what a connection that is going fine looks like -
 *                      one line, no dialog, no navigation. A modal here
 *                      would flash open and shut for a 300ms connect.
 *
 *   HomeConnectPicker  a small dialog, and ONLY for the one state that
 *                      is a genuine question: more than one board on the
 *                      bench. Asking deserves an interruption; reporting
 *                      progress does not.
 *
 * Neither is a route. Both disappear when the phase does.
 */

import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useTranslation} from 'react-i18next';

import {Button} from '../controls';
import {MIN_TOUCH_TARGET} from '../controls/interaction';
import {Icon} from '../../icons';
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../../theme';
import {
  connectOptionId,
  describeConnectOption,
  type ConnectOption,
  type ConnectPhase,
} from '../../session/connectFlow';

/** The progress phases share one line of copy and one spinner. */
const PROGRESS_COPY: Record<string, string> = {
  CHOOSING: 'directConnect.choosing',
  OPENING: 'directConnect.connecting',
  IDENTIFYING: 'directConnect.identifying',
};

export function HomeConnectStatus({
  phase,
  sessionLost,
  onRetry,
  onDismiss,
}: {
  readonly phase: ConnectPhase;
  /** A link died and returned the operator here. Shown until they act. */
  readonly sessionLost: boolean;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}): React.JSX.Element | null {
  const {t} = useTranslation();

  if (phase.kind === 'FAILED') {
    return (
      <View style={[styles.strip, styles.stripFailed]} testID="home-connect-failed">
        <Icon name="triangle-alert" size={20} color={colors.error} />
        <Text style={styles.stripText} testID="home-connect-message">
          {phase.message}
        </Text>
        <View style={styles.stripActions}>
          <Button
            label={t('directConnect.retry')}
            onPress={onRetry}
            variant="secondary"
            testID="home-connect-retry"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('directConnect.cancel')}
            onPress={onDismiss}
            style={styles.dismiss}
            testID="home-connect-dismiss">
            <Icon name="x" size={18} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>
    );
  }

  const progressKey = PROGRESS_COPY[phase.kind];
  if (progressKey !== undefined) {
    return (
      <View style={styles.strip} testID="home-connect-progress">
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.stripText} testID="home-connect-message">
          {t(progressKey)}
        </Text>
      </View>
    );
  }

  /* Nothing in flight. The only thing left to say is that a board went
     away - and only until the operator does something about it. */
  if (sessionLost) {
    return (
      <View style={[styles.strip, styles.stripLost]} testID="home-session-lost">
        <Icon name="triangle-alert" size={20} color={colors.warning} />
        <Text style={styles.stripText} testID="home-connect-message">
          {t('directConnect.sessionLost')}
        </Text>
        <View style={styles.stripActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('directConnect.cancel')}
            onPress={onDismiss}
            style={styles.dismiss}
            testID="home-session-lost-dismiss">
            <Icon name="x" size={18} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>
    );
  }

  return null;
}

export function HomeConnectPicker({
  phase,
  onChoose,
  onDismiss,
}: {
  readonly phase: ConnectPhase;
  readonly onChoose: (option: ConnectOption) => void;
  readonly onDismiss: () => void;
}): React.JSX.Element | null {
  const {t} = useTranslation();
  if (phase.kind !== 'PICKING') return null;

  /* Port numbers are only shown when a board actually exposes more than
     one - "منفذ 1" next to a board with a single port is noise. */
  const multiplePorts =
    new Set(phase.options.map(option => option.device.deviceId)).size <
    phase.options.length;

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={onDismiss}
      testID="home-connect-picker">
      <View style={styles.scrim}>
        <View style={styles.dialog}>
          <Text style={styles.dialogTitle}>{t('directConnect.pickTitle')}</Text>
          {phase.options.map(option => (
            <Pressable
              key={connectOptionId(option)}
              accessibilityRole="button"
              onPress={() => onChoose(option)}
              style={styles.option}
              testID={`home-connect-option-${connectOptionId(option)}`}>
              <Icon name="usb" size={20} color={colors.textPrimary} />
              <Text style={styles.optionLabel}>
                {describeConnectOption(option, multiplePorts)}
              </Text>
            </Pressable>
          ))}
          <Button
            label={t('directConnect.cancel')}
            onPress={onDismiss}
            variant="secondary"
            testID="home-connect-picker-cancel"
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  stripFailed: {borderColor: colors.error},
  stripLost: {borderColor: colors.warning},
  stripText: {
    ...typography.body,
    flex: 1,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  stripActions: {flexDirection: 'row', alignItems: 'center', gap: spacing.xs},
  dismiss: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: 'rgba(15, 23, 32, 0.55)',
  },
  dialog: {
    width: '100%',
    maxWidth: 420,
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  dialogTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl'},
  option: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  optionLabel: {
    ...typography.bodyStrong,
    flex: 1,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl'},
});
