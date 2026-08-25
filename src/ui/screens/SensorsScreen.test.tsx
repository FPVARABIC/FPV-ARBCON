/**
 * THE «المستشعرات» SCREEN, AS AN OPERATOR ACTUALLY READS IT.
 *
 * SENSORS B-4/B-5. Every snapshot in this file is built by feeding
 * HAND-WRITTEN BYTES to the production decoders, never by hand-assembling
 * the decoded objects: a fixture that skips the decoder can drift away
 * from what a board really sends and take the screen's proof with it.
 *
 * WHAT THIS FILE DOES NOT PROVE. There is no flight controller here. It
 * proves what the screen does with a given set of frames - the wording,
 * the separation of the three answers, the gating, the save and
 * calibration lifecycles as the UI drives them. Whether a real board
 * behaves this way is hardware evidence and is reported separately.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {I18nManager, Text} from 'react-native';
import {Polyline} from 'react-native-svg';

import SensorsScreen, {
  sharedTraceBound,
  traceX,
  traceY,
  tracePoints,
  TraceCard,
  TRACE_CAPACITY,
  TRACE_HEIGHT,
  type SensorsControllerPort,
} from './SensorsScreen';
import '../../i18n';
import i18n from '../../i18n';
import {sensorsPendingSave} from '../session/sensorsPendingSave';
import {
  decodeAccTrim,
  decodeCompassConfig,
  decodeGyroSensorActive,
  decodeSensorAlignment,
  decodeSensorConfig,
  decodeSensorConfigActive,
} from '../../core';
import {deriveSensorTruthSet} from '../../core/state/sensorTruthSemantics';
import type {
  SensorsCalibrationObservation,
  SensorsCalibrationOutcome,
  SensorsSnapshot,
  SetupUiSessionKey,
} from '../../platforms/react-native/protocol';

/* ================================================================== *
 * FIXTURES - bytes in, snapshots out
 * ================================================================== */

const KEY: SetupUiSessionKey = {sessionId: 'sensors-ui', generation: 3};

/** MSP_STATUS_EX sensor mask bits, in the firmware's own packing order:
 *  ACC | BARO<<1 | MAG<<2 | GPS<<3 | RANGEFINDER<<4 | GYRO<<5. */
const PRESENT_ACC = 1;
const PRESENT_BARO = 2;
const PRESENT_MAG = 4;
const PRESENT_GYRO = 32;
const TYPICAL_PRESENCE = PRESENT_ACC + PRESENT_BARO + PRESENT_MAG + PRESENT_GYRO;

function u16le(value: number): number[] {
  const unsigned = value < 0 ? value + 0x10000 : value;
  return [unsigned % 256, Math.floor(unsigned / 256) % 256];
}

interface FixtureOptions {
  /** MSP_SENSOR_CONFIG bytes: acc, baro, mag [, rangefinder [, opticalflow]] */
  readonly configuredBytes?: number[];
  /** MSP2_SENSOR_CONFIG_ACTIVE: gyro, acc, baro, mag, rangefinder, opticalflow */
  readonly detectedBytes?: number[] | 'ABSENT';
  /** MSP2_GYRO_SENSOR_ACTIVE: count then one byte per slot. */
  readonly gyroBytes?: number[];
  /** MSP_SENSOR_ALIGNMENT, all eleven bytes. */
  readonly alignmentBytes?: number[];
  readonly accTrimBytes?: number[] | 'ABSENT';
  readonly compassBytes?: number[] | 'ABSENT';
  readonly presenceMask?: number;
  readonly armingDisableFlags?: number;
}

function snapshotFrom(options: FixtureOptions = {}): SensorsSnapshot {
  const configured = decodeSensorConfig(
    Uint8Array.from(options.configuredBytes ?? [0, 0, 0, 0, 0]),
  );
  const detectedBytes = options.detectedBytes ?? [2, 2, 3, 4, 0, 0];
  const detected =
    detectedBytes === 'ABSENT'
      ? ({kind: 'NOT_AVAILABLE_ON_THIS_BOARD'} as const)
      : ({
          kind: 'READ',
          value: decodeSensorConfigActive(Uint8Array.from(detectedBytes)),
        } as const);
  const gyros = {
    kind: 'READ',
    value: decodeGyroSensorActive(Uint8Array.from(options.gyroBytes ?? [1, 2])),
  } as const;
  const alignment = decodeSensorAlignment(
    Uint8Array.from(
      options.alignmentBytes ?? [
        0, 0, 0, /* detected flags */ 0b11, /* enabled mask */ 0b01,
        ...u16le(0), ...u16le(0), ...u16le(0),
      ],
    ),
  );
  const accTrimBytes = options.accTrimBytes ?? [...u16le(0), ...u16le(0)];
  const accTrim =
    accTrimBytes === 'ABSENT'
      ? ({kind: 'NOT_AVAILABLE_ON_THIS_BOARD'} as const)
      : ({kind: 'READ', value: decodeAccTrim(Uint8Array.from(accTrimBytes))} as const);
  const compassBytes = options.compassBytes ?? u16le(0);
  const compass =
    compassBytes === 'ABSENT'
      ? ({kind: 'NOT_AVAILABLE_ON_THIS_BOARD'} as const)
      : ({
          kind: 'READ',
          value: decodeCompassConfig(Uint8Array.from(compassBytes)),
        } as const);
  const presenceMask = options.presenceMask ?? TYPICAL_PRESENCE;
  return {
    configured,
    detected,
    gyros,
    alignment,
    accTrim,
    compass,
    presenceMask,
    armingDisableFlags: options.armingDisableFlags,
    truth: deriveSensorTruthSet({
      configured,
      detected: detected.kind === 'READ' ? detected.value : undefined,
      presenceMask,
    }),
  };
}

/* ================================================================== *
 * THE CONTROLLER STAND-IN
 * ================================================================== */

type Deferred<T> = {promise: Promise<T>; resolve: (value: T) => void};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return {promise, resolve};
}

