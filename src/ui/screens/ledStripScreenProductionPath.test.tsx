/* eslint-disable no-bitwise -- scenario LEDs are built from the firmware's
 * own bit positions, and the reserved-bit assertions mask them back out. */
/**
 * THE LED SCREEN, THE REAL CONTROLLER, AND A BOARD THAT COUNTS.
 *
 * Nothing is stubbed between the rendered tree and the MSP frames. The
 * actual `LedStripScreen` drives the actual
 * `LedStripConfigurationController` against a `VirtualLedBoard` that
 * re-counts its strip after every accepted write, exactly as the firmware
 * does. Only the USB device is imaginary.
 *
 * THE ASSERTION THIS FILE EXISTS FOR is not on any final state. It is the
 * write counters: opening this tab, looking at LEDs, selecting them,
 * dragging them around the grid and typing in the inspector must leave the
 * aircraft byte-for-byte as it was found. A configurator that writes while
 * you look at it is a configurator that can brick a strip mid-inspection,
 * and `NO_WRITES` is checked after every one of those journeys.
 *
 * The Arabic is read out of `ar.json` rather than retyped, so a copy change
 * moves the assertion with it instead of silently rotting.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import LedStripScreen from './LedStripScreen';
import {LedStripConfigurationController} from '../../platforms/react-native/protocol/LedStripConfigurationController';
import {VirtualSession} from '../../platforms/react-native/protocol/__testUtils__/virtualSession';
import {
  LED_CMD,
  VirtualLedBoard,
  type VirtualLedBoardOptions,
} from '../../platforms/react-native/protocol/__testUtils__/virtualLedBoard';
import {
  encodeLedEntry,
  LedBaseFunction,
  LedDirectionBit,
  LedOverlayBit,
  LED_OVERLAY_RESERVED_MASK,
} from '../../core/protocol/msp/decoding/ledStripWireContract';

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

const L = ar.ledStripScreen;

/* ================================================================== *
 * SCENARIO PLUMBING
 * ================================================================== */

function led(params: {
  x: number;
  y: number;
  fn?: number;
  overlays?: number;
  color?: number;
  directions?: number;
}): number {
  return encodeLedEntry({
    x: params.x,
    y: params.y,
    baseFunction: params.fn ?? LedBaseFunction.COLOR,
    overlayMask: params.overlays ?? 0,
    colorIndex: params.color ?? 1,
    directionMask: params.directions ?? 1 << LedDirectionBit.NORTH,
  });
}

/** Four LEDs at the corners of a small box, in wire order. */
const FOUR: readonly number[] = Object.freeze([
  led({x: 2, y: 1, color: 1}),
  led({x: 6, y: 1, color: 2}),
  led({x: 2, y: 5, color: 3}),
  led({x: 6, y: 5, color: 4}),
]);

/** One LED carrying all three reserved overlay bits and an unknown base
 *  function, so a silent normalisation anywhere shows up. */
const EXOTIC = encodeLedEntry({
  x: 9,
  y: 9,
  baseFunction: 14,
  overlayMask: LED_OVERLAY_RESERVED_MASK | (1 << LedOverlayBit.BLINK),
  colorIndex: 7,
  directionMask: (1 << LedDirectionBit.EAST) | (1 << LedDirectionBit.WEST),
});

function makeBoard(options: Partial<VirtualLedBoardOptions> = {}): VirtualLedBoard {
  return new VirtualLedBoard({
    maxLength: 32,
    advancedRaw: 1,
    profile: 2,
    entries: FOUR,
    ...options,
  });
}

interface Harness {
  readonly tree: ReactTestRenderer.ReactTestRenderer;
  readonly board: VirtualLedBoard;
  readonly session: VirtualSession;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

async function mount(
  options: Partial<VirtualLedBoardOptions> = {},
  apiMinor = 48,
): Promise<Harness> {
  const board = makeBoard(options);
  const session = new VirtualSession({
    sessionId: 'led-ui',
    board: board as never,
    apiMinor,
  });
  const controller = new LedStripConfigurationController({
    coordinator: session.coordinator as never,
    appStateOwner: {getPhase: () => session.appPhase as 'ACTIVE'},
  });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <LedStripScreen
        sessionKey={session.key}
        active
        onOpenSetup={() => undefined}
        controller={controller}
      />,
    );
    await sleep(60);
  });
  await act(async () => {
    await sleep(60);
  });
  return {tree, board, session};
}

/** The four SET commands and the persist. Zero on every read-only path. */
function writeCounts(board: VirtualLedBoard) {
  return {
    entries: board.countOf(LED_CMD.SET_STRIP_CONFIG),
    palette: board.countOf(LED_CMD.SET_COLORS),
    modeColors: board.countOf(LED_CMD.SET_MODECOLOR),
    runtimeValues: board.countOf(LED_CMD.SET_VALUES),
    eeprom: board.countOf(LED_CMD.EEPROM),
    reboots: board.countOf(LED_CMD.REBOOT),
  };
}

const NO_WRITES = {
  entries: 0,
  palette: 0,
  modeColors: 0,
  runtimeValues: 0,
  eeprom: 0,
  reboots: 0,
};

function has(tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAllByProps({testID}).length > 0;
}

function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onPress === 'function');
  if (node === undefined) throw new Error(`No pressable ${testID}`);
  act(() => {
    node.props.onPress();
  });
}

function pressable(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): {disabled?: boolean} {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onPress === 'function');
  if (node === undefined) throw new Error(`No pressable ${testID}`);
  return node.props;
}

function toggle(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  next: boolean,
): void {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onValueChange === 'function');
  if (node === undefined) throw new Error(`No switch ${testID}`);
  act(() => {
    node.props.onValueChange(next);
  });
}

function switchValue(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onValueChange === 'function');
  if (node === undefined) throw new Error(`No switch ${testID}`);
  return node.props.value === true;
}

