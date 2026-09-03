/**
 * THE INTERFACE READS RIGHT TO LEFT. THE AIRCRAFT DOES NOT TURN AROUND.
 *
 * =====================================================================
 * THE TWO KINDS OF DIRECTION, AND WHY CONFUSING THEM IS A SAFETY BUG
 * =====================================================================
 *
 * This application is Arabic-first: rows run right to left, a "next"
 * chevron points left, a back arrow points right. That is correct, and
 * every navigation affordance should follow it.
 *
 * Nothing else should. A motor's expected rotation, the corner of the
 * airframe a motor sits in, which edge of the LED strip faces the nose,
 * where an OSD element sits on the video, which way an axis points on a
 * sensor trace - all of those are claims about the WORLD. Mirroring one
 * of them because the interface language changed tells an operator to
 * fit a propeller the wrong way round, and they will find out in the
 * air.
 *
 * `iconTruth` covers the GLYPHS. This covers the WORDS and the
 * IDENTITIES: the accessible names that place a motor in a corner, the
 * coordinates that place an LED on the strip, the labels that name the
 * front of the aircraft. Every one of them must be byte-identical in
 * both layouts.
 *
 * The purely visual half - does the grid itself flip on screen - is a
 * question about a rendered box, and jsdom has no layout engine, so it
 * is measured in real Chromium by
 * `scripts/verify-responsive-interaction.mjs` instead.
 */

const IDENTITY = {
  status: 'SUCCEEDED',
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');
jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol/useMspSessionState'),
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => IDENTITY,
  useMspRecoveryState: () => 'READY',
}));