/**
 * Mirrors the real controller's SHAPE, not its logic: every method
 * records its arguments and hands back a result the test chooses. What
 * the real one does with a real board is proved in
 * sensorsControllerProductionPath.test.ts and
 * sensorsCalibrationProductionPath.test.ts against a virtual FC; what is
 * proved here is that the screen asks for the right thing and renders
 * the answer truthfully.
 */
function makeController(initial: SensorsSnapshot = snapshotFrom()) {
  const calls: string[] = [];
  const saves: unknown[] = [];
  let snapshot = initial;
  let progressHook: ((progress: string) => void) | undefined;
  let cancelled = 0;
  let pendingCalibration: Deferred<SensorsCalibrationOutcome> | undefined;
  const results = new Map<string, unknown>();

  const observationFor = (): SensorsCalibrationObservation => {
    pendingCalibration = deferred<SensorsCalibrationOutcome>();
    return {
      result: pendingCalibration.promise,
      cancel: () => {
        cancelled += 1;
      },
    } as SensorsCalibrationObservation;
  };

  const port: SensorsControllerPort = {
    load: async () => {
      calls.push('load');
      return {kind: 'LOADED', snapshot} as never;
    },
    saveHardwareSelection: async (_key, observed, draft, onProgress) => {
      calls.push('saveHardwareSelection');
      saves.push({observed, draft});
      onProgress?.('SENDING');
      onProgress?.('VERIFYING_APPLY');
      onProgress?.('PERSISTING');
      return (results.get('saveHardwareSelection') ?? {
        kind: 'AWAITING_REBOOT_VERIFICATION',
        pending: {
          sessionId: KEY.sessionId,
          writtenOnGeneration: KEY.generation,
          expected: {},
          contract: 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW',
        },
      }) as never;
    },
    verifyHardwarePersistence: async (_key, pending) => {
      calls.push('verifyHardwarePersistence');
      saves.push({pending});
      return (results.get('verifyHardwarePersistence') ?? {
        kind: 'SUCCEEDED',
        snapshot,
        runtime: {contradictions: []},
      }) as never;
    },
    saveMagAlignment: async (_key, _observed, draft) => {
      calls.push('saveMagAlignment');
      saves.push(draft);
      return (results.get('saveMagAlignment') ?? {kind: 'SUCCEEDED', value: draft}) as never;
    },
    saveAccTrim: async (_key, _observed, draft) => {
      calls.push('saveAccTrim');
      saves.push(draft);
      return (results.get('saveAccTrim') ?? {kind: 'SUCCEEDED', value: draft}) as never;
    },
    saveCompassDeclination: async (_key, _observed, draft) => {
      calls.push('saveCompassDeclination');
      saves.push(draft);
      return (results.get('saveCompassDeclination') ?? {kind: 'SUCCEEDED', value: draft}) as never;
    },
    calibrateAccelerometer: (_key, onProgress) => {
      calls.push('calibrateAccelerometer');
      progressHook = onProgress as never;
      return observationFor();
    },
    calibrateMagnetometer: (_key, onProgress) => {
      calls.push('calibrateMagnetometer');
      progressHook = onProgress as never;
      return observationFor();
    },
  };

  return {
    port,
    calls,
    saves,
    setResult: (method: string, value: unknown) => results.set(method, value),
    setSnapshot: (next: SensorsSnapshot) => {
      snapshot = next;
    },
    emitProgress: (progress: string) => progressHook?.(progress),
    finishCalibration: (outcome: SensorsCalibrationOutcome) =>
      pendingCalibration?.resolve(outcome),
    cancelCount: () => cancelled,
  };
}

/* ================================================================== *
 * RENDER HELPERS
 * ================================================================== */

/**
 * Every renderer this file mounts, so teardown can unmount them all.
 * The screen owns a one-second elapsed interval and a telemetry
 * subscription; a tree left mounted keeps both alive and the test file
 * never finishes.
 */
let mounted: ReactTestRenderer.ReactTestRenderer[] = [];

async function mount(
  controller: ReturnType<typeof makeController>,
  props: {active?: boolean; sessionKey?: SetupUiSessionKey} = {},
) {
  const onOpenSetup = jest.fn();
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <SensorsScreen
        sessionKey={props.sessionKey ?? KEY}
        active={props.active ?? true}
        onOpenSetup={onOpenSetup}
        controller={controller.port}
        now={() => 0}
      />,
    );
  });
  mounted.push(renderer);
  await act(async () => {
    await Promise.resolve();
  });
  return {renderer, onOpenSetup};
}

function texts(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children),
    );
}

function byTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(node => node.props.testID === testID)[0];
}

function pressable(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.props.onPress === 'function',
  )[0];
}

/** Every string rendered INSIDE the node with this testID. A Fact is a
 *  View wrapping two Texts, so reading `props.children` off the View
 *  would read elements rather than words. */
/** Types into the TextInput with this testID. The handler sits on the
 *  host element, which is not always the node the testID matched. */
function changeText(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  text: string,
): void {
  const field = renderer.root.findAll(
    node =>
      node.props.testID === testID && typeof node.props.onChangeText === 'function',
  )[0];
  field.props.onChangeText(text);
}

function textOf(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): string {
  const node = byTestID(renderer, testID);
  if (node === undefined || node === null) return '';
  return node
    .findAllByType(Text)
    .map(text =>
      Array.isArray(text.props.children)
        ? text.props.children.join('')
        : String(text.props.children),
    )
    .join(' ')
    .trim();
}

const t = (key: string, params?: Record<string, unknown>): string =>
  i18n.t(key, params ?? {}) as string;

beforeEach(() => {
  jest.useFakeTimers();
  mounted = [];
});

afterEach(async () => {
  const trees = mounted;
  mounted = [];
  await act(async () => {
    for (const tree of trees) {
      if (tree.toJSON() !== null) tree.unmount();
    }
    await Promise.resolve();
  });
  sensorsPendingSave.clear();
  jest.clearAllTimers();
  jest.useRealTimers();
});

/* ================================================================== *
 * 1-8: THE THREE ANSWERS, KEPT APART
 * ================================================================== */

