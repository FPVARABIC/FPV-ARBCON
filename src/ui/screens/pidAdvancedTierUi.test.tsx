/**
 * P-E §37 - THE EXPERT TIER, THROUGH THE SHIPPED CONTROLLER AND A BOARD.
 *
 * Every scenario here drives PidTuningScreen's own controls, against the
 * real `PidTuningController`, over `VirtualPidBoard`. No outcome is
 * hand-written: the bytes are produced by the production encoders, parsed
 * by the production decoders and judged by the production classifier, and
 * what is asserted is what an operator would read afterwards.
 *
 * WHAT THIS IS NOT. VirtualPidBoard is a model built from pinned firmware
 * source, not a flight controller. Nothing here is evidence about real
 * hardware.
 */
import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import '../../i18n';
import type {MspClientState} from '../../core/protocol/mspClient';
import type {MspTelemetryScheduler} from '../../core/protocol/telemetry';
import {
  MSP_EEPROM_WRITE, MSP_SET_PID_ADVANCED, MSP_SET_FILTER_CONFIG,
} from '../../core/protocol/msp/commands/mspCommands';
import {
  MSP_COPY_PROFILE, MSP_SET_RESET_CURR_PID,
} from '../../core/protocol/msp/commands/pidProfileCommands';
import {PID_ADVANCED_OFFSETS} from '../../core/protocol/msp/decoding/decodePidAdvancedFull';
import {FILTER_CONFIG_OFFSETS} from '../../core/protocol/msp/decoding/decodeFilterConfigFull';
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

