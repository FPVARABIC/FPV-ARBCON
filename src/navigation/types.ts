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
};
