/**
 * WHAT تسجيل الرحلات IS ALLOWED TO PUT ON SCREEN.
 *
 * Every test here is a statement the rendered tree must be able to make -
 * or must be unable to make. The screen is driven through its real
 * controller port with hand-built snapshots, so what is asserted is the
 * actual output of the actual component, not a helper's opinion of it.
 *
 * The recurring shape is a NEGATIVE assertion, and that is deliberate:
 * this class of defect is never a missing element, it is an extra one -
 * a capacity beside a slot with no card, a percentage the firmware never
 * sent, a "saved" before anything was read back.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {
  classifyBlackboxConfig,
  classifyDataflash,
  classifySdcard,
} from '../../core/state/blackboxStorageSemantics';
import type {
  BlackboxEraseObservation,
  BlackboxEraseOutcome,
  BlackboxSnapshot,
} from '../../platforms/react-native/protocol';
import {blackboxPendingSave} from '../session/blackboxPendingSave';
import BlackboxScreen, {type BlackboxControllerPort} from './BlackboxScreen';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

afterEach(() => {
  blackboxPendingSave.clear();
});

/* ================================================================== *
 * HARNESS
 * ================================================================== */

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === 'object') {
      visit((node as {children?: unknown}).children);
    }
  };
  visit(tree.toJSON());
  return out.join(' ');
}

/**
 * Text inside ONE testID subtree - so a negative assertion cannot be
 * satisfied (or defeated) by an unrelated part of the page.
 *
 * It walks the RENDERED JSON, which is the host tree only. Walking test
 * INSTANCES instead reports every string twice, because a composite and
 * the host it renders both carry the same testID; walking ELEMENTS misses
 * the words inside a composite child entirely (a Button keeps its label
 * in a prop). The rendered JSON has neither problem.
 */
interface RenderedNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: unknown;
}

function textIn(tree: ReactTestRenderer.ReactTestRenderer, testID: string): string {
  const locate = (node: unknown): RenderedNode | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = locate(child);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (node === null || typeof node !== 'object') return undefined;
    const shape = node as RenderedNode;
    if ((shape.props as {testID?: string} | undefined)?.testID === testID) {
      return shape;
    }
    return locate(shape.children);
  };
  const found = locate(tree.toJSON());
  if (found === undefined) return '';
  const out: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (node !== null && typeof node === 'object') {
      collect((node as RenderedNode).children);
    }
  };
  collect(found.children);
  return out.join(' ');
}

const has = (tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAllByProps({testID}).length > 0;

function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onPress === 'function');
  if (node === undefined) throw new Error(`No pressable ${testID}`);
  act(() => {
    node.props.onPress();
  });
}

function selectOption(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  key: string,
): void {
  const node = tree.root
    .findAllByProps({testID})
    .find(candidate => typeof candidate.props.onSelect === 'function');
  if (node === undefined) throw new Error(`No selector ${testID}`);
  act(() => {
    node.props.onSelect(key);
  });
}

/* ------------------------------------------------------------------ *
 * SNAPSHOTS, built through the real classifiers from real wire values.
 * ------------------------------------------------------------------ */

const SIXTEEN_MIB = 16777216;
const EIGHT_MIB = 8388608;

function snapshotOf(over: {
  supported?: boolean;
  deviceRaw?: number;
  sampleRateRaw?: number;
  disabledFieldsMask?: number;
  debugMode?: number;
  debugModeCount?: number;
  flash?: {supported: boolean; ready: boolean; total: number; used: number};
  sd?: {
    configured: boolean;
    stateRaw: number;
    freeKilobytes?: number;
    totalKilobytes?: number;
  };
} = {}): BlackboxSnapshot {
  const config = {
    supported: over.supported ?? true,
    supportedRaw: over.supported === false ? 0 : 1,
    deviceRaw: over.deviceRaw ?? 1,
    legacyRateNumerator: 1,
    legacyRateDenominator: 1,
    pRatio: 32,
    sampleRateRaw: over.sampleRateRaw ?? 0,
    disabledFieldsMask: over.disabledFieldsMask ?? 0,
  };
  const flash = over.flash ?? {
    supported: true,
    ready: true,
    total: SIXTEEN_MIB,
    used: EIGHT_MIB,
  };
  const sd = over.sd ?? {configured: false, stateRaw: 0};
  return {
    config,
    configuration: classifyBlackboxConfig(config),
    dataflash: classifyDataflash({
      flagsRaw: (flash.ready ? 1 : 0) + (flash.supported ? 2 : 0),
      supported: flash.supported,
      ready: flash.ready,
      sectorCount: 256,
      totalBytes: flash.total,
      usedBytes: flash.used,
    }),
    sdcard: classifySdcard({
      flagsRaw: sd.configured ? 1 : 0,
      configured: sd.configured,
      stateRaw: sd.stateRaw,
      filesystemLastError: 0,
      freeKilobytes: sd.freeKilobytes ?? 0,
      totalKilobytes: sd.totalKilobytes ?? 0,
    }),
    debugMode: over.debugMode ?? 0,
    debugModeCount: over.debugModeCount ?? 60,
    pidProcessDenom: 4,
  };
}

