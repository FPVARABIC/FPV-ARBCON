/**
 * FIVE WIDTHS, AND THE PAGE NEVER SCROLLS SIDEWAYS.
 *
 * The LED canvas is 704 units across - sixteen columns at the 44-unit
 * minimum touch target - which is wider than a phone. That is not a reason
 * to shrink the cells below a fingertip; it is a reason to bound the canvas
 * inside its OWN scroller so the page around it stays still. A page that
 * scrolls horizontally on a phone puts the save bar, the inspector and the
 * section headings somewhere the operator has to go looking for them.
 *
 * The assertion is structural rather than pixel-measured: every fixed width
 * in the rendered tree is either inside the grid's scroll viewport, or it
 * fits the viewport. Anything else is an element that would push the page.
 *
 * THE TWO-PANEL WORKSPACE PUTS THE GRID ON THE LEFT IN BOTH DIRECTIONS,
 * which needs the direction chosen explicitly: under RTL a plain flex row
 * starts at the right, so the diagram of an aircraft would swap sides with
 * the inspector purely because the text runs the other way.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import LedStripScreen from './LedStripScreen';
import {LedStripConfigurationController} from '../../platforms/react-native/protocol/LedStripConfigurationController';
import {VirtualSession} from '../../platforms/react-native/protocol/__testUtils__/virtualSession';
import {VirtualLedBoard} from '../../platforms/react-native/protocol/__testUtils__/virtualLedBoard';
import {
  encodeLedEntry,
  LedBaseFunction,
  LedDirectionBit,
} from '../../core/protocol/msp/decoding/ledStripWireContract';
import {LED_GRID_EXTENT} from '../led/LedGridCanvas';

let mockRtl = true;
jest.mock('../icons/layoutDirection', () => ({
  isRtlLayout: () => mockRtl,
}));

let mockWidth = 390;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({width: mockWidth, height: 900, scale: 2, fontScale: 1}),
}));

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/** The five widths under review: phone, tablet, small desktop, laptop and
 *  a large monitor. */
const WIDTHS = [390, 768, 1024, 1366, 1920] as const;

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

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

async function mountAt(
  width: number,
  rtl = true,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  mockWidth = width;
  mockRtl = rtl;
  const board = new VirtualLedBoard({
    maxLength: 32,
    advancedRaw: 1,
    profile: 0,
    entries: [word(0, 0, 1), word(15, 0, 2), word(8, 8, 3)],
  });
  const session = new VirtualSession({
    sessionId: `led-${width}`,
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
    await sleep(60);
  });
  await act(async () => {
    await sleep(40);
  });
  return tree;
}