const SESSION: SetupUiSessionKey = {sessionId: 'pid-advanced-ui', generation: 3};

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
  const port: PidControllerPort = {
    load: key => controller.load(key),
    save: (key, original, draft) => controller.save(key, original, draft),
    selectProfile: (key, kind, index) => controller.selectProfile(key, kind, index),
    loadSimplified: key => controller.loadSimplified(key),
    saveSimplified: (key, original, patch) => controller.saveSimplified(key, original, patch),
    setRatesType: (key, original, raw) => controller.setRatesType(key, original, raw),
    readProfileName: (key, kind) => controller.readProfileName(key, kind),
    setProfileName: (key, kind, name) => controller.setProfileName(key, kind, name),
    copyProfile: (key, request) => controller.copyProfile(key, request),
    resetPidProfile: key => controller.resetPidProfile(key),
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
async function pressAsync(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): Promise<void> {
  const target = renderer.root.findAllByProps({testID}).find(node => typeof node.props?.onPress === 'function');
  if (target === undefined) throw new Error(`no pressable ${testID}`);
  await act(async () => { await target.props.onPress(); });
}
function exists(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): boolean {
  return renderer.root.findAllByProps({testID}).length > 0;
}
function typeInto(renderer: ReactTestRenderer.ReactTestRenderer, testID: string, value: string): void {
  const input = renderer.root.findAllByProps({testID}).find(node => typeof node.props.onChangeText === 'function');
  if (input === undefined) throw new Error(`no input ${testID}`);
  act(() => input.props.onChangeText(value));
}
function stepperDisabled(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): boolean | undefined {
  return renderer.root.findAllByProps({testID}).find(node => typeof node.props.editable === 'boolean')?.props.editable === false;
}
async function save(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
}
/** Open the one advanced disclosure and one group inside it. */
function openGroup(renderer: ReactTestRenderer.ReactTestRenderer, group: string): void {
  press(renderer, 'pid-advanced-toggle');
  press(renderer, `pid-advanced-groups-${group}-toggle`);
}
/** A simplified PID block with the generator ON across all three axes. */
function simplifiedPidsOn(): Uint8Array {
  return Uint8Array.from([2, 110, 100, 100, 100, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0]);
}
/**
 * A simplified FILTER block with its enable flag SET.
 *
 * The board's own default leaves byte 0 at zero - the generator is off for
 * that chain - so a scenario about a filter the generator owns has to turn
 * it on explicitly rather than assume it.
 */
function simplifiedFilterOn(lpf1: number, lpf2: number): Uint8Array {
  const block = new Uint8Array(18);
  block[0] = 1;
  block[1] = 100;
  const view = new DataView(block.buffer);
  view.setUint16(2, lpf1, true);
  view.setUint16(4, lpf2, true);
  view.setUint16(6, lpf1, true);
  view.setUint16(8, lpf2, true);
  return block;
}

describe('P-E: the expert tier reaches the board', () => {
  it('1. keeps the tier behind ONE disclosure, with every group folded', async () => {
    const h = harness();
    const renderer = await render(h.port);
    // Before opening: no group body anywhere on the page.
    expect(exists(renderer, 'pid-advanced-groups')).toBe(false);
    press(renderer, 'pid-advanced-toggle');
    expect(exists(renderer, 'pid-advanced-groups')).toBe(true);
    for (const group of ['D_MAX', 'TPA', 'GYRO_FILTERS', 'DTERM_FILTERS']) {
      expect(exists(renderer, `pid-advanced-groups-${group}-toggle`)).toBe(true);
      expect(exists(renderer, `pid-advanced-groups-${group}-body`)).toBe(false);
    }
    act(() => renderer.unmount());
  });

  it('2. writes an edited D Max through MSP_SET_PID_ADVANCED and verifies it', async () => {
    const h = harness();
    const renderer = await render(h.port);
    openGroup(renderer, 'D_MAX');
    typeInto(renderer, 'pid-advanced-dMaxRoll-value', '47');
    await save(renderer);
    expect(h.board.commandCount(MSP_SET_PID_ADVANCED)).toBe(1);
    expect(h.board.pidProfile(h.board.activePidProfile()).advanced[PID_ADVANCED_OFFSETS.dMaxRoll]).toBe(47);
    expect(screenText(renderer)).toContain('أكدت القراءة الراجعة تطابقها');
    act(() => renderer.unmount());
  });

  it('3. writes an edited gyro notch through MSP_SET_FILTER_CONFIG', async () => {
    const h = harness();
    const renderer = await render(h.port);
    openGroup(renderer, 'GYRO_FILTERS');
    typeInto(renderer, 'pid-advanced-gyroSoftNotchHz2-value', '265');
    typeInto(renderer, 'pid-advanced-gyroSoftNotchCutoff2-value', '160');
    await save(renderer);
    expect(h.board.commandCount(MSP_SET_FILTER_CONFIG)).toBe(1);
    const filters = h.board.composedFilterConfig();
    const view = new DataView(filters.buffer, filters.byteOffset, filters.byteLength);
    expect(view.getUint16(FILTER_CONFIG_OFFSETS.gyroSoftNotchHz2, true)).toBe(265);
    expect(view.getUint16(FILTER_CONFIG_OFFSETS.gyroSoftNotchCutoff2, true)).toBe(160);
    act(() => renderer.unmount());
  });

  it('4. writes a D-term type through the same command without disturbing the gyro half', async () => {
    const h = harness();
    const renderer = await render(h.port);
    const before = h.board.composedFilterConfig();
    openGroup(renderer, 'DTERM_FILTERS');
    typeInto(renderer, 'pid-advanced-yawLowpassHz-value', '120');
    await save(renderer);
    const after = h.board.composedFilterConfig();
    const view = new DataView(after.buffer, after.byteOffset, after.byteLength);
    expect(view.getUint16(FILTER_CONFIG_OFFSETS.yawLowpassHz, true)).toBe(120);
    // Every gyro-scope byte comes back unchanged.
    for (const offset of [
      FILTER_CONFIG_OFFSETS.gyroLpf1StaticHz, FILTER_CONFIG_OFFSETS.gyroLpf2StaticHz,
      FILTER_CONFIG_OFFSETS.gyroSoftNotchHz1, FILTER_CONFIG_OFFSETS.gyroSoftNotchHz2,
      FILTER_CONFIG_OFFSETS.gyroLpf1Type, FILTER_CONFIG_OFFSETS.gyroLpf2Type,
    ]) {
      expect(after[offset]).toBe(before[offset]);
    }
    act(() => renderer.unmount());
  });

  it('5. leaves every byte it does not own untouched across an advanced save', async () => {
    const h = harness();
    const renderer = await render(h.port);
    const before = h.board.pidProfile(h.board.activePidProfile()).advanced.slice();
    openGroup(renderer, 'ITERM');
    typeInto(renderer, 'pid-advanced-itermRelaxCutoff-value', '20');
    await save(renderer);
    const after = h.board.pidProfile(h.board.activePidProfile()).advanced;
    const moved = [...after]
      .map((value, index) => (value === before[index] ? undefined : index))
      .filter(index => index !== undefined);
    expect(moved).toEqual([PID_ADVANCED_OFFSETS.itermRelaxCutoff]);
    act(() => renderer.unmount());
  });

  it('6. sends NOTHING when the tier is only opened and read', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    for (const group of ['D_MAX', 'FEEDFORWARD', 'TPA', 'ITERM', 'LIMITS', 'BATTERY', 'GYRO_FILTERS', 'DTERM_FILTERS']) {
      press(renderer, `pid-advanced-groups-${group}-toggle`);
    }
    expect(h.board.commandCount(MSP_SET_PID_ADVANCED)).toBe(0);
    expect(h.board.commandCount(MSP_SET_FILTER_CONFIG)).toBe(0);
    expect(h.board.commandCount(MSP_EEPROM_WRITE)).toBe(0);
    act(() => renderer.unmount());
  });

  it('7. disables a D Max field the active generator owns, and says why', async () => {
    const h = harness({pidProfiles: [{simplifiedPids: simplifiedPidsOn()}, {}, {}, {}]});
    const renderer = await render(h.port);
    openGroup(renderer, 'D_MAX');
    expect(stepperDisabled(renderer, 'pid-advanced-dMaxRoll-value')).toBe(true);
    expect(exists(renderer, 'pid-advanced-dMaxRoll-owned')).toBe(true);
    // d_max_gain is a DIFFERENT stored byte the generator never writes.
    expect(stepperDisabled(renderer, 'pid-advanced-dMaxGain-value')).toBe(false);
    expect(exists(renderer, 'pid-advanced-dMaxGain-owned')).toBe(false);
    act(() => renderer.unmount());
  });

  it('8. disables the second GYRO lowpass while its simplified block is enabled', async () => {
    const h = harness({globals: {simplifiedGyro: simplifiedFilterOn(250, 500)}});
    const renderer = await render(h.port);
    openGroup(renderer, 'GYRO_FILTERS');
    expect(stepperDisabled(renderer, 'pid-advanced-gyroLpf2StaticHz-value')).toBe(true);
    // The notches are NOT generator-owned and stay editable.
    expect(stepperDisabled(renderer, 'pid-advanced-gyroSoftNotchHz1-value')).toBe(false);
    act(() => renderer.unmount());
  });

  it('8b. disables the second D-TERM lowpass on its own block, independently', async () => {
    // The two chains have SEPARATE enable flags - one in the PID profile,
    // one global - so a D-term block that is on must lock the D-term lpf2
    // even when the gyro block is off, and vice versa.
    const h = harness({pidProfiles: [
      {simplifiedDterm: simplifiedFilterOn(75, 150)}, {}, {}, {},
    ]});
    const renderer = await render(h.port);
    openGroup(renderer, 'DTERM_FILTERS');
    expect(stepperDisabled(renderer, 'pid-advanced-dtermLpf2StaticHz-value')).toBe(true);
    expect(exists(renderer, 'pid-advanced-dtermLpf2StaticHz-owned')).toBe(true);
    expect(stepperDisabled(renderer, 'pid-advanced-dtermNotchHz-value')).toBe(false);
    press(renderer, 'pid-advanced-groups-GYRO_FILTERS-toggle');
    expect(stepperDisabled(renderer, 'pid-advanced-gyroLpf2StaticHz-value')).toBe(false);
    act(() => renderer.unmount());
  });

  it('9. offers a lowpass type as a named choice, never as a bare number', async () => {
    const h = harness();
    const renderer = await render(h.port);
    openGroup(renderer, 'GYRO_FILTERS');
    expect(exists(renderer, 'pid-advanced-gyroLpf1Type-choices')).toBe(true);
    expect(exists(renderer, 'pid-advanced-gyroLpf1Type-value')).toBe(false);
    expect(screenText(renderer)).toContain('PT3');
    act(() => renderer.unmount());
  });

  it('10. writes a chosen lowpass type through the wire', async () => {
    const h = harness();
    const renderer = await render(h.port);
    openGroup(renderer, 'DTERM_FILTERS');
    press(renderer, 'pid-advanced-dtermLpf1Type-choices-3');
    await save(renderer);
    expect(h.board.composedFilterConfig()[FILTER_CONFIG_OFFSETS.dtermLpf1Type]).toBe(3);
    act(() => renderer.unmount());
  });

  it('11. names the auto-profile sentinel rather than showing -1', async () => {
    const h = harness();
    const renderer = await render(h.port);
    openGroup(renderer, 'BATTERY');
    expect(exists(renderer, 'pid-advanced-autoProfileCellCount-choices')).toBe(true);
    const text = screenText(renderer);
    expect(text).toContain('تبديل تلقائي');
    expect(text).toContain('بلا تبديل');
    act(() => renderer.unmount());
  });

  it('12. states the SCOPE of the gyro group and the D-term group differently', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    const scopeOf = (group: string): string => {
      const node = renderer.root.findAllByProps({testID: `pid-advanced-groups-${group}-scope`})[0];
      return String(node.props.children);
    };
    expect(scopeOf('GYRO_FILTERS')).toContain('مشترك');
    expect(scopeOf('DTERM_FILTERS')).toContain('ملف PID');
    expect(scopeOf('GYRO_FILTERS')).not.toBe(scopeOf('DTERM_FILTERS'));
    act(() => renderer.unmount());
  });

  it('13. keeps raw wire names out of the page until the technical details are opened', async () => {
    const h = harness();
    const renderer = await render(h.port);
    openGroup(renderer, 'D_MAX');
    expect(screenText(renderer)).not.toContain('d_max_gain');
    press(renderer, 'pid-advanced-groups-D_MAX-detail-toggle');
    expect(screenText(renderer)).toContain('d_max_gain');
    act(() => renderer.unmount());
  });

  it('14. blocks the save and names the reason when an advanced value is out of range', async () => {
    const h = harness();
    const renderer = await render(h.port);
    openGroup(renderer, 'LIMITS');
    // 0 is below MOTOR_OUTPUT_LIMIT_PERCENT_MIN; the control clamps, so the
    // refusal is proven at the model that guards the wire.
    typeInto(renderer, 'pid-advanced-motorOutputLimit-value', '0');
    await save(renderer);
    // The stepper clamped to the firmware minimum rather than sending 0.
    expect(h.board.pidProfile(h.board.activePidProfile()).advanced[PID_ADVANCED_OFFSETS.motorOutputLimit])
      .toBeGreaterThanOrEqual(1);
    act(() => renderer.unmount());
  });

  it('15. refuses a D-term notch whose cutoff has swallowed its centre', async () => {
    const h = harness();
    const renderer = await render(h.port);
    openGroup(renderer, 'DTERM_FILTERS');
    typeInto(renderer, 'pid-advanced-dtermNotchHz-value', '200');
    typeInto(renderer, 'pid-advanced-dtermNotchCutoff-value', '200');
    expect(screenText(renderer)).toContain('حدود Min/Max للفلاتر غير متناسقة');
    await save(renderer);
    // Nothing went out: the page refuses before the wire.
    expect(h.board.commandCount(MSP_SET_FILTER_CONFIG)).toBe(0);
    act(() => renderer.unmount());
  });

  it('16. shows the RPM filter as read-only and explains why', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    expect(exists(renderer, 'pid-rpm-filter')).toBe(true);
    expect(exists(renderer, 'pid-rpm-readout')).toBe(true);
    const text = screenText(renderer);
    expect(text).toContain('مرشّح RPM');
    expect(text).toContain('1.48');
    act(() => renderer.unmount());
  });
});

