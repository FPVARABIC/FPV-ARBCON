/**
 * WHERE تسجيل الرحلات SITS, AND WHY THAT IS NOT ARBITRARY.
 *
 * The tab strip is read right to left, index 0 first. Onboard logging is
 * a DIAGNOSTIC destination, and the diagnostic destinations already live
 * at the far end of the run - so it goes beside Sensors, which answers the
 * live half of the same question, and ahead of the expert/bulk end.
 *
 * Three properties are asserted rather than left to a comment, because
 * each of them is a decision somebody could quietly undo:
 *
 *   1. It is NOT near the front. A first-time operator configures an
 *      aircraft before they have anything to log, and this destination
 *      offers a destructive erase.
 *   2. It sits directly after Sensors - live measurement, then recorded
 *      measurement.
 *   3. It sits before Presets and CLI, which are the expert end.
 *
 * The tab exists in exactly one source of truth (MAIN_TABS) and reaches
 * both navigation surfaces from there, so this file asserts the data and
 * the icon map rather than a rendered tree.
 */

import {MAIN_TABS, isTabSelectable, type MainTabKey} from './tabs';
import {TAB_ICONS} from '../ui/components/navigation/tabIcons';

const order = MAIN_TABS.map(tab => tab.key);
const indexOf = (key: MainTabKey): number => order.indexOf(key);

describe('the onboard-logging tab', () => {
  it('exists once, is implemented, and is reachable', () => {
    expect(order.filter(key => key === 'BLACKBOX')).toHaveLength(1);
    expect(isTabSelectable('BLACKBOX')).toBe(true);
  });

  it('takes its label from the catalogue rather than a render site', () => {
    const tab = MAIN_TABS.find(entry => entry.key === 'BLACKBOX');
    expect(tab?.labelKey).toBe('tabs.blackbox');
  });

  it('is not at the front of the run', () => {
    // Well past the setup-and-configure sequence.
    expect(indexOf('BLACKBOX')).toBeGreaterThan(indexOf('SETUP'));
    expect(indexOf('BLACKBOX')).toBeGreaterThan(indexOf('MOTORS'));
    expect(indexOf('BLACKBOX')).toBeGreaterThan(indexOf('CONFIGURATIONS'));
    expect(indexOf('BLACKBOX')).toBeGreaterThan(indexOf('FAILSAFE'));
  });

  it('sits directly after Sensors - live measurement, then recorded', () => {
    expect(indexOf('BLACKBOX')).toBe(indexOf('SENSORS') + 1);
  });

  it('sits before the expert end of the strip', () => {
    expect(indexOf('BLACKBOX')).toBeLessThan(indexOf('PRESETS'));
    expect(indexOf('BLACKBOX')).toBeLessThan(indexOf('CLI'));
  });

  it('has an icon of its own on every navigation surface', () => {
    // One map feeds both the phone bar and the desktop rail.
    expect(TAB_ICONS.BLACKBOX).toBe('hard-drive');
    const duplicates = Object.entries(TAB_ICONS).filter(
      ([key, icon]) => key !== 'BLACKBOX' && icon === TAB_ICONS.BLACKBOX,
    );
    expect(duplicates).toEqual([]);
  });
});
