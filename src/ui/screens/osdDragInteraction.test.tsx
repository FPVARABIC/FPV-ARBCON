/* eslint-disable no-bitwise -- these assertions read the firmware's own
   16-bit element word, so they do the same masking the protocol does. */
/**
 * DRAGGING AN OSD ELEMENT - the defect this whole rework exists for.
 *
 * The operator could see Battery, GPS and the rest on the preview and
 * could not move them: the preview items were Pressables with an onPress
 * that selected, and nothing that followed a finger. These tests drive
 * the real screen through the real gesture handlers and assert the thing
 * that actually matters - that the cell the operator drags to is the cell
 * handed to the save path, and from there the exact bytes MSP will carry.
 *
 * This suite runs on the DEFAULT (native/Android) React Native preset, so
 * it is the Android touch path. OsdScreen.web.test.tsx runs the same screen
 * against react-native-web for the browser pointer path; both drive the
 * same state model, which is test 25 of the brief.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import {
  encodeChangedOsdConfiguration,
  osdPositionX,
  osdPositionY,
  type MspOsdSnapshot,
  type OsdConfigurationDraft,
} from '../../core';
import OsdScreen, {type OsdControllerPort} from './OsdScreen';

/* A real HD canvas, and two elements whose stored words decode to known
 * cells: 0x0805 -> column 5 row 0 (visible in profile 1), 0x0826 -> column
 * 6 row 1. Element 2 is hidden in profile 1 on purpose. */
const SNAPSHOT: MspOsdSnapshot = {
  canvas: {columns: 53, rows: 20},
  config: {
    flags: 1,
    videoSystem: 3,
    units: 1,
    rssiAlarmPercent: 30,
    capacityAlarmMah: 1400,
    altitudeAlarm: 120,
    elementPositions: [0x0805, 0x0826, 0x0040],
    statistics: [true, false],
    timers: [0x0a21, 0x1422],
    warningCount: 4,
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

/** 1060x400 canvas over a 53x20 grid: exactly 20 px per cell. */
const CANVAS_BOX = {width: 1060, height: 400};
const CELL = 20;

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

/** A responder event shaped the way PanResponder actually reads it. */
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

function canvasOf(renderer: Renderer) {
  return renderer.root.findByProps({testID: 'osd-canvas'});
}

/** Gives the canvas a measured size; without it every cell is zero-wide. */
function layoutCanvas(renderer: Renderer): void {
  act(() => {
    canvasOf(renderer).props.onLayout({
      nativeEvent: {layout: {x: 0, y: 0, width: CANVAS_BOX.width, height: CANVAS_BOX.height}},
    });
  });
}

/** press -> move -> release, in canvas-local pixels. */
function drag(
  renderer: Renderer,
  from: {x: number; y: number},
  to: {x: number; y: number},
): void {
  const canvas = canvasOf(renderer);
  act(() => {
    canvas.props.onStartShouldSetResponder(gesture(from.x, from.y, 1));
    canvas.props.onResponderGrant(gesture(from.x, from.y, 1));
  });
  act(() => {
    canvasOf(renderer).props.onResponderMove(gesture(to.x, to.y, 2));
  });
  act(() => {
    canvasOf(renderer).props.onResponderRelease(gesture(to.x, to.y, 3));
  });
}

async function renderScreen(controller: OsdControllerPort) {
  let renderer!: Renderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <OsdScreen sessionKey={{sessionId: 'fc', generation: 1}} active controller={controller} />,
    );
    await Promise.resolve();
  });
  layoutCanvas(renderer);
  return renderer;
}

function fakeController(): OsdControllerPort & {saved: OsdConfigurationDraft[]} {
  const saved: OsdConfigurationDraft[] = [];
  return {
    saved,
    load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: SNAPSHOT})),
    save: jest.fn(async (_key, _original, draft: OsdConfigurationDraft) => {
      saved.push(draft);
      return {kind: 'SAVED_VERIFIED' as const, snapshot: SNAPSHOT};
    }),
  };
}

/** The element positions the screen is currently holding, read from the
 * element list's own rendered position labels. */
function positionOf(renderer: Renderer, index: number): {column: number; row: number} {
  const label = renderer.root.findByProps({testID: `osd-element-${index}-position`});
  const parts = (label.props.children as readonly unknown[]).map(String).join('');
  const match = /^(\d+),(\d+)$/.exec(parts);
  if (match === null) throw new Error(`no position rendered for element ${index}: ${parts}`);
  return {column: Number(match[1]), row: Number(match[2])};
}