type Json = ReturnType<ReactTestRenderer.ReactTestRenderer['toJSON']>;

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  if (style !== null && typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

/**
 * Every fixed numeric width in the tree that is NOT inside the grid's own
 * scroll viewport, paired with the testID of the nearest labelled ancestor
 * so a failure names the element rather than a number.
 */
function widthsOutsideTheGrid(node: Json, inViewport = false): number[] {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(child => widthsOutsideTheGrid(child, inViewport));
  const props = (node.props ?? {}) as Record<string, unknown>;
  const nowInside = inViewport || props.testID === 'led-grid-viewport';
  const found: number[] = [];
  if (!nowInside) {
    const style = flatten(props.style);
    if (typeof style.width === 'number') found.push(style.width);
    if (typeof style.minWidth === 'number') found.push(style.minWidth);
  }
  const children = (node.children ?? []) as Json[];
  return found.concat(
    children.flatMap(child => widthsOutsideTheGrid(child, nowInside)),
  );
}

/**
 * The DISTINCT horizontal scrollers in the tree, by testID.
 *
 * One `<ScrollView horizontal>` appears several times in a test tree - the
 * composite element and the host views it renders all carry the prop - so
 * the set, not the count, is what "only one thing scrolls sideways" means.
 */
function horizontalScrollers(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const ids = tree.root
    .findAll(node => node.props?.horizontal === true, {deep: true})
    .map(node => String(node.props.testID ?? '<unnamed>'));
  return [...new Set(ids)].sort();
}

function workspaceDirection(
  tree: ReactTestRenderer.ReactTestRenderer,
): string | undefined {
  const grid = tree.root.findAllByProps({testID: 'led-grid-viewport'})[0];
  let node = grid.parent;
  while (node !== null && node !== undefined) {
    const style = flatten(node.props?.style);
    if (typeof style.flexDirection === 'string') return style.flexDirection;
    node = node.parent;
  }
  return undefined;
}

/* ================================================================== *
 * NO HORIZONTAL OVERFLOW
 * ================================================================== */

describe('zero horizontal page overflow', () => {
  it.each(WIDTHS.map(width => [width] as const))(
    'at %ipx, nothing outside the grid viewport is wider than the window',
    async width => {
      const tree = await mountAt(width);
      const offenders = widthsOutsideTheGrid(tree.toJSON()).filter(w => w > width);
      expect(offenders).toEqual([]);
      act(() => tree.unmount());
    },
    30000,
  );

  it.each(WIDTHS.map(width => [width] as const))(
    'at %ipx, the grid viewport is the ONLY thing that scrolls sideways',
    async width => {
      const tree = await mountAt(width);
      expect(horizontalScrollers(tree)).toEqual(['led-grid-viewport']);
      act(() => tree.unmount());
    },
    30000,
  );

  it('keeps the full 16-column canvas at every width rather than shrinking the cells', async () => {
    for (const width of WIDTHS) {
      const tree = await mountAt(width);
      const canvas = tree.root.findAllByProps({testID: 'led-grid-canvas'})[0];
      expect(flatten(canvas.props.style).width).toBe(LED_GRID_EXTENT);
      act(() => tree.unmount());
    }
  }, 60000);
});

/* ================================================================== *
 * THE WORKSPACE
 * ================================================================== */

describe('the two-panel workspace', () => {
  it('stacks on a phone, where two columns would leave neither usable', async () => {
    const tree = await mountAt(390);
    expect(workspaceDirection(tree)).toBeUndefined();
    act(() => tree.unmount());
  }, 30000);

  it.each([768, 1024, 1366, 1920].map(width => [width] as const))(
    'at %ipx, puts the grid on the aircraft-left side under RTL',
    async width => {
      const tree = await mountAt(width, true);
      /* Under RTL a plain `row` starts at the RIGHT, so the grid - which
         is the first child - would land on the wrong side. `row-reverse`
         is what keeps the diagram on the left in an Arabic layout. */
      expect(workspaceDirection(tree)).toBe('row-reverse');
      act(() => tree.unmount());
    },
    30000,
  );

  it('puts the grid on the same physical side when the layout runs LTR', async () => {
    const tree = await mountAt(1366, false);
    expect(workspaceDirection(tree)).toBe('row');
    act(() => tree.unmount());
  }, 30000);
});

/* ================================================================== *
 * EVERY SECTION IS REACHABLE AT EVERY WIDTH
 * ================================================================== */

describe('the four sections are ONE page at every width', () => {
  it.each(WIDTHS.map(width => [width] as const))(
    'at %ipx, all four are reachable from one segmented control',
    async width => {
      const tree = await mountAt(width);
      /* §5: one LED page, four sections, a compact segmented control - not
         four independent screens. Every tab is present at every width, and
         the save surface below is outside the switch. */
      expect(tree.root.findAllByProps({testID: 'led-section-nav'}).length).toBeGreaterThan(0);
      for (const key of ['LAYOUT', 'PALETTE', 'MODE_COLORS', 'RUNTIME'] as const) {
        expect(
          tree.root.findAllByProps({testID: `led-section-tab-${key}`}).length,
        ).toBeGreaterThan(0);
      }
      expect(tree.root.findAllByProps({testID: 'led-save-bar'}).length).toBeGreaterThan(0);
      act(() => tree.unmount());
    },
    30000,
  );

  it.each(
    (['LAYOUT', 'PALETTE', 'MODE_COLORS', 'RUNTIME'] as const).map(k => [k] as const),
  )('%s opens its own section and only that one', async key => {
    const tree = await mountAt(1366);
    const tab = tree.root
      .findAllByProps({testID: `led-section-tab-${key}`})
      .find(node => typeof node.props.onPress === 'function');
    act(() => tab?.props.onPress());
    const testIDs = {
      LAYOUT: 'led-section-layout',
      PALETTE: 'led-section-palette',
      MODE_COLORS: 'led-section-modes',
      RUNTIME: 'led-section-runtime',
    } as const;
    for (const [other, id] of Object.entries(testIDs)) {
      const present = tree.root.findAllByProps({testID: id}).length > 0;
      expect(present).toBe(other === key);
    }
    act(() => tree.unmount());
  }, 30000);
});

/* ================================================================== *
 * THE LAYER PRIORITY LIST READS AS ONE COLUMN
 *
 * Found by looking at a screenshot, not by a test. Without an explicit
 * alignment every row picks its own paragraph direction from its first
 * STRONG character, so "1. تحذير" aligned to the reading edge while
 * "2. RSSI", "4. GPS" and "5. VTX" - whose labels are Latin acronyms
 * the firmware itself uses - jumped to the opposite margin. An ordered
 * list split across two edges cannot be read as an order, and the order
 * IS the content of that card.
 * ================================================================== */

describe('the layer priority list', () => {
  it('pins every row to the same edge, Latin-labelled ones included', async () => {
    const tree = await mountAt(1366);
    /* The card lives in the RUNTIME section, so open it the way an
       operator does rather than reaching past the navigation. */
    const tab = tree.root
      .findAllByProps({testID: 'led-section-tab-RUNTIME'})
      .find(node => typeof node.props.onPress === 'function');
    act(() => tab?.props.onPress());

    const rows = tree.root.findAll(
      node =>
        typeof node.props?.testID === 'string' &&
        /^led-layer-[A-Z_]+$/.test(node.props.testID),
    );
    const byId = new Map<string, unknown>();
    for (const row of rows) {
      const id = row.props.testID as string;
      if (byId.has(id)) continue;
      const flat = ([] as unknown[]).concat(row.props.style).filter(Boolean);
      byId.set(
        id,
        flat.map(x => (x as {textAlign?: string}).textAlign).find(a => a !== undefined),
      );
    }
    /* The runtime layer table has ten entries; five would already be
       enough to catch the split, but a vacuous pass must be impossible. */
    expect(byId.size).toBeGreaterThanOrEqual(5);
    /* ONE alignment across every row, explicitly set - NOT left to the
       per-row bidi default, which is what split the list in the first
       place. */
    const alignments = new Set(byId.values());
    expect(alignments.size).toBe(1);
    expect([...alignments][0]).toBe('right');
    act(() => tree.unmount());
  }, 30000);
});
