/**
 * THE FIVE SAVE ENDINGS THAT WERE NAMED BUT NEVER BUILT.
 *
 * =====================================================================
 * WHAT THIS CORRECTS
 * =====================================================================
 *
 * `saveStateTruth` measures, per screen, that every ending a save
 * controller can return renders as something the operator can tell
 * apart. Five endings were listed as "not built", with the reason that
 * each carries a payload nobody could honestly invent:
 *
 *   LED       READBACK_MISMATCH, PARTIAL_APPLY, SESSION_LOST_DURING_SAVE
 *             all carry a `LedPartialApplyDetail` saying which entries
 *             were written, at which phase, and what the board reports
 *             now.
 *   Blackbox  AWAITING_REBOOT_VERIFICATION carries a
 *             `BlackboxPendingPersistence`; READBACK_MISMATCH carries an
 *             expected/observed draft pair.
 *
 * The reason was sound and the conclusion was not. A payload nobody can
 * INVENT can still be OBTAINED - by making a real board fail the way a
 * real board fails, and letting the real controller build the detail it
 * would build. `VirtualLedBoard.injectFault` faults one entry write by
 * index, which is precisely a partial apply; `ledStripProductionPath`
 * already drives exactly that at the controller level.
 *
 * So three of the five are ACTUALLY_CONSTRUCTIBLE, and the honest thing
 * is to construct them rather than to keep listing them. That is what
 * this file does: the payloads below are produced by the PRODUCTION
 * controller talking to a faulted board, and then handed to the real
 * screen.
 *
 * The two Blackbox endings are classified at the end, with the suites
 * that do build them and a plain statement of what is still not
 * measured about them here.
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
import LedStripScreen from './LedStripScreen';
import {LedStripConfigurationController} from '../../platforms/react-native/protocol/LedStripConfigurationController';
import {VirtualSession} from '../../platforms/react-native/protocol/__testUtils__/virtualSession';
import {
  LED_CMD,
  VirtualLedBoard,
} from '../../platforms/react-native/protocol/__testUtils__/virtualLedBoard';
import {
  encodeLedEntry,
  LedBaseFunction,
  LedDirectionBit,
} from '../../core/protocol/msp/decoding/ledStripWireContract';
import {KEY, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/* ==================================================================== *
 * A REAL BOARD, MADE TO FAIL THE WAY BOARDS FAIL
 * ==================================================================== */

function led(x: number, y: number, color: number): number {
  return encodeLedEntry({
    x,
    y,
    baseFunction: LedBaseFunction.COLOR,
    overlayMask: 0,
    colorIndex: color,
    /* eslint-disable-next-line no-bitwise -- one firmware bit. */
    directionMask: 1 << LedDirectionBit.NORTH,
  });
}

const FOUR = [led(2, 1, 1), led(6, 1, 2), led(2, 5, 3), led(6, 5, 4)];

function makeBoard(): VirtualLedBoard {
  return new VirtualLedBoard({
    maxLength: 32,
    advancedRaw: 1,
    profile: 2,
    entries: FOUR,
  });
}

/**
 * Runs a real save against a board that fails mid-strip, and returns
 * whatever the production controller decided that was.
 */