describe('an OSD element follows the finger, and the firmware gets that cell', () => {
  it('dragging sideways changes the real target COLUMN and nothing else', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);

    // Element 0 sits at column 5, row 0. Grab its first cell and pull it
    // ten cells to the right.
    expect(positionOf(renderer, 0)).toEqual({column: 5, row: 0});
    drag(renderer, {x: 5 * CELL + 4, y: 4}, {x: 15 * CELL + 4, y: 4});

    expect(positionOf(renderer, 0)).toEqual({column: 15, row: 0});
    // ...and the other elements were not touched.
    expect(positionOf(renderer, 1)).toEqual({column: 6, row: 1});
    act(() => renderer.unmount());
  });

  it('dragging down changes the real target ROW and nothing else', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);

    drag(renderer, {x: 5 * CELL + 4, y: 4}, {x: 5 * CELL + 4, y: 7 * CELL + 4});

    expect(positionOf(renderer, 0)).toEqual({column: 5, row: 7});
    act(() => renderer.unmount());
  });

  it('keeps the grab offset, so the element does not jump under the finger', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);

    // Grab element 0 (anchor column 5) at its THIRD cell...
    drag(renderer, {x: 7 * CELL + 10, y: 8}, {x: 20 * CELL + 10, y: 8});

    // ...so the anchor lands 2 cells left of where the finger ended.
    expect(positionOf(renderer, 0)).toEqual({column: 18, row: 0});
    act(() => renderer.unmount());
  });

  it('clamps at the canvas edge instead of leaving the video', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);

    drag(renderer, {x: 5 * CELL + 4, y: 4}, {x: 50_000, y: 50_000});

    expect(positionOf(renderer, 0)).toEqual({column: 52, row: 19});
    act(() => renderer.unmount());
  });

  it('moves the element that was grabbed, not the selected one', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);

    // Element 0 is selected by default; grab element 1 instead.
    drag(renderer, {x: 6 * CELL + 4, y: 1 * CELL + 4}, {x: 6 * CELL + 4, y: 9 * CELL + 4});

    expect(positionOf(renderer, 0)).toEqual({column: 5, row: 0});
    expect(positionOf(renderer, 1)).toEqual({column: 6, row: 9});
    act(() => renderer.unmount());
  });

  it('starts no drag on empty video, so a stray touch cannot move anything', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);

    drag(renderer, {x: 40 * CELL, y: 15 * CELL}, {x: 10 * CELL, y: 2 * CELL});

    expect(positionOf(renderer, 0)).toEqual({column: 5, row: 0});
    expect(positionOf(renderer, 1)).toEqual({column: 6, row: 1});
    act(() => renderer.unmount());
  });

  it('never grabs an element hidden in the active profile', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);

    // Element 2 (0x0040 -> column 0 row 2) has no profile-1 bit set, so
    // it is not on the canvas and its cell is empty video.
    expect(renderer.root.findAllByProps({testID: 'osd-canvas-item-2'})).toHaveLength(0);
    drag(renderer, {x: 4, y: 2 * CELL + 4}, {x: 20 * CELL, y: 2 * CELL + 4});

    expect(positionOf(renderer, 2)).toEqual({column: 0, row: 2});
    act(() => renderer.unmount());
  });
});

describe('a cancelled gesture stops cleanly', () => {
  it('terminate ends the drag, and later moves change nothing', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);
    const canvas = canvasOf(renderer);

    act(() => {
      canvas.props.onStartShouldSetResponder(gesture(5 * CELL + 4, 4, 1));
      canvas.props.onResponderGrant(gesture(5 * CELL + 4, 4, 1));
    });
    act(() => {
      canvasOf(renderer).props.onResponderMove(gesture(9 * CELL + 4, 4, 2));
    });
    expect(positionOf(renderer, 0)).toEqual({column: 9, row: 0});

    // The system takes the gesture away (pointercancel / native steal).
    act(() => {
      canvasOf(renderer).props.onResponderTerminate(gesture(9 * CELL + 4, 4, 3));
    });
    // A late move from the dead gesture must not move anything.
    act(() => {
      canvasOf(renderer).props.onResponderMove(gesture(30 * CELL + 4, 12 * CELL, 4));
    });

    expect(positionOf(renderer, 0)).toEqual({column: 9, row: 0});
    act(() => renderer.unmount());
  });

  it('refuses to hand the gesture away while an element is held', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);
    const canvas = canvasOf(renderer);

    // Nothing grabbed: the ScrollView may have the responder.
    expect(canvas.props.onResponderTerminationRequest(gesture(0, 0, 1))).toBe(true);

    act(() => {
      canvas.props.onResponderGrant(gesture(5 * CELL + 4, 4, 2));
    });
    // Holding an element: a scroll must not be able to steal it.
    expect(canvasOf(renderer).props.onResponderTerminationRequest(gesture(0, 0, 3))).toBe(false);
    act(() => {
      canvasOf(renderer).props.onResponderRelease(gesture(5 * CELL + 4, 4, 4));
    });
    expect(canvasOf(renderer).props.onResponderTerminationRequest(gesture(0, 0, 5))).toBe(true);
    act(() => renderer.unmount());
  });

  it('stops the page scrolling for exactly as long as the drag lasts', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);
    const scroll = () =>
      renderer.root.findAll(
        node => typeof node.type !== 'string' && node.props.scrollEnabled !== undefined,
      )[0];

    expect(scroll().props.scrollEnabled).toBe(true);
    act(() => {
      canvasOf(renderer).props.onResponderGrant(gesture(5 * CELL + 4, 4, 1));
    });
    expect(scroll().props.scrollEnabled).toBe(false);
    act(() => {
      canvasOf(renderer).props.onResponderRelease(gesture(5 * CELL + 4, 4, 2));
    });
    expect(scroll().props.scrollEnabled).toBe(true);
    act(() => renderer.unmount());
  });
});

