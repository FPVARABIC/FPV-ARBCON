/**
 * A PRESET LIST IS COMPATIBLE WITH ONE FIRMWARE, ON ONE AIRCRAFT.
 *
 * =====================================================================
 * WHAT THE SCREEN DOES, AND WHY THE SESSION MATTERS
 * =====================================================================
 *
 * `PresetsScreen` fetches the official index and then filters it:
 *
 *     const [index, version] = await Promise.all([
 *       repository.loadIndex(),
 *       repository.loadFirmwareVersion(sessionKey),   // <- THE BOARD
 *     ]);
 *     const compatible = filterCompatiblePresets(index, version.versionString);
 *
 * `loadFirmwareVersion` is a READ OF THE CONNECTED FLIGHT CONTROLLER, so
 * the list on screen is a claim about the aircraft that is plugged in -
 * "these packages fit the firmware you are running".
 *
 * Two things used to break that claim when the operator swapped
 * aircraft:
 *
 *   1. The fetch effect only ran while `presets` was empty, so after a
 *      swap it never ran again: the list built for the PREVIOUS board's
 *      firmware simply stayed, now labelled with the new one.
 *   2. Nothing dropped a fetch that was still in flight, so a late answer
 *      for the old board could land on the new session.
 *
 * Applying a preset is guarded elsewhere - it is a temporary CLI apply,
 * behind a destructive confirmation, after a backup, with the save
 * blocked when the firmware rejects a command - so this is a defect of
 * what the operator is TOLD, not of what is written. It is still a list
 * of packages presented as fitting a board they do not describe.
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

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import PresetsScreen from './PresetsScreen';

jest.setTimeout(120000);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

const FC_A = {sessionId: 'aircraft-a', generation: 1} as const;
const FC_B = {sessionId: 'aircraft-b', generation: 2} as const;

/** Two boards on the bench, running different firmware. */
const FIRMWARE: Record<string, string> = {
  'aircraft-a': '4.4.3',
  'aircraft-b': '4.5.1',
};

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

function repositoryFor(harness: {asked: string[]; hold: boolean; pending: (() => void)[]}) {
  return {
    loadIndex: async () => ({presets: [], categories: [], rejectedCount: 0}),
    loadFirmwareVersion: async (sessionKey: {sessionId: string}) => {
      harness.asked.push(sessionKey.sessionId);
      const answer = {versionString: FIRMWARE[sessionKey.sessionId] ?? '0.0.0'};
      if (!harness.hold) return answer;
      await new Promise<void>(resolve => harness.pending.push(resolve));
      return answer;
    },
    loadPreset: async () => undefined,
    commands: () => [],
  };
}

const CLI = {
  getPhase: () => 'IDLE' as const,
  begin: async () => undefined,
  captureDiffAll: async () => '',
  saveTextFile: async () => undefined,
  executeBatch: async () => ({errors: []}),
  exitWithoutSave: async () => undefined,
};

async function open(harness: {asked: string[]; hold: boolean; pending: (() => void)[]}): Promise<{
  tree: ReactTestRenderer.ReactTestRenderer;
  render: (sessionKey: {sessionId: string; generation: number}) => Promise<void>;
}> {
  const repository = repositoryFor(harness);
  const element = (sessionKey: {sessionId: string; generation: number}) => (
    <PresetsScreen
      sessionKey={sessionKey as never}
      active
      onCliBusyChange={() => undefined}
      repository={repository as never}
      cli={CLI as never}
    />
  );
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(element(FC_A));
  });
  await act(async () => {
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  });
  return {
    tree,
    render: async sessionKey => {
      await act(async () => {
        tree.update(element(sessionKey));
      });
      await act(async () => {
        for (let round = 0; round < 12; round += 1) await Promise.resolve();
      });
    },
  };
}

