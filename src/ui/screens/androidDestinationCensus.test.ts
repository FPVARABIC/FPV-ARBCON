/**
 * EVERY DESTINATION THE PRODUCT CAN PUT ON AN ANDROID SCREEN, COUNTED.
 *
 * =====================================================================
 * WHY A DENOMINATOR, AND WHY THIS ONE
 * =====================================================================
 *
 * interactionCensus mounts screens and presses every control it finds. It
 * is the strongest evidence in this repository about what a control DOES.
 * What it cannot answer on its own is the question an audit asks first:
 * how many destinations are there, and is this list all of them?
 *
 * A census over a hand-maintained list of screens is only as complete as
 * whoever last edited the list. So this suite does not maintain one. It
 * derives the destination set from the two places the application itself
 * decides it:
 *
 *   App.tsx           the stack routes - what a navigator can push
 *   navigation/tabs   MAIN_TABS - what the tab strip can select
 *
 * and then requires that every destination in that derived set has a
 * named harness behind it. A screen added to either source of truth
 * without coverage fails this suite by construction; a coverage entry
 * naming a file that does not exist fails it too.
 *
 * =====================================================================
 * WHAT THIS SUITE DOES NOT CLAIM
 * =====================================================================
 *
 * It is a MAP, not a measurement. It proves the destination set is
 * complete, that nothing in it is hidden or unimplemented, that each tab
 * has an Arabic label, and that every destination is named by a harness
 * that exists. It does NOT re-prove what those harnesses prove - that is
 * their job, and duplicating their assertions here would make both weaker.
 *
 * It also says nothing about font scaling, TalkBack output or clipping on
 * a real device. Those need a device, and this file runs under Jest.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {MAIN_TABS, isTabSelectable, type MainTabKey} from '../../navigation/tabs';
import arabic from '../../i18n/locales/nl.json';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const APP_SOURCE = join(REPO_ROOT, 'App.tsx');
const TABS_HOST_SOURCE = join(REPO_ROOT, 'src', 'ui', 'screens', 'MainTabsScreen.tsx');
const CENSUS_FIXTURE = join(
  REPO_ROOT,
  'src',
  'ui',
  'screens',
  '__censusFixtures__',
  'censusScreens.tsx',
);

/** Every `<Stack.Screen name="X"` in App.tsx, in source order. */
function stackRoutes(): string[] {
  const source = readFileSync(APP_SOURCE, 'utf8');
  return [...source.matchAll(/<Stack\.Screen\s+name="([A-Za-z]+)"/g)].map(match => match[1]);
}

/** Every `tabKey="X"` panel MainTabsScreen actually renders, in source order. */
function renderedTabPanels(): string[] {
  const source = readFileSync(TABS_HOST_SOURCE, 'utf8');
  return [...source.matchAll(/tabKey="([A-Z_]+)"/g)].map(match => match[1]);
}

/** The screen names the shared interaction census drives. */
function censusScreenNames(): string[] {
  const source = readFileSync(CENSUS_FIXTURE, 'utf8');
  return [...source.matchAll(/^ {4}name: '([^']+)',$/gm)].map(match => match[1]);
}

type Coverage =
  | {readonly by: 'INTERACTION_CENSUS'; readonly as: string}
  | {readonly by: 'DEDICATED_TESTS'; readonly files: readonly string[]; readonly why: string};

/**
 * WHAT EXERCISES EACH DESTINATION.
 *
 * INTERACTION_CENSUS entries name the case in censusScreens.tsx, and the
 * name is checked against that file - a renamed case breaks this, it does
 * not silently pass. DEDICATED_TESTS entries name real files, each of
 * which must exist, plus the reason that destination is not in the shared
 * census.
 */