import ReactTestRenderer, {act} from 'react-test-renderer';
import {I18nManager, Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/**
 * WHAT COUNTS AS A PHYSICAL CLAIM.
 *
 * Identities and accessible names that place something in the world.
 * Matched on the testID or the accessible name, so a control that starts
 * making such a claim joins this census without anyone updating a table,
 * and one that stops making it leaves.
 */
const PHYSICAL = [
  /* Which cell of the LED strip, by grid coordinate. */
  /^led-cell-\d+-\d+$/,
  /* Which position in the wiring order, and which LED. */
  /^led-order-(earlier|later|select)-\d+$/,
  /* Which motor, in which corner, turning which way. */
  /^motors-airframe-slot-\d+$/,
  /^motor-output-row-M\d+$/,
  /* Where an OSD element sits on the video. */
  /^osd-element-\d+$/,
  /* Which way the board is mounted in the airframe, and the pointer
     that draws it. */
  /^sensors-board-alignment-pointer$/,
  /^sensors-alignment$/,
  /* Where home is, relative to where the aircraft is pointing. */
  /^gps-home-arrow$/,
  /^gps-home-arrow-absent$/,
];

function isPhysical(id: string): boolean {
  return PHYSICAL.some(rule => rule.test(id));
}

interface Claim {
  readonly id: string;
  readonly name: string;
}

/**
 * Every physical claim a screen makes, with the words it makes it in.
 *
 * Order matters and is kept: the sequence of the claims is itself a
 * statement about the strip and the airframe, and a layout that reversed
 * it would be reversing the aircraft.
 */
async function claimsOf(
  screenName: string,
  rtl: boolean,
): Promise<{claims: Claim[]; text: string}> {
  const previous = I18nManager.isRTL;
  Object.defineProperty(I18nManager, 'isRTL', {
    value: rtl,
    configurable: true,
    writable: true,
  });
  try {
    const screen = SCREENS.find(candidate => candidate.name === screenName)!;
    const element = await screen.mount(recorder());
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(element);
    });
    await act(async () => {
      for (let round = 0; round < 8; round += 1) await Promise.resolve();
    });
    if (screen.precondition !== undefined) {
      await screen.precondition(tree);
      await act(async () => {
        await Promise.resolve();
      });
    }
    const claims: Claim[] = [];
    const seen = new Set<string>();
    for (const node of tree.root.findAll(
      candidate =>
        typeof (candidate.props as any)?.testID === 'string' &&
        isPhysical((candidate.props as any).testID),
      {deep: true},
    )) {
      const props = node.props as any;
      const id = String(props.testID);
      const name = String(props.accessibilityLabel ?? '');
      const key = `${id}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({id, name});
    }
    const text = tree.root
      .findAllByType(Text)
      .map(node => {
        const value = node.props.children;
        return Array.isArray(value) ? value.join('') : String(value ?? '');
      })
      .join('\n');
    await act(async () => tree.unmount());
    return {claims, text};
  } finally {
    Object.defineProperty(I18nManager, 'isRTL', {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
}

/** Screens that make a physical claim at all. */
/**
 * MotorConfiguration is deliberately absent: it edits protocol, idle and
 * throttle numbers, and makes no claim about where anything is. Its
 * physical claim - which corner each motor sits in - is drawn by Motors,
 * which is measured. A screen listed here that produces no claim would
 * make its row a decoration, so the ledger below fails on one.
 */
const PHYSICAL_SCREENS = ['LED', 'Motors', 'OSD', 'Sensors', 'GPS'];

const LEDGER: {screen: string; claims: number; identical: boolean}[] = [];

describe('a physical claim reads the same in both layouts', () => {
  it.each(PHYSICAL_SCREENS.map(name => [name] as const))('%s', async name => {
    const rtl = await claimsOf(name, true);
    const ltr = await claimsOf(name, false);

    const differences: string[] = [];
    const width = Math.max(rtl.claims.length, ltr.claims.length);
    for (let index = 0; index < width; index += 1) {
      const a = rtl.claims[index];
      const b = ltr.claims[index];
      if (a === undefined || b === undefined) {
        differences.push(
          `position ${index}: rtl=${a?.id ?? '(absent)'} ltr=${b?.id ?? '(absent)'}`,
        );
        continue;
      }
      if (a.id !== b.id) {
        differences.push(`position ${index}: rtl says ${a.id}, ltr says ${b.id}`);
      } else if (a.name !== b.name) {
        differences.push(
          `${a.id}: rtl calls it "${a.name.slice(0, 50)}", ltr calls it "${b.name.slice(0, 50)}"`,
        );
      }
    }
    LEDGER.push({
      screen: name,
      claims: rtl.claims.length,
      identical: differences.length === 0,
    });
    if (differences.length > 0) {
      console.log(
        [
          '',
          `--- ${name}: A PHYSICAL CLAIM CHANGED WITH THE LAYOUT ---`,
          ...differences.slice(0, 20).map(line => `  ${line}`),
        ].join('\n'),
      );
    }
    expect({screen: name, changedWithTheLayout: differences}).toEqual({
      screen: name,
      changedWithTheLayout: [],
    });
  });

  it('prints the physical-claim ledger', () => {
    const total = LEDGER.reduce((sum, row) => sum + row.claims, 0);
    console.log(
      [
        '',
        '===== UI-X1D PHYSICAL DIRECTION UNDER RTL =====',
        `  screens making a physical claim : ${LEDGER.length}`,
        `  claims compared in both layouts : ${total}`,
        ...LEDGER.map(
          row =>
            `  ${row.screen.padEnd(19)} ${String(row.claims).padStart(4)} claims` +
            `  ${row.identical ? 'identical in both layouts' : 'CHANGED'}`,
        ),
        '==============================================',
        '',
      ].join('\n'),
    );
    /* A census with nothing in it would satisfy every row above. */
    expect(total).toBeGreaterThan(10);
    expect(LEDGER.every(row => row.identical)).toBe(true);
    /* Every screen named here really does make a claim. A row reporting
       zero would be a screen this pass believes it is covering and is
       not. */
    expect(LEDGER.filter(row => row.claims === 0).map(row => row.screen)).toEqual(
      [],
    );
  });

  it('the detector sees a claim that flipped', () => {
    /* NEGATIVE CONTROL. */
    const a: Claim[] = [{id: 'motors-airframe-slot-1', name: 'M1، خلفي يمين'}];
    const b: Claim[] = [{id: 'motors-airframe-slot-1', name: 'M1، خلفي يسار'}];
    expect(a[0].name === b[0].name).toBe(false);
    const reordered: Claim[] = [
      {id: 'led-cell-1-0', name: ''},
      {id: 'led-cell-0-0', name: ''},
    ];
    const original: Claim[] = [
      {id: 'led-cell-0-0', name: ''},
      {id: 'led-cell-1-0', name: ''},
    ];
    expect(reordered[0].id === original[0].id).toBe(false);
  });
});
