/**
 * THE GRID IS AN AIRCRAFT, NOT A PARAGRAPH.
 *
 * X=0 IS THE AIRCRAFT'S LEFT AND Y=0 IS ITS NOSE, and the text direction
 * must not reach either. Mirroring this diagram under RTL would turn
 * "front-left" into "front-right" on a machine that is about to fly, and
 * an operator who wired the strip from the nose would be told their LEDs
 * are on the other side of the airframe.
 *
 * The proof is in three layers, because a rendered comparison alone can
 * pass by accident:
 *
 *   1. SOURCE. The canvas names no direction-aware API at all - no
 *      `isRtlLayout`, no `flexDirection`, and none of the logical
 *      `start`/`end` insets that a layout engine mirrors.
 *   2. ARITHMETIC. `ledCellLeft`/`ledCellTop` are pure and asserted
 *      directly, so the numbers are checked without a renderer.
 *   3. RENDER. The same strip is mounted with the layout reported as RTL
 *      and again as LTR, and every cell's resolved position is compared.
 *
 * NOTHING ON THIS SCREEN ANIMATES, and the last block asserts that too.
 * The board reports no LED output over MSP, so an animated preview would
 * be this app inventing motion it cannot observe.
 */

import React from 'react';
import {readFileSync} from 'fs';
import {join} from 'path';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import {
  LedGridCanvas,
  LED_CELL_SIZE,
  LED_GRID_EXTENT,
  LED_GRID_SPAN,
  ledCellKey,
  ledCellLeft,
  ledCellTop,
} from '../led/LedGridCanvas';
import {
  decodeLedEntry,
  encodeLedEntry,
  LedBaseFunction,
  LedDirectionBit,
} from '../../core/protocol/msp/decoding/ledStripWireContract';
import {ledDraftNodes, createLedStripDraft} from '../../core/state/ledStripDraft';
import type {LedDraftNode} from '../../core/state/ledStripDraft';

const REPO_ROOT = join(__dirname, '..', '..', '..');

let mockRtl = true;
jest.mock('../icons/layoutDirection', () => ({
  isRtlLayout: () => mockRtl,
}));

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/* ------------------------------------------------------------------ *
 * A STRIP WITH AN UNAMBIGUOUS HANDEDNESS
 *
 * One LED hard against the left edge and one hard against the right. If
 * anything mirrors, these two swap and the test says so.
 * ------------------------------------------------------------------ */

const word = (x: number, y: number, color: number): number =>
  encodeLedEntry({
    x,
    y,
    baseFunction: LedBaseFunction.COLOR,
    overlayMask: 0,
    colorIndex: color,
    /* eslint-disable-next-line no-bitwise -- one firmware direction bit. */
    directionMask: 1 << LedDirectionBit.NORTH,
  });

const HANDED: readonly number[] = Object.freeze([
  word(0, 0, 1), // front-LEFT corner
  word(15, 0, 2), // front-RIGHT corner
  word(0, 15, 3), // rear-left
  word(15, 15, 4), // rear-right
]);

function nodesOf(words: readonly number[]): readonly LedDraftNode[] {
  const padded = Array.from({length: 32}, (_unused, i) => words[i] ?? 0);
  return ledDraftNodes(
    createLedStripDraft({
      maxLength: 32,
      entries: padded.map((raw, index) => decodeLedEntry(raw, index)),
      capability: 'ADVANCED_STATUS_MODE',
      palette: undefined,
      modeColors: undefined,
      runtimeValues: {brightness: 50, rainbowDelta: 0, rainbowFreq: 120},
    }),
  );
}

function renderGrid(rtl: boolean): ReactTestRenderer.ReactTestRenderer {
  mockRtl = rtl;
  const nodes = nodesOf(HANDED);
  const clusters = new Map<string, readonly number[]>(
    nodes.map(node => [ledCellKey(node.x, node.y), [node.index]]),
  );
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <LedGridCanvas
        nodes={nodes}
        clusters={clusters}
        selection={[]}
        palette={undefined}
        onSelectCell={() => undefined}
        onEmptyCell={() => undefined}
        frontLabel="front"
        rearLabel="rear"
        leftLabel="left"
        rightLabel="right"
        describeCell={(x, y) => `${x},${y}`}
      />,
    );
  });
  return tree;
}