describe('the three answers are never collapsed into one', () => {
  it('1. every visible sensor shows configured, detected and present as three separate lines', async () => {
    const {renderer} = await mount(makeController());
    for (const family of ['GYRO', 'ACC', 'BARO', 'MAG']) {
      expect(byTestID(renderer, `sensors-row-${family}-configured`)).toBeDefined();
      expect(byTestID(renderer, `sensors-row-${family}-detected`)).toBeDefined();
      expect(byTestID(renderer, `sensors-row-${family}-present`)).toBeDefined();
    }
  });

  it('2. DEFAULT is shown as "افتراضي", never rewritten into AUTO or into a part name', async () => {
    // Byte 0 is ACC and 0 is its DEFAULT index.
    const {renderer} = await mount(
      makeController(snapshotFrom({configuredBytes: [0, 0, 0, 0, 0]})),
    );
    expect(textOf(renderer, 'sensors-row-ACC-configured')).toContain(
      t('sensorsScreen.hardware.default'),
    );
    expect(texts(renderer).join(' ')).not.toContain('AUTO');
  });

  it('3. a configured NONE reads as disabled by configuration, not as a missing sensor', async () => {
    // ACC index 1 is NONE for the accelerometer family.
    const {renderer} = await mount(
      makeController(snapshotFrom({configuredBytes: [1, 0, 0, 0, 0]})),
    );
    const headline = textOf(renderer, 'sensors-row-ACC-headline');
    expect(headline).toBe(t('sensorsScreen.headline.disabled'));
    expect(headline).not.toBe(t('sensorsScreen.headline.absent'));
  });

  it('4. an unknown hardware index keeps its raw number instead of being normalised away', async () => {
    const {renderer} = await mount(
      makeController(snapshotFrom({configuredBytes: [42, 0, 0, 0, 0]})),
    );
    expect(textOf(renderer, 'sensors-row-ACC-configured')).toContain('42');
  });

  it('5. the barometer enum matches API 1.47: raw 9 is 2SMPB_02B, not what an older table says', async () => {
    const {renderer} = await mount(
      makeController(snapshotFrom({configuredBytes: [0, 9, 0, 0, 0]})),
    );
    expect(textOf(renderer, 'sensors-row-BARO-configured')).toContain('2SMPB_02B');
  });

  it('6. raw 10 is LPS22DF and raw 11 is VIRTUAL - the two indices an old table shifts', async () => {
    const ten = await mount(makeController(snapshotFrom({configuredBytes: [0, 10, 0, 0, 0]})));
    expect(textOf(ten.renderer, 'sensors-row-BARO-configured')).toContain('LPS22DF');
    const eleven = await mount(makeController(snapshotFrom({configuredBytes: [0, 11, 0, 0, 0]})));
    expect(textOf(eleven.renderer, 'sensors-row-BARO-configured')).toContain('VIRTUAL');
  });

  it('7. a sensor that is present but whose type this build cannot name says exactly that', async () => {
    const {renderer} = await mount(
      makeController(
        snapshotFrom({
          // 0xff on every detected byte: the board answered, and reported
          // that it has nothing to say about the hardware type.
          detectedBytes: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
          presenceMask: TYPICAL_PRESENCE,
        }),
      ),
    );
    expect(textOf(renderer, 'sensors-row-ACC-headline')).toBe(
      t('sensorsScreen.headline.presentUnknownHardware'),
    );
  });

  it('8. a 0xFF detection byte reads as "not built into this firmware", and an unanswered command reads as "no reading" - two different absences', async () => {
    const compiledOut = await mount(
      makeController(snapshotFrom({detectedBytes: [2, 0xff, 3, 4, 0, 0]})),
    );
    expect(textOf(compiledOut.renderer, 'sensors-row-ACC-detected')).toContain(
      t('sensorsScreen.detected.notInFirmware'),
    );

    const noCommand = await mount(makeController(snapshotFrom({detectedBytes: 'ABSENT'})));
    const line = textOf(noCommand.renderer, 'sensors-row-ACC-detected');
    expect(line).toContain(t('sensorsScreen.detected.notRead'));
    // Neither absence is ever reported as a fault of the sensor.
    expect(line).not.toContain(t('sensorsScreen.detected.none'));
  });
});

/* ================================================================== *
 * 9-12: CONTRADICTIONS, NOT HEALTH
 * ================================================================== */

describe('a disagreement is reported as a disagreement', () => {
  it('9. a configured/detected mismatch names both values and never calls it a fault', async () => {
    const {renderer} = await mount(
      makeController(
        snapshotFrom({
          configuredBytes: [2, 0, 0, 0, 0], // a pinned accelerometer...
          detectedBytes: [2, 5, 3, 4, 0, 0], // ...and a different one found
        }),
      ),
    );
    const pair = textOf(renderer, 'sensors-mismatch-ACC');
    expect(pair).toContain(t('sensorsScreen.labelStored'));
    expect(pair).toContain(t('sensorsScreen.labelFound'));
    expect(
      textOf(renderer, 'sensors-contradiction-ACC-CONFIGURED_DEVICE_DIFFERS_FROM_DETECTED'),
    ).toContain(t('sensorsScreen.contradiction.CONFIGURED_DEVICE_DIFFERS_FROM_DETECTED'));
  });

  it('10. contradictions are a compact block, never a red hero that owns the first screen', async () => {
    const {renderer} = await mount(
      makeController(snapshotFrom({configuredBytes: [2, 0, 0, 0, 0], detectedBytes: [2, 5, 3, 4, 0, 0]})),
    );
    // Status comes first; the notice is below it, not above.
    const order = renderer.root
      .findAll(node => typeof node.props.testID === 'string')
      .map(node => String(node.props.testID));
    expect(order.indexOf('sensors-status')).toBeLessThan(order.indexOf('sensors-contradictions'));
  });

  it('11. no health vocabulary reaches the screen - not "سليم", not "OK", not a score', async () => {
    const {renderer} = await mount(makeController());
    const all = texts(renderer).join(' ');
    for (const forbidden of ['سليم', 'صحي', 'الحالة الصحية', 'OK', 'HEALTHY', '%']) {
      expect(all).not.toContain(forbidden);
    }
  });

  it('12. with nothing to disagree about, the whole block is absent rather than empty', async () => {
    const {renderer} = await mount(makeController());
    expect(byTestID(renderer, 'sensors-contradictions')).toBeUndefined();
  });
});

