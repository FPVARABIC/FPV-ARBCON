/**
 * Phase 2I - the DEVELOPMENT-ONLY entry into the motor-test flow.
 *
 * WHY IT IS ITS OWN MODULE. The entry must be absent from a production
 * bundle - not merely inert in it. A `__DEV__ && ...` guard written inline
 * in UsbConnectionScreen would leave this JSX, this testID and the literal
 * route name `'Motors'` in the shipped bytes, because Metro cannot strip a
 * runtime check on an imported binding. Living behind the same
 * `__DEV__`-guarded require() the debug panels already use (debugPanels.ts)
 * is what makes the whole thing genuinely disappear - verified against a
 * real --dev false bundle, not assumed.
 *
 * IT STARTS NOTHING. Navigating does not begin a motor-test session,
 * acquire a lease, pause telemetry, establish command 99 or write a byte.
 * `beginSession()` remains the only initiation point, and a pulse still
 * requires a deliberate 800 ms long press on the accepted control.
 */

import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';

import {colors, radii, spacing, typography} from '../theme';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';

/** The route name, defined ONCE and only inside this stripped module. */
export const MOTORS_ROUTE_NAME = 'Motors' as const;

export interface MotorsDevEntryProps {
  readonly sessionId: string;
  /**
   * The navigator itself, NOT a pre-bound callback.
   *
   * Deliberate: a callback built at the call site would carry the literal
   * route name `'Motors'` into UsbConnectionScreen, and that literal would
   * then survive into a production bundle even though this whole module is
   * stripped - the guard around it is a runtime check on an imported
   * binding, which Metro cannot eliminate. Keeping the route name HERE
   * keeps every trace of the motor flow inside the strippable module.
   */
  readonly navigate: (route: string, params: unknown) => void;
}

export default function MotorsDevEntry({
  sessionId,
  navigate,
}: MotorsDevEntryProps): React.JSX.Element | null {
  // THE EXACT CURRENT OFFICIAL SESSION KEY, read from the coordinator that
  // owns it. Never synthesized, never a second binding, never a remembered
  // copy - a stale key would point the screen at a session that no longer
  // exists.
  const sessionKey = mspSessionCoordinator.getSessionKey(sessionId);
  if (sessionKey === undefined) {
    return null;
  }
  return (
    <Pressable
      onPress={() => navigate(MOTORS_ROUTE_NAME, {sessionKey})}
      accessibilityRole="button"
      style={styles.entry}
      testID="dev-open-motor-test">
      <Text style={styles.label}>اختبار المحركات (تطوير فقط)</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  entry: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.sm,
  },
  label: {
    ...typography.body,
    color: colors.warning,
    writingDirection: 'rtl',
  },
});
