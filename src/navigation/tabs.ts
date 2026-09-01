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
  | 'CONFIGURATIONS'
  | 'RECEIVER'
  | 'PID'
  | 'MODES'
  | 'FAILSAFE'
  | 'POWER'
  | 'OSD'
  | 'VTX'
  | 'LED'
  | 'SENSORS'
  | 'BLACKBOX'
  | 'PRESETS'
  | 'CLI';

export interface MainTabDefinition {
  readonly key: MainTabKey;
  /** i18n key. The label itself is never hard-coded at a render site. */
  readonly labelKey: string;
  /**
   * Whether a real screen exists behind this tab.
   *
   * Future entries may remain unimplemented in this source of truth, but
   * navigation surfaces expose only completed destinations.
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
    key: 'CONFIGURATIONS' as const,
    labelKey: 'tabs.configurations',
    implemented: true,
  }),
  Object.freeze({
    key: 'RECEIVER' as const,
    labelKey: 'tabs.receiver',
    implemented: true,
  }),
  Object.freeze({
    key: 'PID' as const,
    labelKey: 'tabs.pid',
    implemented: true,
  }),
  Object.freeze({
    key: 'MODES' as const,
    labelKey: 'tabs.modes',
    implemented: true,
  }),
  Object.freeze({
    key: 'FAILSAFE' as const,
    labelKey: 'tabs.failsafe',
    implemented: true,
  }),
  Object.freeze({
    key: 'POWER' as const,
    labelKey: 'tabs.power',
    implemented: true,
  }),
  Object.freeze({
    key: 'OSD' as const,
    labelKey: 'tabs.osd',
    implemented: true,
  }),
  Object.freeze({
    key: 'VTX' as const,
    labelKey: 'tabs.vtx',
    implemented: true,
  }),
  /**
   * WHY شريط LED SITS HERE, between VTX and Sensors.
   *
   * It belongs to the PERIPHERAL run, not the configuration run. OSD is
   * what the pilot sees through the goggles, VTX is the link that carries
   * it, and the LED strip is what everyone else sees from the ground -
   * three destinations about equipment bolted to the aircraft rather than
   * about how it flies. Nothing in the flight-configuration sequence
   * (Ports → Configurations → Receiver → PID → Modes → Failsafe → Power)
   * depends on it, and putting it there would interrupt that sequence
   * with a cosmetic destination.
   *
   * It is equally deliberately BEFORE the diagnostic pair (Sensors,
   * تسجيل الرحلات): lighting is something an operator configures, not
   * something they read a measurement from.
   */
  Object.freeze({
    key: 'LED' as const,
    labelKey: 'tabs.led',
    implemented: true,
  }),
  Object.freeze({
    key: 'SENSORS' as const,
    labelKey: 'tabs.sensors',
    implemented: true,
  }),
  /**
   * WHY تسجيل الرحلات SITS HERE, between Sensors and Presets.
   *
   * It is a DIAGNOSTIC screen, and this end of the strip is where the
   * diagnostic screens already are. Sensors answers "what is the aircraft
   * measuring right now"; onboard logging answers "what did it measure
   * while I was flying". Putting the live one and the recorded one next to
   * each other is the grouping a pilot already has in their head, and it
   * keeps logging out of the configuration run (Ports → Configurations →
   * Receiver → PID → Modes → Failsafe → Power) where nothing depends on it.
   *
   * It is deliberately NOT near the front. A first-time operator sets the
   * aircraft up before they have anything to log, and a destination that
   * offers a destructive erase does not belong in front of them on the way
   * to their first flight. It is equally deliberately BEFORE Presets and
   * CLI, which are the expert/bulk end.
   */
  Object.freeze({
    key: 'BLACKBOX' as const,
    labelKey: 'tabs.blackbox',
    implemented: true,
  }),
  Object.freeze({
    key: 'PRESETS' as const,
    labelKey: 'tabs.presets',
    implemented: true,
  }),
  Object.freeze({
    key: 'CLI' as const,
    labelKey: 'tabs.cli',
    implemented: true,
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