/* ================================================================== *
 * 13-17: CAPABILITY GATING
 * ================================================================== */

describe('nothing is shown that the board did not supply', () => {
  it('13. a three-byte SENSOR_CONFIG offers no rangefinder or optical-flow selector', async () => {
    const {renderer} = await mount(
      makeController(snapshotFrom({configuredBytes: [0, 0, 0]})),
    );
    expect(byTestID(renderer, 'sensors-hardware-acc')).toBeDefined();
    expect(byTestID(renderer, 'sensors-hardware-rangefinder')).toBeUndefined();
    expect(byTestID(renderer, 'sensors-hardware-opticalflow')).toBeUndefined();
  });

  it('14. a five-byte SENSOR_CONFIG offers all five', async () => {
    const {renderer} = await mount(makeController());
    for (const family of ['acc', 'baro', 'mag', 'rangefinder', 'opticalflow']) {
      expect(byTestID(renderer, `sensors-hardware-${family}`)).toBeDefined();
    }
  });

  it('15. a board without MSP_ACC_TRIM shows no trim section instead of a section full of dashes', async () => {
    const {renderer} = await mount(makeController(snapshotFrom({accTrimBytes: 'ABSENT'})));
    expect(byTestID(renderer, 'sensors-trim')).toBeUndefined();
  });

  it('16. a board without MSP_COMPASS_CONFIG shows neither declination nor magnetometer alignment', async () => {
    const {renderer} = await mount(makeController(snapshotFrom({compassBytes: 'ABSENT'})));
    expect(byTestID(renderer, 'sensors-declination')).toBeUndefined();
    expect(byTestID(renderer, 'sensors-alignment')).toBeUndefined();
  });

  it('17. a live trace is drawn only for a sensor the board reports as present', async () => {
    const {renderer} = await mount(
      makeController(snapshotFrom({presenceMask: PRESENT_ACC + PRESENT_GYRO})),
    );
    expect(byTestID(renderer, 'sensors-trace-GYRO')).toBeDefined();
    expect(byTestID(renderer, 'sensors-trace-ACC')).toBeDefined();
    expect(byTestID(renderer, 'sensors-trace-MAG')).toBeUndefined();
  });
});

/* ================================================================== *
 * 18-20: UNITS
 * ================================================================== */

describe('a unit is shown only where the firmware proves one', () => {
  it('18. the gyroscope is degrees per second - gyroRateDps() in the firmware', async () => {
    const {renderer} = await mount(makeController());
    expect(textOf(renderer, 'sensors-trace-GYRO-unit')).toBe(
      t('sensorsScreen.unit.degreesPerSecond'),
    );
  });

  it('19. the accelerometer is NEVER labelled g - MSP_RAW_IMU carries raw counts and no acc_1G', async () => {
    const {renderer} = await mount(makeController());
    const unit = textOf(renderer, 'sensors-trace-ACC-unit');
    expect(unit).toBe(t('sensorsScreen.unit.rawCounts'));
    expect(unit).not.toContain('g');
  });

  it('20. the magnetometer carries no invented unit either', async () => {
    const {renderer} = await mount(makeController());
    expect(textOf(renderer, 'sensors-trace-MAG-unit')).toBe(t('sensorsScreen.unit.rawCounts'));
  });
});

/* ================================================================== *
 * 21-26: HARDWARE SELECTION AND THE VERIFIED SAVE
 * ================================================================== */

describe('a hardware save is verified, never announced', () => {
  it('21. the save bar stays hidden until a selection genuinely changes', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    expect(byTestID(renderer, 'sensors-save-bar')?.props.visible).toBe(false);

    await act(async () => {
      byTestID(renderer, 'sensors-hardware-baro').props.onSelect('9');
    });
    expect(byTestID(renderer, 'sensors-save-bar')?.props.visible).toBe(true);
  });

  it('22. re-selecting the value the board already holds leaves the bar hidden', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      byTestID(renderer, 'sensors-hardware-baro').props.onSelect('0'); // unchanged
    });
    expect(byTestID(renderer, 'sensors-save-bar')?.props.visible).toBe(false);
  });

  it('23. the draft names ONLY the field that was touched - untouched fields are never rewritten', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      byTestID(renderer, 'sensors-hardware-baro').props.onSelect('9');
    });
    await act(async () => {
      byTestID(renderer, 'sensors-save-bar').props.onSave();
    });
    const draft = (controller.saves[0] as {draft: Record<string, number>}).draft;
    expect(Object.keys(draft)).toEqual(['baro']);
    expect(draft.baro).toBe(9);
  });

  it('24. a save that reaches the reboot reports awaiting verification - never success', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      byTestID(renderer, 'sensors-hardware-baro').props.onSelect('9');
    });
    await act(async () => {
      byTestID(renderer, 'sensors-save-bar').props.onSave();
    });
    const bar = byTestID(renderer, 'sensors-save-bar');
    expect(bar.props.statusMessage).toBe(
      t('sensorsScreen.save.outcome.AWAITING_REBOOT_VERIFICATION'),
    );
    expect(bar.props.statusMessage).not.toBe(t('sensorsScreen.save.outcome.SUCCEEDED'));
    expect(sensorsPendingSave.get()).not.toBeNull();
  });

  it('25. a readback mismatch says the board did not apply it AND that nothing was saved', async () => {
    const controller = makeController();
    controller.setResult('saveHardwareSelection', {kind: 'READBACK_MISMATCH'});
    const {renderer} = await mount(controller);
    await act(async () => {
      byTestID(renderer, 'sensors-hardware-baro').props.onSelect('9');
    });
    await act(async () => {
      byTestID(renderer, 'sensors-save-bar').props.onSave();
    });
    expect(byTestID(renderer, 'sensors-save-bar').props.statusMessage).toBe(
      t('sensorsScreen.save.outcome.READBACK_MISMATCH'),
    );
  });

  it('26. a rejected save leaves no eternal busy state behind', async () => {
    const controller = makeController();
    controller.setResult('saveHardwareSelection', {kind: 'REJECTED', reason: 'DISCONNECTED'});
    const {renderer} = await mount(controller);
    await act(async () => {
      byTestID(renderer, 'sensors-hardware-baro').props.onSelect('9');
    });
    await act(async () => {
      byTestID(renderer, 'sensors-save-bar').props.onSave();
    });
    expect(byTestID(renderer, 'sensors-save-bar').props.busy).toBe(false);
  });
});

