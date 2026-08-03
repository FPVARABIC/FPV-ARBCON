/**
 * The app's entire STACK navigation surface: exactly two routes.
 *
 * 'Connection' is the USB-connect flow (UsbConnectionScreen); 'Setup' is
 * the post-connection destination, reachable only once a session is
 * genuinely ACTIVE. Kept as its own module (not colocated with App.tsx) so
 * both App.tsx and any screen that needs to navigate/type its own route
 * props can import it without a circular dependency on App.tsx itself.
 *
 * SINGLE-APP MERGE: 'Motors' is no longer a stack route. Motors is a TAB
 * inside the 'Setup' route's shell (MainTabsScreen), alongside the integrated
 * Setup and Ports tabs and the not-yet-implemented Receiver/PID tabs - see
 * navigation/tabs.ts for that set. It was previously typed here but registered
 * only when the build-variant seam supplied a component; both the seam and the
 * separate route are gone.
 *
 * The 'Setup' route NAME is deliberately unchanged even though it now
 * renders the whole tab shell. It is what the connect flow navigates to
 * and what App.tsx's session-loss redirect listener watches; renaming it
 * would have altered that redirect contract as a side effect of adding a
 * tab bar.
 */

import type {SetupUiSessionKey} from '../platforms/react-native/protocol';

export type RootStackParamList = {
  Start: undefined;
  Connection: undefined;
  Setup: {sessionKey: SetupUiSessionKey};
  FirmwareFlasher: undefined;
};
