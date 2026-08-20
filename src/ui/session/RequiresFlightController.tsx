/**
 * THE SCREEN GATE. One clean state instead of a fake workspace.
 *
 * Wraps any configuration screen that needs a flight controller. When
 * there is a live, current, identified session the children render
 * exactly as before and this component costs one function call. When
 * there is not, the children are NOT MOUNTED AT ALL - which matters far
 * more than how the replacement looks:
 *
 *   - a screen that never mounts cannot start a poll, open a lease, or
 *     fire an effect against a session that is gone;
 *   - and the operator is not handed a plausible-looking panel of dead
 *     controls to interpret.
 *
 * The replacement is deliberately small: what is wrong, and one button
 * that goes where it can be fixed. Not a redesign - it uses the app's
 * own Button, spacing, typography and NoticeBox-adjacent surface.
 *
 * NO REDIRECT. The button SELECTS THE SETUP TAB, which is where the USB
 * connection workspace lives; it does not navigate, reset or replace a
 * route. That is what keeps this incapable of looping: the Setup tab is
 * never gated (see FC_DEPENDENT_TABS), so arriving there always
 * terminates.
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Button} from '../components/controls';
import {colors, radii, spacing, typography} from '../theme';
import type {FlightControllerGate} from './flightControllerGate';

export interface RequiresFlightControllerProps {
  readonly gate: FlightControllerGate;
  /** Takes the operator to the connection workspace. */
  readonly onOpenConnection: () => void;
  /** Names the screen being gated, for the testID only. */
  readonly screen: string;
  readonly children: React.ReactNode;
}

export function RequiresFlightController({
  gate,
  onOpenConnection,
  screen,
  children,
}: RequiresFlightControllerProps): React.JSX.Element {
  const {t} = useTranslation();
  if (gate.kind === 'READY') return <>{children}</>;

  const body =
    gate.kind === 'IDENTIFYING'
      ? t('connectionGate.identifying')
      : gate.kind === 'STALE_SESSION'
        ? t('connectionGate.staleBody')
        : t('connectionGate.noSessionBody');

  return (
    <View style={styles.root} testID={`connection-gate-${screen}`}>
      <View style={styles.card}>
        <Text style={styles.title} testID="connection-gate-title">
          {gate.kind === 'IDENTIFYING'
            ? t('connectionGate.identifyingTitle')
            : t('connectionGate.title')}
        </Text>
        <Text style={styles.body} testID="connection-gate-body">
          {body}
        </Text>
        {/* While identification is running there is nothing for the
            operator to DO - the link is already up and the answer is
            seconds away. Offering a connect button there would invite
            them to tear down a session that is working. */}
        {gate.kind === 'IDENTIFYING' ? null : (
          <Button
            label={t('connectionGate.action')}
            onPress={onOpenConnection}
            variant="primary"
            icon="usb"
            testID="connection-gate-action"
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  card: {
    /* Capped rather than stretched: on a 1920 desktop a full-width slab
       carrying two lines of text is exactly the kind of oversized
       surface this round is removing elsewhere. */
    maxWidth: 420,
    width: '100%',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  body: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
});
