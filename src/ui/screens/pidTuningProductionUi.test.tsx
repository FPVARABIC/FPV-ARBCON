/**
 * THE SCREEN, THE REAL CONTROLLER, AND A BOARD - NO MOCKED OUTCOMES.
 *
 * `PidTuningScreen.test.tsx` hands the screen a port that returns finished
 * outcomes. That is the right tool for asking what the screen DOES with an
 * answer, and the wrong tool for asking whether the answer can happen at
 * all: a hand-written `{kind: 'SAVED_VERIFIED'}` proves the copy, and
 * nothing about the transaction that would have to produce it.
 *
 * So these scenarios wire the shipped `PidTuningController` - the same class
 * the app constructs - to `VirtualPidBoard`, and drive it from the screen's
 * own controls. Every byte on the wire is written by the production
 * encoders, read back by the production decoders, and judged by the
 * production classifier. What is asserted is what a pilot would see after
 * the board actually answered.
 *
 * WHAT THIS IS NOT. VirtualPidBoard is a model built from pinned firmware
 * source, not a flight controller. Nothing here is evidence about real
 * hardware and no claim below should be read as one.
 */
import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import '../../i18n';
import {createPidTuningDraft} from '../../core/state/pidTuningModel';
import type {MspClientState} from '../../core/protocol/mspClient';
import type {MspTelemetryScheduler} from '../../core/protocol/telemetry';
import {
  MSP_EEPROM_WRITE, MSP_SET_PID, MSP_SET_RC_TUNING,
} from '../../core/protocol/msp/commands/mspCommands';
import {
  MSP_CALCULATE_SIMPLIFIED_PID, MSP_SET_SIMPLIFIED_TUNING,
} from '../../core/protocol/msp/commands/pidProfileCommands';
import {RC_TUNING_OFFSETS, RC_TUNING_RETIRED_OFFSETS} from '../../core/protocol/msp/decoding/decodeRcTuningFull';
import type {
  MspIdentificationState, SetupUiSessionKey,
} from '../../platforms/react-native/protocol/MspSessionCoordinator';
import {
  PidTuningController, type PidSessionCoordinator,
} from '../../platforms/react-native/protocol/PidTuningController';
import {
  VirtualPidBoard, type VirtualPidBoardOptions,
} from '../../platforms/react-native/protocol/__testUtils__/virtualPidBoard';
import PidTuningScreen, {type PidControllerPort} from './PidTuningScreen';

/** The whole-configuration reset, named only to prove it never goes out. */
const MSP_RESET_CONF_NEVER_SENT = 208;
const SESSION: SetupUiSessionKey = {sessionId: 'pid-production-ui', generation: 7};

function harness(options: Partial<VirtualPidBoardOptions> = {}) {
  const board = new VirtualPidBoard({apiMinor: 47, filterBytes: 49, ...options});
  const telemetry = {
    acquirePauseLease: jest.fn(() => ({release: jest.fn()})),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(() => Promise.resolve()),
    requestRefresh: jest.fn(),
  } as unknown as MspTelemetryScheduler;
  const identification = {
    status: 'SUCCEEDED',
    identity: {
      firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
      apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
      board: {gyroSampleRateHz: 8000},
    },
  } as MspIdentificationState;
  const coordinator: PidSessionCoordinator = {
    getOwnershipState: () => 'ACTIVE',
    getIdentificationState: () => identification,
    getSessionKey: sessionId => ({sessionId, generation: SESSION.generation}),
    getActiveMspClient: () => board as never,
    getTelemetryScheduler: () => telemetry,
    getMspRecoveryState: () => 'READY' as MspClientState,
  };
  const controller = new PidTuningController({
    coordinator,
    appStateOwner: {getPhase: () => 'ACTIVE'},
    isMotorTestActive: () => false,
  });
  /** The screen's port, bound to the REAL controller. Nothing is stubbed. */
  const port: PidControllerPort = {
    load: key => controller.load(key),
    save: (key, original, draft) => controller.save(key, original, draft),
    selectProfile: (key, kind, index) => controller.selectProfile(key, kind, index),
    loadSimplified: key => controller.loadSimplified(key),
    saveSimplified: (key, original, patch) => controller.saveSimplified(key, original, patch),
    setRatesType: (key, original, raw) => controller.setRatesType(key, original, raw),
    readProfileName: (key, kind) => controller.readProfileName(key, kind),
  };
  return {board, controller, port};
}

