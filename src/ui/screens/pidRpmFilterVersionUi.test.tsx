/**
 * P-E2 §16 - THE RPM FILTER ACROSS FOUR API VERSIONS, THROUGH THE SHIPPED
 * SCREEN, THE SHIPPED CONTROLLER AND A BOARD.
 *
 * Every scenario drives PidTuningScreen's own controls against the real
 * `PidTuningController` over `VirtualPidBoard`. Nothing is hand-asserted
 * from an encoder's output: the payload is produced by the production
 * encoder, applied by a board that reimplements the firmware's own
 * MSP_SET_FILTER_CONFIG behaviour, read back by the production decoder and
 * judged by the production classifier.
 *
 * WHAT THE FOUR ROWS ARE FOR
 *
 *   1.47   the tail is not in the wire contract        no controls, one note
 *   1.48   the tail arrives                            five more controls
 *   1.49   same layout, different pinned tree          identical behaviour
 *   1.50   newer than anything we have READ            reads, never writes
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
import {MSP_EEPROM_WRITE, MSP_SET_FILTER_CONFIG} from '../../core/protocol/msp/commands/mspCommands';
import {FILTER_CONFIG_OFFSETS} from '../../core/protocol/msp/decoding/decodeFilterConfigFull';
import {
  MSP_FILTER_CONFIG_BYTES_API147,
  MSP_FILTER_CONFIG_BYTES_API148,
} from '../../core/protocol/msp/decoding/pidWireContracts';
import {RPM_FILTER_TAIL_KEYS} from '../../core/state/rpmFilterFields';
import type {
  MspIdentificationState, SetupUiSessionKey,
} from '../../platforms/react-native/protocol/MspSessionCoordinator';
import {
  PidTuningController, type PidSessionCoordinator,
} from '../../platforms/react-native/protocol/PidTuningController';
import {VirtualPidBoard} from '../../platforms/react-native/protocol/__testUtils__/virtualPidBoard';
import PidTuningScreen, {type PidControllerPort} from './PidTuningScreen';

const SESSION: SetupUiSessionKey = {sessionId: 'pid-rpm-version', generation: 5};

/** The length each firmware ACTUALLY sends. 49 at 1.47, 56 from 1.48. */
function filterBytesFor(apiMinor: number): number {
  return apiMinor <= 47 ? MSP_FILTER_CONFIG_BYTES_API147 : MSP_FILTER_CONFIG_BYTES_API148;
}

function harness(apiMinor: number) {
  const board = new VirtualPidBoard({apiMinor, filterBytes: filterBytesFor(apiMinor)});
  /*
   * THREE DISTINCT WEIGHTS, ON PURPOSE.
   *
   * The firmware's own reset is 100/100/100, which is a fine default and a
   * terrible fixture: every weight reads the same, so a screen that showed
   * harmonic 1's weight in harmonic 3's box would look perfectly correct.
   * Distinct values make the mapping observable.
   */
  if (apiMinor >= 48) {
    const global = board.globals().filterGlobal;
    global[FILTER_CONFIG_OFFSETS.rpmFilterWeights] = 100;
    global[FILTER_CONFIG_OFFSETS.rpmFilterWeights + 1] = 70;
    global[FILTER_CONFIG_OFFSETS.rpmFilterWeights + 2] = 40;
  }
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
      apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: apiMinor},
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
function exists(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): boolean {
  return renderer.root.findAllByProps({testID}).length > 0;
}
function typeInto(renderer: ReactTestRenderer.ReactTestRenderer, testID: string, value: string): void {
  const input = renderer.root.findAllByProps({testID}).find(node => typeof node.props.onChangeText === 'function');
  if (input === undefined) throw new Error(`no input ${testID}`);
  act(() => input.props.onChangeText(value));
}
function fieldValue(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): string | undefined {
  return renderer.root.findAllByProps({testID}).find(node => typeof node.props.value === 'string')?.props.value;
}
async function save(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => { await renderer.root.findByProps({testID: 'pid-save-bar-save'}).props.onPress(); });
}
/** The last payload the app actually put on the wire for a command. */
function lastPayload(board: VirtualPidBoard, command: number): Uint8Array | undefined {
  return [...board.requests].reverse().find(entry => entry.command === command)?.payload;
}

