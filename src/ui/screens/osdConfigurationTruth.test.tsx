/* eslint-disable no-bitwise -- the profile/position bit layout is the
   thing under test, so it is asserted with the protocol's own masks. */
/**
 * OSD CONFIGURATION TRUTH - what is shown is what the board reported.
 *
 * The preview is a picture of a real configuration, so every claim it
 * makes has to come from somewhere real: the element list is the count
 * the firmware sent, an element is "enabled" because its profile bit is
 * set in the word the firmware sent, the canvas is what MSP_OSD_CANVAS
 * answered, and the photograph behind it contributes nothing to any of
 * it. These tests hold each of those to the wire data.
 */

import {readFileSync, readdirSync, statSync} from 'fs';
import path from 'path';

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import {
  encodeChangedOsdConfiguration,
  osdElementName,
  osdVisibleInProfile,
  type MspOsdSnapshot,
  type OsdConfigurationDraft,
} from '../../core';
import OsdScreen, {type OsdControllerPort} from './OsdScreen';

type Renderer = ReactTestRenderer.ReactTestRenderer;

/** 0xD48 decodes to column 40, row 10, visible in profile 1 - outside a
 * PAL grid on purpose, so the video-system test has something to flag. */
function snapshotWith(overrides: Partial<MspOsdSnapshot['config']> = {}): MspOsdSnapshot {
  return {
    canvas: {columns: 53, rows: 20},
    config: {
      flags: 1,
      videoSystem: 3,
      units: 1,
      rssiAlarmPercent: 30,
      capacityAlarmMah: 1400,
      altitudeAlarm: 120,
      elementPositions: [0x0805, 0x0026, 0x0d48],
      statistics: [true, false],
      timers: [0x0a21],
      warningCount: 3,
      enabledWarnings: 1,
      profileCount: 3,
      selectedProfile: 1,
      overlayRadioMode: 0,
      cameraFrameWidth: 24,
      cameraFrameHeight: 11,
      linkQualityAlarmPercent: 70,
      rssiDbmAlarm: -95,
      ...overrides,
    },
  };
}

async function renderScreen(snapshot: MspOsdSnapshot) {
  const saved: OsdConfigurationDraft[] = [];
  const controller: OsdControllerPort = {
    load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot})),
    save: jest.fn(async (_key, _original, draft: OsdConfigurationDraft) => {
      saved.push(draft);
      return {kind: 'SAVED_VERIFIED' as const, snapshot};
    }),
  };
  let renderer!: Renderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <OsdScreen sessionKey={{sessionId: 'fc', generation: 1}} active controller={controller} />,
    );
    await Promise.resolve();
  });
  return {renderer, saved};
}

const press = (renderer: Renderer, testID: string) =>
  act(() => {
    renderer.root.findByProps({testID}).props.onPress();
  });

async function saveAndRead(renderer: Renderer, saved: OsdConfigurationDraft[]) {
  await act(async () => {
    await renderer.root.findByProps({testID: 'osd-save-bar-save'}).props.onPress();
  });
  return saved[saved.length - 1];
}

const caption = (renderer: Renderer) =>
  (renderer.root.findByProps({testID: 'osd-canvas-caption'}).props.children as unknown[])
    .map(String)
    .join('');