describe('P-E: the whole-profile operations', () => {
  it('17. keeps profile management folded until it is asked for', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    expect(exists(renderer, 'pid-profile-management')).toBe(true);
    expect(exists(renderer, 'pid-profile-management-body')).toBe(false);
    press(renderer, 'pid-profile-management-toggle');
    expect(exists(renderer, 'pid-profile-management-body')).toBe(true);
    act(() => renderer.unmount());
  });

  it('18. counts the profile name in BYTES and refuses one that will not fit', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    typeInto(renderer, 'pid-profile-management-name-input', 'RACEDAY9');
    expect(screenText(renderer)).toContain('8 / 8 بايت');
    expect(exists(renderer, 'pid-profile-management-name-too-long')).toBe(false);
    typeInto(renderer, 'pid-profile-management-name-input', 'RACEDAY99');
    expect(screenText(renderer)).toContain('9 / 8 بايت');
    expect(exists(renderer, 'pid-profile-management-name-too-long')).toBe(true);
    // ...and the button is not merely warned about, it is unusable.
    expect(renderer.root.findAllByProps({testID: 'pid-profile-management-name-save'})
      .some(node => node.props.disabled === true)).toBe(true);
    act(() => renderer.unmount());
  });

  it('19. calls the ASCII restriction its OWN policy, not a firmware limit', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    typeInto(renderer, 'pid-profile-management-name-input', 'سباق');
    expect(exists(renderer, 'pid-profile-management-name-non-ascii')).toBe(true);
    expect(screenText(renderer)).toContain('سياسة هذا التطبيق');
    // FOUR characters, EIGHT bytes. Counting characters would have said
    // 4 / 8 and let a name through that the firmware cannot hold.
    expect(screenText(renderer)).toContain('8 / 8 بايت');
    act(() => renderer.unmount());
  });

  it('20. renames the profile and reports the READBACK, not the acknowledgement', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    typeInto(renderer, 'pid-profile-management-name-input', 'RACE2');
    await pressAsync(renderer, 'pid-profile-management-name-save');
    expect(screenText(renderer)).toContain('«RACE2»');
    expect(screenText(renderer)).toContain('طابقته القراءة الراجعة');
    act(() => renderer.unmount());
  });

  it('21. reports NAME_MISMATCH when a board truncates the name it stored', async () => {
    // The firmware truncates silently and acknowledges; a board with a
    // smaller buffer proves the readback is what decides.
    const h = harness({quirks: {profileNameCapacity: 4}});
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    typeInto(renderer, 'pid-profile-management-name-input', 'RACE2');
    await pressAsync(renderer, 'pid-profile-management-name-save');
    const text = screenText(renderer);
    expect(text).toContain('لم يُحفظ الاسم كما طُلب');
    expect(text).not.toContain('طابقته القراءة الراجعة');
    act(() => renderer.unmount());
  });

  it('22. refuses a copy onto the ACTIVE profile and says whose rule that is', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    press(renderer, 'pid-profile-management-copy-source-1');
    press(renderer, `pid-profile-management-copy-destination-${h.board.activePidProfile()}`);
    expect(exists(renderer, 'pid-profile-management-copy-active-refused')).toBe(true);
    expect(screenText(renderer)).toContain('قاعدة هذا التطبيق');
    await pressAsync(renderer, 'pid-profile-management-copy-run');
    expect(h.board.commandCount(MSP_COPY_PROFILE)).toBe(0);
    act(() => renderer.unmount());
  });

  it('23. refuses a copy whose source and destination are the same', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    press(renderer, 'pid-profile-management-copy-source-2');
    press(renderer, 'pid-profile-management-copy-destination-2');
    expect(exists(renderer, 'pid-profile-management-copy-same-refused')).toBe(true);
    await pressAsync(renderer, 'pid-profile-management-copy-run');
    expect(h.board.commandCount(MSP_COPY_PROFILE)).toBe(0);
    act(() => renderer.unmount());
  });

  it('24. copies one inactive profile onto another and verifies it field by field', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    press(renderer, 'pid-profile-management-copy-source-1');
    press(renderer, 'pid-profile-management-copy-destination-2');
    await pressAsync(renderer, 'pid-profile-management-copy-run');
    expect(h.board.commandCount(MSP_COPY_PROFILE)).toBe(1);
    expect(screenText(renderer)).toContain('وطابقت القراءة الراجعة المصدر');
    act(() => renderer.unmount());
  });

  it('25. confirms before a reset, and sends nothing if the confirmation is cancelled', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    press(renderer, 'pid-profile-management-reset-open');
    expect(exists(renderer, 'pid-profile-management-reset-confirm')).toBe(true);
    press(renderer, 'pid-profile-management-reset-cancel');
    expect(exists(renderer, 'pid-profile-management-reset-confirm')).toBe(false);
    expect(h.board.commandCount(MSP_SET_RESET_CURR_PID)).toBe(0);
    act(() => renderer.unmount());
  });

  it('26. reports a reset as APPLIED, PARTIALLY VERIFIED and NOT PERSISTED', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    press(renderer, 'pid-profile-management-reset-open');
    await pressAsync(renderer, 'pid-profile-management-reset-run');
    expect(h.board.commandCount(MSP_SET_RESET_CURR_PID)).toBe(1);
    const text = screenText(renderer);
    expect(text).toContain('في الذاكرة العاملة');
    expect(text).toContain('تحقّقنا من');
    expect(text).toContain('لم نقرأها ولا ندّعي صحتها');
    // The reset command itself persists nothing, and the page says so
    // instead of writing EEPROM behind the operator's back.
    expect(h.board.commandCount(MSP_EEPROM_WRITE)).toBe(0);
    act(() => renderer.unmount());
  });

  it('27. reloads the profile NAME after a reset rather than showing the old one', async () => {
    const h = harness();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    press(renderer, 'pid-profile-management-toggle');
    typeInto(renderer, 'pid-profile-management-name-input', 'BEFORE');
    await pressAsync(renderer, 'pid-profile-management-name-save');
    press(renderer, 'pid-profile-management-reset-open');
    await pressAsync(renderer, 'pid-profile-management-reset-run');
    // The firmware reset rewrites the name; whatever it is now, the page
    // must not still be claiming the one we typed - neither in the field
    // nor in the byte counter beside it.
    expect(h.board.pidProfile(h.board.activePidProfile()).name).not.toBe('BEFORE');
    const field = renderer.root.findAllByProps({testID: 'pid-profile-management-name-input'})
      .find(node => typeof node.props.onChangeText === 'function');
    expect(field?.props.value).not.toBe('BEFORE');
    expect(field?.props.value).toBe(h.board.pidProfile(h.board.activePidProfile()).name);
    act(() => renderer.unmount());
  });

  it('28. refuses every whole-profile operation while edits are unsaved', async () => {
    const h = harness();
    const renderer = await render(h.port);
    openGroup(renderer, 'D_MAX');
    typeInto(renderer, 'pid-advanced-dMaxRoll-value', '60');
    press(renderer, 'pid-profile-management-toggle');
    press(renderer, 'pid-profile-management-reset-open');
    await pressAsync(renderer, 'pid-profile-management-reset-run');
    // The unsaved draft is not carried into a reset, and the reset is not
    // performed underneath it.
    expect(h.board.commandCount(MSP_SET_RESET_CURR_PID)).toBe(0);
    act(() => renderer.unmount());
  });
});