/* ================================================================== *
 * 27-29: PERSISTENCE IS NOT DETECTION
 * ================================================================== */

describe('a stored setting and a found part are two answers', () => {
  it('27. a verified save on the NEW session reports success', async () => {
    sensorsPendingSave.set({
      sessionId: KEY.sessionId,
      writtenOnGeneration: KEY.generation - 1,
      expected: {},
      contract: 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW',
    } as never);
    const controller = makeController();
    const {renderer} = await mount(controller);
    expect(controller.calls).toContain('verifyHardwarePersistence');
    expect(byTestID(renderer, 'sensors-save-bar').props.statusMessage).toBe(
      t('sensorsScreen.save.outcome.SUCCEEDED'),
    );
  });

  it('28. a stored value the board then failed to find is still a SUCCESSFUL save, with its own note', async () => {
    sensorsPendingSave.set({
      sessionId: KEY.sessionId,
      writtenOnGeneration: KEY.generation - 1,
      expected: {},
      contract: 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW',
    } as never);
    const controller = makeController();
    controller.setResult('verifyHardwarePersistence', {
      kind: 'SUCCEEDED',
      snapshot: snapshotFrom(),
      runtime: {contradictions: [{family: 'BARO'}]},
    });
    const {renderer} = await mount(controller);
    const message = byTestID(renderer, 'sensors-save-bar').props.statusMessage as string;
    expect(message).toContain(t('sensorsScreen.save.outcome.SUCCEEDED'));
    expect(message).toContain(t('sensorsScreen.save.runtimeMismatch'));
  });

  it('29. a persistence mismatch offers a re-read rather than declaring a failure of the board', async () => {
    sensorsPendingSave.set({
      sessionId: KEY.sessionId,
      writtenOnGeneration: KEY.generation - 1,
      expected: {},
      contract: 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW',
    } as never);
    const controller = makeController();
    controller.setResult('verifyHardwarePersistence', {kind: 'PERSISTENCE_MISMATCH'});
    const {renderer} = await mount(controller);
    expect(byTestID(renderer, 'sensors-save-bar').props.statusMessage).toBe(
      t('sensorsScreen.save.outcome.PERSISTENCE_MISMATCH'),
    );
  });
});

/* ================================================================== *
 * 30-33: TRIM, DECLINATION, ALIGNMENT
 * ================================================================== */

describe('the fine adjustments carry their real ranges and units', () => {
  it('30. the accelerometer trim is a raw offset with no degrees anywhere near it', async () => {
    const {renderer} = await mount(makeController());
    const block = texts(renderer).join(' ');
    expect(block).toContain(t('sensorsScreen.trimTitle'));
    expect(t('sensorsScreen.trimTitle')).not.toContain('°');
    expect(byTestID(renderer, 'sensors-trim-pitch').props.value).toBe('0');
  });

  it('31. declination is decidegrees on the wire and degrees on the screen: CE FF reads -5.0°', async () => {
    const {renderer} = await mount(
      // 0xFFCE little-endian is -50 decidegrees.
      makeController(snapshotFrom({compassBytes: [0xce, 0xff]})),
    );
    expect(byTestID(renderer, 'sensors-declination-input').props.value).toBe('-5.0');
  });

  it('32. a declination outside the firmware range is refused before it can be sent', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      changeText(renderer, 'sensors-declination-input', '99');
    });
    expect(byTestID(renderer, 'sensors-declination-invalid')).toBeDefined();
    expect(pressable(renderer, 'sensors-declination-save').props.disabled).toBe(true);
    expect(controller.calls).not.toContain('saveCompassDeclination');
  });

  it('33. the magnetometer alignment section never shows the gyro detected flags or the enable mask', async () => {
    const {renderer} = await mount(makeController());
    const block = texts(renderer).join(' ');
    expect(byTestID(renderer, 'sensors-alignment')).toBeDefined();
    expect(block).not.toContain('gyro_enabled_bitmask');
    expect(block).not.toContain('gyroDetectedFlags');
  });
});

/* ================================================================== *
 * 34-40: CALIBRATION AS AN OBSERVATION
 * ================================================================== */

