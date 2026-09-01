/**
 * @jest-environment jsdom
 *
 * THE BROWSER PATH. Same screen, same state model, react-native-web
 * underneath - so what is proven here is that the web pointer path drives
 * exactly the state the Android touch path drives (test 25 of the brief),
 * and that the browser-specific ways a drag can go wrong are closed:
 * the page must not pan under the finger, the photograph must never
 * become the gesture's target, text must not be selected by a drag, and a
 * window that loses focus must not leave an element stuck to the pointer.
 */

jest.mock('react-native', () => jest.requireActual('react-native-web'));

import {readFileSync} from 'fs';
import path from 'path';

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import {osdPositionX, osdPositionY, type MspOsdSnapshot} from '../../core';
import OsdScreen, {type OsdControllerPort} from './OsdScreen';

const SNAPSHOT: MspOsdSnapshot = {
  canvas: {columns: 53, rows: 20},
  config: {
    flags: 1,
    videoSystem: 3,
    units: 1,
    rssiAlarmPercent: 30,
    capacityAlarmMah: 1400,
    altitudeAlarm: 120,
    elementPositions: [0x0805, 0x0826],
    statistics: [true],
    timers: [0x0a21],
    warningCount: 2,
    enabledWarnings: 1,
    profileCount: 3,
    selectedProfile: 1,
    overlayRadioMode: 0,
    cameraFrameWidth: 24,
    cameraFrameHeight: 11,
    linkQualityAlarmPercent: 70,
    rssiDbmAlarm: -95,
  },
};

const CELL = 20;
const BOX = {width: 1060, height: 400};
type Renderer = ReactTestRenderer.ReactTestRenderer;

function touchHistory(x: number, y: number, timeStamp: number) {
  const touch = {
    touchActive: true,
    startPageX: x,
    startPageY: y,
    startTimeStamp: timeStamp,
    currentPageX: x,
    currentPageY: y,
    currentTimeStamp: timeStamp,
    previousPageX: x,
    previousPageY: y,
    previousTimeStamp: timeStamp,
  };
  return {
    touchBank: [touch],
    numberActiveTouches: 1,
    indexOfSingleActiveTouch: 0,
    mostRecentTimeStamp: timeStamp,
  };
}

function gesture(x: number, y: number, timeStamp = 1) {
  return {
    nativeEvent: {
      locationX: x,
      locationY: y,
      pageX: x,
      pageY: y,
      identifier: 1,
      target: 1,
      timestamp: timeStamp,
      touches: [{identifier: 1, pageX: x, pageY: y, locationX: x, locationY: y}],
      changedTouches: [],
    },
    touchHistory: touchHistory(x, y, timeStamp),
    persist: () => undefined,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as never;
}

const canvasOf = (renderer: Renderer) => renderer.root.findByProps({testID: 'osd-canvas'});

function positionOf(renderer: Renderer, index: number) {
  const label = renderer.root.findByProps({testID: `osd-element-${index}-position`});
  const parts = (label.props.children as readonly unknown[]).map(String).join('');
  const match = /^(\d+),(\d+)$/.exec(parts);
  if (match === null) throw new Error(`no position for ${index}`);
  return {column: Number(match[1]), row: Number(match[2])};
}

function flatten(style: unknown): Record<string, unknown> {
  return Array.isArray(style)
    ? Object.assign({}, ...style.filter(Boolean).map(flatten))
    : ((style ?? {}) as Record<string, unknown>);
}

async function renderScreen(save?: OsdControllerPort['save']) {
  const controller: OsdControllerPort = {
    load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: SNAPSHOT})),
    save: save ?? jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: SNAPSHOT})),
  };
  let renderer!: Renderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <OsdScreen sessionKey={{sessionId: 'fc', generation: 3}} active controller={controller} />,
    );
    await Promise.resolve();
  });
  act(() => {
    canvasOf(renderer).props.onLayout({
      nativeEvent: {layout: {x: 0, y: 0, width: BOX.width, height: BOX.height}},
    });
  });
  return {renderer, controller};
}

