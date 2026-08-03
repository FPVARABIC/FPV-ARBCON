/**
 * THE MAIN TAB SET - pure data and pure geometry, no React.
 *
 * Kept out of the component so the ORDER, the disabled set and the
 * initial scroll position can be asserted directly by tests rather than
 * inferred from a rendered tree.
 */

export type MainTabKey =
  | 'SETUP'
  | 'MOTORS'
  | 'PORTS'
  | 'GPS'
  | 'RECEIVER'
  | 'PID';

export interface MainTabDefinition {
  readonly key: MainTabKey;
  /** i18n key. The label itself is never hard-coded at a render site. */
  readonly labelKey: string;
  /**
   * Whether a real screen exists behind this tab.
   *
   * Unimplemented tabs are RENDERED, visibly disabled, rather than hidden:
   * the roadmap is part of what the operator is entitled to see, and a tab
   * that silently appears later is a worse surprise than one that was
   * always visible and greyed out.
   */
  readonly implemented: boolean;
}

/**
 * RIGHT-TO-LEFT ORDER. Index 0 is the RIGHTMOST tab.
 *
 * The app runs under `I18nManager.forceRTL(true)`, so a `flexDirection:
 * 'row'` container lays these out starting at the right edge - which is
 * exactly the reading order this array encodes. Do not "fix" this by
 * reversing the array for an LTR preview; the product is Arabic-first and
 * this order is the product order, not a mirrored one.
 */
export const MAIN_TABS: readonly MainTabDefinition[] = Object.freeze([
  Object.freeze({
    key: 'SETUP' as const,
    labelKey: 'tabs.setup',
    implemented: true,
  }),
  Object.freeze({
    key: 'MOTORS' as const,
    labelKey: 'tabs.motors',
    implemented: true,
  }),
  Object.freeze({
    key: 'PORTS' as const,
    labelKey: 'tabs.ports',
    implemented: true,
  }),
  Object.freeze({
    key: 'GPS' as const,
    labelKey: 'tabs.gps',
    implemented: true,
  }),
  Object.freeze({
    key: 'RECEIVER' as const,
    labelKey: 'tabs.receiver',
    implemented: false,
  }),
  Object.freeze({
    key: 'PID' as const,
    labelKey: 'tabs.pid',
    implemented: false,
  }),
]);

/** The tab a freshly-connected session lands on. */
export const INITIAL_MAIN_TAB: MainTabKey = 'SETUP';

export function findTab(key: MainTabKey): MainTabDefinition {
  const found = MAIN_TABS.find(tab => tab.key === key);
  if (found === undefined) {
    // Unreachable while MainTabKey and MAIN_TABS agree, which the type
    // system enforces at every call site. Throwing beats returning a
    // silently wrong tab.
    throw new Error(`Unknown tab: ${key}`);
  }
  return found;
}

export function isTabSelectable(key: MainTabKey): boolean {
  return findTab(key).implemented;
}

/**
 * The initial horizontal scroll offset that puts the RIGHT edge of the tab
 * strip in view.
 *
 * WHY THIS IS COMPUTED RATHER THAN LEFT TO THE PLATFORM. The requirement
 * is "initial scroll position is the right edge" on a genuinely RTL
 * layout. Android's horizontal scroll view MIRRORS its coordinate space
 * under RTL - offset 0 is the right edge, not the left - while an LTR
 * layout puts the right edge at the far end of the scrollable range. Both
 * cases are handled here explicitly, so the bar lands on the right edge
 * whether or not the platform's own RTL default did the work, and the
 * behaviour is asserted by a test instead of trusted.
 */
export function computeTabBarInitialScrollOffset(input: {
  readonly contentWidth: number;
  readonly layoutWidth: number;
  readonly isRTL: boolean;
}): number {
  const overflow = Math.max(0, input.contentWidth - input.layoutWidth);
  return input.isRTL ? 0 : overflow;
}