describe('what was dragged is what gets written', () => {
  it('hands the dragged cell to save, and encodes the exact MSP element word', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);

    drag(renderer, {x: 5 * CELL + 4, y: 4}, {x: 15 * CELL + 4, y: 3 * CELL + 4});

    await act(async () => {
      await renderer.root.findByProps({testID: 'osd-save-bar-save'}).props.onPress();
    });

    expect(controller.saved).toHaveLength(1);
    const draft = controller.saved[0];
    // The draft carries the dragged cell, in the firmware's own encoding.
    expect(osdPositionX(draft.elementPositions[0])).toBe(15);
    expect(osdPositionY(draft.elementPositions[0])).toBe(3);
    // Untouched elements keep their exact original words.
    expect(draft.elementPositions[1]).toBe(0x0826);
    expect(draft.elementPositions[2]).toBe(0x0040);

    // And the bytes that MSP_SET_OSD_CONFIG will carry: element index 0,
    // the new 16-bit word little-endian, then the write marker.
    const writes = encodeChangedOsdConfiguration(SNAPSHOT, draft);
    expect(writes).toHaveLength(1);
    expect(writes[0].group).toBe('ELEMENT');
    expect(writes[0].index).toBe(0);
    expect(Array.from(writes[0].payload)).toEqual([
      0,
      draft.elementPositions[0] & 0xff,
      (draft.elementPositions[0] >> 8) & 0xff,
      1,
    ]);
    act(() => renderer.unmount());
  });

  it('carries no image and no pixels into the payload - only the cell', async () => {
    const controller = fakeController();
    const renderer = await renderScreen(controller);

    drag(renderer, {x: 5 * CELL + 4, y: 4}, {x: 21 * CELL + 7, y: 5 * CELL + 13});
    await act(async () => {
      await renderer.root.findByProps({testID: 'osd-save-bar-save'}).props.onPress();
    });

    const draft = controller.saved[0];
    const writes = encodeChangedOsdConfiguration(SNAPSHOT, draft);
    // Four bytes total for the move. Pixel coordinates (21*20+7 = 427,
    // 113) appear nowhere; the preview's own geometry never leaves the
    // screen.
    expect(writes[0].payload).toHaveLength(4);
    expect(Array.from(writes[0].payload)).not.toContain(427);
    expect(osdPositionX(draft.elementPositions[0])).toBe(21);
    expect(osdPositionY(draft.elementPositions[0])).toBe(5);
    act(() => renderer.unmount());
  });

  it('a failed save keeps the dragged position and the screen dirty', async () => {
    const controller: OsdControllerPort = {
      load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: SNAPSHOT})),
      save: jest.fn(async () => ({kind: 'FAILED' as const, error: new Error('link died')})),
    };
    const renderer = await renderScreen(controller);

    drag(renderer, {x: 5 * CELL + 4, y: 4}, {x: 12 * CELL + 4, y: 4});
    await act(async () => {
      await renderer.root.findByProps({testID: 'osd-save-bar-save'}).props.onPress();
    });

    // The edit is still there and the save bar is still offering to save
    // it: nothing pretended the flight controller took it.
    expect(positionOf(renderer, 0)).toEqual({column: 12, row: 0});
    expect(renderer.root.findByProps({testID: 'osd-save-bar'}).props.visible).toBe(true);
    act(() => renderer.unmount());
  });

  it('a verified save adopts the flight controller read-back and goes clean', async () => {
    const saved: MspOsdSnapshot = {
      ...SNAPSHOT,
      config: {...SNAPSHOT.config, elementPositions: [0x080c, 0x0826, 0x0040]},
    };
    const controller: OsdControllerPort = {
      load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: SNAPSHOT})),
      save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: saved})),
    };
    const renderer = await renderScreen(controller);

    drag(renderer, {x: 5 * CELL + 4, y: 4}, {x: 12 * CELL + 4, y: 4});
    await act(async () => {
      await renderer.root.findByProps({testID: 'osd-save-bar-save'}).props.onPress();
    });

    // 0x080c decodes to column 12 - the read-back agreed with the drag.
    expect(positionOf(renderer, 0)).toEqual({column: 12, row: 0});
    expect(renderer.root.findByProps({testID: 'osd-save-bar'}).props.visible).toBe(false);
    act(() => renderer.unmount());
  });
});
