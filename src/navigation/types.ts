/**
 * The app's entire STACK navigation surface: five routes.
 *
 * 'Start' is the two-choice home. 'Setup' renders the main TAB SHELL
 * (MainTabsScreen) and is now reachable DIRECTLY from Start with NO
 * params: the shell opens in its honest disconnected posture and hosts
 * the real USB connection workspace inside the Setup tab
 * (SetupScreen.tsx), which re-parameterizes this same route in place via
 * navigation.setParams({sessionKey}) once a session is genuinely ACTIVE.
 * 'FirmwareFlasher' is the standalone flashing tool, also entered
 * directly from Start.
 *
 * 'FlightStyleGuide' is the directory of flight styles, and
 * 'FlightStyleCorner' is ONE style's own guide. They are two routes
 * rather than one screen with a mode, because they answer different
 * questions - "which of these am I flying?" and "how do I set this one
 * up?" - and because the corner must be addressable on its own. The
 * corner takes the style id as a parameter and renders that style ALONE:
 * a page that pooled two styles' numbers would be dangerous, not untidy,
 * since the same field takes opposite correct values on a 1S whoop and a
 * 6S racer.
 *
 * THE 'Connection' ROUTE IS GONE - deliberately. It was a full-screen
 * stop between Home and the configurator whose only product purpose was
 * producing a sessionKey for navigate('Setup'). The screen component
 * (UsbConnectionScreen.tsx) survives with all of its transport safety
 * intact; it is now hosted INSIDE the Setup tab when no session exists,
 * so connecting is contextual rather than a separate navigation stop.
 * Nothing about USB permission, MSP activation or session ownership
 * changed - only where the surface renders.
 *
 * `Setup`'s params are `... | undefined` on purpose: undefined IS the
 * disconnected configurator, a first-class product state - not a
 * malformed navigation. The session-loss redirect
 * (useSessionLossRedirect.ts) resets to exactly that state when a
 * tracked session dies.
 *
 * Kept as its own module (not colocated with App.tsx) so both App.tsx
 * and any screen that needs to navigate/type its own route props can
 * import it without a circular dependency on App.tsx itself.
 */

import type {SetupUiSessionKey} from '../platforms/react-native/protocol';

export type RootStackParamList = {
  /**
   * HOME, AND THE WHOLE DISCONNECTED APPLICATION.
   *
   * There is NO connection route in this list, and its absence is a
   * product decision rather than an omission. A standalone connection
   * page is somewhere the application can strand an operator: it can be
   * deep-linked, restored from saved navigation state, walked back into
   * with the browser's Back button, and left showing "not connected"
   * with no way forward. So connecting is not a destination at all -
   * Home DOES it (StartScreen + ui/session/useDirectConnect), inline,
   * while the operator stays exactly where they pressed.
   *
   * It takes no params for the same reason. "You were returned here
   * because a link died" is a one-shot signal
   * (ui/session/connectionNotice.ts), not navigation state: a param
   * would survive a refresh and announce a lost board to somebody who
   * simply reloaded the page.
   */
  Start: undefined;
  /**
   * THE CONFIGURATION WORKSPACE, and it exists only while a flight
   * controller is verified.
   *
   * This route is registered in the navigator ONLY while
   * ui/session/verifiedConnection.ts reports CONNECTED (App.tsx,
   * App.web.tsx). That is the hard wall: before it there is no protected
   * route to deep-link into, to restore from a saved navigation state,
   * or to render for a frame before a guard notices.
   *
   * `sessionKey` is therefore always present in practice - the route
   * cannot be entered without one - and stays optional in the type only
   * because react-navigation cannot express "this route exists
   * conditionally" at the param level.
   */
  Setup: {sessionKey?: SetupUiSessionKey} | undefined;
  FirmwareFlasher: undefined;
  FlightStyleGuide: undefined;
  /**
   * `styleId` is a plain string rather than the generated union so a
   * stale deep link cannot fail to typecheck; the screen resolves it and
   * says plainly when there is no such corner.
   */
  FlightStyleCorner: {styleId: string};
};