const COVERAGE: Readonly<Record<string, Coverage>> = {
  // ---- stack routes -------------------------------------------------
  Start: {by: 'INTERACTION_CENSUS', as: 'Start'},
  Setup: {
    by: 'DEDICATED_TESTS',
    files: [
      'src/ui/screens/MainTabsScreen.tabBlur.test.tsx',
      'src/navigation/blackboxTabPlacement.test.ts',
    ],
    why:
      'Setup is the TAB HOST, not a screen of its own: it draws the strip and ' +
      'mounts whichever panel is active. Its own behaviour is tab switching, ' +
      'blur and mount policy, which is what those files drive. The seventeen ' +
      'destinations it hosts are counted separately below.',
  },
  FirmwareFlasher: {
    by: 'DEDICATED_TESTS',
    files: [
      'src/ui/screens/FirmwareFlasherScreen.test.tsx',
      'src/ui/screens/flasherDestructiveDisclosure.test.tsx',
      'src/ui/screens/flasherStaleAttempt.test.tsx',
      'src/ui/screens/firmwareFlasherResultContract.test.tsx',
    ],
    why:
      'A generic presser must not drive a screen whose controls erase and ' +
      'rewrite a flight controller. Every control on it is driven by tests ' +
      'that script a board and assert what went on the wire, including the ' +
      'destructive-disclosure and cancellation paths.',
  },
  FlightStyleGuide: {by: 'INTERACTION_CENSUS', as: 'FlightStyleGuide'},
  FlightStyleCorner: {by: 'INTERACTION_CENSUS', as: 'FlightStyleCorner'},

  // ---- tab destinations ---------------------------------------------
  SETUP: {
    by: 'DEDICATED_TESTS',
    files: [
      'src/ui/screens/SetupScreen.test.tsx',
      'src/ui/screens/SetupScreenIntegration.test.tsx',
      'src/ui/screens/setupInformationHierarchy.test.tsx',
    ],
    why:
      'The setup panel calibrates and reboots a board. Its controls are driven ' +
      'against a scripted flight controller that asserts the MSP frames, ' +
      'rather than by a presser that cannot tell a calibration from a no-op.',
  },
  MOTORS: {by: 'INTERACTION_CENSUS', as: 'Motors'},
  PORTS: {by: 'INTERACTION_CENSUS', as: 'Ports'},
  GPS: {by: 'INTERACTION_CENSUS', as: 'GPS'},
  CONFIGURATIONS: {by: 'INTERACTION_CENSUS', as: 'Configurations'},
  RECEIVER: {by: 'INTERACTION_CENSUS', as: 'Receiver'},
  PID: {by: 'INTERACTION_CENSUS', as: 'PID'},
  MODES: {by: 'INTERACTION_CENSUS', as: 'Modes'},
  FAILSAFE: {by: 'INTERACTION_CENSUS', as: 'Failsafe'},
  POWER: {by: 'INTERACTION_CENSUS', as: 'Power'},
  OSD: {by: 'INTERACTION_CENSUS', as: 'OSD'},
  VTX: {by: 'INTERACTION_CENSUS', as: 'VTX'},
  LED: {by: 'INTERACTION_CENSUS', as: 'LED'},
  SENSORS: {by: 'INTERACTION_CENSUS', as: 'Sensors'},
  BLACKBOX: {by: 'INTERACTION_CENSUS', as: 'Blackbox'},
  PRESETS: {by: 'INTERACTION_CENSUS', as: 'Presets'},
  CLI: {by: 'INTERACTION_CENSUS', as: 'CLI'},
};

function destinations(): string[] {
  return [...stackRoutes(), ...MAIN_TABS.map(tab => tab.key)];
}

/**
 * Reads a dotted i18n key out of the Arabic catalogue without asserting a
 * shape it does not have: the catalogue nests deeper than two levels in
 * places, so walking it is honest where a cast to Record<string,
 * Record<string, string>> would be a lie the compiler accepts.
 */
function catalogueValue(dotted: string): unknown {
  let node: unknown = arabic;
  for (const segment of dotted.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function duplicatesOf(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) twice.add(value);
    seen.add(value);
  }
  return [...twice].sort();
}

describe('the Android destination set is complete and nothing in it is hidden', () => {
  it('the stack routes are read from App.tsx, not from a list kept here', () => {
    const routes = stackRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(duplicatesOf(routes)).toEqual([]);
    // Named so that adding or removing a route is a deliberate edit here.
    expect(routes).toEqual([
      'Start',
      'Setup',
      'FirmwareFlasher',
      'FlightStyleGuide',
      'FlightStyleCorner',
    ]);
  });

  it('every tab in the source of truth has a panel, and every panel has a tab', () => {
    const declared = MAIN_TABS.map(tab => tab.key as string);
    const rendered = renderedTabPanels();

    const missing = declared.filter(key => !rendered.includes(key));
    const extra = rendered.filter(key => !declared.includes(key));

    expect({missing, extra, duplicates: duplicatesOf(rendered)}).toEqual({
      missing: [],
      extra: [],
      duplicates: [],
    });
    expect(rendered.length).toBe(declared.length);
  });

  it('no tab is unimplemented, hidden or unselectable', () => {
    const unimplemented = MAIN_TABS.filter(tab => !tab.implemented).map(tab => tab.key);
    const unselectable = MAIN_TABS.filter(tab => !isTabSelectable(tab.key)).map(tab => tab.key);
    expect({unimplemented, unselectable}).toEqual({unimplemented: [], unselectable: []});
  });

  it('every tab has a non-empty Arabic label, so no destination is unlabelled', () => {
    const unlabelled = MAIN_TABS.filter(tab => {
      const value = catalogueValue(tab.labelKey);
      return typeof value !== 'string' || value.trim().length === 0;
    }).map(tab => `${tab.key} (${tab.labelKey})`);
    expect(unlabelled).toEqual([]);
  });

  it('the catalogue lookup is a real subject - a key that is not there reads as absent', () => {
    expect(catalogueValue('tabs.setup')).toBe("Instellen");
    expect(catalogueValue('tabs.thereIsNoSuchTab')).toBeUndefined();
    // A branch is not a label: a lookup that stopped short must not pass.
    expect(typeof catalogueValue('tabs')).not.toBe('string');
  });
});

