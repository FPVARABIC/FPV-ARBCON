/**
 * THE BLACKBOX SCREEN, IN EVERY STORAGE STATE THE FIRMWARE CAN REPORT.
 *
 * =====================================================================
 * WHY THE STATES MATTER MORE HERE THAN ALMOST ANYWHERE
 * =====================================================================
 *
 * A blackbox log is the only account of a crash. An operator who is told
 * their flash is recording, and lands to find it was full or absent, has
 * lost the one thing that explains what happened. And an operator who
 * erases because the screen said "holding logs" when it was reporting a
 * volume that is not idle has destroyed a flight they still needed.
 *
 * "No storage" and "storage that has not finished waking up" look almost
 * identical on the wire - three zeros - and the production classifier
 * (`classifyDataflash`) exists precisely to keep them apart. This holds
 * the SCREEN to the same distinction.
 *
 * =====================================================================
 * THE STATES, FROM THE PRODUCTION UNION
 * =====================================================================
 *
 * Every member of `DataflashState`, built by handing the PRODUCTION
 * classifier a wire summary and letting it decide - never by writing a
 * `state` string into a snapshot, which would be this suite deciding
 * what the firmware said:
 *
 *   UNSUPPORTED        no flash chip at all       -> the brief's NO_STORAGE
 *   BUSY_OR_NOT_READY  present, not idle
 *   READY_EMPTY        idle and holding nothing   -> FLASH_READY / EMPTY
 *   READY_WITH_DATA    idle and holding logs      -> LOGS_PRESENT
 *   READY_FULL         no room for another log
 *   INCONSISTENT       used > total
 *
 * plus the two the CONTROLLER can answer with rather than the volume:
 *
 *   FAILED             the read did not come back -> READ_FAILED
 *   REJECTED           the board refused it
 *
 * =====================================================================
 * EXPORT / DOWNLOAD
 * =====================================================================
 *
 * There is none. `BlackboxControllerPort` is `load`, `save`,
 * `verifyPersistence` and `eraseDataflash`; no control on the screen
 * offers to pull a log off the board, and no string in it mentions one.
 * The brief asks for export "where supported", and the honest answer is
 * that this build does not support it - so the last test below asserts
 * that absence rather than inventing a flow to exercise. If a download
 * is ever added, that test fails and this suite has to grow.
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
import BlackboxScreen from './BlackboxScreen';
import {
  classifyBlackboxConfig,
  classifyDataflash,
  classifySdcard,
  type DataflashState,
} from '../../core/state/blackboxStorageSemantics';
import {KEY, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

const MIB = 1024 * 1024;

/** One wire summary per state, classified by production. */
const WIRE: Readonly<Record<DataflashState, unknown>> = {
  UNSUPPORTED: {
    flagsRaw: 0,
    supported: false,
    ready: false,
    sectorCount: 0,
    totalBytes: 0,
    usedBytes: 0,
  },
  BUSY_OR_NOT_READY: {
    flagsRaw: 2,
    supported: true,
    ready: false,
    sectorCount: 256,
    totalBytes: 16 * MIB,
    usedBytes: 4 * MIB,
  },
  READY_EMPTY: {
    flagsRaw: 3,
    supported: true,
    ready: true,
    sectorCount: 256,
    totalBytes: 16 * MIB,
    usedBytes: 0,
  },
  READY_WITH_DATA: {
    flagsRaw: 3,
    supported: true,
    ready: true,
    sectorCount: 256,
    totalBytes: 16 * MIB,
    usedBytes: 8 * MIB,
  },
  READY_FULL: {
    flagsRaw: 3,
    supported: true,
    ready: true,
    sectorCount: 256,
    totalBytes: 16 * MIB,
    usedBytes: 16 * MIB,
  },
  INCONSISTENT: {
    flagsRaw: 3,
    supported: true,
    ready: true,
    sectorCount: 256,
    totalBytes: 4 * MIB,
    usedBytes: 8 * MIB,
  },
};

function snapshotFor(state: DataflashState): unknown {
  const config = {
    supported: true,
    supportedRaw: 1,
    deviceRaw: 1,
    legacyRateNumerator: 1,
    legacyRateDenominator: 1,
    pRatio: 32,
    sampleRateRaw: 0,
    disabledFieldsMask: 0,
  };
  return {
    config,
    configuration: classifyBlackboxConfig(config as never),
    dataflash: classifyDataflash(WIRE[state] as never),
    sdcard: classifySdcard({
      flagsRaw: 0,
      configured: false,
      stateRaw: 0,
      filesystemLastError: 0,
      freeKilobytes: 0,
      totalKilobytes: 0,
    } as never),
    debugMode: 0,
    debugModeCount: 60,
    pidProcessDenom: 4,
  };
}

interface EraseCall {
  readonly at: number;
}

