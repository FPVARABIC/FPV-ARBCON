/**
 * THE SHELL'S OWN GEOMETRY, in one place, because two things need it.
 *
 * MainTabsScreen renders it; `scripts/verify-desktop-workspace.mjs`
 * measures it through the browser fixture. While the fixture carried its
 * own copy of these four rules, the gate could not have caught a
 * regression in the shell itself - it would have measured the copy and
 * reported that the copy was fine. Sharing the object makes that class of
 * false pass impossible rather than unlikely.
 *
 * There is nothing clever here, and that is the point: the workspace is
 * `flex: 1` beside the rail, so the width a screen may use is already
 * computed by flex, and no envelope constant has to guess it.
 */
import type {ViewStyle} from 'react-native';

export const MAIN_TABS_SHELL: {
  /** Fills the route. */
  readonly root: ViewStyle;
  /**
   * Added to `root` when the navigation rail is showing. Under the app's
   * forceRTL a plain row puts the rail on the RIGHT, which is the
   * reading start.
   */
  readonly rootDesktop: ViewStyle;
  /** The workspace: everything the rail did not take. */
  readonly content: ViewStyle;
  /** A mounted, visible tab panel. */
  readonly visible: ViewStyle;
  /**
   * Hidden, NOT unmounted - the Motors stop bridge depends on panels
   * staying mounted. `display: 'none'` removes it from layout entirely,
   * so a hidden tab cannot occupy space or intercept touches.
   */
  readonly hidden: ViewStyle;
} = {
  root: {flex: 1},
  rootDesktop: {flexDirection: 'row'},
  content: {flex: 1},
  visible: {flex: 1},
  hidden: {display: 'none'},
};