/** The flattened style of one cell, as the renderer resolved it. */
function cellStyle(
  tree: ReactTestRenderer.ReactTestRenderer,
  x: number,
  y: number,
): Record<string, unknown> {
  const node = tree.root
    .findAllByProps({testID: `led-cell-${x}-${y}`})
    .find(candidate => typeof candidate.props.onPress === 'function');
  if (node === undefined) throw new Error(`No cell ${x},${y}`);
  const flatten = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    if (style !== null && typeof style === 'object') return style as Record<string, unknown>;
    return {};
  };
  return flatten(node.props.style);
}

/** Which cell an LED number ended up in. */
function cellOf(tree: ReactTestRenderer.ReactTestRenderer, index: number): string {
  for (let y = 0; y < LED_GRID_SPAN; y++) {
    for (let x = 0; x < LED_GRID_SPAN; x++) {
      const cell = tree.root
        .findAllByProps({testID: `led-cell-${x}-${y}`})
        .find(c => typeof c.props.onPress === 'function');
      if (cell !== undefined && cell.findAllByProps({testID: `led-node-${index}`}).length > 0) {
        return `${x}:${y}`;
      }
    }
  }
  throw new Error(`LED ${index} not drawn`);
}

/* ================================================================== *
 * 1. SOURCE - the canvas names nothing the layout engine can mirror
 * ================================================================== */

describe('the canvas cannot be reached by the layout direction', () => {
  const source = readFileSync(
    join(REPO_ROOT, 'src', 'ui', 'led', 'LedGridCanvas.tsx'),
    'utf8',
  );

  /** Code only: a comment mentioning `flexDirection` is not a layout. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('scans the real file, so the check is not vacuous', () => {
    expect(source).toContain('LedGridCanvas');
    expect(code.length).toBeGreaterThan(1000);
  });

  it('never asks which way the layout runs', () => {
    expect(code).not.toContain('isRtlLayout');
    expect(code).not.toContain('I18nManager');
  });

  it('places cells with the PHYSICAL insets, never the logical ones', () => {
    /* `start`/`end` are the two React Native mirrors under RTL. The cell
       positions use `left`/`top`, which neither platform flips. */
    expect(code).toMatch(/left:\s*ledCellLeft\(x\)/);
    expect(code).toMatch(/top:\s*ledCellTop\(y\)/);
    expect(code).not.toMatch(/\bstart:/);
    expect(code).not.toMatch(/\bend:/);
    expect(code).not.toMatch(/marginStart|marginEnd|paddingStart|paddingEnd/);
  });

  it('pins the scrolling viewport to LTR, so it opens on the aircraft LEFT', () => {
    /* A horizontal scroller inherits the layout direction, and under RTL
       that puts its scroll ORIGIN at the right - which showed the
       aircraft's right-hand side first and left LED 1 at x=2 off-screen.
       The constant is hard-coded, never derived from the locale. */
    expect(code).toMatch(/viewport:\s*\{[^}]*direction:\s*'ltr'/s);
  });

  it('does not lay the cells out in a flex row, which WOULD mirror', () => {
    /* The two `flexDirection: 'row'` uses left in the file are the front
       marker and nothing that positions a cell; the canvas itself is a
       plain box the cells are absolutely placed inside. */
    expect(code).toMatch(/position:\s*'absolute'/);
    const canvasBlock = code.slice(code.indexOf('canvas: {'), code.indexOf('cell: {'));
    expect(canvasBlock).not.toContain('flexDirection');
  });
});

/* ================================================================== *
 * 2. ARITHMETIC
 * ================================================================== */

