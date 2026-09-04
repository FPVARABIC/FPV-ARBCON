/**
 * THE LED STRIP EDITOR, ONE BEHAVIOUR CLASS AT A TIME.
 *
 * =====================================================================
 * WHY A CENSUS OF 412 CONTROLS IS NOT AN ENUMERATION OF BEHAVIOURS
 * =====================================================================
 *
 * The LED screen renders more controls than any other in this
 * application - a 16x16 grid alone is 256 cells - and the interaction
 * census presses them all. What it cannot say is what KIND of thing each
 * press was. Four hundred presses that all mean "select a cell" are one
 * behaviour measured four hundred times, and the two behaviours nobody
 * measured are still nobody's.
 *
 * So this enumerates the classes instead, from production source, and
 * measures each one ONCE with a representative whose equivalence is
 * argued rather than assumed. Pressing 256 cells to say the grid works
 * is not more coverage; it is the same coverage, more slowly.
 *
 * =====================================================================
 * THE TWO PROPERTIES EVERY CLASS IS HELD TO
 * =====================================================================
 *
 * 1. EDITING IS A DRAFT. Selecting, moving, adding, removing, recolouring
 *    - none of it may reach the board. The strip is on the aircraft; a
 *    half-finished edit that wrote itself out as it was typed would leave
 *    the operator with a lighting configuration nobody chose.
 *
 * 2. SAVE WRITES THE PATH THAT WAS EDITED, AND NO OTHER.
 *    `LedStripSaveRequest` has four independent groups - `entries`,
 *    `palette`, `modeColors`, `runtimeValues` - and each is a separate
 *    conversation with the firmware. Editing a palette slot and sending
 *    the whole entry array as well is an unrequested rewrite of the
 *    strip's layout; that is the failure this half exists to catch.
 *
 * Each class below declares its PRECONDITION, ACTION, expected DRAFT
 * DELTA, expected WIRE DELTA and POSTCONDITION, and the ledger prints
 * what was actually observed for each.
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

import '../../i18n';
import i18n from '../../i18n';
import LedStripScreen from './LedStripScreen';
import {LedStripConfigurationController} from '../../platforms/react-native/protocol/LedStripConfigurationController';
import {VirtualLedBoard} from '../../platforms/react-native/protocol/__testUtils__/virtualLedBoard';
import {
  LedBaseFunction,
  LedDirectionBit,
  encodeLedEntry,
} from '../../core/protocol/msp/decoding/ledStripWireContract';
import {KEY, outcomeVia, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/* ==================================================================== *
 * THE BOARD, AND THE ONE SEAM
 * ==================================================================== */

type SaveRequest = {
  entries?: unknown;
  palette?: ReadonlyMap<number, unknown>;
  modeColors?: readonly unknown[];
  runtimeValues?: Record<string, unknown>;
};

interface Harness {
  readonly tree: ReactTestRenderer.ReactTestRenderer;
  readonly saves: SaveRequest[];
  readonly loads: number[];
}

/** The strip the classes below are measured on: three real LEDs. */
function board(): VirtualLedBoard {
  return new VirtualLedBoard({
    maxLength: 32,
    advancedRaw: 1,
    profile: 0,
    entries: [0, 1, 2].map(index =>
      encodeLedEntry({
        x: index * 5,
        y: index * 3,
        baseFunction: LedBaseFunction.COLOR,
        overlayMask: 0,
        colorIndex: index + 1,
        /* eslint-disable-next-line no-bitwise -- one firmware bit. */
        directionMask: 1 << LedDirectionBit.NORTH,
      }),
    ),
  });
}

async function openLed(): Promise<Harness> {
  const outcome: any = await outcomeVia(
    o => new LedStripConfigurationController(o),
    board(),
    48,
    'led-classes',
  );
  const saves: SaveRequest[] = [];
  const loads: number[] = [];
  const controller = {
    load: async () => {
      loads.push(Date.now());
      return outcome;
    },
    save: async (_key: unknown, request: SaveRequest) => {
      saves.push(request);
      return {kind: 'NO_CHANGES', snapshot: outcome.snapshot};
    },
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <LedStripScreen
        sessionKey={KEY}
        active
        onOpenSetup={() => undefined}
        controller={controller as any}
      />,
    );
  });
  await act(async () => {
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  });
  return {tree, saves, loads};
}