function portFor(
  snapshot: BlackboxSnapshot,
  over: Partial<BlackboxControllerPort> = {},
): BlackboxControllerPort {
  return {
    load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot})),
    save: jest.fn(async () => ({kind: 'NO_CHANGES' as const, snapshot})),
    verifyPersistence: jest.fn(async () => ({kind: 'SUCCEEDED' as const, snapshot})),
    eraseDataflash: jest.fn(
      (): BlackboxEraseObservation => ({
        result: new Promise<BlackboxEraseOutcome>(() => undefined),
        cancel: () => undefined,
      }),
    ),
    ...over,
  };
}

async function render(
  port: BlackboxControllerPort,
  props: {generation?: number; now?: () => number} = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <BlackboxScreen
        sessionKey={{sessionId: 'fc', generation: props.generation ?? 1}}
        active
        controller={port}
        now={props.now}
      />,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

/* ================================================================== *
 * 1-3. CAPABILITY: SUPPORTED, ENABLED, AND THE DIFFERENCE
 * ================================================================== */

describe('capability', () => {
  it('renders no editable configuration at all on a build without blackbox', async () => {
    const tree = await render(portFor(snapshotOf({supported: false})));
    expect(has(tree, 'blackbox-unsupported')).toBe(true);
    // Not disabled controls - ABSENT ones. A greyed selector still claims
    // the setting exists on this firmware.
    expect(has(tree, 'blackbox-device-select')).toBe(false);
    expect(has(tree, 'blackbox-rate-select')).toBe(false);
    expect(has(tree, 'blackbox-debug-select')).toBe(false);
    expect(has(tree, 'blackbox-erase-button')).toBe(false);
    expect(has(tree, 'blackbox-flash')).toBe(false);
    expect(has(tree, 'blackbox-advanced')).toBe(false);
    act(() => tree.unmount());
  });

  /**
   * "NOTHING IS BEING LOGGED" AND "THIS FIRMWARE CANNOT LOG" ARE DIFFERENT
   * SENTENCES WITH DIFFERENT FIXES, and the first one comes from the
   * DEVICE byte rather than a feature flag - `features_e` has no blackbox
   * member at either pinned revision, so there is no flag to read.
   */
  it('says nothing is being logged when the destination is NONE', async () => {
    const tree = await render(portFor(snapshotOf({deviceRaw: 0})));
    expect(has(tree, 'blackbox-feature-disabled')).toBe(true);
    expect(textIn(tree, 'blackbox-feature-disabled')).toContain(
      ar.blackbox.featureDisabled,
    );
    // Never swapped for the capability sentence.
    expect(textOf(tree)).not.toContain(ar.blackbox.unsupportedTitle);
    // And the configuration stays reachable, because it exists.
    expect(has(tree, 'blackbox-device-select')).toBe(true);
    act(() => tree.unmount());
  });

  it('says nothing of the kind once a destination is set', async () => {
    for (const deviceRaw of [1, 2, 3]) {
      const tree = await render(portFor(snapshotOf({deviceRaw})));
      expect(has(tree, 'blackbox-feature-disabled')).toBe(false);
      act(() => tree.unmount());
    }
  });
});

/* ================================================================== *
 * 4-9. STORAGE - ABSENCE, BUSYNESS, AND ZEROES
 * ================================================================== */

describe('storage sections', () => {
  it('renders no flash card at all when the board has no flash', async () => {
    const tree = await render(
      portFor(
        snapshotOf({
          flash: {supported: false, ready: false, total: 0, used: 0},
          sd: {configured: true, stateRaw: 4, freeKilobytes: 100, totalKilobytes: 200},
        }),
      ),
    );
    expect(has(tree, 'blackbox-flash')).toBe(false);
    expect(has(tree, 'blackbox-sd')).toBe(true);
    act(() => tree.unmount());
  });

  it('renders no SD card section when no SD slot is configured', async () => {
    const tree = await render(portFor(snapshotOf()));
    expect(has(tree, 'blackbox-sd')).toBe(false);
    expect(has(tree, 'blackbox-flash')).toBe(true);
    act(() => tree.unmount());
  });

  it('offers serial-only wording when the board has neither medium', async () => {
    const tree = await render(
      portFor(
        snapshotOf({
          deviceRaw: 3,
          flash: {supported: false, ready: false, total: 0, used: 0},
          sd: {configured: false, stateRaw: 0},
        }),
      ),
    );
    expect(textIn(tree, 'blackbox-serial-only')).toContain(ar.blackbox.serialOnly);
    expect(has(tree, 'blackbox-flash')).toBe(false);
    expect(has(tree, 'blackbox-sd')).toBe(false);
    act(() => tree.unmount());
  });

  it('shows no numbers whatsoever on a busy flash volume', async () => {
    const tree = await render(
      portFor(
        snapshotOf({
          flash: {supported: true, ready: false, total: SIXTEEN_MIB, used: EIGHT_MIB},
        }),
      ),
    );
    const card = textIn(tree, 'blackbox-flash');
    expect(card).toContain(ar.blackbox.flashState.BUSY_OR_NOT_READY);
    // The frame still carried 16 MiB / 8 MiB. Neither is a reading.
    expect(card).not.toContain('16');
    expect(card).not.toContain('8');
    expect(card).not.toContain('MiB');
    expect(has(tree, 'blackbox-flash-usage')).toBe(false);
    expect(has(tree, 'blackbox-flash-bar')).toBe(false);
    act(() => tree.unmount());
  });

  it('shows a real zero on a ready-empty volume, because zero IS the reading', async () => {
    const tree = await render(
      portFor(
        portSnapshotEmptyFlash(),
      ),
    );
    const card = textIn(tree, 'blackbox-flash');
    expect(card).toContain(ar.blackbox.flashState.READY_EMPTY);
    expect(textIn(tree, 'blackbox-flash-usage')).toContain('0');
    // The TOTAL is real here and must be shown - "0 of 16 MiB", never
    // "0 MiB total".
    expect(textIn(tree, 'blackbox-flash-usage')).toContain('16');
    act(() => tree.unmount());
  });

  it('shows no capacity at all for a slot with no card in it', async () => {
    const tree = await render(
      portFor(snapshotOf({sd: {configured: true, stateRaw: 0}})),
    );
    const card = textIn(tree, 'blackbox-sd');
    expect(card).toContain(ar.blackbox.sdState.NOT_PRESENT);
    expect(card).not.toContain('MiB');
    expect(card).not.toContain('GiB');
    expect(card).not.toContain('0');
    expect(has(tree, 'blackbox-sd-usage')).toBe(false);
    expect(has(tree, 'blackbox-sd-bar')).toBe(false);
    act(() => tree.unmount());
  });

  it('shows an SD fault as a fault, with the raw numbers only as diagnostics', async () => {
    const tree = await render(
      portFor(snapshotOf({sd: {configured: true, stateRaw: 1}})),
    );
    expect(textIn(tree, 'blackbox-sd-state')).toContain(ar.blackbox.sdState.FATAL);
    // The technical numbers exist, but never as the headline.
    expect(has(tree, 'blackbox-sd-diagnostic')).toBe(true);
    expect(textIn(tree, 'blackbox-sd-state')).not.toContain('1');
    act(() => tree.unmount());
  });

  it('shows SD capacity only in READY', async () => {
    for (const stateRaw of [0, 1, 2, 3]) {
      const tree = await render(
        portFor(
          snapshotOf({
            sd: {configured: true, stateRaw, freeKilobytes: 12000, totalKilobytes: 30000},
          }),
        ),
      );
      expect(has(tree, 'blackbox-sd-usage')).toBe(false);
      act(() => tree.unmount());
    }
    const ready = await render(
      portFor(
        snapshotOf({
          sd: {configured: true, stateRaw: 4, freeKilobytes: 12000, totalKilobytes: 30000},
        }),
      ),
    );
    expect(has(ready, 'blackbox-sd-usage')).toBe(true);
    act(() => ready.unmount());
  });

  it('invents no label for an SD state it has never read', async () => {
    const tree = await render(
      portFor(snapshotOf({sd: {configured: true, stateRaw: 9}})),
    );
    const headline = textIn(tree, 'blackbox-sd-state');
    expect(headline).toContain(ar.blackbox.sdState.UNKNOWN);
    // Never folded into a fault, an absence, or a readiness.
    expect(headline).not.toContain(ar.blackbox.sdState.FATAL);
    expect(headline).not.toContain(ar.blackbox.sdState.NOT_PRESENT);
    expect(headline).not.toContain(ar.blackbox.sdState.READY);
    act(() => tree.unmount());
  });
});

function portSnapshotEmptyFlash(): BlackboxSnapshot {
  return snapshotOf({
    flash: {supported: true, ready: true, total: SIXTEEN_MIB, used: 0},
  });
}

/* ================================================================== *
 * 10-11. UNKNOWN VALUES SURVIVE
 * ================================================================== */

describe('values this build cannot name', () => {
  it('keeps an unknown logging destination visible with its raw number', async () => {
    // 4 is VIRTUAL on master; this build has never read its behaviour.
    const tree = await render(portFor(snapshotOf({deviceRaw: 4})));
    const status = textIn(tree, 'blackbox-persisted-device');
    expect(status).toContain('4');
    // Never normalised into "no logging".
    expect(status).not.toContain(ar.blackbox.device.NONE);
    act(() => tree.unmount());
  });

  it('never offers VIRTUAL as a destination a person can pick', async () => {
    const tree = await render(portFor(snapshotOf()));
    const select = tree.root
      .findAllByProps({testID: 'blackbox-device-select'})
      .find(node => Array.isArray(node.props.options));
    const keys = (select?.props.options as {key: string}[]).map(option => option.key);
    // NONE / FLASH / SDCARD / SERIAL and nothing else.
    expect(keys).toEqual(['0', '1', '2', '3']);
    act(() => tree.unmount());
  });

  it('keeps an unknown debug mode as an unknown mode carrying its raw value', async () => {
    // 96 is where the two verified firmware revisions disagree.
    const tree = await render(
      portFor(snapshotOf({debugMode: 96, debugModeCount: 102})),
    );
    const select = tree.root
      .findAllByProps({testID: 'blackbox-debug-select'})
      .find(node => Array.isArray(node.props.options));
    const options = select?.props.options as {key: string; label: string}[];
    const current = options.find(option => option.key === '96');
    expect(current?.label).toContain('96');
    // And no name is invented for it.
    expect(current?.label).not.toContain('CHIRP');
    expect(current?.label).not.toContain('AUTOPILOT_POSITION');
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 12-14. DRAFT vs PERSISTED, AND THE DIRTY GATE
 * ================================================================== */

describe('draft and persisted state', () => {
  it('keeps showing the PERSISTED destination while a draft is pending', async () => {
    const tree = await render(portFor(snapshotOf({deviceRaw: 1})));
    selectOption(tree, 'blackbox-device-select', '2');
    // The status block still reports the board's own value...
    expect(textIn(tree, 'blackbox-persisted-device')).toContain(
      ar.blackbox.device.FLASH,
    );
    // ...and the draft is announced separately, as a future.
    expect(has(tree, 'blackbox-draft-notice')).toBe(true);
    expect(textIn(tree, 'blackbox-draft-notice')).toContain(ar.blackbox.device.SDCARD);
    act(() => tree.unmount());
  });

  it('offers no save at all when nothing changed', async () => {
    const tree = await render(portFor(snapshotOf()));
    const bar = tree.root
      .findAllByProps({testID: 'blackbox-save-bar'})
      .find(node => typeof node.props.visible === 'boolean');
    expect(bar?.props.visible).toBe(false);
    act(() => tree.unmount());
  });

  it('offers a save once an owned field genuinely differs', async () => {
    const tree = await render(portFor(snapshotOf({sampleRateRaw: 0})));
    selectOption(tree, 'blackbox-rate-select', '2');
    const bar = tree.root
      .findAllByProps({testID: 'blackbox-save-bar'})
      .find(node => typeof node.props.visible === 'boolean');
    expect(bar?.props.visible).toBe(true);
    act(() => tree.unmount());
  });

  it('withdraws the save when the draft is put back to the persisted value', async () => {
    const tree = await render(portFor(snapshotOf({sampleRateRaw: 0})));
    selectOption(tree, 'blackbox-rate-select', '2');
    selectOption(tree, 'blackbox-rate-select', '0');
    const bar = tree.root
      .findAllByProps({testID: 'blackbox-save-bar'})
      .find(node => typeof node.props.visible === 'boolean');
    expect(bar?.props.visible).toBe(false);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 15-18. SAVE - NO SUCCESS WITHOUT PROOF
 * ================================================================== */

describe('saving', () => {
  it('never says saved when the board acknowledged and changed nothing', async () => {
    const snapshot = snapshotOf({deviceRaw: 1});
    const port = portFor(snapshot, {
      save: jest.fn(async () => ({
        kind: 'READBACK_MISMATCH' as const,
        stage: 'BLACKBOX' as const,
        expected: {deviceRaw: 2, sampleRateRaw: 0, disabledFieldsMask: 0, debugMode: 0},
        observed: {deviceRaw: 1, sampleRateRaw: 0, disabledFieldsMask: 0, debugMode: 0},
      })),
    });
    const tree = await render(port);
    selectOption(tree, 'blackbox-device-select', '2');
    await act(async () => {
      press(tree, 'blackbox-save-bar-save');
      await Promise.resolve();
    });
    const line = textIn(tree, 'blackbox-status-line');
    expect(line).toContain(ar.blackbox.outcome.readbackMismatch);
    expect(line).not.toContain(ar.blackbox.outcome.saved);
    act(() => tree.unmount());
  });

  it('never says saved on a persistence mismatch, and offers a re-read', async () => {
    const snapshot = snapshotOf();
    const expected = {
      deviceRaw: 2,
      sampleRateRaw: 0,
      disabledFieldsMask: 0,
      debugMode: 0,
    };
    blackboxPendingSave.set({
      sessionId: 'fc',
      writtenOnGeneration: 1,
      expected,
      debugModeChanged: false,
    });
    const port = portFor(snapshot, {
      verifyPersistence: jest.fn(async () => ({
        kind: 'PERSISTENCE_MISMATCH' as const,
        expected,
        observed: {...expected, deviceRaw: 1},
      })),
    });
    // Generation 2 - a genuinely NEW session, which is the only kind that
    // may answer the token.
    const tree = await render(port, {generation: 2});
    const line = textIn(tree, 'blackbox-status-line');
    expect(line).toContain(ar.blackbox.outcome.persistenceMismatch);
    expect(line).not.toContain(ar.blackbox.outcome.saved);
    expect(has(tree, 'blackbox-reread')).toBe(true);
    act(() => tree.unmount());
  });

  it('says saved only after the post-reboot readback succeeded', async () => {
    const snapshot = snapshotOf({deviceRaw: 2});
    blackboxPendingSave.set({
      sessionId: 'fc',
      writtenOnGeneration: 1,
      expected: {deviceRaw: 2, sampleRateRaw: 0, disabledFieldsMask: 0, debugMode: 0},
      debugModeChanged: false,
    });
    const verify = jest.fn(async () => ({kind: 'SUCCEEDED' as const, snapshot}));
    const tree = await render(portFor(snapshot, {verifyPersistence: verify}), {
      generation: 2,
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(textIn(tree, 'blackbox-status-line')).toContain(ar.blackbox.outcome.saved);
    act(() => tree.unmount());
  });

  it('does not verify against the session the write happened on', async () => {
    const snapshot = snapshotOf();
    blackboxPendingSave.set({
      sessionId: 'fc',
      writtenOnGeneration: 7,
      expected: {deviceRaw: 2, sampleRateRaw: 0, disabledFieldsMask: 0, debugMode: 0},
      debugModeChanged: false,
    });
    const verify = jest.fn(async () => ({kind: 'SUCCEEDED' as const, snapshot}));
    // Same generation as the write: verifying here would read the RAM the
    // write already changed and prove nothing.
    const tree = await render(portFor(snapshot, {verifyPersistence: verify}), {
      generation: 7,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(textOf(tree)).not.toContain(ar.blackbox.outcome.saved);
    act(() => tree.unmount());
  });

  it('names the real save stage rather than a timed animation', async () => {
    const snapshot = snapshotOf();
    let publish: ((stage: 'SENDING' | 'VERIFYING_APPLY' | 'PERSISTING') => void) | undefined;
    const port = portFor(snapshot, {
      save: jest.fn(
        (_key, _observed, _draft, onProgress) =>
          new Promise(() => {
            publish = onProgress;
          }),
      ) as BlackboxControllerPort['save'],
    });
    const tree = await render(port);
    selectOption(tree, 'blackbox-device-select', '2');
    await act(async () => {
      press(tree, 'blackbox-save-bar-save');
      await Promise.resolve();
    });
    expect(textOf(tree)).toContain(ar.blackbox.saveStage.SENDING);
    await act(async () => {
      publish?.('VERIFYING_APPLY');
      await Promise.resolve();
    });
    expect(textOf(tree)).toContain(ar.blackbox.saveStage.VERIFYING_APPLY);
    await act(async () => {
      publish?.('PERSISTING');
      await Promise.resolve();
    });
    expect(textOf(tree)).toContain(ar.blackbox.saveStage.PERSISTING);
    // And no success has appeared anywhere along the way.
    expect(textOf(tree)).not.toContain(ar.blackbox.outcome.saved);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 19-22. ERASE
 * ================================================================== */

describe('erasing the onboard flash', () => {
  it('offers the erase only when the PERSISTED destination is flash', async () => {
    // Persisted SDCARD, flash present and holding data. The firmware would
    // erase nothing, so nothing may be offered.
    const tree = await render(portFor(snapshotOf({deviceRaw: 2})));
    expect(has(tree, 'blackbox-erase-button')).toBe(false);
    act(() => tree.unmount());
  });

  it('explains that the destination must be SAVED before it can be erased', async () => {
    const tree = await render(portFor(snapshotOf({deviceRaw: 2})));
    selectOption(tree, 'blackbox-device-select', '1');
    expect(textIn(tree, 'blackbox-erase-needs-save')).toContain(
      ar.blackbox.eraseNeedsSavedDevice,
    );
    expect(has(tree, 'blackbox-erase-button')).toBe(false);
    act(() => tree.unmount());
  });

  it('offers no erase for a volume that is already empty', async () => {
    const tree = await render(portFor(portSnapshotEmptyFlash()));
    expect(has(tree, 'blackbox-erase-button')).toBe(false);
    act(() => tree.unmount());
  });

  it('asks once, clearly, before erasing anything', async () => {
    const erase = jest.fn(
      (): BlackboxEraseObservation => ({
        result: new Promise<BlackboxEraseOutcome>(() => undefined),
        cancel: () => undefined,
      }),
    );
    const tree = await render(portFor(snapshotOf(), {eraseDataflash: erase}));
    press(tree, 'blackbox-erase-button');
    // Nothing destructive has been sent yet.
    expect(erase).not.toHaveBeenCalled();
    const dialog = textIn(tree, 'blackbox-erase-dialog');
    expect(dialog).toContain(ar.blackbox.eraseConfirmTitle);
    expect(dialog).toContain(ar.blackbox.eraseConfirmBody);
    expect(dialog).toContain(ar.blackbox.eraseConfirmCancel);
    expect(dialog).toContain(ar.blackbox.eraseConfirmAccept);
    // ONE confirmation. No checkbox, no typed word, no long press.
    press(tree, 'blackbox-erase-confirm');
    expect(erase).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('cancelling the dialog sends nothing', async () => {
    const erase = jest.fn(
      (): BlackboxEraseObservation => ({
        result: new Promise<BlackboxEraseOutcome>(() => undefined),
        cancel: () => undefined,
      }),
    );
    const tree = await render(portFor(snapshotOf(), {eraseDataflash: erase}));
    press(tree, 'blackbox-erase-button');
    press(tree, 'blackbox-erase-cancel');
    expect(erase).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  /**
   * ELAPSED TIME IS MEASURED, PROGRESS IS NOT.
   *
   * The two captions come from the controller's own progress seam - the
   * erase command going out, and its acknowledgement - so they name the
   * real step rather than following a timer. The clock is the screen's
   * injected `now`, so the reading is a subtraction of two real instants
   * and never an estimate. What must NOT appear is anything shaped like
   * completion: no percentage, no fraction, no bar.
   */
  it('names the real erase step and shows real elapsed time, with no progress', async () => {
    let clock = 1_000_000;
    let publish: ((progress: 'REQUESTED' | 'OBSERVING') => void) | undefined;
    const tree = await render(
      portFor(snapshotOf(), {
        eraseDataflash: jest.fn(
          (_key, _snapshot, onProgress): BlackboxEraseObservation => {
            publish = onProgress;
            return {
              result: new Promise<BlackboxEraseOutcome>(() => undefined),
              cancel: () => undefined,
            };
          },
        ) as BlackboxControllerPort['eraseDataflash'],
      }),
      {now: () => clock},
    );
    press(tree, 'blackbox-erase-button');
    press(tree, 'blackbox-erase-confirm');
    expect(textIn(tree, 'blackbox-erase-progress')).toContain(
      ar.blackbox.eraseStarting,
    );
    // Zero real seconds have passed, and that is what it says.
    expect(textIn(tree, 'blackbox-erase-elapsed')).toBe('00:00');

    // The board acknowledged: the caption moves on because the STEP did.
    act(() => publish?.('OBSERVING'));
    expect(textIn(tree, 'blackbox-erase-progress')).toContain(
      ar.blackbox.eraseRunning,
    );

    // Seventeen real seconds later, from the same real clock.
    clock += 17_000;
    act(() => publish?.('OBSERVING'));
    expect(textIn(tree, 'blackbox-erase-elapsed')).toBe('00:17');

    // No percentage, no fraction, no bar - the firmware publishes none.
    const text = textIn(tree, 'blackbox-erase-progress');
    expect(text).not.toContain('%');
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(has(tree, 'blackbox-flash-bar')).toBe(false);
    act(() => tree.unmount());
  });

  it('never calls a stopped watch a cancelled erase', async () => {
    let settle: ((outcome: BlackboxEraseOutcome) => void) | undefined;
    const tree = await render(
      portFor(snapshotOf(), {
        eraseDataflash: jest.fn(
          (): BlackboxEraseObservation => ({
            result: new Promise<BlackboxEraseOutcome>(resolve => {
              settle = resolve;
            }),
            cancel: () => undefined,
          }),
        ),
      }),
    );
    press(tree, 'blackbox-erase-button');
    press(tree, 'blackbox-erase-confirm');
    await act(async () => {
      settle?.({kind: 'OBSERVATION_CANCELLED', boardMayStillBeErasing: true});
      await Promise.resolve();
    });
    const outcome = textIn(tree, 'blackbox-erase-outcome');
    expect(outcome).toBe(ar.blackbox.erase.observationCancelled);
    // It must say the BOARD may still be working, not that the erase stopped.
    expect(outcome).toContain('قد يستمر المتحكم');
    act(() => tree.unmount());
  });

  it('never calls a lost link a failed erase', async () => {
    let settle: ((outcome: BlackboxEraseOutcome) => void) | undefined;
    const tree = await render(
      portFor(snapshotOf(), {
        eraseDataflash: jest.fn(
          (): BlackboxEraseObservation => ({
            result: new Promise<BlackboxEraseOutcome>(resolve => {
              settle = resolve;
            }),
            cancel: () => undefined,
          }),
        ),
      }),
    );
    press(tree, 'blackbox-erase-button');
    press(tree, 'blackbox-erase-confirm');
    await act(async () => {
      settle?.({kind: 'LINK_LOST'});
      await Promise.resolve();
    });
    expect(textIn(tree, 'blackbox-erase-outcome')).toBe(ar.blackbox.erase.linkLost);
    expect(textOf(tree)).not.toContain(ar.blackbox.erase.failed);
    act(() => tree.unmount());
  });

  it('never calls a timeout a failure', async () => {
    let settle: ((outcome: BlackboxEraseOutcome) => void) | undefined;
    const tree = await render(
      portFor(snapshotOf(), {
        eraseDataflash: jest.fn(
          (): BlackboxEraseObservation => ({
            result: new Promise<BlackboxEraseOutcome>(resolve => {
              settle = resolve;
            }),
            cancel: () => undefined,
          }),
        ),
      }),
    );
    press(tree, 'blackbox-erase-button');
    press(tree, 'blackbox-erase-confirm');
    await act(async () => {
      settle?.({kind: 'TIMED_OUT', elapsedMs: 120_000});
      await Promise.resolve();
    });
    const outcome = textIn(tree, 'blackbox-erase-outcome');
    expect(outcome).toBe(ar.blackbox.erase.timedOut);
    expect(outcome).toContain('قد يظل المتحكم يعمل');
    act(() => tree.unmount());
  });

  it('renders the new observed truth after a successful erase', async () => {
    let settle: ((outcome: BlackboxEraseOutcome) => void) | undefined;
    const tree = await render(
      portFor(snapshotOf(), {
        eraseDataflash: jest.fn(
          (): BlackboxEraseObservation => ({
            result: new Promise<BlackboxEraseOutcome>(resolve => {
              settle = resolve;
            }),
            cancel: () => undefined,
          }),
        ),
      }),
    );
    press(tree, 'blackbox-erase-button');
    press(tree, 'blackbox-erase-confirm');
    await act(async () => {
      settle?.({
        kind: 'SUCCEEDED',
        dataflash: classifyDataflash({
          flagsRaw: 3,
          supported: true,
          ready: true,
          sectorCount: 256,
          totalBytes: SIXTEEN_MIB,
          usedBytes: 0,
        }),
      });
      await Promise.resolve();
    });
    const card = textIn(tree, 'blackbox-flash');
    expect(card).toContain(ar.blackbox.flashState.READY_EMPTY);
    // The TOTAL survives the erase; only the used figure went to zero.
    expect(textIn(tree, 'blackbox-flash-usage')).toContain('16');
    expect(textIn(tree, 'blackbox-flash-usage')).toContain('0');
    // And with nothing stored, there is nothing left to erase.
    expect(has(tree, 'blackbox-erase-button')).toBe(false);
    act(() => tree.unmount());
  });

  it('stops watching, and sends nothing, when the screen goes away mid-erase', async () => {
    const cancel = jest.fn();
    const tree = await render(
      portFor(snapshotOf(), {
        eraseDataflash: jest.fn(
          (): BlackboxEraseObservation => ({
            result: new Promise<BlackboxEraseOutcome>(() => undefined),
            cancel,
          }),
        ),
      }),
    );
    press(tree, 'blackbox-erase-button');
    press(tree, 'blackbox-erase-confirm');
    act(() => tree.unmount());
    // The local watch is released. No "stop erasing" command exists in the
    // firmware and none is invented here.
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== *
 * NO FALSE LIVENESS - the claim this screen must never make
 * ================================================================== */

describe('liveness claims', () => {
  it('never says the board is recording, on any storage state', async () => {
    const cases: BlackboxSnapshot[] = [
      snapshotOf({deviceRaw: 1}),
      snapshotOf({deviceRaw: 2, sd: {configured: true, stateRaw: 4, freeKilobytes: 10, totalKilobytes: 20}}),
      snapshotOf({deviceRaw: 3}),
      portSnapshotEmptyFlash(),
    ];
    for (const snapshot of cases) {
      const tree = await render(portFor(snapshot));
      const text = textOf(tree);
      for (const forbidden of [
        'يسجّل الآن',
        'يسجل الآن',
        'جارٍ التسجيل',
        'تم تسجيل رحلتك',
        'آخر تسجيل ناجح',
        'مباشر',
      ]) {
        expect(text).not.toContain(forbidden);
      }
      act(() => tree.unmount());
    }
  });

  it('offers no viewer, no download and no mass storage anywhere', async () => {
    const tree = await render(portFor(snapshotOf()));
    const text = textOf(tree);
    for (const forbidden of ['العارض', 'تنزيل', 'تحميل السجل', 'MSC', 'Mass Storage']) {
      expect(text).not.toContain(forbidden);
    }
    act(() => tree.unmount());
  });

  it('shows no frequency in kilohertz, because none is on the wire', async () => {
    for (const sampleRateRaw of [0, 1, 2, 3, 4]) {
      const tree = await render(portFor(snapshotOf({sampleRateRaw})));
      const text = textOf(tree);
      expect(text).not.toContain('kHz');
      expect(text).not.toContain('كيلوهرتز · ');
      act(() => tree.unmount());
    }
  });
});