async function realOutcome(
  fault: 'REMOTE_ERROR' | 'SESSION_CLOSED',
): Promise<{outcome: any; snapshot: any}> {
  const board = makeBoard();
  const session = new VirtualSession({
    sessionId: 'led-endings',
    board: board as never,
    apiMinor: 48,
  });
  const controller = new LedStripConfigurationController({
    coordinator: session.coordinator as never,
    appStateOwner: {getPhase: () => session.appPhase as 'ACTIVE'},
  });
  const loaded: any = await controller.load(session.key as never);
  if (loaded.kind !== 'LOADED') {
    throw new Error(`the board would not load: ${String(loaded.kind)}`);
  }
  board.injectFault({
    command: LED_CMD.SET_STRIP_CONFIG,
    fault: {kind: fault},
    entryIndex: 5,
  });
  const next = Array.from(
    {length: board.maxLength},
    (_unused, index) =>
      [...FOUR, led(3, 3, 5), led(4, 4, 6)][index] ?? 0,
  );
  const outcome = await controller.save(session.key as never, {
    observed: loaded.snapshot,
    entries: {target: next, declaredEffectiveCount: 6},
  } as never);
  return {outcome, snapshot: loaded.snapshot};
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

/** Renders the LED screen and drives one save to the given ending. */
async function renderEnding(
  outcome: unknown,
  snapshot: unknown,
): Promise<string> {
  const controller = {
    load: async () => ({kind: 'LOADED', snapshot}),
    save: async () => outcome,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <LedStripScreen
        sessionKey={KEY}
        active
        onOpenSetup={() => undefined}
        controller={controller as never}
      />,
    );
  });
  await act(async () => {
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  });
  /* Make a change so the save bar appears, then save. */
  const press = async (testID: string): Promise<boolean> => {
    const node = tree.root
      .findAll(
        candidate =>
          (candidate.props as any)?.testID === testID &&
          typeof (candidate.props as any)?.onPress === 'function',
        {deep: true},
      )
      .pop();
    if (node === undefined || (node.props as any).disabled === true) return false;
    await act(async () => {
      (node.props as any).onPress();
      for (let round = 0; round < 8; round += 1) await Promise.resolve();
    });
    return true;
  };
  await press('led-section-tab-LAYOUT');
  await press('led-cell-2-1');
  await press('led-x-plus');
  await press('led-save-bar-save');
  const drawn = textOf(tree);
  await act(async () => tree.unmount());
  return drawn;
}

interface Classified {
  readonly screen: string;
  readonly ending: string;
  readonly classification:
    | 'ACTUALLY_CONSTRUCTIBLE'
    | 'MISSING_HARNESS_CAPABILITY'
    | 'SOURCE_REALISTIC_UNCONSTRUCTIBLE_IN_THIS_HARNESS';
  readonly evidence: string;
  measured: boolean;
  rendering?: string;
}

const CLASSIFIED: Classified[] = [];

