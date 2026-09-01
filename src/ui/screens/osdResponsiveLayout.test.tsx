/**
 * THE OSD ELEMENT GRID'S RESPONSIVE CONTRACT, AND WHAT OPENING THE
 * SCREEN IS ALLOWED TO DO.
 *
 * Two things are pinned here that a rendered-geometry gate cannot state
 * on its own:
 *
 *   1. THE ROOT CAUSE, as a relationship rather than a screenshot. The
 *      element chip grows over a flex BASIS, and `flexGrow` only shares
 *      out leftover space - so as more columns fit, every chip converges
 *      DOWN toward that basis. A basis smaller than the widest label
 *      therefore makes a WIDER window produce NARROWER chips and newly
 *      ellipsized Arabic names. The browser gate
 *      (`scripts/verify-osd-labels.mjs`) measures the consequence; this
 *      pins the mechanism, including the `flexShrink` that stops a basis
 *      wider than the line from overhanging a narrow or zoomed viewport.
 *
 *   2. NO WRITE ON ARRIVAL. Laying out is not an action. Opening OSD
 *      reads; it must not save, and must not reach EEPROM or a reboot
 *      through the controller it was handed.
 */
import React from 'react';
import {StyleSheet} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import {
  OSD_ELEMENT_NAMES_AR,
  setOsdPosition,
  setOsdProfileVisibility,
} from '../../core/state/osdConfigurationModel';
import OsdScreen, {type OsdControllerPort} from './OsdScreen';

const ELEMENT_POSITIONS = OSD_ELEMENT_NAMES_AR.map((_name, index) =>
  setOsdProfileVisibility(setOsdPosition(0, index % 30, index % 15), 1, index % 3 !== 0),
);

const SNAPSHOT = {
  canvas: {columns: 53, rows: 20},
  config: {
    flags: 1,
    videoSystem: 3,
    units: 1,
    rssiAlarmPercent: 30,
    capacityAlarmMah: 1400,
    altitudeAlarm: 120,
    elementPositions: ELEMENT_POSITIONS,
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
} as never;

function ports() {
  const load = jest.fn(async () => ({kind: 'LOADED' as const, snapshot: SNAPSHOT}));
  const save = jest.fn(async () => ({
    kind: 'SAVED_VERIFIED' as const,
    snapshot: SNAPSHOT,
  }));
  return {load, save, controller: {load, save} as OsdControllerPort};
}

async function mount(controller: OsdControllerPort) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <OsdScreen sessionKey={{sessionId: 'osd', generation: 2}} active controller={controller} />,
    );
    await Promise.resolve();
  });
  for (let pass = 0; pass < 3; pass += 1)
    await act(async () => {
      await Promise.resolve();
    });
  return renderer;
}

/** The resolved style of the element chip that carries the press. */
function chipStyle(renderer: ReactTestRenderer.ReactTestRenderer, index: number) {
  const node = renderer.root
    .findAllByProps({testID: `osd-element-${index}`})
    .find(n => typeof (n.props as {onPress?: unknown}).onPress === 'function');
  if (node === undefined) throw new Error(`no element chip ${index}`);
  const raw = (node.props as {style?: unknown}).style;
  return (StyleSheet.flatten(raw as never) ?? {}) as Record<string, number | string>;
}

describe('the OSD element grid cannot get narrower as the window gets wider', () => {
  it('grows over a basis wide enough for the longest shipped label', async () => {
    const {controller} = ports();
    const renderer = await mount(controller);
    const style = chipStyle(renderer, 0);

    /* Growing over a basis is the mechanism that produced the defect,
       so the mechanism itself is stated: leftover space is shared, and
       what is left when it runs out is the basis. */
    expect(style.flexGrow).toBe(1);

    /* The widest element name renders at ~116px and the chip spends
       ~95px on the visibility target, the x,y readout, the gaps and the
       padding. Below ~211 a wide window starts ellipsizing real names -
       measured at 180: 4 truncated at 1024, 10 at 1366. */
    expect(typeof style.flexBasis).toBe('number');
    expect(style.flexBasis as number).toBeGreaterThanOrEqual(211);

    /* And a basis is a starting width, not a floor: without this a
       216px chip overhangs the ~157px line a 200%-zoomed phone has, and
       the label is clipped off the side of the screen instead of
       ellipsized inside it. */
    expect(style.flexShrink).toBe(1);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('renders every element the firmware reported, each with its own name', async () => {
    const {controller} = ports();
    const renderer = await mount(controller);
    /* Counted by DISTINCT testID: a Pressable forwards its props to the
       host View it renders, so the same chip appears at more than one
       node in the tree and a raw node count would not be the number of
       chips. */
    const ids = new Set(
      renderer.root
        .findAll(
          node =>
            typeof (node.props as {testID?: string}).testID === 'string' &&
            /^osd-element-\d+$/.test((node.props as {testID: string}).testID),
          {deep: true},
        )
        .map(node => (node.props as {testID: string}).testID),
    );
    expect(ids.size).toBe(OSD_ELEMENT_NAMES_AR.length);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});

describe('opening OSD reads and writes nothing', () => {
  it('loads once and never saves, reboots or writes EEPROM on arrival', async () => {
    const {load, save, controller} = ports();
    const renderer = await mount(controller);

    /* The one read the screen exists to make. */
    expect(load).toHaveBeenCalledTimes(1);
    /* SAVE is the only path to MSP_SET_OSD_CONFIG, EEPROM and any
       reboot, so zero calls here is zero configuration writes. Laying
       out - at any width - is not an action. */
    expect(save).not.toHaveBeenCalled();

    ReactTestRenderer.act(() => renderer.unmount());
    expect(save).not.toHaveBeenCalled();
  });
});