describe('calibration completion is observed, never assumed', () => {
  it('34. starting a calibration shows a stage and an elapsed count, and no percentage', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-acc-start').props.onPress();
    });
    expect(controller.calls).toContain('calibrateAccelerometer');
    expect(byTestID(renderer, 'sensors-calibrate-acc-stage')).toBeDefined();
    expect(textOf(renderer, 'sensors-calibrate-acc-elapsed')).not.toContain('%');
  });

  it('35. while it runs there is NO success message anywhere', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-acc-start').props.onPress();
    });
    await act(async () => {
      controller.emitProgress('CALIBRATING');
    });
    expect(texts(renderer).join(' ')).not.toContain(
      t('sensorsScreen.calibration.outcome.SUCCEEDED.ACCELEROMETER'),
    );
  });

  it('36. only the settled outcome produces the completion sentence', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-acc-start').props.onPress();
    });
    await act(async () => {
      controller.finishCalibration({
        kind: 'SUCCEEDED',
        evidence: {observedCalibratingEdge: true, accBlockerCleared: false, elapsedMs: 900},
      } as never);
      await Promise.resolve();
    });
    expect(textOf(renderer, 'sensors-calibrate-acc-outcome')).toContain(
      t('sensorsScreen.calibration.outcome.SUCCEEDED.ACCELEROMETER'),
    );
  });

  it('37. a stopped observation says the board may still be calibrating - never "cancelled"', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-mag-start').props.onPress();
    });
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-mag-stop').props.onPress();
    });
    expect(controller.cancelCount()).toBe(1);
    await act(async () => {
      controller.finishCalibration({
        kind: 'OBSERVATION_CANCELLED',
        boardMayStillBeCalibrating: true,
      } as never);
      await Promise.resolve();
    });
    const outcome = textOf(renderer, 'sensors-calibrate-mag-outcome');
    expect(outcome).toBe(t('sensorsScreen.calibration.outcome.OBSERVATION_CANCELLED'));
    expect(outcome).not.toContain('تم إلغاء المعايرة');
  });

  it('38. a magnetometer run with no movement says so, and offers the retry advice', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-mag-start').props.onPress();
    });
    await act(async () => {
      controller.finishCalibration({kind: 'NO_MOVEMENT_DETECTED', elapsedMs: 15_000} as never);
      await Promise.resolve();
    });
    expect(textOf(renderer, 'sensors-calibrate-mag-outcome')).toContain(
      t('sensorsScreen.calibration.outcome.NO_MOVEMENT_DETECTED'),
    );
    expect(byTestID(renderer, 'sensors-calibrate-mag-hint')).toBeDefined();
  });

  it('39. an unconfirmed completion is not reported as a definite failure', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-acc-start').props.onPress();
    });
    await act(async () => {
      controller.finishCalibration({
        kind: 'COMPLETION_UNCONFIRMED',
        reason: 'NO_OBSERVABLE_TRANSITION',
        elapsedMs: 8_000,
      } as never);
      await Promise.resolve();
    });
    const outcome = textOf(renderer, 'sensors-calibrate-acc-outcome');
    expect(outcome).toBe(t('sensorsScreen.calibration.outcome.COMPLETION_UNCONFIRMED'));
    expect(outcome).not.toBe(t('sensorsScreen.calibration.outcome.FAILED'));
  });

  it('39b. a NEW run clears the previous result at once, so no completed sentence sits beside a running one', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-acc-start').props.onPress();
    });
    await act(async () => {
      controller.finishCalibration({
        kind: 'SUCCEEDED',
        evidence: {observedCalibratingEdge: true, accBlockerCleared: false, elapsedMs: 900},
      } as never);
      await Promise.resolve();
    });
    expect(textOf(renderer, 'sensors-calibrate-acc-outcome')).toContain(
      t('sensorsScreen.calibration.outcome.SUCCEEDED.ACCELEROMETER'),
    );

    // A second run starts: the first run's sentence must go immediately.
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-acc-start').props.onPress();
    });
    expect(byTestID(renderer, 'sensors-calibrate-acc-outcome')).toBeUndefined();
    expect(texts(renderer).join(' ')).not.toContain(
      t('sensorsScreen.calibration.outcome.SUCCEEDED.ACCELEROMETER'),
    );
    expect(byTestID(renderer, 'sensors-calibrate-acc-stage')).toBeDefined();
  });

  it('40. a sensor the board does not report gets no calibration card at all', async () => {
    const {renderer} = await mount(
      makeController(snapshotFrom({presenceMask: PRESENT_ACC + PRESENT_GYRO})),
    );
    expect(byTestID(renderer, 'sensors-calibrate-acc')).toBeDefined();
    expect(byTestID(renderer, 'sensors-calibrate-mag')).toBeUndefined();
  });
});

/* ================================================================== *
 * 41-46: LOCKING, SCOPE AND ACCESSIBILITY
 * ================================================================== */

describe('the screen stays inside its own scope, and stays operable', () => {
  it('41. a running operation locks every other control on the screen', async () => {
    const controller = makeController();
    const {renderer} = await mount(controller);
    await act(async () => {
      pressable(renderer, 'sensors-calibrate-acc-start').props.onPress();
    });
    expect(byTestID(renderer, 'sensors-hardware-baro').props.disabled).toBe(true);
    expect(pressable(renderer, 'sensors-trim-save').props.disabled).toBe(true);
    expect(pressable(renderer, 'sensors-alignment-save').props.disabled).toBe(true);
  });

  it('42. board alignment is POINTED AT, never duplicated here', async () => {
    const {renderer, onOpenSetup} = await mount(makeController());
    expect(byTestID(renderer, 'sensors-board-alignment-pointer')).toBeDefined();
    act(() => {
      pressable(renderer, 'sensors-open-setup').props.onPress();
    });
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
    // The board's own roll/pitch/yaw fields belong to Setup and are not here.
    expect(byTestID(renderer, 'sensors-board-roll')).toBeUndefined();
  });

  it('43. there is no gyro HARDWARE selector - the firmware exposes no such setting', async () => {
    const {renderer} = await mount(makeController());
    expect(byTestID(renderer, 'sensors-hardware-gyro')).toBeUndefined();
  });

  it('44. raw enum numbers live under technical details, collapsed by default', async () => {
    const {renderer} = await mount(makeController());
    expect(byTestID(renderer, 'sensors-advanced-body')).toBeUndefined();
    await act(async () => {
      pressable(renderer, 'sensors-advanced-toggle').props.onPress();
    });
    expect(byTestID(renderer, 'sensors-advanced-body')).toBeDefined();
  });

  it('45. a dual-gyro board shows both slots once the details are open', async () => {
    const {renderer} = await mount(
      makeController(snapshotFrom({gyroBytes: [2, 2, 3]})),
    );
    await act(async () => {
      pressable(renderer, 'sensors-advanced-toggle').props.onPress();
    });
    expect(byTestID(renderer, 'sensors-gyro-slot-0')).toBeDefined();
    expect(byTestID(renderer, 'sensors-gyro-slot-1')).toBeDefined();
  });

  it('46. every state row is one accessibility node whose label carries label AND value', async () => {
    const {renderer} = await mount(makeController());
    const labelled = renderer.root.findAll(
      candidate =>
        candidate.props.testID === 'sensors-row-ACC-configured' &&
        typeof candidate.props.accessibilityLabel === 'string',
    );
    expect(labelled.length).toBeGreaterThan(0);
    const label = String(labelled[0].props.accessibilityLabel);
    expect(labelled[0].props.accessible).toBe(true);
    // Label AND value, so a reader hears which of the three answers this is.
    expect(label).toContain(t('sensorsScreen.labelConfigured'));
    expect(label).toContain(t('sensorsScreen.hardware.default'));
  });

  it('47. loading shows a compact loading state, never zeros or dashes standing in for facts', async () => {
    const controller = makeController();
    // A load that never settles: the screen must show its loading state
    // rather than a page of empty values.
    const stalled: SensorsControllerPort = {
      ...controller.port,
      load: () => new Promise(() => undefined),
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SensorsScreen sessionKey={KEY} active onOpenSetup={jest.fn()} controller={stalled} />,
      );
    });
    mounted.push(renderer);
    expect(byTestID(renderer, 'sensors-loading')).toBeDefined();
    /* No STATE rows at all - not rows whose values are dashes or zeros.
       (The subtitle's em dash is punctuation inside a sentence, which is
       why this looks for the rows rather than for the character.) */
    expect(byTestID(renderer, 'sensors-status')).toBeUndefined();
    for (const value of texts(renderer)) {
      expect(value.trim()).not.toBe('—');
      expect(value.trim()).not.toBe('--');
    }
  });

  it('48. the hardware-verification notice is unconditional and states the behavioural test', async () => {
    const {renderer} = await mount(makeController());
    expect(byTestID(renderer, 'sensors-hardware-verification')).toBeDefined();
    expect(texts(renderer).join(' ')).toContain('حرّك كل محور منفردًا');
  });
});

