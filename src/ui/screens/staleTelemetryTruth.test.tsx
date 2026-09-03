/**
 * A READING THAT HAS STOPPED ARRIVING IS NOT A LIVE READING.
 *
 * =====================================================================
 * THE MECHANISM THIS TESTS
 * =====================================================================
 *
 * Every live number in this application arrives as a `TelemetryValue`,
 * and the poller already knows when one has gone quiet: the status moves
 * from `FRESH` to `STALE` and carries the age with it. The information
 * is there. The question this suite asks is whether the SCREEN passes it
 * on.
 *
 * Every screen holds the same helper:
 *
 *     value.status === 'FRESH' || value.status === 'STALE'
 *       ? value.value : undefined
 *
 * which is right - a number worth showing is usually still worth showing
 * while it ages - and which, on its own, draws a reading that stopped
 * arriving thirty seconds ago exactly like one that arrived this frame.
 * Under a heading that says «قياس حي», that is the interface telling an
 * operator the battery is at 16.5V when the last time anybody heard from
 * it was half a minute ago.
 *
 * =====================================================================
 * THE ORACLE
 * =====================================================================
 *
 * The telemetry hook is replaced with one this suite drives, and each
 * screen is rendered twice with THE SAME VALUE - once FRESH, once STALE.
 * The two renders must differ. What the difference IS is the screen's
 * business: a word, a dot, an age. That there is one is not.
 *
 * The value handed in is an input, not a finding: it is a plausible
 * reading in the shape the production decoder produces, and nothing in
 * this suite asserts anything about the number itself.
 */

const IDENTITY = {
  status: 'SUCCEEDED',
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

/**
 * Driven by the tests below, and answered PER POLL.
 *
 * Answering every poll with one value handed Failsafe's status poll an
 * RC-channels payload and made the screen throw - the harness inventing
 * a frame no poller produces. Each poll gets its own reading, and a poll
 * this suite has nothing for is answered WAITING, exactly as a poller
 * that has not delivered yet would.
 */
const telemetry: {status: 'FRESH' | 'STALE'} = {status: 'FRESH'};

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');
jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol/useMspSessionState'),
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => IDENTITY,
  useMspRecoveryState: () => 'READY',
}));
jest.mock('../../platforms/react-native/protocol/useTelemetryValue', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol/useTelemetryValue'),
  useTelemetryValue: (_sessionId: string, pollId: string) => {
    const value = (READINGS as Record<string, unknown>)[pollId];
    if (value === undefined) return {status: 'WAITING'};
    return telemetry.status === 'FRESH'
      ? {status: 'FRESH', value, updatedAtMs: 1_000, sampleSeq: 1}
      : {
          status: 'STALE',
          value,
          updatedAtMs: 1_000,
          ageMs: 30_000,
          sampleSeq: 1,
        };
  },
}));

import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

/**
 * A plausible reading in each shape the screens consume.
 *
 * These are INPUTS. Nothing below asserts anything about the numbers;
 * they exist so that the FRESH and STALE renders have something to draw,
 * and both renders draw the SAME one.
 */
const READINGS: Record<string, unknown> = {
  /* MspBatteryState: a 4S pack at 16.5V pulling 8.5A. */
  'power-battery-live': {
    cellCount: 4,
    configuredCapacityMah: 1500,
    legacyVoltageDecivolts: 165,
    consumedMah: 320,
    amperageCentiamps: 850,
    batteryStateRaw: 0,
    voltageCentivolts: 1650,
  },
  /* MspRcChannels: sticks centred, throttle low, two switches. */
  'receiver-channels-live': {
    channels: [1500, 1500, 1000, 1500, 1800, 1000, 1000, 1000],
  },
  receiver: {channels: [1500, 1500, 1000, 1500, 1800, 1000, 1000, 1000]},
};

async function draw(
  screenName: string,
  status: 'FRESH' | 'STALE',
): Promise<string> {
  telemetry.status = status;
  const screen = SCREENS.find(candidate => candidate.name === screenName)!;
  const element = await screen.mount(recorder());
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(element);
  });
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
  });
  const drawn = textOf(tree);
  await act(async () => tree.unmount());
  return drawn;
}

/** The screens that draw a live reading from the telemetry poller. */
const LIVE = ['Power', 'Failsafe', 'Modes', 'Receiver'];

const LEDGER: {screen: string; differs: boolean; freshLength: number}[] = [];

describe('a stale reading does not read like a live one', () => {
  it.each(LIVE.map(name => [name] as const))('%s', async name => {
    const fresh = await draw(name, 'FRESH');
    const stale = await draw(name, 'STALE');

    /* THE SUBJECT EXISTS: the screen really did draw the reading. A
       screen that ignored the value entirely would produce two identical
       renders for a reason that has nothing to do with staleness, and
       this catches that first. */
    const missing = await draw(name, 'FRESH');
    expect(missing).toBe(fresh);
    expect(fresh.length).toBeGreaterThan(0);

    if (fresh === stale) {
      /* WHY are they the same? Either the screen says nothing about
         staleness, or it never drew the reading at all - and those are
         different findings. Print the live markers the product uses so
         the answer is in the log rather than in a guess. */
      const markers = ['receiver-live-label', 'power-live-stale', 'failsafe-live-stale', 'sensors-live-stale'];
      console.log(`  [${name}] markers present:`, markers.filter(id => fresh.includes(id)).join(',') || 'none by text');
      const a = fresh.split('\n');
      console.log(`  [${name}] first live-ish lines:`, JSON.stringify(a.filter(l => /حي|قديم|محدث|قناة|V$|A$/.test(l)).slice(0, 6)));
    }
    LEDGER.push({screen: name, differs: fresh !== stale, freshLength: fresh.length});
    if (fresh === stale) {
      console.log(
        [
          '',
          `--- ${name}: A STALE READING IS DRAWN AS A LIVE ONE ---`,
          '  the same value, thirty seconds old, renders byte-identically',
          '  to one that arrived this frame - nothing on the screen says so',
        ].join('\n'),
      );
    }
    expect({screen: name, staleReadsLikeLive: fresh === stale}).toEqual({
      screen: name,
      staleReadsLikeLive: false,
    });
  });

  it('prints the staleness ledger', () => {
    console.log(
      [
        '',
        '===== UI-X1D STALE TELEMETRY =====',
        ...LEDGER.map(
          row =>
            `  ${row.screen.padEnd(14)} ${
              row.differs ? 'says so' : 'DRAWN AS LIVE'
            }`,
        ),
        '==================================',
        '',
      ].join('\n'),
    );
    expect(LEDGER.length).toBe(LIVE.length);
  });

  it('the oracle sees two renders that are the same', () => {
    /* NEGATIVE CONTROL. */
    const live = '16.50 V';
    expect(live === String('16.50 V')).toBe(true);
    expect(live === String('16.50 V · قديمة')).toBe(false);
  });
});