describe('the element list is the firmware answer, not a catalogue', () => {
  it('renders exactly the elements the flight controller reported', async () => {
    const {renderer} = await renderScreen(snapshotWith());
    expect(renderer.root.findAllByProps({testID: 'osd-element-0'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'osd-element-2'}).length).toBeGreaterThan(0);
    // The firmware sent three; a fourth is not invented from Betaflight's
    // full element catalogue.
    expect(renderer.root.findAllByProps({testID: 'osd-element-3'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('grows and shrinks with the firmware count', async () => {
    const {renderer} = await renderScreen(
      snapshotWith({elementPositions: [0x0805, 0x0026, 0x0d48, 0x0850, 0x0851]}),
    );
    expect(renderer.root.findAllByProps({testID: 'osd-element-4'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'osd-element-5'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('names an element beyond the known table neutrally instead of guessing', () => {
    // A firmware that reports more elements than this build knows names
    // for must not have them labelled with somebody else's meaning.
    expect(osdElementName(0)).toBe('قوة الإشارة RSSI');
    expect(osdElementName(4096)).toBe('عنصر OSD 4097');
  });

  it('draws only the elements visible in the active profile', async () => {
    // 0x0026 has no profile bits set at all -> present in the list,
    // absent from the canvas.
    const {renderer} = await renderScreen(snapshotWith());
    expect(renderer.root.findAllByProps({testID: 'osd-canvas-item-0'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'osd-canvas-item-1'})).toHaveLength(0);
    expect(caption(renderer)).toContain('العناصر الظاهرة 2');
    act(() => renderer.unmount());
  });
});

describe('enabling and disabling an element is a real configuration change', () => {
  it('writes the profile bit of the ACTIVE profile and leaves the others alone', async () => {
    const {renderer, saved} = await renderScreen(snapshotWith());

    // Element 1 is hidden everywhere; enable it in profile 1.
    press(renderer, 'osd-element-1-toggle');
    const draft = await saveAndRead(renderer, saved);

    expect(osdVisibleInProfile(draft.elementPositions[1], 1)).toBe(true);
    expect(osdVisibleInProfile(draft.elementPositions[1], 2)).toBe(false);
    expect(osdVisibleInProfile(draft.elementPositions[1], 3)).toBe(false);
    // The cell it would occupy is untouched by a visibility change.
    expect(draft.elementPositions[1] & 0x07ff).toBe(0x0026 & 0x07ff);
    act(() => renderer.unmount());
  });

  it('disabling clears only that bit, and the change reaches the MSP write', async () => {
    const {renderer, saved} = await renderScreen(snapshotWith());
    const original = snapshotWith();

    press(renderer, 'osd-element-0-toggle');
    const draft = await saveAndRead(renderer, saved);

    expect(osdVisibleInProfile(draft.elementPositions[0], 1)).toBe(false);
    const writes = encodeChangedOsdConfiguration(original, draft);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({group: 'ELEMENT', index: 0});
    act(() => renderer.unmount());
  });
});

describe('profiles show their own configuration', () => {
  it('switching profile changes which elements are drawn, not their words', async () => {
    // Element 2 is visible in profile 1 only; element 1 in profile 2 only
    // (0x1026 sets bit 12).
    const {renderer, saved} = await renderScreen(
      snapshotWith({elementPositions: [0x0805, 0x1026, 0x0d48]}),
    );

    expect(renderer.root.findAllByProps({testID: 'osd-canvas-item-1'})).toHaveLength(0);
    press(renderer, 'osd-profile-2');
    expect(renderer.root.findAllByProps({testID: 'osd-canvas-item-1'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'osd-canvas-item-0'})).toHaveLength(0);

    // Selecting a profile changes `selectedProfile` alone: no element
    // word may be rewritten by the act of looking at another profile.
    const draft = await saveAndRead(renderer, saved);
    expect(draft.selectedProfile).toBe(2);
    expect(draft.elementPositions).toEqual([0x0805, 0x1026, 0x0d48]);
    act(() => renderer.unmount());
  });

  it('offers exactly the profiles the firmware declares', async () => {
    const {renderer} = await renderScreen(snapshotWith({profileCount: 2}));
    expect(renderer.root.findAllByProps({testID: 'osd-profile-2'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'osd-profile-3'})).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

describe('the video system decides the canvas the preview draws', () => {
  it('switches to the analogue grid and says what is now outside it', async () => {
    const {renderer} = await renderScreen(snapshotWith());
    expect(caption(renderer)).toContain('53×20');
    expect(renderer.root.findAllByProps({testID: 'osd-outside-canvas'})).toHaveLength(0);

    // PAL: 30x16. Element 2 sits at column 40, row 10.
    press(renderer, 'osd-video-1');

    expect(caption(renderer)).toContain('30×16');
    const notice = renderer.root.findAllByProps({testID: 'osd-outside-canvas'});
    expect(notice.length).toBeGreaterThan(0);
    // Flagged, NOT silently rewritten - moving somebody's layout without
    // being asked is not a display concern.
    expect(
      (
        renderer.root.findByProps({testID: 'osd-element-2-position'}).props
          .children as readonly unknown[]
      )
        .map(String)
        .join(''),
    ).toBe('40,10');
    act(() => renderer.unmount());
  });

  it('returns to the reported canvas for HD and AUTO', async () => {
    const {renderer} = await renderScreen(snapshotWith());
    press(renderer, 'osd-video-1');
    expect(caption(renderer)).toContain('30×16');
    press(renderer, 'osd-video-0');
    expect(caption(renderer)).toContain('53×20');
    act(() => renderer.unmount());
  });
});

describe('the preview photograph never reaches the flight controller', () => {
  const PROTOCOL_ROOTS = [
    path.join(__dirname, '..', '..', 'core'),
    path.join(__dirname, '..', '..', 'platforms', 'react-native', 'protocol'),
  ];

  function sourceFiles(root: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(root)) {
      const full = path.join(root, entry);
      if (statSync(full).isDirectory()) {
        out.push(...sourceFiles(full));
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  it('is imported by no protocol, encoder or controller module', () => {
    const offenders = PROTOCOL_ROOTS.flatMap(sourceFiles).filter(file =>
      readFileSync(file, 'utf8').includes('osdPreviewBackground'),
    );
    expect(offenders).toEqual([]);
  });

  it('contributes no bytes to any OSD write', async () => {
    const original = snapshotWith();
    const {renderer, saved} = await renderScreen(original);

    press(renderer, 'osd-element-1-toggle');
    const draft = await saveAndRead(renderer, saved);

    // Everything MSP will carry for this edit, end to end.
    const bytes = encodeChangedOsdConfiguration(original, draft).flatMap(write =>
      Array.from(write.payload),
    );
    expect(bytes.length).toBeLessThanOrEqual(4);
    const uri = readFileSync(
      path.join(__dirname, 'osd', 'osdPreviewBackground.ts'),
      'utf8',
    );
    // The image is ~65 kB of JPEG; nothing of that scale could hide in a
    // four-byte element write, and the draft itself holds no such field.
    expect(uri.length).toBeGreaterThan(50_000);
    expect(JSON.stringify(draft)).not.toContain('data:image');
    act(() => renderer.unmount());
  });
});