/* ================================================================== *
 * 49-52: THE TRACE GEOMETRY, AS PURE FUNCTIONS
 * ================================================================== */

describe('the live trace geometry is exact', () => {
  it('49. zero sits on the centre line whatever the bound', () => {
    expect(traceY(0, 1)).toBe(TRACE_HEIGHT / 2);
    expect(traceY(0, 5_000)).toBe(TRACE_HEIGHT / 2);
  });

  it('50. one bound is shared by the three axes, so their proportion survives', () => {
    expect(sharedTraceBound([{x: 10, y: -400, z: 3}])).toBe(400);
    expect(sharedTraceBound([])).toBe(1);
  });

  it('51. a value beyond the bound is clamped inside the box rather than drawn outside it', () => {
    const y = traceY(10_000, 100);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(TRACE_HEIGHT);
  });

  it('52. the polyline carries one point per sample and never more than the capacity', () => {
    const samples = Array.from({length: TRACE_CAPACITY}, (_, index) => ({
      x: index,
      y: -index,
      z: 0,
    }));
    expect(
      tracePoints(samples, 'x', sharedTraceBound(samples), 600).split(' '),
    ).toHaveLength(TRACE_CAPACITY);
  });
});

/* ================================================================== *
 * 53-65: THE SAMPLE AXIS USES THE WIDTH IT WAS GIVEN
 *
 * THE DEFECT THESE TESTS EXIST TO CLOSE. `tracePoints()` used to emit
 * the array index as the x coordinate into an <Svg width="100%"> with no
 * viewBox, so one sample was one CSS pixel: a full 48-sample window drew
 * 47px wide inside a ~600px card and the whole trace collapsed against
 * one edge. The data was right; the axis had no relationship to the
 * space it was drawn in.
 * ================================================================== */

/** A window of `count` samples with a distinct, ordered value per axis,
 *  so a reordering or an axis mix-up cannot pass unnoticed. */
function traceWindow(count: number): ReadonlyArray<{x: number; y: number; z: number}> {
  return Array.from({length: count}, (_unused, index) => ({
    x: index - count / 2,
    y: (count - index) / 2,
    z: index % 7,
  }));
}

/** The x coordinate of every point in a rendered polyline string. */
function xsOf(points: string): number[] {
  return points === '' ? [] : points.split(' ').map(pair => Number(pair.split(',')[0]));
}

/** The y coordinate of every point in a rendered polyline string. */
function ysOf(points: string): number[] {
  return points === '' ? [] : points.split(' ').map(pair => Number(pair.split(',')[1]));
}