function step(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  direction: 'up' | 'down',
): void {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onIncrement === 'function');
  if (node === undefined) throw new Error(`No stepper ${testID}`);
  act(() => {
    if (direction === 'up') node.props.onIncrement();
    else node.props.onDecrement();
  });
}

function stepperValue(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): string {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onIncrement === 'function');
  if (node === undefined) throw new Error(`No stepper ${testID}`);
  return String(node.props.value);
}

/** Open one of the four sections, the way an operator does. */
function openSection(
  tree: ReactTestRenderer.ReactTestRenderer,
  key: 'LAYOUT' | 'PALETTE' | 'MODE_COLORS' | 'RUNTIME',
): void {
  press(tree, `led-section-tab-${key}`);
}

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(collect).join(' ');
    if (node !== null && typeof node === 'object' && 'children' in node) {
      return collect((node as {children: unknown}).children);
    }
    return '';
  };
  return collect(tree.toJSON());
}

function saveBar(tree: ReactTestRenderer.ReactTestRenderer): {
  visible: boolean;
  disabledReason?: string;
  details?: readonly string[];
} {
  const node = tree.root
    .findAllByProps({testID: 'led-save-bar'})
    .find(candidate => typeof candidate.props.visible === 'boolean');
  if (node === undefined) throw new Error('No save bar');
  return node.props as {
    visible: boolean;
    disabledReason?: string;
    details?: readonly string[];
  };
}

/** The text of ONE subtree, so an assertion about the inspector cannot be
 *  satisfied - or defeated - by wording somewhere else on the page. */
function textIn(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): string {
  const node = tree.root.findAllByProps({testID})[0];
  if (node === undefined) throw new Error(`No subtree ${testID}`);
  const walk = (instance: ReactTestRenderer.ReactTestInstance | string): string =>
    typeof instance === 'string' ? instance : instance.children.map(walk).join(' ');
  return walk(node);
}

/** Every node number currently drawn on the grid, in physical order. */
function nodeNumbers(tree: ReactTestRenderer.ReactTestRenderer): number[] {
  const numbers: number[] = [];
  for (let index = 0; index < 64; index++) {
    const found = tree.root.findAllByProps({testID: `led-node-${index}`});
    if (found.length > 0) numbers.push(index + 1);
  }
  return numbers;
}

/** Which cell an LED number is drawn in. */
function cellOf(
  tree: ReactTestRenderer.ReactTestRenderer,
  index: number,
): {x: number; y: number} {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const cell = tree.root
        .findAllByProps({testID: `led-cell-${x}-${y}`})
        .find(c => typeof c.props.onPress === 'function');
      if (cell === undefined) continue;
      const inside = cell.findAllByProps({testID: `led-node-${index}`});
      if (inside.length > 0) return {x, y};
    }
  }
  throw new Error(`LED ${index} is not on the grid`);
}

/* ================================================================== *
 * 1-8. LOAD, AND IT WRITES NOTHING
 * ================================================================== */

