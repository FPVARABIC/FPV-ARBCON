/* The census walks rendered nodes of many screen types; their prop
   shapes are not a single union and narrowing each one would obscure
   the oracle, so `any` is used deliberately below. */
/**
 * THE 44px TOUCH FLOOR, MEASURED ON THE CONTROL THAT RECEIVES THE PRESS.
 *
 * Every one of these controls rendered under the floor while a test
 * asserting `MIN_TOUCH_TARGET` as a SOURCE SUBSTRING stayed green in CI.
 * That is the failure this file exists to prevent, so two rules govern
 * it:
 *
 *   1. It reads the RESOLVED style of the node carrying `onPress` - the
 *      element a press actually lands on - not source text, not a
 *      StyleSheet object, and never an inner <Text> or icon. In React
 *      Native the resolved style IS the layout contract; there is no
 *      cascade to inherit a height from.
 *   2. Every control this phase repaired is named in an explicit
 *      inventory and must DECLARE the floor. Eleven of the eighteen
 *      declared nothing at all and drew their 42px from padding plus a
 *      line box, so "it renders tall enough today" is not the contract -
 *      stating the floor is.
 *
 * jsdom has no layout engine, so `getBoundingClientRect` here would
 * return zeros and prove nothing. The rendered-geometry half of this
 * proof is the Chromium sweep; this is the half that runs in CI.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import { MIN_TOUCH_TARGET } from '../components/controls';

jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => ({ status: 'IDLE' }),
  useMspRecoveryState: () => 'READY',
}));

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import ModesScreen from './ModesScreen';
import PresetsScreen from './PresetsScreen';
import { MotorAirframeControls } from './MotorAirframeControls';
import { FirmwareChoice } from '../components/firmware';
import FirmwareFlasherScreen from './FirmwareFlasherScreen';

const KEY = { sessionId: 'touch-floor', generation: 1 } as const;

/**
 * THE CONTROLS R-4 REPAIRED, by the identity each renders under.
 *
 * Named rather than inferred: a census alone would go quiet the moment a
 * fixture stopped rendering one of them, and six of these are only
 * reachable in a state the global sweep never produced.
 */
const REPAIRED_MODES = ['modes-add-range-0', 'modes-add-range-1', 'حذف'];
const REPAIRED_PRESETS = [
  'الكل', 'Tune', 'Rates', 'Filters', 'RC Link', 'Modes',
  'OSD', 'VTX', 'LEDs', 'BNF', 'Other',
];
const REPAIRED_MOTORS = ['motors-airframe-retry'];
const REPAIRED_FLASHER_CHOICE = ['choice-online', 'choice-local'];
const REPAIRED_FLASHER_STEPS = ['firmware-step-board', 'firmware-step-flash'];

interface Measured {
  readonly id: string;
  readonly height: number | undefined;
  readonly source: 'height' | 'minHeight' | 'none';
}

/** The label a control renders, dug out of its descendants - a
 *  Pressable's own `children` is an element, not the string. */
function labelOf(node: ReactTestRenderer.ReactTestInstance): string {
  const texts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      texts.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value !== null && typeof value === 'object' && 'props' in (value as any))
      walk((value as any).props?.children);
  };
  walk((node.props as any).children);
  return texts.filter(t => t.length > 0)[0] ?? '<unnamed>';
}

/** Everything the screen currently says, for the "did it actually
 *  load?" guards - a screen measured in its error state measures the
 *  wrong screen. */
function allText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => {
      const value = (node.props as any).children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

/**
 * The census. Walks the rendered tree for nodes that actually receive a
 * press and reports the height each one declares.
 *
 * `onPress` is the discriminator on purpose: it is carried by the
 * Pressable, never by the Text or Icon inside it, so the oracle cannot
 * drift onto a visual child.
 */
function measureControls(
  renderer: ReactTestRenderer.ReactTestRenderer,
): Measured[] {
  const out: Measured[] = [];
  const nodes = renderer.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      typeof (node.props as any)?.onPress === 'function',
    { deep: true },
  );
  for (const node of nodes) {
    const props = node.props as any;
    /* Pressable accepts a style FUNCTION; call it in the resting state
       so what is measured is what a resting control actually renders. */
    const raw =
      typeof props.style === 'function'
        ? props.style({ pressed: false, hovered: false, focused: false })
        : props.style;
    const flat = (StyleSheet.flatten(raw) ?? {}) as {
      height?: number;
      minHeight?: number;
    };
    const id: string =
      props.testID ?? props.accessibilityLabel ?? labelOf(node);
    if (typeof flat.height === 'number')
      out.push({ id, height: flat.height, source: 'height' });
    else if (typeof flat.minHeight === 'number')
      out.push({ id, height: flat.minHeight, source: 'minHeight' });
    else out.push({ id, height: undefined, source: 'none' });
  }
  return out;
}