describe('the preset catalogue belongs to the aircraft it was built for', () => {
  it('a new aircraft is asked for its own firmware version', async () => {
    const harness = {asked: [] as string[], hold: false, pending: [] as (() => void)[]};
    const {tree, render} = await open(harness);

    /* THE SUBJECT EXISTS: the first board really was asked. */
    expect(harness.asked).toEqual(['aircraft-a']);
    expect(textOf(tree)).toContain('4.4.3');

    await render(FC_B);

    /* THE REQUIREMENT: the catalogue is rebuilt for the board that is
       now connected, and the previous board's firmware is no longer
       presented as the one the packages fit. */
    expect({asked: harness.asked}).toEqual({
      asked: ['aircraft-a', 'aircraft-b'],
    });
    const after = textOf(tree);
    expect({stillShowsTheOldFirmware: after.includes('4.4.3')}).toEqual({
      stillShowsTheOldFirmware: false,
    });
    expect({showsTheNewFirmware: after.includes('4.5.1')}).toEqual({
      showsTheNewFirmware: true,
    });
    await act(async () => tree.unmount());
  });

  it('an answer for the previous aircraft never lands on the new one', async () => {
    const harness = {asked: [] as string[], hold: true, pending: [] as (() => void)[]};
    const {tree, render} = await open(harness);
    /* The first board's read is still in flight. */
    expect(harness.pending.length).toBe(1);

    await render(FC_B);
    const oldAnswer = harness.pending.shift();
    expect(oldAnswer).toBeDefined();

    /* Now the OLD board answers, late. */
    await act(async () => {
      oldAnswer!();
      for (let round = 0; round < 12; round += 1) await Promise.resolve();
    });
    expect({
      theOldBoardsFirmwareIsOnScreen: textOf(tree).includes('4.4.3'),
    }).toEqual({theOldBoardsFirmwareIsOnScreen: false});

    /* And when the new board answers, its own version is what shows. */
    const newAnswer = harness.pending.shift();
    if (newAnswer !== undefined) {
      await act(async () => {
        newAnswer();
        for (let round = 0; round < 12; round += 1) await Promise.resolve();
      });
    }
    expect({
      theNewBoardsFirmwareIsOnScreen: textOf(tree).includes('4.5.1'),
    }).toEqual({theNewBoardsFirmwareIsOnScreen: true});
    await act(async () => tree.unmount());
  });

  it('an empty compatible list is an answer, not a reason to ask again', async () => {
    /* THE REFETCH LOOP.
       `filterCompatiblePresets` returning nothing is an ordinary
       outcome - the official index simply has no package for this
       firmware, and the screen has a sentence for it. The fetch effect
       used to decide whether to fetch by asking whether `presets` was
       empty, so that answer put it straight back into the same
       condition: fetch, empty, fetch, empty, without end. Measured
       against the unmodified screen, the index request never stopped
       repeating. */
    const harness = {asked: [] as string[], hold: false, pending: [] as (() => void)[]};
    let indexFetches = 0;
    const repository = {
      loadIndex: async () => {
        indexFetches += 1;
        /* A SCREEN THAT RE-FETCHES FOR EVER ALSO KEEPS REACT'S MICROTASK
           QUEUE BUSY FOR EVER, and `act` would then never return - the
           run would hang instead of reporting anything. So the fourth
           request is simply never answered: the storm stops, the
           assertion below runs, and it names the count. */
        if (indexFetches >= 4) await new Promise(() => undefined);
        return {presets: [], categories: [], rejectedCount: 0};
      },
      loadFirmwareVersion: async (sessionKey: {sessionId: string}) => {
        harness.asked.push(sessionKey.sessionId);
        return {versionString: FIRMWARE[sessionKey.sessionId] ?? '0.0.0'};
      },
      loadPreset: async () => undefined,
      commands: () => [],
    };
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <PresetsScreen
          sessionKey={FC_A as never}
          active
          onCliBusyChange={() => undefined}
          repository={repository as never}
          cli={CLI as never}
        />,
      );
    });
    /* Bounded on purpose. A screen that re-fetches for ever also keeps
       React's microtask queue busy for ever, and an unbounded flush loop
       here would hang the run instead of reporting the defect. Four
       fetches is already proof; the loop stops and the assertion names
       the number. */
    for (let round = 0; round < 40 && indexFetches < 4; round += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    /* THE SUBJECT EXISTS: it really did fetch, and the answer really was
       empty. */
    expect(indexFetches).toBeGreaterThan(0);
    expect(textOf(tree)).toContain('لا توجد حزم');
    /* AND IT ASKED ONCE. */
    expect({indexFetches}).toEqual({indexFetches: 1});
    await act(async () => tree.unmount());
  });

  it('the two boards really do report different firmware', () => {
    /* NEGATIVE CONTROL: if both answered the same string, neither
       assertion above could tell a stale catalogue from a fresh one. */
    expect(FIRMWARE['aircraft-a']).not.toBe(FIRMWARE['aircraft-b']);
  });
});