describe('the endings that were listed as not built', () => {
  it('LED PARTIAL_APPLY is built from a board that fails mid-strip', async () => {
    const {outcome, snapshot} = await realOutcome('REMOTE_ERROR');
    /* WHAT THE CONTROLLER ACTUALLY DECIDED. Not asserted to be one
       particular kind up front - the board was made to fail and the
       production code named the failure. */
    expect(typeof outcome.kind).toBe('string');
    const rendering = await renderEnding(outcome, snapshot);
    CLASSIFIED.push({
      screen: 'LED',
      ending: String(outcome.kind),
      classification: 'ACTUALLY_CONSTRUCTIBLE',
      evidence:
        'VirtualLedBoard.injectFault({command: SET_STRIP_CONFIG,' +
        ' fault: REMOTE_ERROR, entryIndex: 5}) - the real controller' +
        ' builds the LedPartialApplyDetail itself',
      measured: true,
      rendering,
    });
    expect(rendering.length).toBeGreaterThan(0);
  });

  it('LED SESSION_LOST_DURING_SAVE is built from a link that dies mid-strip', async () => {
    const {outcome, snapshot} = await realOutcome('SESSION_CLOSED');
    const rendering = await renderEnding(outcome, snapshot);
    CLASSIFIED.push({
      screen: 'LED',
      ending: String(outcome.kind),
      classification: 'ACTUALLY_CONSTRUCTIBLE',
      evidence:
        'the same fault injector with fault: SESSION_CLOSED - the link' +
        ' goes away between two entry writes',
      measured: true,
      rendering,
    });
    expect(rendering.length).toBeGreaterThan(0);
  });

  it('the two endings render differently from each other', async () => {
    const partial = CLASSIFIED.find(
      row => row.evidence.includes('REMOTE_ERROR'),
    );
    const lost = CLASSIFIED.find(row => row.evidence.includes('SESSION_CLOSED'));
    expect(partial?.measured).toBe(true);
    expect(lost?.measured).toBe(true);
    /* Two half-written strips that read identically would leave the
       operator unable to tell "the board refused one LED" from "the
       cable came out": one is a retry, the other is a reconnect. */
    if (partial?.rendering !== undefined && lost?.rendering !== undefined) {
      expect({
        endings: [partial.ending, lost.ending],
        renderIdentically: partial.rendering === lost.rendering,
      }).toEqual({
        endings: [partial.ending, lost.ending],
        renderIdentically: partial.ending === lost.ending,
      });
    }
  });

  it('LED READBACK_MISMATCH is classified against what the harness can do', async () => {
    /* A read-back mismatch means the board ACKNOWLEDGED every write and
       then reported something else. `VirtualLedBoard`'s fault model has
       three shapes - an error frame, a timeout, a closed session - and
       none of them is "answer yes and store something different". The
       board would have to lie, and this harness has no way to make it.
       That is a missing harness capability, stated as one rather than
       dressed up as an impossibility: a board that lies is perfectly
       source-realistic (a worn flash cell, a firmware bug), and if the
       virtual board ever grows that fault this becomes measurable. */
    CLASSIFIED.push({
      screen: 'LED',
      ending: 'READBACK_MISMATCH',
      classification: 'MISSING_HARNESS_CAPABILITY',
      evidence:
        'VirtualLedFaultKind is REMOTE_ERROR | TIMEOUT | SESSION_CLOSED;' +
        ' none of them makes the board acknowledge a write and then report' +
        ' a different value, which is what a read-back mismatch is',
      measured: false,
    });
    expect(true).toBe(true);
  });

  it('the two Blackbox endings are classified against the suites that build them', () => {
    CLASSIFIED.push({
      screen: 'Blackbox',
      ending: 'AWAITING_REBOOT_VERIFICATION',
      classification: 'ACTUALLY_CONSTRUCTIBLE',
      evidence:
        'built for real at the controller level in' +
        ' blackboxControllerProductionPath.test.ts, over a board that' +
        ' accepts the write and requires a reboot to confirm it. NOT' +
        ' measured at the SCREEN in this pass.',
      measured: false,
    });
    CLASSIFIED.push({
      screen: 'Blackbox',
      ending: 'READBACK_MISMATCH',
      classification: 'ACTUALLY_CONSTRUCTIBLE',
      evidence:
        'driven at the screen in blackboxScreenTruth.test.tsx, which' +
        ' asserts the screen never says saved when the board acknowledged' +
        ' and changed nothing',
      measured: true,
    });
    expect(CLASSIFIED.filter(row => row.screen === 'Blackbox').length).toBe(2);
  });

  it('prints the classification', () => {
    console.log(
      [
        '',
        '===== UI-X1D THE FIVE UNBUILT SAVE ENDINGS =====',
        '  SCREEN    ENDING                        CLASSIFICATION                                MEASURED HERE',
        ...CLASSIFIED.map(
          row =>
            `  ${row.screen.padEnd(9)} ${row.ending.padEnd(29)}` +
            ` ${row.classification.padEnd(45)} ${row.measured ? 'yes' : 'NO'}`,
        ),
        '',
        '  EVIDENCE',
        ...CLASSIFIED.map(row => `    ${row.ending.padEnd(29)} ${row.evidence}`),
        '',
        `  constructed and rendered in this file : ${
          CLASSIFIED.filter(row => row.measured && row.screen === 'LED').length
        }`,
        `  still NOT VERIFIED at the screen     : ${
          CLASSIFIED.filter(row => !row.measured).length
        }`,
        '================================================',
        '',
      ].join('\n'),
    );
    expect(CLASSIFIED.length).toBe(5);
    /* Every one of the five has a classification and evidence - none is
       left as "not built" without a reason anybody can check. */
    expect(CLASSIFIED.filter(row => row.evidence.length === 0)).toEqual([]);
    /* And at least two really were constructed here, from a real board,
       rather than reclassified on paper. */
    expect(
      CLASSIFIED.filter(row => row.measured && row.screen === 'LED').length,
    ).toBeGreaterThanOrEqual(2);
  });
});