/**
 * TWO CHECKS, BECAUSE "NO DECLARED HEIGHT" MEANS TWO DIFFERENT THINGS.
 *
 * For a control this phase repaired, an absent declaration is a
 * regression: we know it needs the floor, and eleven of them previously
 * drew 42px from padding alone. For any other control it is simply not
 * statically decidable - some render well above the floor from their own
 * content, and calling those failures would be a false alarm the
 * Chromium sweep contradicts. Those are judged by rendered geometry
 * instead, not by this file.
 *
 * So: anything that DECLARES a short height fails here, and every named
 * member of the repaired inventory must declare the floor explicitly.
 */
function offenders(measured: readonly Measured[]): string[] {
  return measured
    .filter(m => m.height !== undefined && m.height < MIN_TOUCH_TARGET)
    .map(m => `${m.id} = ${m.height!}px`);
}

function inventoryOffenders(
  measured: readonly Measured[],
  repaired: readonly string[],
): string[] {
  const out: string[] = [];
  for (const id of repaired) {
    const hits = measured.filter(m => m.id === id);
    if (hits.length === 0) continue; // not rendered in this state
    for (const hit of hits) {
      if (hit.height === undefined)
        out.push(`${id} = no declared height (repaired control must state the floor)`);
      else if (hit.height < MIN_TOUCH_TARGET) out.push(`${id} = ${hit.height}px`);
    }
  }
  return out;
}

async function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(element);
  });
  /* A SECOND act pass, deliberately. A screen that loads asynchronously
     resolves its promise only after the creating act closes, so a
     single pass leaves it in LOADING and the states this file exists to
     measure never render. Each case below asserts its control is
     actually present, so an under-flushed render fails loudly rather
     than passing on a spinner. */
  for (let pass = 0; pass < 3; pass += 1)
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
    });
  return renderer;
}

/* ------------------------------------------------------------------ */
/* MODES                                                               */
/* ------------------------------------------------------------------ */

const MODES_DEFINITIONS = [
  { name: 'ARM', permanentId: 0, flagIndex: 0 },
  { name: 'ANGLE', permanentId: 1, flagIndex: 1 },
  { name: 'BEEPER', permanentId: 13, flagIndex: 2 },
];
const emptySlot = () => ({
  permanentId: 0, auxChannelIndex: 0, start: 900, end: 900,
  logic: 0 as const, linkedTo: 0, outOfRange: false,
});

function modesController(configured: boolean) {
  const slots = Array.from({ length: 20 }, emptySlot);
  if (configured) {
    /* A real AUX range, so the per-condition remove control renders.
       The stock fixture leaves every slot at start=end=900 and never
       draws it - which is exactly why the global sweep never saw it. */
    slots[0] = {
      permanentId: 1, auxChannelIndex: 0, start: 1300, end: 1700,
      logic: 0 as const, linkedTo: 0, outOfRange: false,
    };
  }
  const snapshot = {
    definitions: MODES_DEFINITIONS, capacity: 20, unknownIds: [], slots,
  };
  return {
    load: jest.fn(async () => ({ kind: 'LOADED' as const, snapshot })),
    save: jest.fn(async () => ({ kind: 'NO_CHANGES' as const, snapshot })),
  } as any;
}