/** The board's own composed MSP_FILTER_CONFIG, decoded at the RPM offsets. */
function boardRpm(board: VirtualPidBoard) {
  const bytes = board.composedFilterConfig();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = FILTER_CONFIG_OFFSETS;
  return {
    length: bytes.length,
    harmonics: bytes[o.rpmFilterHarmonics],
    minHz: bytes[o.rpmFilterMinHz],
    dynNotchMaxHz: view.getUint16(o.dynNotchMaxHz, true),
    dynNotchCount: bytes[o.dynNotchCount],
    ...(bytes.length >= MSP_FILTER_CONFIG_BYTES_API148 ? {
      fadeRangeHz: view.getUint16(o.rpmFilterFadeRangeHz, true),
      q: view.getUint16(o.rpmFilterQ, true),
      weights: [bytes[o.rpmFilterWeights], bytes[o.rpmFilterWeights + 1], bytes[o.rpmFilterWeights + 2]],
    } : {}),
  };
}

const TAIL_IDS = RPM_FILTER_TAIL_KEYS.map(field => `pid-rpm-filter-${field}`);

describe('P-E2 §16: the RPM filter card across the version matrix', () => {
  it('1. API 1.47 shows the head as real controls and no tail at all', async () => {
    const h = harness(47);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    expect(exists(renderer, 'pid-rpm-filter-harmonics')).toBe(true);
    expect(exists(renderer, 'pid-rpm-filter-minHz')).toBe(true);
    for (const id of TAIL_IDS) expect(exists(renderer, id)).toBe(false);
    act(() => renderer.unmount());
  });

  it('2. API 1.47 says the extra settings need a newer protocol, and shows no zeros', async () => {
    const h = harness(47);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    expect(exists(renderer, 'pid-rpm-filter-tail-absent')).toBe(true);
    expect(screenText(renderer)).toContain('الإعدادات الإضافية لمرشّح RPM تتوفر عبر MSP في الإصدارات الأحدث.');
    act(() => renderer.unmount());
  });

  it('3. API 1.47 reads the head from the BOARD, not from a default', async () => {
    const h = harness(47);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    // The board's PG defaults: harmonics 3, min_hz 100.
    expect(fieldValue(renderer, 'pid-rpm-filter-harmonics-value')).toBe('3');
    expect(fieldValue(renderer, 'pid-rpm-filter-minHz-value')).toBe('100');
    act(() => renderer.unmount());
  });

  it.each([48, 49])('4. API 1.%s exposes all seven fields with the board\'s values', async apiMinor => {
    const h = harness(apiMinor);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    for (const id of TAIL_IDS) expect(exists(renderer, id)).toBe(true);
    expect(exists(renderer, 'pid-rpm-filter-tail-absent')).toBe(false);
    // `pg/rpm_filter.c` defaults: fade 50, q 500, weights 100/100/100.
    expect(fieldValue(renderer, 'pid-rpm-filter-fadeRangeHz-value')).toBe('50');
    expect(fieldValue(renderer, 'pid-rpm-filter-q-value')).toBe('500');
    // Distinct on purpose: each box must show ITS OWN harmonic's weight.
    expect(fieldValue(renderer, 'pid-rpm-filter-weight1-value')).toBe('100');
    expect(fieldValue(renderer, 'pid-rpm-filter-weight2-value')).toBe('70');
    expect(fieldValue(renderer, 'pid-rpm-filter-weight3-value')).toBe('40');
    act(() => renderer.unmount());
  });

  it.each([48, 49])('5. API 1.%s writes an edited tail to the board and verifies it', async apiMinor => {
    const h = harness(apiMinor);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    typeInto(renderer, 'pid-rpm-filter-q-value', '1400');
    typeInto(renderer, 'pid-rpm-filter-fadeRangeHz-value', '250');
    typeInto(renderer, 'pid-rpm-filter-weight2-value', '60');
    await save(renderer);
    expect(h.board.commandCount(MSP_SET_FILTER_CONFIG)).toBe(1);
    expect(h.board.commandCount(MSP_EEPROM_WRITE)).toBe(1);
    expect(boardRpm(h.board)).toMatchObject({q: 1400, fadeRangeHz: 250, weights: [100, 60, 40]});
    act(() => renderer.unmount());
  });

  it.each([48, 49])('6. API 1.%s leaves dyn_notch_max_hz and dyn_notch_count untouched', async apiMinor => {
    // The neighbours of the RPM group, in a different parameter group. A
    // tail that drifted by a byte would land on exactly these.
    const h = harness(apiMinor);
    const before = boardRpm(h.board);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    typeInto(renderer, 'pid-rpm-filter-q-value', '900');
    await save(renderer);
    expect(boardRpm(h.board)).toMatchObject({
      dynNotchMaxHz: before.dynNotchMaxHz,
      dynNotchCount: before.dynNotchCount,
    });
    act(() => renderer.unmount());
  });

  it('7. API 1.47 sends a 49-byte payload and never writes bytes 49-55', async () => {
    const h = harness(47);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    typeInto(renderer, 'pid-rpm-filter-minHz-value', '80');
    await save(renderer);
    const sent = lastPayload(h.board, MSP_SET_FILTER_CONFIG);
    expect(sent?.length).toBe(MSP_FILTER_CONFIG_BYTES_API147);
    expect(boardRpm(h.board)).toMatchObject({minHz: 80, length: MSP_FILTER_CONFIG_BYTES_API147});
    act(() => renderer.unmount());
  });

  it.each([48, 49])('8. API 1.%s sends a 56-byte payload built from the board\'s own bytes', async apiMinor => {
    const h = harness(apiMinor);
    const fresh = h.board.composedFilterConfig();
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    typeInto(renderer, 'pid-rpm-filter-harmonics-value', '2');
    await save(renderer);
    const sent = lastPayload(h.board, MSP_SET_FILTER_CONFIG);
    expect(sent?.length).toBe(MSP_FILTER_CONFIG_BYTES_API148);
    /* PATCHED, NOT RECONSTRUCTED. Exactly one byte differs from what the
       board sent - offset 43 - and byte 0 tracks the legacy gyro copy the
       encoder keeps coherent. Everything else comes back verbatim. */
    const differing: number[] = [];
    sent?.forEach((value, index) => { if (value !== fresh[index]) differing.push(index); });
    expect(differing).toEqual([FILTER_CONFIG_OFFSETS.rpmFilterHarmonics]);
    act(() => renderer.unmount());
  });

  it('9. API 1.50 reads the tail against the newest layout we have read', async () => {
    /* A future API is decoded against 1.49 - refusing to show a pilot their
       tune helps nobody - and the decoders preserve bytes they do not know. */
    const h = harness(50);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    for (const id of TAIL_IDS) expect(exists(renderer, id)).toBe(true);
    expect(fieldValue(renderer, 'pid-rpm-filter-q-value')).toBe('500');
    act(() => renderer.unmount());
  });

  it('10. API 1.50 refuses the save outright: no MSP_SET_FILTER_CONFIG at all', async () => {
    /* NOT a per-field UI gate invented for the RPM group. The controller's
       write authority already refuses every write on an unverified future
       API, before a single byte is encoded, and this proves the RPM tail
       inherits that rather than sneaking around it. */
    const h = harness(50);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    typeInto(renderer, 'pid-rpm-filter-q-value', '1400');
    await save(renderer);
    expect(h.board.commandCount(MSP_SET_FILTER_CONFIG)).toBe(0);
    expect(h.board.commandCount(MSP_EEPROM_WRITE)).toBe(0);
    expect(boardRpm(h.board)).toMatchObject({q: 500});
    act(() => renderer.unmount());
  });

  it('11. the controls never offer a value the firmware would refuse', async () => {
    /* MSP_SET_FILTER_CONFIG returns MSP_RESULT_ERROR for a q outside
       {250, 3000} - after the rest of the payload has already been applied,
       so there is no clean failure to report. The control clamps on the way
       in, and the board therefore never sees one. */
    const h = harness(49);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    typeInto(renderer, 'pid-rpm-filter-q-value', '9000');
    expect(fieldValue(renderer, 'pid-rpm-filter-q-value')).toBe('3000');
    typeInto(renderer, 'pid-rpm-filter-q-value', '10');
    expect(fieldValue(renderer, 'pid-rpm-filter-q-value')).toBe('250');
    typeInto(renderer, 'pid-rpm-filter-weight3-value', '250');
    expect(fieldValue(renderer, 'pid-rpm-filter-weight3-value')).toBe('100');
    await save(renderer);
    expect(h.board.commandCount(MSP_SET_FILTER_CONFIG)).toBe(1);
    expect(boardRpm(h.board)).toMatchObject({q: 250, weights: [100, 70, 100]});
    act(() => renderer.unmount());
  });

  it('12. the firmware refusal this app avoids is real, and the app avoids it', async () => {
    /* TWO HALVES OF ONE CLAIM.
       First: a board built from the firmware's own MSP_SET_FILTER_CONFIG
       DOES refuse an out-of-range q outright - so the bound is not a
       cosmetic choice. Second: no payload the screen produces ever carries
       one, which is why the refusal never fires through the UI. */
    const h = harness(49);
    const outOfRange = h.board.composedFilterConfig();
    new DataView(outOfRange.buffer).setUint16(FILTER_CONFIG_OFFSETS.rpmFilterQ, 3001, true);
    await expect(
      h.board.request(MSP_SET_FILTER_CONFIG, outOfRange, {wireFormat: 'v1'}),
    ).rejects.toThrow(/RPM filter value out of range/);

    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    typeInto(renderer, 'pid-rpm-filter-q-value', '3001');
    await save(renderer);
    const sent = lastPayload(h.board, MSP_SET_FILTER_CONFIG);
    expect(sent).toBeDefined();
    expect(new DataView(sent!.buffer, sent!.byteOffset, sent!.byteLength)
      .getUint16(FILTER_CONFIG_OFFSETS.rpmFilterQ, true)).toBe(3000);
    expect(h.board.commandCount(MSP_EEPROM_WRITE)).toBe(1);
    act(() => renderer.unmount());
  });

  it('13. the RPM filter is GLOBAL: switching PID profile leaves it alone', async () => {
    /* PG_RPM_FILTER_CONFIG is a MASTER_VALUE parameter group, so a profile
       switch must neither change these values nor make them look dirty. */
    const h = harness(49);
    const renderer = await render(h.port);
    press(renderer, 'pid-advanced-toggle');
    typeInto(renderer, 'pid-rpm-filter-q-value', '1400');
    await save(renderer);
    const afterSave = boardRpm(h.board);
    await act(async () => { await h.controller.selectProfile(SESSION, 'PID', 1); });
    expect(boardRpm(h.board)).toMatchObject({q: afterSave.q, weights: afterSave.weights});
    act(() => renderer.unmount());
  });

  it('14. reading the screen writes nothing at any API version', async () => {
    /* Opening the card populates seven controls from the board. None of
       that is an edit, so there is nothing to save - the save control is
       not even offered - and no byte goes out. Proven at all four rows,
       because the version-aware branch is exactly where a spurious dirty
       state would hide. */
    for (const apiMinor of [47, 48, 49, 50]) {
      const h = harness(apiMinor);
      const renderer = await render(h.port);
      press(renderer, 'pid-advanced-toggle');
      expect(exists(renderer, 'pid-save-bar-save')).toBe(false);
      expect(h.board.commandCount(MSP_SET_FILTER_CONFIG)).toBe(0);
      expect(h.board.commandCount(MSP_EEPROM_WRITE)).toBe(0);
      act(() => renderer.unmount());
    }
  });
});