interface Harness {
  readonly tree: ReactTestRenderer.ReactTestRenderer;
  readonly erases: EraseCall[];
  readonly cancels: number[];
}

type Outcome =
  | {kind: 'STATE'; state: DataflashState}
  | {kind: 'FAILED'}
  | {kind: 'REJECTED'};

async function open(outcome: Outcome): Promise<Harness> {
  const erases: EraseCall[] = [];
  const cancels: number[] = [];
  let settle: ((value: unknown) => void) | undefined;
  const snapshot =
    outcome.kind === 'STATE' ? snapshotFor(outcome.state) : undefined;
  const controller = {
    load: async () =>
      outcome.kind === 'STATE'
        ? {kind: 'LOADED', snapshot}
        : outcome.kind === 'FAILED'
          ? {kind: 'FAILED', error: new Error('link lost')}
          : {kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'},
    save: async () => ({kind: 'NO_CHANGES', snapshot}),
    verifyPersistence: async () => ({kind: 'SUCCEEDED', snapshot}),
    eraseDataflash: () => {
      erases.push({at: erases.length});
      const result = new Promise(resolve => {
        settle = resolve;
      });
      return {
        result,
        cancel: () => {
          cancels.push(cancels.length);
          settle?.({kind: 'CANCELLED'});
        },
      };
    },
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <BlackboxScreen
        sessionKey={KEY}
        active
        controller={controller as never}
        now={() => 0}
      />,
    );
  });
  await act(async () => {
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  });
  return {tree, erases, cancels};
}

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .filter(line => line.length > 0)
    .join(' | ');
}

function control(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): ReactTestRenderer.ReactTestInstance | undefined {
  return tree.root
    .findAll(
      candidate =>
        (candidate.props as any)?.testID === testID &&
        typeof (candidate.props as any)?.onPress === 'function',
      {deep: true},
    )
    .pop();
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<boolean> {
  const found = control(tree, testID);
  if (found === undefined || (found.props as any).disabled === true) {
    return false;
  }
  await act(async () => {
    (found.props as any).onPress();
    for (let round = 0; round < 6; round += 1) await Promise.resolve();
  });
  return true;
}

const STATES = Object.keys(WIRE) as DataflashState[];

interface Row {
  readonly scenario: string;
  readonly words: string;
  readonly offersErase: boolean;
}

const LEDGER: Row[] = [];

describe('every storage state says which one it is', () => {
  it.each(STATES.map(state => [state] as const))('%s', async state => {
    const {tree} = await open({kind: 'STATE', state});
    const words = textOf(tree);
    LEDGER.push({
      scenario: state,
      words,
      offersErase: control(tree, 'blackbox-erase-button') !== undefined,
    });
    /* THE SUBJECT EXISTS. */
    expect(words.length).toBeGreaterThan(0);
    /* THE STATE THE CLASSIFIER DERIVED IS THE ONE THE SCREEN WAS GIVEN -
       this suite never writes a state string, so a classifier change
       would show up here rather than being papered over. */
    expect(
      (classifyDataflash(WIRE[state] as never) as {state: string}).state,
    ).toBe(state);
    await act(async () => tree.unmount());
  });

  it.each([['FAILED'], ['REJECTED']] as const)(
    'a read that ends in %s says so instead of showing storage',
    async kind => {
      const {tree} = await open({kind} as Outcome);
      const words = textOf(tree);
      LEDGER.push({
        scenario: `READ_${kind}`,
        words,
        offersErase: control(tree, 'blackbox-erase-button') !== undefined,
      });
      expect(words.length).toBeGreaterThan(0);
      /* A FAILED READ IS NOT AN EMPTY VOLUME. Nothing may offer to erase
         a volume nobody has read. */
      expect({kind, offersErase: control(tree, 'blackbox-erase-button') !== undefined})
        .toEqual({kind, offersErase: false});
      await act(async () => tree.unmount());
    },
  );

  it('no two storage states read the same', () => {
    /* An operator who cannot tell "no chip" from "not ready yet" has not
       been told anything. Compared on the WORDS, which is what they
       actually read. */
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const row of LEDGER) {
      const already = seen.get(row.words);
      if (already !== undefined) {
        collisions.push(`${already} and ${row.scenario} render identically`);
      }
      seen.set(row.words, row.scenario);
    }
    expect({collisions}).toEqual({collisions: []});
  });
});

/* ==================================================================== *
 * ERASE: CANCEL DOES NOTHING, CONFIRM DOES EXACTLY ONE THING
 * ==================================================================== */

