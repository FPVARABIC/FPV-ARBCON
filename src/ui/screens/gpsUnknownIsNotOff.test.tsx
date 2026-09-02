/**
 * NOT KNOWING IS NOT THE SAME AS KNOWING IT IS OFF.
 *
 * The GPS screen answers three questions in a row of pills at the top -
 * is the link up, is there a fix, is the GPS feature enabled - and a
 * card underneath answers a fourth: is a UART assigned to GPS. Two of
 * those, the feature and the port, are CONFIGURATION facts that come
 * from a read of the board. Until that read lands the application does
 * not know either one.
 *
 * It used to say them anyway. `draft?.enabled === true ? on : off` and
 * `ports.length === 0 ? noPort : portReady` both fall to the negative
 * while the read is still outstanding, so an operator opening the screen
 * was told, as settled fact, "GPS is not enabled" and "no GPS port is
 * assigned" - before the board had said a word. On a screen whose whole
 * job is to explain why GPS is not working, being told the two most
 * likely causes are true, wrongly, sends people to change settings that
 * were never wrong.
 *
 * The rule this file fixes: while the configuration read is outstanding,
 * a configuration fact is UNKNOWN and must read as unknown. After it
 * lands - enabled, disabled, failed, or refused - the screen may state
 * what it now knows.
 *
 * The live fix pill is deliberately NOT covered by this rule. "No fix
 * yet" is a true statement about a stream that has not delivered, not a
 * claim about a value the board already holds.
 */
const IDENTITY = {
  status: 'SUCCEEDED',
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

/* WITHOUT THIS, NOTHING IS EVER READ AND EVERY ASSERTION HERE IS EMPTY.
   GpsScreen's load effect returns early unless `ownership === 'ACTIVE'`
   and identification has settled. Mounted without a session the screen
   sits in IDLE forever, never calls `load`, and shows the unknown state
   for a reason that has nothing to do with the rule under test - five of
   these six tests passed that way before this mock existed. */
jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol/useMspSessionState'),
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => IDENTITY,
  useMspRecoveryState: () => 'READY',
}));

import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import {act} from 'react-test-renderer';
import {Text} from 'react-native';

import GpsScreen from './GpsScreen';
/* The screen renders through i18n; without this every `t()` returns its
   key and a test asserting on Arabic copy passes for the wrong reason. */
import '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {GpsConfigurationController} from '../../platforms/react-native/protocol/GpsConfigurationController';
import {
  DRONE_SPECS,
  buildFactoryBoard,
} from '../../platforms/react-native/protocol/__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from '../../platforms/react-native/protocol/__testUtils__/virtualFlightController';
import {VirtualSession} from '../../platforms/react-native/protocol/__testUtils__/virtualSession';

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');
jest.setTimeout(60000);

const KEY = {sessionId: 'gps-unknown', generation: 1} as const;
const COPY = ar.gpsSystem as unknown as Record<string, string>;

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
  });
}

async function realSnapshot(): Promise<unknown> {
  const spec = DRONE_SPECS.find(candidate => candidate.key === 'LONG_RANGE');
  if (spec === undefined) throw new Error('no LONG_RANGE spec');
  const session = new VirtualSession({
    sessionId: KEY.sessionId,
    board: new VirtualFlightController({
      parameters: buildFactoryBoard(spec),
    }) as never,
    apiMinor: 47,
  });
  const outcome: any = await new GpsConfigurationController(
    session.options as never,
  ).load(session.key);
  return outcome.snapshot;
}

async function mountWith(load: () => Promise<unknown>) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <GpsScreen
        sessionKey={KEY}
        active
        onOpenPorts={() => undefined}
        controller={
          {load, save: async () => ({kind: 'NO_CHANGES'})} as never
        }
      />,
    );
  });
  await flush();
  return tree;
}

describe('GPS does not state a configuration fact it has not read', () => {
  it('while the read is outstanding it claims neither "feature off" nor "no port"', async () => {
    /* Held open: the board has not answered, so nothing about the GPS
       CONFIGURATION is known yet. */
    const tree = await mountWith(() => new Promise(() => undefined));
    const shown = textOf(tree);

    expect({
      claimsFeatureOff: shown.includes(COPY.featureOff),
      claimsNoPort: shown.includes(COPY.noPort),
    }).toEqual({claimsFeatureOff: false, claimsNoPort: false});

    await act(async () => tree.unmount());
  });

  it('while the read is outstanding it says so', async () => {
    const tree = await mountWith(() => new Promise(() => undefined));
    const shown = textOf(tree);
    /* Unknown has to READ as unknown - leaving the pill blank would be
       the same defect with the words removed. */
    expect({
      saysFeatureUnknown: shown.includes(COPY.featureUnknown),
      saysPortUnknown: shown.includes(COPY.portUnknown),
    }).toEqual({saysFeatureUnknown: true, saysPortUnknown: true});
    await act(async () => tree.unmount());
  });

  it('once the read lands and GPS really is off, it says off', async () => {
    /* The LONG_RANGE board has the GPS feature clear and no GPS UART, so
       after the read these negatives are OBSERVED, and stating them is
       exactly right. */
    const snapshot = await realSnapshot();
    const tree = await mountWith(async () => ({kind: 'LOADED', snapshot}));
    const shown = textOf(tree);
    expect({
      claimsFeatureOff: shown.includes(COPY.featureOff),
      claimsNoPort: shown.includes(COPY.noPort),
      stillSaysUnknown: shown.includes(COPY.featureUnknown),
    }).toEqual({
      claimsFeatureOff: true,
      claimsNoPort: true,
      stillSaysUnknown: false,
    });
    await act(async () => tree.unmount());
  });

  it('a read that FAILS does not become "off" either', async () => {
    /* A failed read leaves the configuration exactly as unknown as it
       was before, and the screen must not resolve that into a negative
       fact - the forbidden READ_FAILED -> OFF collapse. */
    const tree = await mountWith(async () => ({
      kind: 'FAILED',
      error: new Error('link lost'),
    }));
    const shown = textOf(tree);
    expect({
      claimsFeatureOff: shown.includes(COPY.featureOff),
      saysFeatureUnknown: shown.includes(COPY.featureUnknown),
    }).toEqual({claimsFeatureOff: false, saysFeatureUnknown: true});
    await act(async () => tree.unmount());
  });

  it('a read the board REFUSES does not become "off" either', async () => {
    const tree = await mountWith(async () => ({
      kind: 'REJECTED',
      reason: 'CONFIGURATION_BUSY',
    }));
    const shown = textOf(tree);
    expect({
      claimsFeatureOff: shown.includes(COPY.featureOff),
      saysFeatureUnknown: shown.includes(COPY.featureUnknown),
    }).toEqual({claimsFeatureOff: false, saysFeatureUnknown: true});
    await act(async () => tree.unmount());
  });

  it('the live fix pill is not covered by this rule, and still reads "no fix yet"', async () => {
    /* A negative control for the rule itself: it must constrain
       CONFIGURATION facts and leave live telemetry alone. */
    const tree = await mountWith(() => new Promise(() => undefined));
    expect(textOf(tree).includes(COPY.noFix)).toBe(true);
    await act(async () => tree.unmount());
  });
});