describe('Modes: every pressable meets the touch floor', () => {
  it('with no ranges configured', async () => {
    const renderer = await render(
      <ModesScreen
        sessionKey={KEY}
        active
        onOpenMotors={() => undefined}
        controller={modesController(false)}
      />,
    );
    const measured = measureControls(renderer);
    expect(measured.length).toBeGreaterThan(0);
    expect(offenders(measured)).toEqual([]);
    expect(inventoryOffenders(measured, REPAIRED_MODES)).toEqual([]);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('with a configured AUX range, which is the only way the remove control renders', async () => {
    const renderer = await render(
      <ModesScreen
        sessionKey={KEY}
        active
        onOpenMotors={() => undefined}
        controller={modesController(true)}
      />,
    );
    const measured = measureControls(renderer);
    /* Prove the fixture actually produced the control this case exists
       for; otherwise a green result would mean nothing. */
    const removeLabels = measured.filter(m => m.id === 'حذف');
    expect(removeLabels.length).toBeGreaterThan(0);
    expect(offenders(measured)).toEqual([]);
    expect(inventoryOffenders(measured, REPAIRED_MODES)).toEqual([]);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});

/* ------------------------------------------------------------------ */
/* PRESETS                                                             */
/* ------------------------------------------------------------------ */

const PRESET_SUMMARY = {
  fullPath: 'presets/2025.12/tune/test.txt',
  hash: 'a'.repeat(64),
  title: 'Verified tune',
  firmwareVersions: ['2025.12'],
  category: 'TUNE',
  status: 'OFFICIAL',
  rawCategory: 'TUNE',
  rawStatus: 'OFFICIAL',
  keywords: ['five-inch'],
  author: 'Betaflight',
  forceOptionsReview: true,
  priority: 10,
};

function presetsPorts() {
  const repository = {
    loadIndex: jest.fn(async () => ({
      majorVersion: 1, minorVersion: 0,
      presets: [PRESET_SUMMARY], rejectedCount: 0,
    })),
    loadFirmwareVersion: jest.fn(async () => ({
      year: 2025, month: 12, patch: 5,
      versionString: '2025.12.5', suffix: null,
    })),
    loadPreset: jest.fn(async () => undefined),
    commands: jest.fn(() => []),
  } as any;
  const cli = {
    getPhase: jest.fn(() => 'IDLE'),
    begin: jest.fn(async () => undefined),
    captureDiffAll: jest.fn(async () => '# diff all\n'),
    saveTextFile: jest.fn(async () => true),
    executeBatch: jest.fn(async () => ({ commandCount: 0, errors: [] })),
    saveAndClose: jest.fn(async () => undefined),
    exitWithoutSave: jest.fn(async () => undefined),
  } as any;
  return { repository, cli };
}

describe('Presets: every pressable meets the touch floor', () => {
  it('including the eleven category chips, which declare no height of their own', async () => {
    const { repository, cli } = presetsPorts();
    const renderer = await render(
      <PresetsScreen
        sessionKey={KEY}
        active
        repository={repository}
        cli={cli}
        onCliBusyChange={() => undefined}
      />,
    );
    /* THE SCREEN MUST HAVE LOADED. The chips render on the error path
       too, so without this the whole case would happily measure a
       failed screen - which it silently did until a screenshot showed
       «r.loadFirmwareVersion is not a function» where the catalogue
       should have been. A stub whose method names have drifted from the
       port now fails here instead of being measured. */
    expect(allText(renderer)).not.toMatch(/is not a function/);
    expect(allText(renderer)).toContain('الحزم المتوافقة (1)');

    const measured = measureControls(renderer);
    /* The chips are the reason this case exists: eleven controls whose
       height came from padding alone. If the fixture stops rendering
       them the assertion below would pass vacuously. */
    expect(measured.length).toBeGreaterThanOrEqual(11);
    expect(offenders(measured)).toEqual([]);
    /* Every chip present AND declaring the floor - not merely absent. */
    const seen = measured.map(m => m.id);
    for (const chip of REPAIRED_PRESETS) expect(seen).toContain(chip);
    expect(inventoryOffenders(measured, REPAIRED_PRESETS)).toEqual([]);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});

/* ------------------------------------------------------------------ */
/* THE ORACLE ITSELF                                                   */
/* ------------------------------------------------------------------ */

describe('the census measures the pressable, not its visual child', () => {
  it('requires a REPAIRED control to declare the floor, not merely render tall', () => {
    expect(
      inventoryOffenders([{ id: 'x', height: undefined, source: 'none' }], ['x']),
    ).toEqual(['x = no declared height (repaired control must state the floor)']);
  });

  it('does not fail an unrepaired control that simply declares nothing', () => {
    /* modes-add-link-* declare no height and render well above the floor
       in Chromium; calling them failures here would be a false alarm the
       rendered measurement contradicts. */
    expect(offenders([{ id: 'modes-add-link-1', height: undefined, source: 'none' }]))
      .toEqual([]);
  });

  it('names the offender and its measured size', () => {
    expect(
      offenders([{ id: 'firmware-source-online', height: 39, source: 'minHeight' }]),
    ).toEqual(['firmware-source-online = 39px']);
  });

  it('accepts exactly the floor and rejects one pixel under it', () => {
    expect(offenders([{ id: 'a', height: 44, source: 'minHeight' }])).toEqual([]);
    expect(offenders([{ id: 'b', height: 43, source: 'minHeight' }])).toEqual([
      'b = 43px',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* MOTORS - the retry, which renders only after a failed read          */
/* ------------------------------------------------------------------ */

/*
 * Reaching UNAVAILABLE needs `onTopology`. It is a REQUIRED prop, and the
 * failure path calls `onTopology(undefined)` BEFORE it sets the state -
 * so omitting it makes `load()` reject, the outcome is swallowed by the
 * caller's `.catch()`, and the screen sits in LOADING forever while a
 * test that only asked "did it render" would pass. Every case here
 * asserts the retry is actually on screen for exactly that reason.
 */
describe('Motors: the airframe retry meets the touch floor', () => {
  function mountUnavailable() {
    const load = jest.fn(async () => {
      throw new Error('link down');
    });
    const controller = { load, save: jest.fn(), requestReboot: jest.fn() } as any;
    return {
      load,
      element: (
        <MotorAirframeControls
          sessionId="touch-floor"
          liveMixerModeRaw={3}
          liveYawMotorsReversed={false}
          writesLocked={false}
          directionOpen={false}
          reorderOpen={false}
          onToggleDirection={() => undefined}
          onToggleReorder={() => undefined}
          onTopology={() => undefined}
          controller={controller}
        />
      ),
    };
  }

  it('declares the floor in the UNAVAILABLE state, the only state that draws it', async () => {
    const { element } = mountUnavailable();
    const renderer = await render(element);
    const measured = measureControls(renderer);
    expect(measured.map(m => m.id)).toContain('motors-airframe-retry');
    expect(offenders(measured)).toEqual([]);
    expect(inventoryOffenders(measured, REPAIRED_MOTORS)).toEqual([]);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('mounting reads once and never retries by itself', async () => {
    const { load, element } = mountUnavailable();
    const renderer = await render(element);
    /* Layout is not an action: arriving on the screen performs the one
       read the screen exists to make, and nothing more. */
    expect(load).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('pressing the retry re-reads, so the enlarged target is still wired', async () => {
    const { load, element } = mountUnavailable();
    const renderer = await render(element);
    const retry = renderer.root.findAllByProps({
      testID: 'motors-airframe-retry',
    })[0];
    await ReactTestRenderer.act(async () => {
      retry.props.onPress();
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(2);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});

/* ------------------------------------------------------------------ */
/* THE FREEZE - enlarging a target changed nothing else                */
/* ------------------------------------------------------------------ */

/**
 * A height is the only thing this phase was allowed to change. Two ways
 * that could have gone wrong, and one case each:
 *
 *   BEHAVIOUR  a repaired control that no longer does its job. Each one
 *              is pressed and the resulting state change asserted, so a
 *              bigger button that stopped working fails here.
 *   SIDE       a screen that WRITES on mount. None of these screens may
 *              save, reboot, flash, or drive a motor merely because it
 *              was rendered - laying out is not an action. Asserted as
 *              zero calls on every writing port the screen is given.
 */
function pressableWithTestID(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): ReactTestRenderer.ReactTestInstance {
  const node = renderer.root
    .findAllByProps({ testID })
    .find(n => typeof (n.props as any).onPress === 'function');
  if (node === undefined) throw new Error(`no pressable ${testID}`);
  return node;
}

/** The resolved style of a control, in its resting state. */
function styleOf(node: ReactTestRenderer.ReactTestInstance): any {
  const raw = (node.props as any).style;
  return StyleSheet.flatten(
    typeof raw === 'function'
      ? raw({ pressed: false, hovered: false, focused: false })
      : raw,
  );
}

describe('the repaired controls still do their job, and mounting writes nothing', () => {
  it('Modes: adding a range from the enlarged button really adds one', async () => {
    const controller = modesController(false);
    const renderer = await render(
      <ModesScreen
        sessionKey={KEY}
        active
        onOpenMotors={() => undefined}
        controller={controller}
      />,
    );
    /* No range yet, so no remove control. */
    expect(measureControls(renderer).map(m => m.id)).not.toContain('حذف');
    await ReactTestRenderer.act(async () => {
      pressableWithTestID(renderer, 'modes-add-range-1').props.onPress();
      await Promise.resolve();
    });
    /* One appeared: the enlarged add button is still wired. */
    expect(measureControls(renderer).map(m => m.id)).toContain('حذف');
    /* And drawing the screen wrote nothing to the board. */
    expect(controller.save).not.toHaveBeenCalled();
    expect(controller.load).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('Presets: the enlarged chip still changes the selected category', async () => {
    const { repository, cli } = presetsPorts();
    const renderer = await render(
      <PresetsScreen
        sessionKey={KEY}
        active
        repository={repository}
        cli={cli}
        onCliBusyChange={() => undefined}
      />,
    );
    const chipFor = (label: string) =>
      measureControls(renderer).find(m => m.id === label);
    expect(chipFor('Tune')).toBeDefined();
    const tune = renderer.root
      .findAll(
        n =>
          typeof n.type !== 'string' &&
          typeof (n.props as any)?.onPress === 'function',
        { deep: true },
      )
      .find(n => labelOf(n) === 'Tune')!;
    const before = styleOf(tune).backgroundColor;
    await ReactTestRenderer.act(async () => {
      tune.props.onPress();
      await Promise.resolve();
    });
    const after = styleOf(
      renderer.root
        .findAll(
          n =>
            typeof n.type !== 'string' &&
            typeof (n.props as any)?.onPress === 'function',
          { deep: true },
        )
        .find(n => labelOf(n) === 'Tune')!,
    ).backgroundColor;
    /* Selection moved - the chip is a control, not a label. */
    expect(after).not.toEqual(before);
    /* Nothing was written, nothing was executed, no CLI session opened. */
    expect(cli.begin).not.toHaveBeenCalled();
    expect(cli.executeBatch).not.toHaveBeenCalled();
    expect(cli.saveAndClose).not.toHaveBeenCalled();
    expect(cli.saveTextFile).not.toHaveBeenCalled();
    expect(repository.loadPreset).not.toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('Motors: mounting the failed-read state saves nothing and reboots nothing', async () => {
    const load = jest.fn(async () => {
      throw new Error('link down');
    });
    const save = jest.fn();
    const requestReboot = jest.fn();
    const renderer = await render(
      <MotorAirframeControls
        sessionId="touch-floor"
        liveMixerModeRaw={3}
        liveYawMotorsReversed={false}
        writesLocked={false}
        directionOpen={false}
        reorderOpen={false}
        onToggleDirection={() => undefined}
        onToggleReorder={() => undefined}
        onTopology={() => undefined}
        controller={{ load, save, requestReboot } as any}
      />,
    );
    expect(measureControls(renderer).map(m => m.id)).toContain(
      'motors-airframe-retry',
    );
    expect(save).not.toHaveBeenCalled();
    expect(requestReboot).not.toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('Flasher: mounting never flashes, never writes a file, never opens a picker', async () => {
    const client = {
      listDevices: jest.fn(async () => []),
      listDfuDevices: jest.fn(async () => []),
      onDeviceAttached: jest.fn(() => jest.fn()),
      onDeviceDetached: jest.fn(() => jest.fn()),
      onDfuFlashProgress: jest.fn(() => jest.fn()),
      cancelDfuFlash: jest.fn(async () => undefined),
      flashDfuFirmware: jest.fn(async () => undefined),
      saveFirmwareFile: jest.fn(async () => true),
      pickFirmwareFile: jest.fn(async () => null),
      unprotectDfuDevice: jest.fn(async () => undefined),
      exitDfuMode: jest.fn(async () => undefined),
    } as any;
    const buildApi = {
      loadTargets: jest.fn(async () => []),
      loadTargetReleases: jest.fn(),
      loadOptions: jest.fn(),
      loadBuild: jest.fn(),
      loadCommits: jest.fn(),
      loadBuildLog: jest.fn(async () => ''),
      requestBuild: jest.fn(),
    } as any;
    const renderer = await render(
      <FirmwareFlasherScreen client={client} buildApi={buildApi} />,
    );
    expect(measureControls(renderer).map(m => m.id)).toContain(
      'firmware-step-board',
    );
    /* The one irreversible operation, and everything adjacent to it. */
    expect(client.flashDfuFirmware).not.toHaveBeenCalled();
    expect(client.saveFirmwareFile).not.toHaveBeenCalled();
    expect(client.pickFirmwareFile).not.toHaveBeenCalled();
    expect(client.unprotectDfuDevice).not.toHaveBeenCalled();
    expect(client.exitDfuMode).not.toHaveBeenCalled();
    expect(buildApi.requestBuild).not.toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });
});

/* ------------------------------------------------------------------ */
/* FLASHER - the shared radio chip behind all nine FirmwareChoice sites */
/* ------------------------------------------------------------------ */

describe('Flasher: the shared choice chip meets the touch floor', () => {
  it('covers every FirmwareChoice call site at once, not the two the sweep rendered', async () => {
    const renderer = await render(
      <FirmwareChoice
        value="online"
        testIDPrefix="choice"
        choices={[
          { value: 'online', label: 'Firmware الرسمي عبر الإنترنت' },
          { value: 'local', label: 'ملف من الجهاز' },
        ]}
        onChange={() => undefined}
      />,
    );
    const measured = measureControls(renderer);
    expect(measured).toHaveLength(2);
    expect(offenders(measured)).toEqual([]);
    expect(inventoryOffenders(measured, REPAIRED_FLASHER_CHOICE)).toEqual([]);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('keeps the floor while disabled - a disabled control must not collapse', async () => {
    const renderer = await render(
      <FirmwareChoice
        value="online"
        disabled
        testIDPrefix="choice"
        choices={[
          { value: 'online', label: 'Firmware الرسمي عبر الإنترنت' },
          { value: 'local', label: 'ملف من الجهاز' },
        ]}
        onChange={() => undefined}
      />,
    );
    const measured = measureControls(renderer);
    expect(measured).toHaveLength(2);
    expect(inventoryOffenders(measured, REPAIRED_FLASHER_CHOICE)).toEqual([]);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});

/* ------------------------------------------------------------------ */
/* FLASHER - the two step tabs, on the screen that owns them           */
/* ------------------------------------------------------------------ */

/**
 * The step tabs exist nowhere but this screen, so the screen is mounted
 * whole. Both dependencies are injected props with production defaults;
 * substituting them changes what the screen TALKS TO, never what it
 * declares, and the style under test belongs to the screen.
 */
function flasherPorts() {
  return {
    client: {
      listDevices: jest.fn(async () => []),
      listDfuDevices: jest.fn(async () => []),
      onDeviceAttached: jest.fn(() => jest.fn()),
      onDeviceDetached: jest.fn(() => jest.fn()),
      onDfuFlashProgress: jest.fn(() => jest.fn()),
      cancelDfuFlash: jest.fn(async () => undefined),
    } as any,
    buildApi: {
      loadTargets: jest.fn(async () => []),
      loadTargetReleases: jest.fn(),
      loadOptions: jest.fn(),
      loadBuild: jest.fn(),
      loadCommits: jest.fn(),
      loadBuildLog: jest.fn(async () => ''),
    } as any,
  };
}

describe('Flasher: the step tabs meet the touch floor', () => {
  it('declares the floor on both tabs, on the screen that renders them', async () => {
    const { client, buildApi } = flasherPorts();
    const renderer = await render(
      <FirmwareFlasherScreen client={client} buildApi={buildApi} />,
    );
    const measured = measureControls(renderer);
    /* Prove the tabs are actually present: a green inventory over an
       unrendered control says nothing. */
    const seen = measured.map(m => m.id);
    for (const tab of REPAIRED_FLASHER_STEPS) expect(seen).toContain(tab);
    /* And nothing else on this screen declares a sub-floor height
       either: 18 pressables render in this state and none of them does.
       Stated as an assertion, not as a comment, so a future short
       declaration anywhere on the Flasher fails here. */
    expect(offenders(measured)).toEqual([]);
    expect(inventoryOffenders(measured, REPAIRED_FLASHER_STEPS)).toEqual([]);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('pressing a step tab still switches step, so the enlarged tab is wired', async () => {
    const { client, buildApi } = flasherPorts();
    const renderer = await render(
      <FirmwareFlasherScreen client={client} buildApi={buildApi} />,
    );
    const selectedOf = (testID: string): boolean =>
      renderer.root
        .findAllByProps({ testID })
        .find(n => typeof n.props.onPress === 'function')?.props
        .accessibilityState?.selected === true;
    expect(selectedOf('firmware-step-board')).toBe(true);
    expect(selectedOf('firmware-step-flash')).toBe(false);
    await ReactTestRenderer.act(async () => {
      renderer.root
        .findAllByProps({ testID: 'firmware-step-flash' })
        .find(n => typeof n.props.onPress === 'function')!
        .props.onPress();
      await Promise.resolve();
    });
    expect(selectedOf('firmware-step-flash')).toBe(true);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