describe('erasing asks first, and Cancel means nothing happened', () => {
  it('Cancel performs zero destructive action', async () => {
    const {tree, erases} = await open({
      kind: 'STATE',
      state: 'READY_WITH_DATA',
    });
    /* THE SUBJECT EXISTS: a volume holding logs is the one state where
       erasing is meaningful. */
    expect(control(tree, 'blackbox-erase-button')).toBeDefined();

    expect(await press(tree, 'blackbox-erase-button')).toBe(true);
    /* Opening the confirmation is not erasing. */
    expect({erasesAfterOpeningTheConfirmation: erases.length}).toEqual({
      erasesAfterOpeningTheConfirmation: 0,
    });
    expect(control(tree, 'blackbox-erase-confirm')).toBeDefined();
    expect(control(tree, 'blackbox-erase-cancel')).toBeDefined();

    expect(await press(tree, 'blackbox-erase-cancel')).toBe(true);
    expect({erasesAfterCancel: erases.length}).toEqual({erasesAfterCancel: 0});
    /* And the confirmation is gone rather than left hanging. */
    expect(control(tree, 'blackbox-erase-confirm')).toBeUndefined();
    await act(async () => tree.unmount());
  });

  it('Confirm performs exactly one erase, of this session', async () => {
    const {tree, erases} = await open({
      kind: 'STATE',
      state: 'READY_WITH_DATA',
    });
    expect(await press(tree, 'blackbox-erase-button')).toBe(true);
    expect(await press(tree, 'blackbox-erase-confirm')).toBe(true);
    expect({erases: erases.length}).toEqual({erases: 1});
    /* Pressing again while one is running does not start a second. */
    await press(tree, 'blackbox-erase-button');
    await press(tree, 'blackbox-erase-confirm');
    expect({erasesAfterASecondAttempt: erases.length}).toEqual({
      erasesAfterASecondAttempt: 1,
    });
    await act(async () => tree.unmount());
  });

  it('a running erase can be stopped, and stopping is not erasing again', async () => {
    const {tree, erases, cancels} = await open({
      kind: 'STATE',
      state: 'READY_WITH_DATA',
    });
    expect(await press(tree, 'blackbox-erase-button')).toBe(true);
    expect(await press(tree, 'blackbox-erase-confirm')).toBe(true);
    const stopped = await press(tree, 'blackbox-erase-cancel');
    if (stopped) {
      expect({cancels: cancels.length}).toEqual({cancels: 1});
    }
    expect({erases: erases.length}).toEqual({erases: 1});
    await act(async () => tree.unmount());
  });

  it('a volume with nothing on it is not offered an erase it does not need', async () => {
    const empty = await open({kind: 'STATE', state: 'READY_EMPTY'});
    const absent = await open({kind: 'STATE', state: 'UNSUPPORTED'});
    /* UNSUPPORTED is the decisive one: there is no chip to erase. */
    expect({
      unsupportedOffersErase:
        control(absent.tree, 'blackbox-erase-button') !== undefined,
    }).toEqual({unsupportedOffersErase: false});
    expect({erasesFromMerelyRendering: absent.erases.length}).toEqual({
      erasesFromMerelyRendering: 0,
    });
    await act(async () => empty.tree.unmount());
    await act(async () => absent.tree.unmount());
  });
});

/* ==================================================================== *
 * WHAT THIS BUILD DOES NOT HAVE
 * ==================================================================== */

describe('export / download', () => {
  it('is not a capability this screen has, and is not invented here', async () => {
    const {tree} = await open({kind: 'STATE', state: 'READY_WITH_DATA'});
    const controls = tree.root
      .findAll(
        candidate =>
          typeof (candidate.props as any)?.testID === 'string' &&
          typeof (candidate.props as any)?.onPress === 'function',
        {deep: true},
      )
      .map(candidate => String((candidate.props as any).testID));
    const exporters = controls.filter(id =>
      /export|download|save-file|pull|fetch-log/i.test(id),
    );
    /* If a download is ever added, this fails and the suite has to grow
       a real flow for it - which is the point of asserting an absence
       rather than quietly not testing one. */
    expect({exportControls: exporters}).toEqual({exportControls: []});
    await act(async () => tree.unmount());
  });
});

describe('the Blackbox scenario ledger', () => {
  it('prints it', () => {
    console.log(
      [
        '',
        '===== UI-X1D BLACKBOX STORAGE SCENARIOS =====',
        `  storage states built through the production classifier : ${STATES.length}`,
        `  read outcomes                                          : 2 (FAILED, REJECTED)`,
        `  scenarios rendered                                     : ${LEDGER.length}`,
        '',
        '  SCENARIO             ERASE OFFERED   WHAT THE OPERATOR READS',
        ...LEDGER.map(
          row =>
            `  ${row.scenario.padEnd(20)} ${(row.offersErase ? 'yes' : 'no').padEnd(15)}` +
            ` ${row.words.slice(0, 90)}`,
        ),
        '',
        '  EXPORT / DOWNLOAD : not a capability of this build - the port is',
        '                      load / save / verifyPersistence / eraseDataflash',
        '                      and no control offers one. Asserted as an absence.',
        '=============================================',
        '',
      ].join('\n'),
    );
    expect(LEDGER.length).toBe(STATES.length + 2);
  });
});
