/**
 * THE CONNECTION, RENDERED WHERE THE OPERATOR PRESSED.
 *
 * Three pieces, and the split is the design:
 *
 *   HomeConnectStatus  an INLINE strip under the two Home cards. It is
 *                      what a connection that is going fine looks like -
 *                      one line, no dialog, no navigation. A modal here
 *                      would flash open and shut for a 300ms connect.
 *                      Under the cards, because that is where the
 *                      operator just pressed.
 *
 *   HomeConnectNotice  the same strip shape, ABOVE the cards, for the
 *                      opposite situation: the operator did not press
 *                      anything, they were ejected here by a link that
 *                      died or a reboot that never came back. Different
 *                      position because it answers a question they did
 *                      not ask, and below the fold it answered nothing.
 *
 *   HomeConnectPicker  a small dialog, and ONLY for the one state that
 *                      is a genuine question: more than one board on the
 *                      bench. Asking deserves an interruption; reporting
 *                      progress does not.
 *
 * None is a route. All disappear when their reason does.
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
import type {ConnectionNotice} from '../../session/connectionNotice';

/** The progress phases share one line of copy and one spinner. */
const PROGRESS_COPY: Record<string, string> = {
  CHOOSING: 'directConnect.choosing',
  OPENING: 'directConnect.connecting',
  IDENTIFYING: 'directConnect.identifying',
};

export function HomeConnectStatus({
  phase,
  onRetry,
  onDismiss,
}: {
  readonly phase: ConnectPhase;
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

  return null;
}

/**
 * WHY THE OPERATOR IS LOOKING AT HOME WHEN THEY DID NOT CHOOSE TO BE.
 *
 * =====================================================================
 * WHY THIS IS A SEPARATE COMPONENT WITH A SEPARATE PLACE ON THE PAGE
 * =====================================================================
 *
 * The strip above answers "what is happening to the thing I just
 * pressed", so it belongs directly under the card that was pressed -
 * where the operator is already looking.
 *
 * This one answers a question the operator never asked, because they
 * were EJECTED here: a reboot that did not come back, or a link that
 * died. Measured at 360, 390, 412 and 768 with the two primary cards
 * stacked, the old shared position put this message 74 to 118 pixels
 * BELOW the fold. The escape hatch existed and was invisible - the
 * operator saw a Home screen with no explanation of why they had left
 * the workspace, which is the same experience as the hang it replaced.
 *
 * So it is rendered ABOVE the cards instead. Precedence is unchanged:
 * it stays silent while a connection attempt is in flight or has just
 * failed, because those have their own, newer sentence.
 */
export function HomeConnectNotice({
  phase,
  notice,
  onRetry,
  onDismiss,
}: {
  readonly phase: ConnectPhase;
  readonly notice: ConnectionNotice;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}): React.JSX.Element | null {
  const {t} = useTranslation();
  // A fresh attempt, or a fresh failure, is the newer news. IDLE is the
  // only phase that means "nothing of mine is in flight".
  if (phase.kind !== 'IDLE') return null;
  if (notice !== null) {
    const failedReconnect = notice === 'RECONNECT_FAILED';
    return (
      <View
        style={[styles.strip, styles.stripLost]}
        testID={failedReconnect ? 'home-reconnect-failed' : 'home-session-lost'}>
        <Icon name="triangle-alert" size={20} color={colors.warning} />
        <Text style={styles.stripText} testID="home-connect-message">
          {t(
            failedReconnect
              ? 'directConnect.reconnectFailed'
              : 'directConnect.sessionLost',
          )}
        </Text>
        <View style={styles.stripActions}>
          {/* A recovery that timed out is exactly the case where the
              operator wants to try again without hunting for the door. */}
          {failedReconnect ? (
            <Button
              label={t('directConnect.retry')}
              onPress={onRetry}
              variant="secondary"
              testID="home-reconnect-retry"
            />
          ) : null}
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
    /* WRAPS, because at 360 the icon, a full sentence, a button and a
       dismiss target do not fit on one line - and when they are forced
       to, the sentence collapses into a column of two-word fragments
       that is harder to read than the failure it describes. Wrapping
       puts the actions on their own line instead. */
    flexWrap: 'wrap',
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
    /* Enough room that the sentence stays a sentence; below this the
       row wraps and the text gets the full width to itself. */
    minWidth: 200,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  stripActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    // Trails the text on a wide row; sits under it on a wrapped one.
    marginRight: 'auto',
  },
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