describe('the live trace fills the width it is actually given', () => {
  it('53. a full window spans the whole plot, edge to edge', () => {
    const samples = traceWindow(TRACE_CAPACITY);
    for (const width of [318, 704, 1294]) {
      const xs = xsOf(tracePoints(samples, 'x', sharedTraceBound(samples), width));
      expect(xs).toHaveLength(TRACE_CAPACITY);
      expect(xs[0]).toBeCloseTo(0, 1);
      expect(xs[xs.length - 1]).toBeCloseTo(width, 1);
      // The span is the plot, not a 47px stub in the corner of it.
      expect(xs[xs.length - 1] - xs[0]).toBeGreaterThan(width * 0.99);
    }
  });

  it('54. one sample does not crash, and does not pretend to be a window', () => {
    const points = tracePoints(traceWindow(1), 'x', 1, 600);
    const xs = xsOf(points);
    expect(xs).toHaveLength(1);
    expect(Number.isFinite(xs[0])).toBe(true);
    expect(ysOf(points).every(value => Number.isFinite(value))).toBe(true);
    // Newest is pinned to the right edge; the rest of the window is
    // simply history this session does not have yet.
    expect(xs[0]).toBeCloseTo(600, 1);
  });

  it('55. an empty trace renders an empty polyline rather than a degenerate one', () => {
    expect(tracePoints([], 'x', 1, 600)).toBe('');
    expect(() => tracePoints([], 'z', 1, 600)).not.toThrow();
  });

  it('56. before layout has reported a width, no point is invented', () => {
    const samples = traceWindow(TRACE_CAPACITY);
    expect(tracePoints(samples, 'x', 1, 0)).toBe('');
    expect(tracePoints(samples, 'x', 1, Number.NaN)).toBe('');
  });

  it('57. x is strictly chronological: index 0 is the oldest and leftmost', () => {
    const samples = traceWindow(TRACE_CAPACITY);
    const xs = xsOf(tracePoints(samples, 'y', sharedTraceBound(samples), 900));
    for (let index = 1; index < xs.length; index += 1) {
      expect(xs[index]).toBeGreaterThan(xs[index - 1]);
    }
  });

  it('58. container width changes the pixels and nothing about the data', () => {
    const samples = traceWindow(TRACE_CAPACITY);
    const bound = sharedTraceBound(samples);
    const narrow = tracePoints(samples, 'x', bound, 300);
    const wide = tracePoints(samples, 'x', bound, 1200);
    // Same samples, same count, same vertical mapping.
    expect(xsOf(narrow)).toHaveLength(xsOf(wide).length);
    expect(ysOf(narrow)).toEqual(ysOf(wide));
    // Purely proportional horizontally - one shared scale, no offset.
    const narrowXs = xsOf(narrow);
    xsOf(wide).forEach((x, index) => {
      expect(x).toBeCloseTo(narrowXs[index] * 4, 1);
    });
  });

  it('59. the three series of one sensor share one coordinate space', () => {
    const samples = traceWindow(TRACE_CAPACITY);
    const bound = sharedTraceBound(samples);
    const xAxis = xsOf(tracePoints(samples, 'x', bound, 640));
    expect(xsOf(tracePoints(samples, 'y', bound, 640))).toEqual(xAxis);
    expect(xsOf(tracePoints(samples, 'z', bound, 640))).toEqual(xAxis);
  });

  it('60. the geometry has no direction dependency, so RTL cannot mirror time', () => {
    const samples = traceWindow(TRACE_CAPACITY);
    const bound = sharedTraceBound(samples);
    const draw = () =>
      (['x', 'y', 'z'] as const)
        .map(axis => tracePoints(samples, axis, bound, 512))
        .join('|');
    const original = I18nManager.isRTL;
    try {
      (I18nManager as unknown as {isRTL: boolean}).isRTL = false;
      const ltr = draw();
      (I18nManager as unknown as {isRTL: boolean}).isRTL = true;
      const rtl = draw();
      expect(rtl).toBe(ltr);
      // And the oldest sample is still on the left in the RTL app.
      const xs = xsOf(tracePoints(samples, 'x', bound, 512));
      expect(xs[0]).toBeLessThan(xs[xs.length - 1]);
    } finally {
      (I18nManager as unknown as {isRTL: boolean}).isRTL = original;
    }
  });

  it('61. a filling window keeps every sample where it was: the axis is the window, not the count', () => {
    // Sample 5 of a 10-long history must sit exactly where sample 5 of a
    // 20-long history sits, or the time axis rescales on every frame.
    const width = 480;
    const shortWindow = xsOf(tracePoints(traceWindow(10), 'x', 1, width));
    const longWindow = xsOf(tracePoints(traceWindow(20), 'x', 1, width));
    const step = width / (TRACE_CAPACITY - 1);
    expect(shortWindow[shortWindow.length - 1]).toBeCloseTo(width, 1);
    expect(longWindow[longWindow.length - 1]).toBeCloseTo(width, 1);
    expect(shortWindow[0]).toBeCloseTo(width - 9 * step, 1);
    expect(longWindow[0]).toBeCloseTo(width - 19 * step, 1);
    // One slot is one slot at every fill level.
    expect(shortWindow[1] - shortWindow[0]).toBeCloseTo(step, 1);
    expect(longWindow[1] - longWindow[0]).toBeCloseTo(step, 1);
  });

  it('62. traceX never leaves the plot box for any window the buffer can hold', () => {
    const width = 777;
    for (let count = 1; count <= TRACE_CAPACITY; count += 1) {
      for (let index = 0; index < count; index += 1) {
        const x = traceX(index, count, width);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(width);
      }
    }
  });
});

/* ================================================================== *
 * 63-65: THE CARD MEASURES ITSELF
 * ================================================================== */

describe('the trace card feeds its own measured width to every series', () => {
  const translate = ((key: string) => key) as never;

  function card(samples: ReadonlyArray<{x: number; y: number; z: number}>) {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TraceCard
          family="GYRO"
          samples={samples}
          title="Gyro"
          unit="dps"
          t={translate}
        />,
      );
    });
    return renderer;
  }

  function measure(renderer: ReactTestRenderer.ReactTestRenderer, width: number) {
    const plot = byTestID(renderer, 'sensors-trace-GYRO-plot');
    act(() => {
      plot.props.onLayout({nativeEvent: {layout: {width, height: TRACE_HEIGHT}}});
    });
  }

  it('63. an unmeasured card draws no polyline at all', () => {
    const renderer = card(traceWindow(TRACE_CAPACITY));
    const lines = renderer.root.findAllByType(Polyline);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.props.points).toBe('');
    }
  });

  it('64. once measured, all three series span the measured width', () => {
    const renderer = card(traceWindow(TRACE_CAPACITY));
    measure(renderer, 612);
    const lines = renderer.root.findAllByType(Polyline);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const xs = xsOf(line.props.points as string);
      expect(xs[0]).toBeCloseTo(0, 1);
      expect(xs[xs.length - 1]).toBeCloseTo(612, 1);
    }
  });

  it('65. re-measuring at another width re-lays the same samples, unchanged', () => {
    const renderer = card(traceWindow(TRACE_CAPACITY));
    measure(renderer, 318);
    const narrow = renderer.root
      .findAllByType(Polyline)
      .map(line => line.props.points as string);
    measure(renderer, 1294);
    const wide = renderer.root
      .findAllByType(Polyline)
      .map(line => line.props.points as string);
    narrow.forEach((points, index) => {
      expect(ysOf(wide[index])).toEqual(ysOf(points));
      expect(xsOf(wide[index])[TRACE_CAPACITY - 1]).toBeCloseTo(1294, 1);
    });
  });
});
