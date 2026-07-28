/**
 * Pass 7.1 - the app's entire navigation surface: exactly two routes.
 * 'Connection' is the existing USB-connect flow (UsbConnectionScreen,
 * unmodified except for one navigate() call); 'Setup' is a new stub
 * (SetupScreen) reachable only once a session is genuinely ACTIVE. Kept as
 * its own module (not colocated with App.tsx) so both App.tsx and any
 * screen that needs to navigate/type its own route props can import it
 * without a circular dependency on App.tsx itself.
 */

import type {SetupUiSessionKey} from '../platforms/react-native/protocol';

export type RootStackParamList = {
  Connection: undefined;
  Setup: {sessionKey: SetupUiSessionKey};
  /**
   * Phase 2H - the motor-test screen.
   *
   * TYPED HERE UNCONDITIONALLY, REGISTERED CONDITIONALLY. The param type
   * must exist for any consumer to be type-checked, but App.tsx only
   * registers the <Stack.Screen> when the __DEV__-gated component
   * (debugPanels.ts's DevMotorsScreen) actually resolved. In a production
   * bundle that component is `undefined`, the screen is never registered,
   * and navigating to 'Motors' therefore reaches nothing - the motor flow
   * stays unreachable until Phase 2I completes the verification wizard
   * and report.
   */
  Motors: {sessionKey: SetupUiSessionKey};
};