describe('load', () => {
  it('1. renders the Arabic title and subtitle', async () => {
    const {tree} = await mount();
    const text = textOf(tree);
    expect(text).toContain(L.title);
    expect(text).toContain(L.subtitle);
    act(() => tree.unmount());
  });

  it('2. RELEASE GATE - a load produces zero SET, zero EEPROM and zero reboot', async () => {
    const {tree, board} = await mount();
    expect(writeCounts(board)).toEqual(NO_WRITES);
    expect(board.requests.length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('3. draws one node per effective LED', async () => {
    const {tree} = await mount();
    expect(nodeNumbers(tree)).toEqual([1, 2, 3, 4]);
    act(() => tree.unmount());
  });

  it('4. numbers the first physical LED as 1, not 0', async () => {
    const {tree} = await mount();
    expect(has(tree, 'led-node-0')).toBe(true);
    expect(nodeNumbers(tree)[0]).toBe(1);
    act(() => tree.unmount());
  });

  it('5. draws nothing for the terminator words past the effective run', async () => {
    const {tree} = await mount();
    expect(has(tree, 'led-node-4')).toBe(false);
    expect(has(tree, 'led-node-31')).toBe(false);
    act(() => tree.unmount());
  });

  it('6. states the effective count against the board array length', async () => {
    const {tree} = await mount();
    expect(textOf(tree)).toContain('4');
    expect(textOf(tree)).toContain('32');
    act(() => tree.unmount());
  });

  it('7. re-reading still writes nothing', async () => {
    const {tree, board} = await mount();
    await act(async () => {
      press(tree, 'led-reload');
      await sleep(80);
    });
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('8. a board without the LED subsystem says so, in Arabic, and writes nothing', async () => {
    const {tree, board} = await mount({ledStripAbsent: true});
    expect(has(tree, 'led-blocked')).toBe(true);
    expect(textOf(tree)).toContain(L.blocked.LED_STRIP_UNSUPPORTED_BY_BUILD);
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 9-16. THE GRID
 * ================================================================== */

describe('the grid', () => {
  it('9. offers every cell of the 16x16 physical space', async () => {
    const {tree} = await mount();
    expect(has(tree, 'led-cell-0-0')).toBe(true);
    expect(has(tree, 'led-cell-15-15')).toBe(true);
    expect(has(tree, 'led-cell-15-0')).toBe(true);
    expect(has(tree, 'led-cell-0-15')).toBe(true);
    act(() => tree.unmount());
  });

  it('10. places each LED at its own X and Y, front row at the top', async () => {
    const {tree} = await mount();
    expect(cellOf(tree, 0)).toEqual({x: 2, y: 1});
    expect(cellOf(tree, 1)).toEqual({x: 6, y: 1});
    expect(cellOf(tree, 2)).toEqual({x: 2, y: 5});
    expect(cellOf(tree, 3)).toEqual({x: 6, y: 5});
    act(() => tree.unmount());
  });

  it('11. bounds the wide canvas inside its own scroller', async () => {
    const {tree} = await mount();
    expect(has(tree, 'led-grid-viewport')).toBe(true);
    expect(has(tree, 'led-grid-canvas')).toBe(true);
    act(() => tree.unmount());
  });

  it('12. marks the front of the aircraft and calls itself a symbolic preview', async () => {
    const {tree} = await mount();
    const text = textOf(tree);
    expect(text).toContain(L.grid.front);
    expect(text).toContain(L.grid.symbolicPreview);
    act(() => tree.unmount());
  });

  it('13. selecting an LED writes nothing to the board', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-cell-2-1');
    press(tree, 'led-cell-6-5');
    press(tree, 'led-cell-2-5');
    expect(writeCounts(board)).toEqual(NO_WRITES);
    expect(saveBar(tree).visible).toBe(false);
    act(() => tree.unmount());
  });

  it('14. pressing an EMPTY cell with nothing selected creates no LED', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-cell-11-11');
    expect(nodeNumbers(tree)).toEqual([1, 2, 3, 4]);
    expect(writeCounts(board)).toEqual(NO_WRITES);
    expect(saveBar(tree).visible).toBe(false);
    act(() => tree.unmount());
  });

  it('15. a shared coordinate is counted, and the second LED is not dropped', async () => {
    const twin = led({x: 2, y: 1, color: 9});
    const {tree} = await mount({entries: [FOUR[0], twin, FOUR[2]]});
    /* One cell, a ×2 badge, and BOTH entries still present as their own
       rows in the wiring order. The reference tab's grid keys entries by
       coordinate and silently loses the second; this one cannot. */
    expect(has(tree, 'led-cluster-2-1')).toBe(true);
    expect(textIn(tree, 'led-cluster-2-1')).toContain('2');
    expect(has(tree, 'led-order-0')).toBe(true);
    expect(has(tree, 'led-order-1')).toBe(true);
    expect(has(tree, 'led-order-2')).toBe(true);
    expect(has(tree, 'led-order-shared-0')).toBe(true);
    expect(has(tree, 'led-order-shared-1')).toBe(true);
    act(() => tree.unmount());
  });

  it('16. both LEDs of a shared coordinate are individually selectable', async () => {
    const twin = led({x: 2, y: 1, color: 9});
    const {tree} = await mount({entries: [FOUR[0], twin, FOUR[2]]});
    press(tree, 'led-cell-2-1');
    expect(textIn(tree, 'led-inspector')).toContain('LED 1');
    expect(has(tree, 'led-node-0')).toBe(true);
    press(tree, 'led-cell-2-1');
    expect(textIn(tree, 'led-inspector')).toContain('LED 2');
    /* The CELL follows the selection too, so the operator is never editing
       one LED while the grid shows another's number. */
    expect(has(tree, 'led-node-1')).toBe(true);
    expect(has(tree, 'led-cluster-member-0')).toBe(true);
    expect(has(tree, 'led-cluster-member-1')).toBe(true);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 17-26. THE INSPECTOR
 * ================================================================== */

describe('the inspector', () => {
  it('17. asks for a selection before showing any control', async () => {
    const {tree} = await mount();
    expect(has(tree, 'led-inspector-empty')).toBe(true);
    expect(textOf(tree)).toContain(L.inspector.nothingSelected);
    act(() => tree.unmount());
  });

  it('18. names the selected LED by its human number', async () => {
    const {tree} = await mount();
    press(tree, 'led-cell-6-5');
    expect(textOf(tree)).toContain('LED 4');
    act(() => tree.unmount());
  });

  it('19. shows the selected LED coordinates', async () => {
    const {tree} = await mount();
    press(tree, 'led-cell-6-5');
    expect(stepperValue(tree, 'led-x')).toBe('6');
    expect(stepperValue(tree, 'led-y')).toBe('5');
    act(() => tree.unmount());
  });

  it('20. moving an LED with the coordinate control changes the draft, not the board', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-cell-2-1');
    step(tree, 'led-x', 'up');
    expect(cellOf(tree, 0)).toEqual({x: 3, y: 1});
    expect(writeCounts(board)).toEqual(NO_WRITES);
    expect(saveBar(tree).visible).toBe(true);
    act(() => tree.unmount());
  });

  it('21. names the base function in Arabic', async () => {
    const {tree} = await mount({entries: [led({x: 3, y: 3, fn: LedBaseFunction.THRUST_RING})]});
    press(tree, 'led-cell-3-3');
    expect(textOf(tree)).toContain(L.function.THRUST_RING);
    act(() => tree.unmount());
  });

  it('22. says an unknown base function IS unknown, and carries its number', async () => {
    const {tree} = await mount({entries: [EXOTIC]});
    press(tree, 'led-cell-9-9');
    expect(has(tree, 'led-unknown-function')).toBe(true);
    expect(textIn(tree, 'led-inspector')).toContain('14');
    /* And it is NOT silently renamed to the function a `% 10` would give.
       Scoped to the inspector: «قوة الإشارة» legitimately appears further
       down the page as the name of a runtime LAYER. */
    expect(textIn(tree, 'led-inspector')).not.toContain(L.function.RSSI);
    act(() => tree.unmount());
  });

  it('23. reflects the LED overlay bits', async () => {
    const {tree} = await mount({entries: [EXOTIC]});
    press(tree, 'led-cell-9-9');
    expect(switchValue(tree, `led-overlay-${LedOverlayBit.BLINK}`)).toBe(true);
    expect(switchValue(tree, `led-overlay-${LedOverlayBit.RAINBOW}`)).toBe(false);
    act(() => tree.unmount());
  });

  it('24. says the unknown overlay bits exist and will be kept', async () => {
    const {tree} = await mount({entries: [EXOTIC]});
    press(tree, 'led-cell-9-9');
    expect(has(tree, 'led-reserved-overlays')).toBe(true);
    expect(textOf(tree)).toContain(L.overlay.reservedPreserved);
    act(() => tree.unmount());
  });

  it('25. toggling one direction leaves the others alone', async () => {
    const {tree} = await mount({entries: [EXOTIC]});
    press(tree, 'led-cell-9-9');
    expect(switchValue(tree, `led-direction-${LedDirectionBit.EAST}`)).toBe(true);
    expect(switchValue(tree, `led-direction-${LedDirectionBit.WEST}`)).toBe(true);
    toggle(tree, `led-direction-${LedDirectionBit.UP}`, true);
    expect(switchValue(tree, `led-direction-${LedDirectionBit.EAST}`)).toBe(true);
    expect(switchValue(tree, `led-direction-${LedDirectionBit.WEST}`)).toBe(true);
    expect(switchValue(tree, `led-direction-${LedDirectionBit.UP}`)).toBe(true);
    act(() => tree.unmount());
  });

  it('26. offers the sixteen colour slots by number, with no invented names', async () => {
    const {tree} = await mount();
    press(tree, 'led-cell-2-1');
    expect(has(tree, 'led-color-0')).toBe(true);
    expect(has(tree, 'led-color-15')).toBe(true);
    expect(has(tree, 'led-color-16')).toBe(false);
    for (const name of ['أخضر', 'أحمر', 'أزرق']) {
      expect(textOf(tree)).not.toContain(name);
    }
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 27-32. MULTI-SELECTION
 * ================================================================== */

describe('multi-selection', () => {
  it('27. is off until the operator turns it on', async () => {
    const {tree} = await mount();
    expect(switchValue(tree, 'led-multi-select')).toBe(false);
    toggle(tree, 'led-multi-select', true);
    expect(switchValue(tree, 'led-multi-select')).toBe(true);
    act(() => tree.unmount());
  });

  it('28. selects every LED without touching the board', async () => {
    const {tree, board} = await mount();
    toggle(tree, 'led-multi-select', true);
    press(tree, 'led-select-all');
    expect(textIn(tree, 'led-inspector')).toContain(
      L.inspector.manySelected.replace('{{count}}', '4'),
    );
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('29. says «قيم مختلفة» rather than showing the first LED value as everyone’s', async () => {
    const {tree} = await mount();
    toggle(tree, 'led-multi-select', true);
    press(tree, 'led-select-all');
    /* The four LEDs carry four different colour slots. */
    expect(textIn(tree, 'led-inspector')).toContain(L.inspector.mixed);
    act(() => tree.unmount());
  });

  it('30. marks a mixed overlay as mixed', async () => {
    const withBlink = led({x: 8, y: 8, overlays: 1 << LedOverlayBit.BLINK});
    const {tree} = await mount({entries: [FOUR[0], withBlink]});
    toggle(tree, 'led-multi-select', true);
    press(tree, 'led-select-all');
    expect(has(tree, `led-overlay-mixed-${LedOverlayBit.BLINK}`)).toBe(true);
    act(() => tree.unmount());
  });

  it('31. applies one edit to every selected LED', async () => {
    const {tree} = await mount();
    toggle(tree, 'led-multi-select', true);
    press(tree, 'led-select-all');
    toggle(tree, `led-overlay-${LedOverlayBit.WARNING}`, true);
    expect(switchValue(tree, `led-overlay-${LedOverlayBit.WARNING}`)).toBe(true);
    expect(saveBar(tree).visible).toBe(true);
    act(() => tree.unmount());
  });

  it('32. keeps at most one LED when multi-selection is switched off', async () => {
    const {tree} = await mount();
    toggle(tree, 'led-multi-select', true);
    press(tree, 'led-select-all');
    toggle(tree, 'led-multi-select', false);
    expect(textIn(tree, 'led-inspector')).toContain('LED 1');
    expect(textIn(tree, 'led-inspector')).not.toContain(
      L.inspector.manySelected.replace('{{count}}', '4'),
    );
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 33-40. ADDING AND REMOVING
 * ================================================================== */

describe('adding and removing', () => {
  it('33. «إضافة LED» opens the NEXT physical index and no other', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-append');
    expect(nodeNumbers(tree)).toEqual([1, 2, 3, 4, 5]);
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('34. an all-zero new LED cannot be saved, and says exactly why', async () => {
    const {tree} = await mount();
    press(tree, 'led-append');
    expect(saveBar(tree).disabledReason).toBe(
      L.save.blocked.PENDING_LED_ENCODES_AS_TERMINATOR,
    );
    act(() => tree.unmount());
  });

  it('35. placing the new LED on the grid makes it saveable', async () => {
    const {tree} = await mount();
    press(tree, 'led-append');
    press(tree, 'led-cell-12-3');
    expect(saveBar(tree).disabledReason).toBeUndefined();
    expect(cellOf(tree, 4)).toEqual({x: 12, y: 3});
    act(() => tree.unmount());
  });

  it('36. refuses to add past the board array length', async () => {
    const full = Array.from({length: 4}, (_unused, i) => led({x: i, y: 0, color: i + 1}));
    const {tree} = await mount({maxLength: 4, entries: full});
    press(tree, 'led-append');
    expect(has(tree, 'led-edit-refusal')).toBe(true);
    expect(textOf(tree)).toContain(L.edit.refusal.STRIP_FULL);
    act(() => tree.unmount());
  });

  it('37. «حذف آخر LED» is offered only for the last LED', async () => {
    const {tree} = await mount();
    expect(pressable(tree, 'led-delete-last').disabled).toBe(true);
    press(tree, 'led-cell-2-1');
    expect(pressable(tree, 'led-delete-last').disabled).toBe(true);
    press(tree, 'led-cell-6-5');
    expect(pressable(tree, 'led-delete-last').disabled).toBe(false);
    act(() => tree.unmount());
  });

  it('38. deleting the last LED shortens the draft and writes nothing yet', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-cell-6-5');
    press(tree, 'led-delete-last');
    expect(nodeNumbers(tree)).toEqual([1, 2, 3]);
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('39. an edit that would make an LED the strip terminator is refused', async () => {
    /* x=1 and nothing else: clearing x makes the whole word zero. */
    const bare = encodeLedEntry({
      x: 1,
      y: 0,
      baseFunction: 0,
      overlayMask: 0,
      colorIndex: 0,
      directionMask: 0,
    });
    const {tree, board} = await mount({entries: [bare]});
    press(tree, 'led-cell-1-0');
    step(tree, 'led-x', 'down');
    expect(has(tree, 'led-edit-refusal')).toBe(true);
    expect(textOf(tree)).toContain(L.edit.refusal.WOULD_ENCODE_AS_TERMINATOR);
    /* The LED is still there and the board is still untouched. */
    expect(nodeNumbers(tree)).toEqual([1]);
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('40. none of the editing journeys wrote a single byte of configuration', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-cell-2-1');
    step(tree, 'led-x', 'up');
    step(tree, 'led-y', 'up');
    toggle(tree, `led-overlay-${LedOverlayBit.BLINK}`, true);
    toggle(tree, `led-direction-${LedDirectionBit.SOUTH}`, true);
    press(tree, 'led-color-5');
    press(tree, 'led-append');
    press(tree, 'led-cell-14-14');
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 41-46. WIRING ORDER
 * ================================================================== */

describe('the wiring order', () => {
  it('41. lists the LEDs in wire order, not by coordinate', async () => {
    const backwards = [led({x: 15, y: 0, color: 1}), led({x: 0, y: 0, color: 2})];
    const {tree} = await mount({entries: backwards});
    expect(has(tree, 'led-order-0')).toBe(true);
    expect(has(tree, 'led-order-1')).toBe(true);
    expect(cellOf(tree, 0)).toEqual({x: 15, y: 0});
    expect(cellOf(tree, 1)).toEqual({x: 0, y: 0});
    act(() => tree.unmount());
  });

  it('42. moving an LED earlier swaps it with its neighbour', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-order-earlier-1');
    /* LED 1 now sits where LED 2 was and vice versa. */
    expect(cellOf(tree, 0)).toEqual({x: 6, y: 1});
    expect(cellOf(tree, 1)).toEqual({x: 2, y: 1});
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('43. cannot move the first LED any earlier', async () => {
    const {tree} = await mount();
    expect(pressable(tree, 'led-order-earlier-0').disabled).toBe(true);
    act(() => tree.unmount());
  });

  it('44. cannot move the last LED any later', async () => {
    const {tree} = await mount();
    expect(pressable(tree, 'led-order-later-3').disabled).toBe(true);
    act(() => tree.unmount());
  });

  it('45. a reorder carries the WHOLE entry, reserved bits included', async () => {
    const {tree, board} = await mount({entries: [FOUR[0], EXOTIC]});
    press(tree, 'led-order-earlier-1');
    press(tree, 'led-cell-9-9');
    /* The exotic LED is now index 0, and every unknown bit came with it. */
    expect(has(tree, 'led-node-0')).toBe(true);
    expect(has(tree, 'led-reserved-overlays')).toBe(true);
    expect(textOf(tree)).toContain('14');
    expect(switchValue(tree, `led-direction-${LedDirectionBit.EAST}`)).toBe(true);
    expect(switchValue(tree, `led-direction-${LedDirectionBit.WEST}`)).toBe(true);
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('46. refuses to reorder while a new LED is half-built', async () => {
    const {tree} = await mount();
    press(tree, 'led-append');
    press(tree, 'led-order-earlier-1');
    expect(textOf(tree)).toContain(L.edit.refusal.PENDING_BLOCKS_REORDER);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 47-52. PALETTE, MODE COLOURS AND RUNTIME VALUES
 * ================================================================== */

describe('colours and effects', () => {
  it('47. shows the sixteen observed palette slots, numbered', async () => {
    const {tree} = await mount();
    openSection(tree, 'PALETTE');
    expect(has(tree, 'led-palette-slot-0')).toBe(true);
    expect(has(tree, 'led-palette-slot-15')).toBe(true);
    expect(has(tree, 'led-palette-slot-16')).toBe(false);
    act(() => tree.unmount());
  });

  it('48. editing a palette slot marks the palette group dirty and writes nothing', async () => {
    const {tree, board} = await mount();
    openSection(tree, 'PALETTE');
    step(tree, 'led-palette-hue', 'up');
    expect(saveBar(tree).details).toContain(L.save.group.PALETTE);
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('49. a basic board has no palette to show and is told so', async () => {
    const {tree} = await mount({advancedRaw: 0});
    openSection(tree, 'PALETTE');
    expect(has(tree, 'led-no-palette')).toBe(true);
    expect(textOf(tree)).toContain(L.palette.unavailable);
    expect(textOf(tree)).toContain(L.capability.BASIC_LED_STRIP);
    act(() => tree.unmount());
  });

  it('50. keeps the stored-but-never-read flight mode OUT of the editable modes', async () => {
    const {tree} = await mount();
    openSection(tree, 'MODE_COLORS');
    /* §42: mode 5 is on the wire, is validated on write, and is never read
       by the firmware. It gets no editing control beside the four that
       work - it appears only behind the technical disclosure, with why. */
    expect(has(tree, 'led-mode-0')).toBe(true);
    expect(has(tree, 'led-mode-4')).toBe(true);
    expect(has(tree, 'led-mode-5')).toBe(false);

    press(tree, 'led-technical-toggle');
    expect(has(tree, 'led-technical-inert-5')).toBe(true);
    expect(textIn(tree, 'led-technical-body')).toContain(L.technical.inertMode);
    act(() => tree.unmount());
  });

  it('51. exposes the BACKGROUND special colour slot and the aux channel', async () => {
    const {tree} = await mount();
    openSection(tree, 'MODE_COLORS');
    expect(textOf(tree)).toContain(L.special.BACKGROUND);
    expect(textOf(tree)).toContain(L.mode.auxChannel);
    expect(has(tree, 'led-special-10')).toBe(true);
    act(() => tree.unmount());
  });

  it('52. lets the rainbow frequency go past 360, because the firmware does', async () => {
    const {tree} = await mount({rainbowFreq: 400});
    openSection(tree, 'RUNTIME');
    expect(stepperValue(tree, 'led-runtime-rainbowFreq')).toBe('400');
    step(tree, 'led-runtime-rainbowFreq', 'up');
    expect(stepperValue(tree, 'led-runtime-rainbowFreq')).toBe('401');
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 53-60. SAVING
 * ================================================================== */

describe('saving', () => {
  it('53. hides the save bar while nothing has changed', async () => {
    const {tree} = await mount();
    expect(saveBar(tree).visible).toBe(false);
    act(() => tree.unmount());
  });

  it('54. names each dirty group on the save bar', async () => {
    const {tree} = await mount();
    press(tree, 'led-cell-2-1');
    press(tree, 'led-color-6');
    openSection(tree, 'RUNTIME');
    step(tree, 'led-runtime-brightness', 'up');
    /* The save surface is OUTSIDE the section switch, so it still carries
       the layout change made in a different section. */
    const bar = saveBar(tree);
    expect(bar.visible).toBe(true);
    expect(bar.details).toContain(L.save.group.ENTRIES);
    expect(bar.details).toContain(L.save.group.RUNTIME_VALUES);
    act(() => tree.unmount());
  });

  it('55. a save writes, reads back, persists ONCE and never reboots', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-cell-2-1');
    press(tree, 'led-color-6');
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(250);
    });
    expect(textOf(tree)).toContain(L.save.outcome.SAVE_VERIFIED);
    const counts = writeCounts(board);
    expect(counts.entries).toBeGreaterThan(0);
    expect(counts.eeprom).toBe(1);
    expect(counts.reboots).toBe(0);
    /* The persist is the LAST thing, after every readback. */
    const eepromAt = board.requests.findIndex(r => r.command === LED_CMD.EEPROM);
    const lastSetAt = board.requests
      .map(r => r.command)
      .lastIndexOf(LED_CMD.SET_STRIP_CONFIG);
    expect(eepromAt).toBeGreaterThan(lastSetAt);
    act(() => tree.unmount());
  });

  it('56. a verified save leaves the screen clean, with nothing left pending', async () => {
    const {tree} = await mount();
    press(tree, 'led-cell-2-1');
    press(tree, 'led-color-6');
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(250);
    });
    expect(saveBar(tree).visible).toBe(false);
    act(() => tree.unmount());
  });

  it('57. «تجاهل التغييرات» returns every group to what the board holds', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-cell-2-1');
    step(tree, 'led-x', 'up');
    openSection(tree, 'PALETTE');
    step(tree, 'led-palette-hue', 'up');
    expect(saveBar(tree).visible).toBe(true);
    press(tree, 'led-save-bar-discard');
    expect(saveBar(tree).visible).toBe(false);
    openSection(tree, 'LAYOUT');
    expect(cellOf(tree, 0)).toEqual({x: 2, y: 1});
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('58. a save the board would not persist is NOT reported as a success', async () => {
    const {tree, board} = await mount();
    board.injectFault({command: LED_CMD.EEPROM, fault: {kind: 'REMOTE_ERROR'}});
    press(tree, 'led-cell-2-1');
    press(tree, 'led-color-6');
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(400);
    });
    const text = textOf(tree);
    expect(text).toContain(L.save.outcome.APPLIED_NOT_PERSISTED);
    expect(text).not.toContain(L.save.outcome.SAVE_VERIFIED);
    act(() => tree.unmount());
  });

  it('59. a save that half-applied re-reads the board before anything else', async () => {
    const {tree, board} = await mount();
    /* TWO existing LEDs change, and the board refuses the second write.
       The first one has already landed, so this is genuinely a strip that
       is neither the old one nor the new one - the state the operator must
       be told about rather than shown a success for. */
    board.injectFault({
      command: LED_CMD.SET_STRIP_CONFIG,
      fault: {kind: 'REMOTE_ERROR'},
      entryIndex: 2,
    });
    press(tree, 'led-cell-2-1');
    press(tree, 'led-color-6');
    press(tree, 'led-cell-2-5');
    press(tree, 'led-color-6');
    const readsBefore = board.countOf(LED_CMD.STRIP_CONFIG);
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(400);
    });
    expect(textOf(tree)).toContain(L.save.outcome.PARTIAL_APPLY);
    expect(textOf(tree)).not.toContain(L.save.outcome.SAVE_VERIFIED);
    expect(board.countOf(LED_CMD.STRIP_CONFIG)).toBeGreaterThan(readsBefore);
    expect(writeCounts(board).eeprom).toBe(0);
    act(() => tree.unmount());
  });

  it('60. a standing blocker disables the save and says which one', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-append');
    const bar = saveBar(tree);
    expect(bar.visible).toBe(true);
    expect(bar.disabledReason).toBe(L.save.blocked.PENDING_LED_ENCODES_AS_TERMINATOR);
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(120);
    });
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 61-75. THE STATES THE FIRST PASS OF THIS MATRIX DID NOT COVER
 *
 * Every one of these is a §72 line item that had no test until the spec
 * was re-read against the delivery. They are the states an operator only
 * meets when something is wrong, which is exactly when a configurator
 * must not improvise.
 * ================================================================== */

describe('states that only appear when something is wrong', () => {
  it('61. §47 - a board reporting a value it would not accept is shown, not corrected', async () => {
    const {tree} = await mount({brightness: 0});
    openSection(tree, 'RUNTIME');
    /* Zero is real: the firmware stores it and the decoder returns it. The
       reference tab's `brightness || 50` would show a fabricated 50 here. */
    expect(stepperValue(tree, 'led-runtime-brightness')).toBe('0');
    expect(textOf(tree)).not.toContain('50');
    expect(has(tree, 'led-runtime-observed-brightness')).toBe(true);
    act(() => tree.unmount());
  });

  it('62. §47 - stepping out of that value lands INSIDE the writable range', async () => {
    const {tree, board} = await mount({brightness: 0});
    openSection(tree, 'RUNTIME');
    step(tree, 'led-runtime-brightness', 'up');
    /* Not 1. The firmware's write floor is 5, and `0 + 1` is a number the
       encoder throws a RangeError on - a crash instead of a sentence. */
    expect(stepperValue(tree, 'led-runtime-brightness')).toBe('5');
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('63. §47 - and that draft saves cleanly instead of throwing', async () => {
    const {tree, board} = await mount({brightness: 0});
    openSection(tree, 'RUNTIME');
    step(tree, 'led-runtime-brightness', 'up');
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(250);
    });
    expect(textOf(tree)).toContain(L.save.outcome.SAVE_VERIFIED);
    expect(writeCounts(board).runtimeValues).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('64. §72.5 - a board that claims the advanced build then refuses one of its reads', async () => {
    const board = makeBoard();
    board.injectFault({command: LED_CMD.COLORS, fault: {kind: 'REMOTE_ERROR'}});
    const session = new VirtualSession({
      sessionId: 'led-contradiction',
      board: board as never,
      apiMinor: 48,
    });
    const controller = new LedStripConfigurationController({
      coordinator: session.coordinator as never,
      appStateOwner: {getPhase: () => 'ACTIVE' as const},
    });
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <LedStripScreen
          sessionKey={session.key}
          active
          onOpenSetup={() => undefined}
          controller={controller}
        />,
      );
      await sleep(120);
    });
    expect(has(tree, 'led-capability-contradiction')).toBe(true);
    /* NOT an empty palette pretending to be the board's. */
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  }, 30000);

  it('65. §72.6 / §61 - a firmware newer than any pinned source is READ, and is read-only', async () => {
    const {tree} = await mount({}, 50);
    /* The controller decodes it through the newest layout it verified, so
       there IS data - the strip renders. What it does not offer is a Save. */
    expect(nodeNumbers(tree)).toEqual([1, 2, 3, 4]);
    expect(has(tree, 'led-read-only')).toBe(true);
    expect(has(tree, 'led-read-only-badge')).toBe(true);
    expect(textIn(tree, 'led-read-only')).toContain(L.readOnlyBadge);
    expect(textIn(tree, 'led-read-only')).toContain(L.blocked.futureApiReadOnly);
    act(() => tree.unmount());
  });

  it('65b. §61 - and no edit or save is reachable on that surface', async () => {
    const {tree, board} = await mount({}, 50);
    /* Every control is inert, and the save bar never appears however hard
       the grid is pressed. */
    press(tree, 'led-cell-2-1');
    expect(pressable(tree, 'led-append').disabled).toBe(true);
    expect(saveBar(tree).visible).toBe(false);
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('66. §58 / §72.47-49 - an observed gap names the count and the unreachable LEDs', async () => {
    /* index 1 is empty, so index 2 is configured and invisible. */
    const gapped = [FOUR[0], 0, FOUR[2], FOUR[3]];
    const {tree, board} = await mount({entries: gapped});
    expect(has(tree, 'led-observed-gap')).toBe(true);
    const card = textIn(tree, 'led-observed-gap');
    expect(card).toContain(L.gap.title);
    expect(card).toContain(L.gap.explain);
    expect(has(tree, 'led-gap-effective')).toBe(true);
    expect(has(tree, 'led-gap-unreachable')).toBe(true);
    /* One LED is reachable; LEDs 3 and 4 are not. */
    expect(textIn(tree, 'led-gap-effective')).toContain('1');
    expect(textIn(tree, 'led-gap-unreachable')).toContain('3');
    expect(textIn(tree, 'led-gap-unreachable')).toContain('4');
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('67. §58 - and it is not auto-repaired or compacted away', async () => {
    const gapped = [FOUR[0], 0, FOUR[2], FOUR[3]];
    const {tree, board} = await mount({entries: gapped});
    /* The board still holds exactly what it held. No silent compaction. */
    expect(writeCounts(board)).toEqual(NO_WRITES);
    press(tree, 'led-cell-2-1');
    press(tree, 'led-color-6');
    expect(saveBar(tree).disabledReason).toBe(L.save.blocked.OBSERVED_STRIP_HAS_GAP);
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(150);
    });
    expect(writeCounts(board)).toEqual(NO_WRITES);
    act(() => tree.unmount());
  });

  it('68. §72.54 - someone else re-ordered the strip while it was being edited', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-cell-2-1');
    press(tree, 'led-color-6');
    board.externallySetEntry(1, led({x: 9, y: 9, color: 11}));
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(300);
    });
    expect(textOf(tree)).toContain(L.save.outcome.REFUSED);
    expect(textOf(tree)).not.toContain(L.save.outcome.SAVE_VERIFIED);
    /* Refused BEFORE writing: no entry SET, no persist. */
    expect(writeCounts(board).entries).toBe(0);
    expect(writeCounts(board).eeprom).toBe(0);
    act(() => tree.unmount());
  });

  it('69. §72.55 - the same palette slot changed on the board mid-edit', async () => {
    const {tree, board} = await mount();
    openSection(tree, 'PALETTE');
    step(tree, 'led-palette-hue', 'up');
    board.externallySetPaletteSlot(0, {hue: 300, whiteness: 4, value: 9});
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(300);
    });
    expect(textOf(tree)).toContain(L.save.outcome.REFUSED);
    expect(textOf(tree)).toContain(L.save.refusal.STALE_PALETTE_SLOT);
    expect(writeCounts(board).palette).toBe(0);
    act(() => tree.unmount());
  });

  it('70. §72.56 - a mode colour changed on the board mid-edit', async () => {
    const {tree, board} = await mount();
    openSection(tree, 'MODE_COLORS');
    press(tree, 'led-mode-0-0-current');
    press(tree, 'led-mode-0-0-picker-9');
    board.externallySetTuple(0, 0, 13);
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(300);
    });
    expect(textOf(tree)).toContain(L.save.outcome.REFUSED);
    expect(textOf(tree)).toContain(L.save.refusal.STALE_MODE_COLOR);
    expect(writeCounts(board).modeColors).toBe(0);
    act(() => tree.unmount());
  });

  it('71. §72.57 - a runtime value changed on the board mid-edit', async () => {
    const {tree, board} = await mount();
    openSection(tree, 'RUNTIME');
    step(tree, 'led-runtime-rainbowFreq', 'up');
    board.externallySetValues({rainbowFreq: 777});
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(300);
    });
    expect(textOf(tree)).toContain(L.save.outcome.REFUSED);
    expect(textOf(tree)).toContain(L.save.refusal.STALE_RUNTIME_VALUE);
    expect(writeCounts(board).runtimeValues).toBe(0);
    act(() => tree.unmount());
  });

  it('72. §49 / §72.58-60 - a save touches no feature mask and no reboot', async () => {
    const {tree, board} = await mount();
    press(tree, 'led-cell-2-1');
    press(tree, 'led-color-6');
    await act(async () => {
      press(tree, 'led-save-bar-save');
      await sleep(300);
    });
    expect(textOf(tree)).toContain(L.save.outcome.SAVE_VERIFIED);
    /* MSP_FEATURE_CONFIG / MSP_SET_FEATURE_CONFIG are 36 and 37. This
       screen is not a second owner of feature bit 16, so neither number
       may appear anywhere in the transcript. */
    const commands = board.requests.map(r => r.command);
    expect(commands).not.toContain(36);
    expect(commands).not.toContain(37);
    expect(writeCounts(board).reboots).toBe(0);
    act(() => tree.unmount());
  });

  it('73. §9/§27/§44/§62 - the technical disclosure carries what the primary surface will not', async () => {
    const {tree} = await mount({entries: [EXOTIC], profile: 2});
    press(tree, 'led-cell-9-9');
    expect(has(tree, 'led-technical-body')).toBe(false);
    press(tree, 'led-technical-toggle');
    const body = textIn(tree, 'led-technical-body');
    /* LED 1 is raw index 0, and the disclosure is where that is said. */
    expect(body).toContain('0');
    expect(has(tree, 'led-technical-wire-index')).toBe(true);
    expect(has(tree, 'led-technical-symbol')).toBe(true);
    expect(has(tree, 'led-technical-raw')).toBe(true);
    expect(has(tree, 'led-technical-profile')).toBe(true);
    expect(has(tree, 'led-technical-special-slots')).toBe(true);
    /* §44: the three unnamed slots are listed by number, never renamed. */
    expect(textIn(tree, 'led-technical-special-slots')).toContain('8');
    expect(textIn(tree, 'led-technical-special-slots')).toContain('10');
    act(() => tree.unmount());
  });

  it('74. §34/§35 - an effect that depends on wire order or geometry says so', async () => {
    /* A thrust ring walks the chain in WIRE ORDER; a flight-mode LED reads
       its own X/Y against every other LED's extent. Two different
       couplings, two different sentences. */
    const ring = led({x: 4, y: 4, fn: LedBaseFunction.THRUST_RING});
    const mode = led({x: 10, y: 10, fn: LedBaseFunction.FLIGHT_MODE});
    const {tree} = await mount({entries: [ring, mode]});

    press(tree, 'led-cell-4-4');
    expect(textIn(tree, 'led-inspector')).toContain(L.effect.ordinalDependent);
    expect(textIn(tree, 'led-inspector')).not.toContain(L.effect.geometryDependent);
    /* And the wiring-order editor repeats the ordinal one where the order
       is actually being changed. */
    expect(has(tree, 'led-order-ordinal-note')).toBe(true);

    press(tree, 'led-cell-10-10');
    expect(textIn(tree, 'led-inspector')).toContain(L.effect.geometryDependent);
    expect(textIn(tree, 'led-inspector')).not.toContain(L.effect.ordinalDependent);

    /* A plain colour LED is coupled to nothing and says nothing. */
    const plain = await mount({entries: [led({x: 3, y: 3})]});
    press(plain.tree, 'led-cell-3-3');
    expect(textIn(plain.tree, 'led-inspector')).not.toContain(L.effect.ordinalDependent);
    expect(textIn(plain.tree, 'led-inspector')).not.toContain(L.effect.geometryDependent);
    act(() => plain.tree.unmount());
    act(() => tree.unmount());
  });

  it('75. §40 - a basic board names the colour INDEX and invents no swatch', async () => {
    const {tree} = await mount({advancedRaw: 0});
    press(tree, 'led-cell-2-1');
    expect(has(tree, 'led-color-index-only')).toBe(true);
    expect(textIn(tree, 'led-inspector')).toContain(L.palette.indexOnlyHelp);
    act(() => tree.unmount());
  });
});