async function render(port: PidControllerPort) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <PidTuningScreen sessionKey={SESSION} active onOpenMotors={jest.fn()} controller={port} />,
    );
  });
  return renderer;
}
function screenText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root.findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')))
    .join('\n');
}
function press(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  const target = renderer.root.findAllByProps({testID}).find(node => typeof node.props?.onPress === 'function');
  if (target === undefined) throw new Error(`no pressable ${testID}`);
  act(() => target.props.onPress());
}
function editable(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): boolean | undefined {
  return renderer.root.findAllByProps({testID}).find(node => typeof node.props.editable === 'boolean')?.props.editable;
}
function typeInto(renderer: ReactTestRenderer.ReactTestRenderer, testID: string, value: string): void {
  const input = renderer.root.findAllByProps({testID}).find(node => typeof node.props.onChangeText === 'function');
  if (input === undefined) throw new Error(`no input ${testID}`);
  act(() => input.props.onChangeText(value));
}
async function save(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
}
/** A simplified PID block with the generator ON across all three axes. */
function simplifiedPidsOn(): Uint8Array {
  return Uint8Array.from([2, 110, 100, 100, 100, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0]);
}

describe('the PID page against a board, through the shipped controller', () => {
  it('marks the profile the board itself reports active', async () => {
    const h = harness();
    const renderer = await render(h.port);
    const selected = renderer.root
      .findAllByProps({testID: 'pid-active-profile'})
      .flatMap(node => node.findAll(child => child.props?.accessibilityState?.selected === true))
      .map(child => child.props.accessibilityLabel);
    expect(selected).toContain(`ملف PID ${h.board.activePidProfile() + 1}`);
    act(() => renderer.unmount());
  });

  it('writes an edited gain and claims verified only after the board answers', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    typeInto(renderer, 'pid-roll-p', '52');
    await save(renderer);

    expect(h.board.commandCount(MSP_SET_PID)).toBe(1);
    expect(h.board.commandCount(MSP_EEPROM_WRITE)).toBe(1);
    expect(h.board.pidProfile(h.board.activePidProfile()).pid[0]).toBe(52);
    expect(screenText(renderer)).toContain('أكدت القراءة الراجعة تطابقها');
    act(() => renderer.unmount());
  });

  it('refuses a direct edit the active generator would immediately undo', async () => {
    // The screen disables the owned fields; this proves the CONTROLLER
    // refuses the same edit, so the guarantee does not rest on a disabled
    // prop that a future layout change could drop.
    const h = harness({pidProfiles: [{simplifiedPids: simplifiedPidsOn()}, {}, {}, {}]});
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    expect(editable(renderer, 'pid-roll-p')).toBe(false);
    act(() => renderer.unmount());

    const loaded = await h.controller.load(SESSION);
    if (loaded.kind !== 'LOADED') throw new Error(`load: ${loaded.kind}`);
    const draft = createPidTuningDraft(loaded.snapshot);
    const outcome = await h.controller.save(SESSION, loaded.snapshot, {
      ...draft, roll: {...draft.roll, p: draft.roll.p + 9},
    });
    expect(outcome.kind).toBe('REJECTED');
    expect(h.board.commandCount(MSP_SET_PID)).toBe(0);
  });

  it('regenerates the tune through the real simplified transaction', async () => {
    const h = harness({pidProfiles: [{simplifiedPids: simplifiedPidsOn()}, {}, {}, {}]});
    const renderer = await render(h.port);
    const before = Uint8Array.from(h.board.pidProfile(0).pid);
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    await save(renderer);

    expect(h.board.commandCount(MSP_SET_SIMPLIFIED_TUNING)).toBe(1);
    // The generator really did rewrite the stored gains - which is what
    // makes the overwrite warning on the screen a true statement rather
    // than a scary one.
    expect(Array.from(h.board.pidProfile(0).pid)).not.toEqual(Array.from(before));
    expect(screenText(renderer)).toContain('أعاد المتحكم حساب القيم من الشرائح');
    act(() => renderer.unmount());
  });

  it('refuses to write when the board\'s own calculator disagrees with ours', async () => {
    const h = harness({
      pidProfiles: [{simplifiedPids: simplifiedPidsOn()}, {}, {}, {}],
      quirks: {calculateOracle: 'DISAGREES'},
    });
    const renderer = await render(h.port);
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    await save(renderer);
    expect(h.board.commandCount(MSP_SET_SIMPLIFIED_TUNING)).toBe(0);
    expect(screenText(renderer)).toContain('لا يطابق حسابنا');
    act(() => renderer.unmount());
  });

  it('changes the rates FORMULA and leaves the stored numbers alone', async () => {
    const h = harness();
    const renderer = await render(h.port);
    const before = Uint8Array.from(h.board.rateProfile(h.board.activeRateProfile()).rcTuning);
    press(renderer, 'pid-rates-type-3');
    await save(renderer);

    expect(h.board.commandCount(MSP_SET_RC_TUNING)).toBe(1);
    const after = h.board.rateProfile(h.board.activeRateProfile()).rcTuning;
    expect(after[RC_TUNING_OFFSETS.ratesType]).toBe(3);
    // Every other byte the firmware keeps is untouched: no silent conversion.
    for (let offset = 0; offset < before.length; offset += 1) {
      if (offset === RC_TUNING_OFFSETS.ratesType) continue;
      if (RC_TUNING_RETIRED_OFFSETS.includes(offset)) continue;
      expect(after[offset]).toBe(before[offset]);
    }
    act(() => renderer.unmount());
  });

  it('catches a board that rescales the numbers while changing the formula', async () => {
    const h = harness({quirks: {ratesTypeWrite: 'ALSO_RESCALES'}});
    const renderer = await render(h.port);
    press(renderer, 'pid-rates-type-3');
    await save(renderer);
    const text = screenText(renderer);
    expect(text).toContain('أعادت اللوحة قيم Rates مختلفة');
    expect(text).not.toContain('بُدّلت خوارزمية Rates وحُفظت');
    act(() => renderer.unmount());
  });

  it('never sends the whole-configuration reset, and never lets the calculator follow the write', async () => {
    const h = harness({pidProfiles: [{simplifiedPids: simplifiedPidsOn()}, {}, {}, {}]});
    const renderer = await render(h.port);
    press(renderer, 'pid-rates-type-3');
    press(renderer, 'pid-simplified-masterMultiplier-value-plus');
    await save(renderer);

    expect(h.board.commandCount(MSP_RESET_CONF_NEVER_SENT)).toBe(0);
    // MSP_CALCULATE_SIMPLIFIED_PID may be consulted as an ORACLE before a
    // write - it stores nothing - but it must never be what a press sends
    // on its own, and it must never follow the write and be mistaken for
    // the result.
    const requests = h.board.requests.map(entry => entry.command);
    const write = requests.indexOf(MSP_SET_SIMPLIFIED_TUNING);
    const calculate = requests.indexOf(MSP_CALCULATE_SIMPLIFIED_PID);
    expect(write).toBeGreaterThan(-1);
    if (calculate !== -1) expect(calculate).toBeLessThan(write);
    act(() => renderer.unmount());
  });

  it('says UNSUPPORTED about the FIRMWARE only when the board really lacks the command', async () => {
    const h = harness({unsupportedCommands: [MSP_SET_SIMPLIFIED_TUNING, 0x8c /* MSP_SIMPLIFIED_TUNING */]});
    const renderer = await render(h.port);
    const text = screenText(renderer);
    expect(text).toContain('بناء البرنامج الثابت');
    expect(text).not.toContain('هذه حدود التطبيق');
    // With no generator to work in, the direct controls are the workspace.
    expect(renderer.root.findAllByProps({testID: 'pid-roll-p'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });
});