describe('the cell arithmetic', () => {
  it('puts X=0 hard against the left edge', () => {
    expect(ledCellLeft(0)).toBe(0);
  });

  it('puts X=15 at the far right of the canvas', () => {
    expect(ledCellLeft(15)).toBe(LED_GRID_EXTENT - LED_CELL_SIZE);
    expect(ledCellLeft(15)).toBe(660);
  });

  it('puts Y=0 at the top, which is the nose', () => {
    expect(ledCellTop(0)).toBe(0);
  });

  it('puts Y=15 at the bottom, which is the tail', () => {
    expect(ledCellTop(15)).toBe(LED_GRID_EXTENT - LED_CELL_SIZE);
  });

  it('increases monotonically with the coordinate, so nothing is reversed', () => {
    for (let i = 1; i < LED_GRID_SPAN; i++) {
      expect(ledCellLeft(i)).toBeGreaterThan(ledCellLeft(i - 1));
      expect(ledCellTop(i)).toBeGreaterThan(ledCellTop(i - 1));
    }
  });

  it('keeps every cell at least the minimum touch target', () => {
    expect(LED_CELL_SIZE).toBeGreaterThanOrEqual(44);
  });
});

/* ================================================================== *
 * 3. RENDER - identical under both layout directions
 * ================================================================== */

describe('the rendered grid is identical in RTL and in LTR', () => {
  it('gives every one of the 256 cells the same position in both', () => {
    const rtl = renderGrid(true);
    const positions: Record<string, unknown> = {};
    for (let y = 0; y < LED_GRID_SPAN; y++) {
      for (let x = 0; x < LED_GRID_SPAN; x++) {
        const style = cellStyle(rtl, x, y);
        positions[`${x}:${y}`] = {left: style.left, top: style.top};
      }
    }
    act(() => rtl.unmount());

    const ltr = renderGrid(false);
    for (let y = 0; y < LED_GRID_SPAN; y++) {
      for (let x = 0; x < LED_GRID_SPAN; x++) {
        const style = cellStyle(ltr, x, y);
        expect({left: style.left, top: style.top}).toEqual(positions[`${x}:${y}`]);
      }
    }
    act(() => ltr.unmount());
  });

  it('keeps the front-left LED front-left in both, and never swaps it with front-right', () => {
    for (const rtl of [true, false]) {
      const tree = renderGrid(rtl);
      /* LED 1 was authored at x=0 (aircraft left) and LED 2 at x=15. */
      expect(cellOf(tree, 0)).toBe('0:0');
      expect(cellOf(tree, 1)).toBe('15:0');
      expect(cellOf(tree, 2)).toBe('0:15');
      expect(cellOf(tree, 3)).toBe('15:15');
      act(() => tree.unmount());
    }
  });

  it('draws the same canvas box in both', () => {
    for (const rtl of [true, false]) {
      const tree = renderGrid(rtl);
      const canvas = tree.root.findAllByProps({testID: 'led-grid-canvas'})[0];
      const style = Array.isArray(canvas.props.style)
        ? Object.assign({}, ...canvas.props.style)
        : canvas.props.style;
      expect(style.width).toBe(LED_GRID_EXTENT);
      expect(style.height).toBe(LED_GRID_EXTENT);
      act(() => tree.unmount());
    }
  });
});

/* ================================================================== *
 * 4. NOTHING ANIMATES
 * ================================================================== */

describe('the LED surfaces run no animation and no clock', () => {
  const FILES = [
    join(REPO_ROOT, 'src', 'ui', 'led', 'LedGridCanvas.tsx'),
    join(REPO_ROOT, 'src', 'ui', 'led', 'ledColorPresentation.ts'),
    join(REPO_ROOT, 'src', 'ui', 'screens', 'LedStripScreen.tsx'),
  ];

  it.each(FILES.map(file => [file.slice(REPO_ROOT.length + 1), file] as const))(
    '%s',
    (_name, file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code.length).toBeGreaterThan(200);
      /* An animated "preview" would be motion this app never observed:
         the firmware reports no LED output over MSP at all. */
      expect(code).not.toContain('Animated');
      expect(code).not.toContain('useAnimatedValue');
      expect(code).not.toContain('requestAnimationFrame');
      expect(code).not.toContain('setInterval');
      expect(code).not.toContain('setTimeout');
      expect(code).not.toContain('LayoutAnimation');
    },
  );
});