function handlerNode(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  handler: 'onPress' | 'onValueChange' = 'onPress',
): ReactTestRenderer.ReactTestInstance | undefined {
  return tree.root
    .findAll(
      candidate =>
        (candidate.props as any)?.testID === testID &&
        typeof (candidate.props as any)?.[handler] === 'function',
      {deep: true},
    )
    .pop();
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<boolean> {
  const found = handlerNode(tree, testID);
  if (found === undefined || (found.props as any).disabled === true) {
    return false;
  }
  await act(async () => {
    (found.props as any).onPress();
    for (let round = 0; round < 6; round += 1) await Promise.resolve();
  });
  return true;
}

/** The first rendered, enabled control whose testID matches. */
function firstMatching(
  tree: ReactTestRenderer.ReactTestRenderer,
  pattern: RegExp,
): string | undefined {
  for (const candidate of tree.root.findAll(
    instance =>
      typeof (instance.props as any)?.testID === 'string' &&
      pattern.test((instance.props as any).testID) &&
      typeof (instance.props as any)?.onPress === 'function',
    {deep: true},
  )) {
    if ((candidate.props as any).disabled === true) continue;
    return String((candidate.props as any).testID);
  }
  return undefined;
}

/** The first rendered, enabled control that is not already the selection. */
function unchosen(
  tree: ReactTestRenderer.ReactTestRenderer,
  pattern: RegExp,
): string | undefined {
  for (const candidate of tree.root.findAll(
    instance =>
      typeof (instance.props as any)?.testID === 'string' &&
      pattern.test((instance.props as any).testID) &&
      typeof (instance.props as any)?.onPress === 'function',
    {deep: true},
  )) {
    const props = candidate.props as any;
    if (props.disabled === true) continue;
    if (props.accessibilityState?.selected === true) continue;
    return String(props.testID);
  }
  return undefined;
}

function snapshotOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

/** The words the save bar shows when it refuses. */
function reasonText(
  tree: ReactTestRenderer.ReactTestRenderer,
): string | undefined {
  const node = tree.root
    .findAll(
      candidate =>
        (candidate.props as any)?.testID === 'led-save-bar-disabled-reason',
      {deep: true},
    )
    .pop();
  if (node === undefined) return undefined;
  const value = (node.props as any).children;
  return Array.isArray(value) ? value.join('') : String(value ?? '');
}

/** Which save groups the screen filled in. */
function groupsOf(request: SaveRequest | undefined): string[] {
  if (request === undefined) return [];
  const groups: string[] = [];
  if (request.entries !== undefined) groups.push('entries');
  if (request.palette !== undefined && request.palette.size > 0) {
    groups.push('palette');
  }
  if (request.modeColors !== undefined && request.modeColors.length > 0) {
    groups.push('modeColors');
  }
  if (
    request.runtimeValues !== undefined &&
    Object.keys(request.runtimeValues).length > 0
  ) {
    groups.push('runtimeValues');
  }
  return groups;
}

/* ==================================================================== *
 * THE CLASSES, FROM PRODUCTION SOURCE
 * ==================================================================== */

interface BehaviourClass {
  readonly name: string;
  readonly precondition: string;
  readonly action: string;
  /** Which `LedStripSaveRequest` group this class may fill in. */
  readonly writePath:
    | 'entries'
    | 'palette'
    | 'modeColors'
    | 'runtimeValues'
    | 'none';
  /** Does the class change the draft at all? */
  readonly expectDraftDelta: boolean;
  /** Why one representative stands for the whole class. */
  readonly representativeCovers: string;
  /** Puts the screen in the class's precondition and returns the control. */
  readonly reach: (
    tree: ReactTestRenderer.ReactTestRenderer,
  ) => Promise<string | undefined>;
  /**
   * Some edits are deliberately UNSAVEABLE until they are finished, and
   * that is the screen protecting the strip rather than a defect. An
   * appended LED that has not been placed encodes as the firmware's
   * end-of-strip terminator word, so saving it would silently truncate
   * the strip on the aircraft; `ledDraftSaveBlockers` refuses, by name.
   * A class that declares this must SHOW the reason, and must become
   * saveable once the edit is completed here.
   */
  readonly settle?: (
    tree: ReactTestRenderer.ReactTestRenderer,
  ) => Promise<string | undefined>;
  readonly expectBlockedBeforeSettle?: boolean;
}

/** Selects an LED that exists, so the inspector and grid have a subject. */
async function selectAnLed(
  tree: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await press(tree, 'led-section-tab-LAYOUT');
  await press(tree, 'led-cell-0-0');
}

const CLASSES: readonly BehaviourClass[] = [
  {
    name: 'SELECT_OCCUPIED_CELL',
    precondition: 'the LAYOUT section, an LED at 0,0',
    action: 'press the cell that holds it',
    writePath: 'none',
    expectDraftDelta: true,
    representativeCovers:
      'every occupied cell runs one onSelectCell with its own coordinates;' +
      ' the coordinates are data, not a branch',
    reach: async tree => {
      await press(tree, 'led-section-tab-LAYOUT');
      return 'led-cell-0-0';
    },
  },
  {
    name: 'SELECT_EMPTY_CELL',
    precondition: 'an LED already selected, and a cell with nothing on it',
    action: 'press the empty cell',
    writePath: 'entries',
    expectDraftDelta: true,
    representativeCovers:
      'the empty-cell branch is one handler shared by every unoccupied' +
      ' coordinate; which one is chosen changes only the destination',
    reach: async tree => {
      await selectAnLed(tree);
      return 'led-cell-9-9';
    },
  },
  {
    name: 'MOVE_SELECTED_LED',
    precondition: 'an LED selected at x=0, the inspector open',
    action: 'step its X coordinate up',
    writePath: 'entries',
    expectDraftDelta: true,
    representativeCovers:
      'X and Y are the same stepper component over two fields of one' +
      ' record; plus and minus are one handler with opposite signs',
    reach: async tree => {
      await selectAnLed(tree);
      return 'led-x-plus';
    },
  },
  {
    name: 'ADD_LED',
    precondition: 'a strip shorter than the board maximum',
    action: 'append an LED, then place it',
    writePath: 'entries',
    expectDraftDelta: true,
    expectBlockedBeforeSettle: true,
    representativeCovers: 'there is exactly one append control',
    reach: async tree => {
      await press(tree, 'led-section-tab-LAYOUT');
      return 'led-append';
    },
    settle: async () => 'led-x-plus',
  },
  {
    name: 'REMOVE_LED',
    precondition:
      'the LAST LED selected - `canDeleteSelectedLed` refuses any other,' +
      ' because zeroing a middle entry would end the strip there and' +
      ' switch off every LED after it',
    action: 'press delete-last',
    writePath: 'entries',
    expectDraftDelta: true,
    representativeCovers: 'there is exactly one delete control',
    reach: async tree => {
      await press(tree, 'led-section-tab-LAYOUT');
      /* The third LED of the fixture strip, at 10,6 - the last one. */
      await press(tree, 'led-cell-10-6');
      return 'led-delete-last';
    },
  },
  {
    name: 'BASE_FUNCTION',
    precondition: 'an LED selected',
    action: 'choose a different base function',
    writePath: 'entries',
    expectDraftDelta: true,
    representativeCovers:
      'every base function is one option of one selector writing one field',
    reach: async tree => {
      await selectAnLed(tree);
      await press(tree, 'led-function');
      /* An option that is NOT already chosen. Pressing the one the LED
         already has is correct and changes nothing, which would score a
         working selector as a class that writes nothing. */
      return unchosen(tree, /^led-function-option-\d+$/);
    },
  },
  {
    name: 'OVERLAY',
    precondition: 'an LED selected',
    action: 'toggle an overlay bit',
    writePath: 'entries',
    expectDraftDelta: true,
    representativeCovers:
      'each overlay is the same toggle over a different bit of one mask',
    reach: async tree => {
      await selectAnLed(tree);
      return firstMatching(tree, /^led-overlay-\d+$/);
    },
  },
  {
    name: 'DIRECTION',
    precondition: 'an LED selected',
    action: 'toggle a direction bit',
    writePath: 'entries',
    expectDraftDelta: true,
    representativeCovers:
      'each direction is the same toggle over a different bit of one mask',
    reach: async tree => {
      await selectAnLed(tree);
      return firstMatching(tree, /^led-direction-\d+$/);
    },
  },
  {
    name: 'WIRING_ORDER',
    precondition: 'a strip with more than one LED',
    action: 'move an LED later in the wiring order',
    writePath: 'entries',
    expectDraftDelta: true,
    representativeCovers:
      'earlier and later are one swap in opposite directions over the' +
      ' same array',
    reach: async tree => {
      await press(tree, 'led-section-tab-LAYOUT');
      return firstMatching(tree, /^led-order-(earlier|later)-\d+$/);
    },
  },
  {
    name: 'COLOR',
    precondition: 'the PALETTE section, a slot chosen',
    action: 'step the hue channel',
    writePath: 'palette',
    expectDraftDelta: true,
    representativeCovers:
      'hue, whiteness and value are three fields of one editor over one' +
      ' slot; the sixteen slots differ only by index',
    reach: async tree => {
      await press(tree, 'led-section-tab-PALETTE');
      await press(tree, 'led-palette-slot-0');
      return 'led-palette-hue-plus';
    },
  },
  {
    name: 'MODE_COLOR',
    precondition: 'the MODE COLOURS section',
    action: 'change one mode/direction tuple',
    writePath: 'modeColors',
    expectDraftDelta: true,
    representativeCovers:
      'every mode/direction/special tuple is one row of one editor' +
      ' producing one LedModeColorWrite',
    reach: async tree => {
      await press(tree, 'led-section-tab-MODE_COLORS');
      /* The row is a container; its swatch opens the colour picker, and
         the picker's options are what actually choose a colour. */
      await press(tree, 'led-mode-0-0-current');
      return unchosen(tree, /^led-mode-0-0-picker-\d+$/);
    },
  },
  {
    name: 'SPECIAL_COLOR',
    precondition: 'the MODE COLOURS section',
    action: 'change one special colour slot',
    writePath: 'modeColors',
    expectDraftDelta: true,
    representativeCovers:
      'the special slots share the mode-colour editor and the same write' +
      ' shape; only the slot index differs',
    reach: async tree => {
      await press(tree, 'led-section-tab-MODE_COLORS');
      await press(tree, 'led-special-0-current');
      return unchosen(tree, /^led-special-0-picker-\d+$/);
    },
  },
  {
    name: 'RUNTIME_VALUE',
    precondition: 'the RUNTIME section',
    action: 'step the brightness field',
    writePath: 'runtimeValues',
    expectDraftDelta: true,
    representativeCovers:
      'brightness, rainbowDelta and rainbowFreq are the same stepper over' +
      ' three keys of one Partial<LedRuntimeValues>',
    reach: async tree => {
      await press(tree, 'led-section-tab-RUNTIME');
      return 'led-runtime-brightness-plus';
    },
  },
];

interface Observed {
  readonly name: string;
  readonly control: string;
  readonly draftDelta: boolean;
  readonly wireDeltaBeforeSave: number;
  readonly writePathsOnSave: string[];
  readonly verdict: string;
}

const OBSERVED: Observed[] = [];

describe('every LED behaviour class edits a draft and writes only its own path', () => {
  it.each(CLASSES.map(entry => [entry.name, entry] as const))(
    '%s',
    async (name, behaviour) => {
      const {tree, saves} = await openLed();
      const control = await behaviour.reach(tree);
      if (control === undefined) {
        OBSERVED.push({
          name,
          control: '(not rendered on this board)',
          draftDelta: false,
          wireDeltaBeforeSave: 0,
          writePathsOnSave: [],
          verdict: 'NOT_RENDERED_ON_THIS_BOARD',
        });
        await act(async () => tree.unmount());
        return;
      }

      const before = snapshotOf(tree);
      const acted = await press(tree, control);
      const draftDelta = snapshotOf(tree) !== before;

      /* 1. EDITING IS A DRAFT. Nothing on the strip changes until Save. */
      const wireDeltaBeforeSave = saves.length;

      /* AN EDIT THAT IS NOT FINISHED IS REFUSED, BY NAME.
         `led-append` leaves a pending LED whose word is the firmware's
         end-of-strip terminator, so saving it would truncate the strip
         on the aircraft. The screen blocks Save and says why. That is the
         product being careful, and the class declares it. */
      let blockedReason: string | undefined;
      if (behaviour.expectBlockedBeforeSettle === true) {
        const saveNode = handlerNode(tree, 'led-save-bar-save');
        blockedReason = reasonText(tree);
        expect({
          class: name,
          saveOffered: (saveNode?.props as any)?.disabled !== true,
        }).toEqual({class: name, saveOffered: false});
        expect({class: name, hasNamedReason: (blockedReason ?? '').length > 0})
          .toEqual({class: name, hasNamedReason: true});
        const finish = await behaviour.settle!(tree);
        expect(finish).toBeDefined();
        expect(await press(tree, finish!)).toBe(true);
      }

      /* 2. AND SAVE WRITES ONLY THE PATH THAT WAS EDITED. */
      await press(tree, 'led-save-bar-save');
      const paths = groupsOf(saves[0]);

      const verdict =
        !acted
          ? 'CONTROL_REFUSED'
          : wireDeltaBeforeSave > 0
            ? 'WROTE_BEFORE_SAVE'
            : behaviour.writePath === 'none'
              ? paths.length === 0
                ? 'SELECTION_ONLY_NO_WRITE'
                : `SELECTION_WROTE:${paths.join('+')}`
              : paths.length === 0
                ? 'NOTHING_TO_WRITE'
                : paths.length === 1 && paths[0] === behaviour.writePath
                  ? 'OWN_PATH_ONLY'
                  : `EXTRA_PATHS:${paths.join('+')}`;

      OBSERVED.push({
        name,
        control,
        draftDelta,
        wireDeltaBeforeSave,
        writePathsOnSave: paths,
        verdict:
          blockedReason === undefined
            ? verdict
            : `${verdict} (refused until placed: "${blockedReason.slice(0, 40)}...")`,
      });

      expect({class: name, reached: acted}).toEqual({class: name, reached: true});
      expect({class: name, draftChangedTheScreen: draftDelta}).toEqual({
        class: name,
        draftChangedTheScreen: behaviour.expectDraftDelta,
      });
      /* THE SAFETY HALF: no edit reaches the strip before Save. */
      expect({class: name, wroteBeforeSave: wireDeltaBeforeSave}).toEqual({
        class: name,
        wroteBeforeSave: 0,
      });
      /* AND THE WRITE HALF: exactly the path this class owns. A
         selection writes nothing at all. */
      if (behaviour.writePath === 'none') {
        expect({class: name, writePathsOnSave: paths}).toEqual({
          class: name,
          writePathsOnSave: [],
        });
      } else {
        expect({class: name, writePathsOnSave: paths}).toEqual({
          class: name,
          writePathsOnSave: [behaviour.writePath],
        });
      }
      await act(async () => tree.unmount());
    },
  );

  it('SAVE and CANCEL/RELOAD, which are classes of their own', async () => {
    const {tree, saves, loads} = await openLed();
    await selectAnLed(tree);
    /* PLUS, not "whichever stepper button comes first". The LED sits at
       x=0, so minus is a correct no-op there and the draft would never
       become dirty - which would hide the save bar and make this test
       measure its own mistake. */
    const stepper = 'led-x-plus';
    expect(await press(tree, stepper)).toBe(true);
    const dirty = snapshotOf(tree);

    /* CANCEL: the draft goes back to the board's own values and nothing
       is written. */
    expect(await press(tree, 'led-save-bar-discard')).toBe(true);
    const afterDiscard = snapshotOf(tree);
    OBSERVED.push({
      name: 'CANCEL_DISCARD',
      control: 'led-save-bar-discard',
      draftDelta: afterDiscard !== dirty,
      wireDeltaBeforeSave: saves.length,
      writePathsOnSave: [],
      verdict: saves.length === 0 ? 'DISCARDED_WITHOUT_WRITING' : 'WROTE_ON_DISCARD',
    });
    expect({wroteOnDiscard: saves.length}).toEqual({wroteOnDiscard: 0});
    expect({discardChangedTheScreen: afterDiscard !== dirty}).toEqual({
      discardChangedTheScreen: true,
    });

    /* RELOAD: reads the board again. */
    const loadsBefore = loads.length;
    await press(tree, 'led-reload');
    await act(async () => {
      for (let round = 0; round < 8; round += 1) await Promise.resolve();
    });
    OBSERVED.push({
      name: 'RELOAD',
      control: 'led-reload',
      draftDelta: false,
      wireDeltaBeforeSave: saves.length,
      writePathsOnSave: [],
      verdict:
        loads.length > loadsBefore ? 'RE_READ_THE_BOARD' : 'DID_NOT_RE_READ',
    });
    expect(loads.length).toBeGreaterThan(loadsBefore);

    /* SAVE: one write, carrying the entries path only.
       A reload legitimately drops the selection, so the inspector - and
       with it the X stepper - is gone until an LED is chosen again. */
    await selectAnLed(tree);
    expect(await press(tree, stepper)).toBe(true);
    expect(await press(tree, 'led-save-bar-save')).toBe(true);
    OBSERVED.push({
      name: 'SAVE',
      control: 'led-save-bar-save',
      draftDelta: false,
      wireDeltaBeforeSave: 0,
      writePathsOnSave: groupsOf(saves[0]),
      verdict: saves.length === 1 ? 'ONE_WRITE' : `WRITES:${saves.length}`,
    });
    expect({writes: saves.length}).toEqual({writes: 1});
    expect(groupsOf(saves[0])).toEqual(['entries']);
    await act(async () => tree.unmount());
  });

  it('prints the LED behaviour-class ledger', () => {
    console.log(
      [
        '',
        '===== UI-X1D LED BEHAVIOUR CLASSES =====',
        `  classes enumerated from production source : ${CLASSES.length + 3}`,
        `  classes exercised                         : ${OBSERVED.length}`,
        '',
        '  CLASS                 CONTROL                          DRAFT  WIRE-BEFORE-SAVE  WRITE PATH        VERDICT',
        ...OBSERVED.map(
          row =>
            `  ${row.name.padEnd(21)} ${row.control.padEnd(32)}` +
            ` ${(row.draftDelta ? 'yes' : 'no ').padEnd(6)}` +
            ` ${String(row.wireDeltaBeforeSave).padStart(9)}        ` +
            ` ${(row.writePathsOnSave.join('+') || '-').padEnd(17)} ${row.verdict}`,
        ),
        '',
        '  EQUIVALENCE - why one representative stands for the class',
        ...CLASSES.map(
          entry => `    ${entry.name.padEnd(21)} ${entry.representativeCovers}`,
        ),
        '========================================',
        '',
      ].join('\n'),
    );
    /* A ledger with nothing in it would satisfy every row above. */
    expect(OBSERVED.length).toBe(CLASSES.length + 3);
    /* Nothing wrote before Save, anywhere. */
    expect(OBSERVED.filter(row => row.wireDeltaBeforeSave > 0)).toEqual([]);
    /* And every class that was rendered resolved to a good verdict. */
    expect(
      OBSERVED.filter(
        row =>
          row.verdict.includes('EXTRA_PATHS') ||
          row.verdict.includes('SELECTION_WROTE') ||
          row.verdict.includes('WROTE_BEFORE_SAVE') ||
          row.verdict.includes('CONTROL_REFUSED') ||
          row.verdict.includes('NOT_RENDERED'),
      ),
    ).toEqual([]);
  });
});