describe('the browser pointer path drives the same OSD state', () => {
  it('drags an element to a new cell exactly as the native path does', async () => {
    const {renderer} = await renderScreen();

    expect(positionOf(renderer, 0)).toEqual({column: 5, row: 0});
    act(() => {
      canvasOf(renderer).props.onStartShouldSetResponder(gesture(5 * CELL + 4, 4, 1));
      canvasOf(renderer).props.onResponderGrant(gesture(5 * CELL + 4, 4, 1));
    });
    act(() => {
      canvasOf(renderer).props.onResponderMove(gesture(24 * CELL + 4, 6 * CELL + 4, 2));
    });
    act(() => {
      canvasOf(renderer).props.onResponderRelease(gesture(24 * CELL + 4, 6 * CELL + 4, 3));
    });

    expect(positionOf(renderer, 0)).toEqual({column: 24, row: 6});
    act(() => renderer.unmount());
  });

  it('a window that loses focus cannot leave an element stuck to the pointer', async () => {
    const {renderer} = await renderScreen();

    act(() => {
      canvasOf(renderer).props.onResponderGrant(gesture(5 * CELL + 4, 4, 1));
    });
    act(() => {
      canvasOf(renderer).props.onResponderMove(gesture(11 * CELL + 4, 4, 2));
    });
    expect(positionOf(renderer, 0)).toEqual({column: 11, row: 0});

    // Alt-tab: the browser may never deliver a cancel.
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    act(() => {
      canvasOf(renderer).props.onResponderMove(gesture(40 * CELL + 4, 12 * CELL, 3));
    });

    expect(positionOf(renderer, 0)).toEqual({column: 11, row: 0});
    act(() => renderer.unmount());
  });

  it('tells the browser not to pan the page or select text during a drag', async () => {
    const {renderer} = await renderScreen();
    const style = flatten(canvasOf(renderer).props.style);

    // Without touch-action the browser starts scrolling before React ever
    // sees the move, and the element is dropped mid-gesture.
    expect(style.touchAction).toBe('none');
    expect(style.userSelect).toBe('none');
    act(() => renderer.unmount());
  });

  it('keeps the OSD canvas physically LTR even though the app is RTL', async () => {
    const {renderer} = await renderScreen();

    // The canvas is video, not a paragraph: pinning direction here is
    // what stops a locale mirroring the pilot's layout.
    expect(flatten(canvasOf(renderer).props.style).direction).toBe('ltr');
    act(() => renderer.unmount());
  });
});

describe('the preview photograph is scenery and nothing else', () => {
  it('cannot intercept a drag', async () => {
    const {renderer} = await renderScreen();
    const layer = renderer.root.findByProps({testID: 'osd-preview-background-layer'});

    expect(layer.props.pointerEvents).toBe('none');
    // Grabbing "over the photo" still grabs the element above it.
    act(() => {
      canvasOf(renderer).props.onResponderGrant(gesture(5 * CELL + 4, 4, 1));
    });
    act(() => {
      canvasOf(renderer).props.onResponderMove(gesture(9 * CELL + 4, 2 * CELL + 4, 2));
    });
    expect(positionOf(renderer, 0)).toEqual({column: 9, row: 2});
    act(() => renderer.unmount());
  });

  it('renders behind every OSD element and is hidden from assistive tech', async () => {
    const {renderer} = await renderScreen();
    // Depth-first traversal order == paint order for absolutely
    // positioned siblings, and it survives the extra host wrapper
    // react-native-web puts around every View.
    const order = renderer.root
      .findAll(node => typeof node.props?.testID === 'string')
      .map(node => String(node.props.testID));

    const background = order.indexOf('osd-preview-background-layer');
    const firstElement = order.findIndex(id => id.startsWith('osd-canvas-item-'));
    expect(background).toBeGreaterThanOrEqual(0);
    expect(firstElement).toBeGreaterThan(background);

    const layer = renderer.root.findByProps({testID: 'osd-preview-background-layer'});
    expect(layer.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(renderer.root.findByProps({testID: 'osd-preview-background'}).props.accessible).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('is the operator’s own still, carried as an inert data URI', async () => {
    const {renderer} = await renderScreen();
    const source = renderer.root.findByProps({testID: 'osd-preview-background'}).props.source;

    expect(String(source.uri).startsWith('data:image/jpeg;base64,')).toBe(true);
    // No network, no file system, nothing to resolve at runtime.
    expect(String(source.uri)).not.toMatch(/https?:/);
    act(() => renderer.unmount());
  });
});

describe('the web shell still lets people type and copy', () => {
  const shell = readFileSync(path.join(__dirname, '..', '..', '..', 'index.html'), 'utf8');

  it('suppresses selection on product chrome so a drag never selects text', () => {
    expect(shell).toMatch(/#root\s*\{[^}]*user-select:\s*none/);
  });

  it('but keeps real inputs and copyable diagnostics selectable', () => {
    for (const selector of ['#root input', '#root textarea', '#root [data-testid="cli-output"]']) {
      expect(shell).toContain(selector);
    }
    expect(shell.slice(shell.indexOf('#root input'))).toMatch(/user-select:\s*text/);
  });
});

describe('save still carries the dragged cell on web', () => {
  it('hands the flight controller the cell the pointer produced', async () => {
    const saves: Array<{column: number; row: number}> = [];
    const {renderer} = await renderScreen(async (_key, _original, draft) => {
      saves.push({
        column: osdPositionX(draft.elementPositions[0]),
        row: osdPositionY(draft.elementPositions[0]),
      });
      return {kind: 'SAVED_VERIFIED' as const, snapshot: SNAPSHOT};
    });

    act(() => {
      canvasOf(renderer).props.onResponderGrant(gesture(5 * CELL + 4, 4, 1));
    });
    act(() => {
      canvasOf(renderer).props.onResponderMove(gesture(31 * CELL + 4, 8 * CELL + 4, 2));
    });
    act(() => {
      canvasOf(renderer).props.onResponderRelease(gesture(31 * CELL + 4, 8 * CELL + 4, 3));
    });
    await act(async () => {
      await renderer.root.findByProps({testID: 'osd-save-bar-save'}).props.onPress();
    });

    expect(saves).toEqual([{column: 31, row: 8}]);
    act(() => renderer.unmount());
  });
});