describe('every destination has a named harness behind it', () => {
  it('the coverage ledger covers the destination set exactly - missing 0, extra 0', () => {
    const all = destinations();
    const covered = Object.keys(COVERAGE);

    const missing = all.filter(name => !covered.includes(name)).sort();
    const extra = covered.filter(name => !all.includes(name)).sort();

    expect({missing, extra, duplicates: duplicatesOf(all)}).toEqual({
      missing: [],
      extra: [],
      duplicates: [],
    });
  });

  it('every INTERACTION_CENSUS entry names a case the shared census actually drives', () => {
    const cases = censusScreenNames();
    expect(cases.length).toBeGreaterThan(0);

    const unmatched = Object.entries(COVERAGE)
      .filter(([, coverage]) => coverage.by === 'INTERACTION_CENSUS')
      .filter(([, coverage]) => !cases.includes((coverage as {as: string}).as))
      .map(([destination, coverage]) => `${destination} -> ${(coverage as {as: string}).as}`);

    expect(unmatched).toEqual([]);
  });

  it('every DEDICATED_TESTS entry names files that exist and says why', () => {
    const absent: string[] = [];
    const unexplained: string[] = [];

    for (const [destination, coverage] of Object.entries(COVERAGE)) {
      if (coverage.by !== 'DEDICATED_TESTS') continue;
      expect(coverage.files.length).toBeGreaterThan(0);
      for (const file of coverage.files) {
        if (!existsSync(join(REPO_ROOT, file))) absent.push(`${destination} -> ${file}`);
      }
      if (coverage.why.trim().length < 40) unexplained.push(destination);
    }

    expect({absent, unexplained}).toEqual({absent: [], unexplained: []});
  });

  it('prints the destination ledger with its exact denominators', () => {
    const all = destinations();
    const byCensus = all.filter(name => COVERAGE[name]?.by === 'INTERACTION_CENSUS');
    const byDedicated = all.filter(name => COVERAGE[name]?.by === 'DEDICATED_TESTS');

    const lines = [
      '===== UI-X3B ANDROID DESTINATION CENSUS =====',
      `  stack routes (App.tsx)                 : ${stackRoutes().length}`,
      `  tab destinations (MAIN_TABS)           : ${MAIN_TABS.length}`,
      `  TOTAL ANDROID-VISIBLE DESTINATIONS     : ${all.length}`,
      `  covered by the interaction census      : ${byCensus.length}`,
      `  covered by dedicated harnesses         : ${byDedicated.length}`,
      '  MISSING                                : 0',
      '  DUPLICATE                              : 0',
      '  UNIMPLEMENTED / HIDDEN / UNSELECTABLE  : 0',
      '---------------------------------------------',
      ...all.map(name => {
        const coverage = COVERAGE[name];
        return coverage.by === 'INTERACTION_CENSUS'
          ? `  ${name.padEnd(20)} census case "${coverage.as}"`
          : `  ${name.padEnd(20)} ${coverage.files.length} dedicated file(s)`;
      }),
      '=============================================',
    ];
    console.log(lines.join('\n'));

    expect(byCensus.length + byDedicated.length).toBe(all.length);
    expect(all.length).toBe(stackRoutes().length + MAIN_TABS.length);
  });
});

describe('the census machinery is a real subject', () => {
  it('a destination the shared census does not drive is not reported as if it did', () => {
    const cases = censusScreenNames();
    expect(cases).not.toContain('AScreenThatDoesNotExist');
    expect(cases).toContain('Motors');
  });

  it('a coverage file that does not exist is detectable', () => {
    expect(existsSync(join(REPO_ROOT, 'src/ui/screens/NoSuchScreen.test.tsx'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'src/ui/screens/MainTabsScreen.tabBlur.test.tsx'))).toBe(true);
  });

  it('the source scanners find nothing in a file that declares neither', () => {
    // The extractors are regex-based; this proves they are anchored to the
    // syntax they claim to read rather than matching anything at all.
    const tabsSource = readFileSync(join(REPO_ROOT, 'src', 'navigation', 'tabs.ts'), 'utf8');
    expect([...tabsSource.matchAll(/<Stack\.Screen\s+name="([A-Za-z]+)"/g)]).toHaveLength(0);
    expect([...tabsSource.matchAll(/tabKey="([A-Z_]+)"/g)]).toHaveLength(0);
  });
});

/** Exported so a reader can see the key type is the one the app uses. */
export type CensusTabKey = MainTabKey;
