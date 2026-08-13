/**
 * SETUP P1 - THE ARMING-TRUTH REGRESSION CONTRACT.
 *
 * THE DEFECT THIS FILE PINS. On a real board, Setup showed
 * "حالة التسليح غير مؤكدة" in its safety strip and "غير مؤكدة" in its
 * top-bar badge while, in the same frame, its three FC-tool buttons all
 * read "غير متاح: الطائرة مسلّحة". The screen simultaneously claimed not
 * to know whether the aircraft was armed and refused three actions
 * BECAUSE it was armed. The cause: SetupScreen subscribed to
 * ARMED_TELEMETRY_POLL_ID and ARMING_BLOCKERS_TELEMETRY_POLL_ID, which
 * nothing in the application ever registers, so both were UNAVAILABLE
 * forever.
 *
 * WHY THE OLD TESTS COULD NOT CATCH IT. The previous screen-level arming
 * tests called `scheduler.registerPoll()` themselves for those two ids
 * with a fake command number. They proved a pipeline that production
 * never runs. Passing tests over an unreachable path is exactly how a
 * defect survives a green suite.
 *
 * WHAT IS REAL HERE. The coordinator, RNMspTransport, MspClient (real
 * FIFO, real v1 framing, real checksums), the real telemetry scheduler
 * and its real tick driver, the real identification handshake, the real
 * at-most-once MSP_BOXIDS acquisition, the real FcToolsController, the
 * real deriveArmedState / deriveSetupArmingReadiness, and the real
 * TopSystemBar / SafetyStrip / FcToolsSection. ONLY the USB transport is
 * faked, and its response frames are built by the same MSP frame builder
 * the client's own tests use - so the bytes reaching the parser are the
 * bytes a flight controller sends.
 *
 * NOTHING HERE REGISTERS A POLL. If a future edit reintroduced the
 * placeholder path, these tests would fail rather than quietly pass.
 */

jest.mock('../orientation3d', () => ({
  OrientationRenderer: jest.fn(() => null),
}));

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import SetupScreen from './SetupScreen';
import '../../i18n';
import i18n from '../../i18n';
import type {RootStackParamList} from '../../navigation/types';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {
  MSP_API_VERSION,
  MSP_FC_VARIANT,
  MSP_BOARD_INFO,
  MSP_ATTITUDE,
  MSP_STATUS_EX,
  MSP_BOXIDS,
  MSP_ANALOG,
  MSP_RAW_GPS,
  MSP_BATTERY_STATE,
  ARMING_DISABLE_FLAG_TOKENS,
  FC_TOOL_IDS,
  resolveFcToolAvailability,
  deriveSetupArmingReadiness,
} from '../../core';
import {buildMspFrameBytes} from '../../core/protocol/__testUtils__/mspFixtures';
import {
  base64ToBytes,
  bytesToBase64,
} from '../../platforms/react-native/protocol/base64';
import type {
  UsbSerialDataEvent,
  UsbSerialSessionDetachedEvent,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

/* ------------------------------------------------------------------ *
 * Wire fixtures - real payload layouts, not hand-waved objects
 * ------------------------------------------------------------------ */

const ascii = (text: string) => text.split('').map(c => c.charCodeAt(0));
const pstring = (text: string) => [text.length, ...ascii(text)];
/* Arithmetic, not bitwise - the same convention armingBlockers.ts states
 * and for the same reason: JavaScript's bitwise operators are signed
 * 32-bit and would corrupt bit 31 of an unsigned u32 mask. */
const byteAt = (value: number, index: number) =>
  Math.floor(value / Math.pow(256, index)) % 256;
const u16 = (v: number) => [byteAt(v, 0), byteAt(v, 1)];
const u32 = (v: number) => [
  byteAt(v, 0),
  byteAt(v, 1),
  byteAt(v, 2),
  byteAt(v, 3),
];

function boardInfoPayload(): Uint8Array {
  return Uint8Array.from([
    ...ascii('AFF3'),
    ...u16(0),
    0,
    0,
    ...pstring('TEST'),
    ...pstring('MyBoard'),
    ...pstring('MTKS'),
    ...new Array(32).fill(0),
    0,
  ]);
}

function attitudePayload(): Uint8Array {
  return Uint8Array.from([...u16(0), ...u16(0), ...u16(0)]);
}

/** ACC | BARO | MAG | GPS | GYRO - see msp.c's own bit packing. */
const SENSOR_MASK = 0x2f;

/**
 * A real MSP_STATUS_EX frame at the pinned layout:
 *   0  u16 cycle time      2  u16 i2c errors     4  u16 sensor mask
 *   6  u32 flight-mode flags (low 32)           10  u8  pid profile
 *   11 u16 cpu load        13 u8  profile count 14  u8  rate profile
 *   15 u8  extension byte count (0 here)
 *      u8  arming-disable-flag count
 *      u32 arming-disable flags
 *      u8  config state (bit 0 = reboot required)
 *      u16 core temperature
 */
function statusExPayload(options: {
  flightModeFlags?: number;
  armingDisableFlags?: number;
  rebootRequired?: boolean;
  sensorMask?: number;
  /** Truncate after the fixed prefix, so no readiness tail exists. */
  omitTail?: boolean;
}): Uint8Array {
  const prefix = [
    ...u16(312),
    ...u16(0),
    ...u16(options.sensorMask ?? SENSOR_MASK),
    ...u32(options.flightModeFlags ?? 0),
    0,
    ...u16(17),
  ];
  if (options.omitTail === true) {
    return Uint8Array.from(prefix);
  }
  return Uint8Array.from([
    ...prefix,
    4, // PID_PROFILE_COUNT
    0, // control rate profile index
    0, // flight-mode-flags extension byte count
    ARMING_DISABLE_FLAG_TOKENS.length,
    ...u32(options.armingDisableFlags ?? 0),
    options.rebootRequired === true ? 1 : 0,
    ...u16(250),
  ]);
}

/** The remaining registered polls, with real payload layouts so nothing
 * stalls the serialized link. Their VALUES are irrelevant to these tests;
 * their answerability is not. */
function analogPayload(): Uint8Array {
  return Uint8Array.from([164, ...u16(480), ...u16(812), ...u16(320), ...u16(1642)]);
}
function batteryPayload(): Uint8Array {
  return Uint8Array.from([4, ...u16(1500), 164, ...u16(480), ...u16(320), 0, ...u16(1642)]);
}
function rawGpsPayload(): Uint8Array {
  return Uint8Array.from(new Array(18).fill(0));
}

/** MSP_BOXIDS in wire order. BOXARM's permanent id is 0 (msp_box.c:49),
 * so putting it first makes bit 0 of the packed flight-mode flags the
 * armed bit. */
const BOXIDS_WITH_ARM = Uint8Array.from([0, 1, 2]);
/** A mapping that does NOT contain BOXARM - armed becomes unprovable. */
const BOXIDS_WITHOUT_ARM = Uint8Array.from([1, 2, 3]);

const ARMED_BIT = 1;
const bitFor = (token: string) =>
  Math.pow(2, ARMING_DISABLE_FLAG_TOKENS.indexOf(token));

/* ------------------------------------------------------------------ *
 * Fake transport
 * ------------------------------------------------------------------ */

function makeFakeClient(sessionId: string) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const detachListeners = new Set<
    (event: UsbSerialSessionDetachedEvent) => void
  >();
  const responses = new Map<number, Uint8Array>();

  const fake = {
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      const bytes = base64ToBytes(dataBase64);
      const command = bytes[4];
      const payload = responses.get(command);
      if (payload) {
        const frameBytes = buildMspFrameBytes(command, payload, {
          wireFormat: 'v1',
          direction: 'response',
        });
        Promise.resolve().then(() => {
          for (const listener of Array.from(dataListeners)) {
            listener({sessionId, dataBase64: bytesToBase64(frameBytes)});
          }
        });
      }
      return Promise.resolve(undefined);
    }),
    onDataReceived: jest.fn((cb: (event: UsbSerialDataEvent) => void) => {
      dataListeners.add(cb);
      return jest.fn(() => dataListeners.delete(cb));
    }),
    onSessionDetached: jest.fn(
      (cb: (event: UsbSerialSessionDetachedEvent) => void) => {
        detachListeners.add(cb);
        return jest.fn(() => detachListeners.delete(cb));
      },
    ),
    startReading: jest.fn(() => Promise.resolve(undefined)),
    stopReading: jest.fn(() => Promise.resolve(undefined)),
    setResponse: (command: number, payload: Uint8Array) => {
      responses.set(command, payload);
    },
  };
  return fake;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
  }
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

function has(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({testID}).length > 0;
}

function makeProps(sessionId: string): Props {
  return {
    route: {
      key: `Setup-${sessionId}`,
      name: 'Setup',
      params: {sessionKey: {sessionId, generation: 1}},
    },
    navigation: {goBack: () => undefined, addListener: () => () => undefined},
  } as unknown as Props;
}

/**
 * Brings up a real session, identified as Betaflight at the pinned API
 * 1.47 (the contract the armed proof is authorized against), with the
 * supplied STATUS_EX and BOXIDS responses scripted, and returns the
 * mounted screen.
 */
async function mountWithSession(
  sessionId: string,
  options: {
    statusEx: Uint8Array;
    boxIds?: Uint8Array;
    apiMinor?: number;
  },
): Promise<{
  renderer: ReactTestRenderer.ReactTestRenderer;
  client: ReturnType<typeof makeFakeClient>;
}> {
  const client = makeFakeClient(sessionId);
  client.setResponse(
    MSP_API_VERSION,
    Uint8Array.from([0, 1, options.apiMinor ?? 47]),
  );
  client.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  client.setResponse(MSP_ATTITUDE, attitudePayload());
  client.setResponse(MSP_STATUS_EX, options.statusEx);
  // Every OTHER registered poll must also be answerable. MspClient allows
  // exactly ONE request in flight, so an unanswered aux poll would hold
  // that slot for its whole response timeout and starve the very poll
  // under test - a real starvation observed while writing this file, not
  // a precaution.
  client.setResponse(MSP_ANALOG, analogPayload());
  client.setResponse(MSP_BATTERY_STATE, batteryPayload());
  client.setResponse(MSP_RAW_GPS, rawGpsPayload());
  if (options.boxIds !== undefined) {
    client.setResponse(MSP_BOXIDS, options.boxIds);
  }

  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(<SetupScreen {...makeProps(sessionId)} />);
  });

  await act(async () => {
    mspSessionCoordinator.openSession(
      client as unknown as UsbSerialTransportClient,
      sessionId,
    );
    await flushAsync();
  });

  // Advance the REAL clock far enough for the FC-status poll to dispatch
  // on the real 10ms tick driver at its own registered cadence (2100ms
  // initial delay, 8000ms interval) while the 50ms attitude stream keeps
  // competing for the single in-flight slot. No hand-driven scheduler
  // poking and no shortcut past the cadence the product actually runs at.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20_000);
    await flushAsync();
  });

  return {renderer, client};
}

async function teardown(
  sessionId: string,
  renderer: ReactTestRenderer.ReactTestRenderer,
) {
  await act(async () => {
    mspSessionCoordinator.deactivateMspSession(sessionId);
    await flushAsync();
  });
  act(() => {
    renderer.unmount();
  });
}

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

describe('SETUP P1 - the armed contradiction is impossible', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('ARMED: the badge, the strip and the FC tools all say armed - none of them says "unknown"', async () => {
    const sessionId = 'p1-armed-agreement';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({flightModeFlags: ARMED_BIT}),
      boxIds: BOXIDS_WITH_ARM,
    });

    const text = allText(renderer).join('|');

    // The strip.
    expect(has(renderer, 'safety-strip-armed')).toBe(true);
    expect(has(renderer, 'safety-strip-unknown')).toBe(false);
    expect(text).toContain(i18n.t('safetyStrip.armed'));

    // The badge - same canonical state, different presentation.
    expect(text).toContain(i18n.t('setupTopBar.armingBadge.armed'));
    expect(text).not.toContain(i18n.t('setupTopBar.armingBadge.unknown'));

    // The FC tools refuse, and they refuse from the SAME armed source.
    //
    // The refusal REASON is asserted separately, below: under Jest,
    // React Native reports AppState as not-foregrounded, and the tool
    // gate deliberately checks `appActive` BEFORE `armedState`
    // (fcTools.ts:96 vs :125), so the foreground refusal legitimately
    // outranks the armed one here. That precedence is product behaviour,
    // not a defect, and this suite does not fake it away.
    for (const tool of ['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']) {
      expect(has(renderer, `fc-tool-${tool}-reason`)).toBe(true);
    }

    // THE EXACT P0 CONTRADICTION, asserted as a pair: the tools knowing
    // the aircraft is armed while the strip says it cannot tell.
    const stripSaysUnknown = text.includes(i18n.t('safetyStrip.unknown'));
    expect(stripSaysUnknown).toBe(false);

    await teardown(sessionId, renderer);
  });

  it('ARMED is never rendered as "ready to arm"', async () => {
    const sessionId = 'p1-armed-not-ready';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({flightModeFlags: ARMED_BIT}),
      boxIds: BOXIDS_WITH_ARM,
    });
    const text = allText(renderer).join('|');
    expect(text).not.toContain(i18n.t('safetyStrip.ready'));
    expect(has(renderer, 'safety-strip-ready')).toBe(false);
    await teardown(sessionId, renderer);
  });

  it('DISARMED with no blockers is READY on both surfaces', async () => {
    const sessionId = 'p1-ready';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({flightModeFlags: 0, armingDisableFlags: 0}),
      boxIds: BOXIDS_WITH_ARM,
    });
    const text = allText(renderer).join('|');
    expect(has(renderer, 'safety-strip-ready')).toBe(true);
    expect(text).toContain(i18n.t('setupTopBar.armingBadge.ready'));
    await teardown(sessionId, renderer);
  });

  it('DISARMED with one blocker is BLOCKED, and names it in Arabic', async () => {
    const sessionId = 'p1-blocked-one';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({
        flightModeFlags: 0,
        armingDisableFlags: bitFor('THROTTLE'),
      }),
      boxIds: BOXIDS_WITH_ARM,
    });
    const text = allText(renderer).join('|');
    expect(has(renderer, 'safety-strip-blocked')).toBe(true);
    expect(text).toContain(i18n.t('diagnostics.blockerDescriptions.THROTTLE'));
    // The raw firmware code is never shown to the operator.
    expect(text).not.toContain('THROTTLE:');
    expect(text).toContain(i18n.t('setupTopBar.armingBadge.blocked'));
    await teardown(sessionId, renderer);
  });

  it('multiple blockers are all preserved, and the top three are shown first', async () => {
    const sessionId = 'p1-blocked-many';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({
        flightModeFlags: 0,
        // Disjoint bits, so a sum IS the mask - and stays arithmetic.
        armingDisableFlags:
          bitFor('THROTTLE') +
          bitFor('ANGLE') +
          bitFor('RX_FAILSAFE') +
          bitFor('CLI'),
      }),
      boxIds: BOXIDS_WITH_ARM,
    });
    const text = allText(renderer).join('|');
    expect(has(renderer, 'safety-strip-blocked')).toBe(true);
    // RX_FAILSAFE is CRITICAL_DANGER, so it ranks above the rest.
    expect(text).toContain(i18n.t('diagnostics.blockerDescriptions.RX_FAILSAFE'));
    // The fourth-ranked reason is behind the existing show-all link.
    expect(has(renderer, 'safety-strip-show-all')).toBe(true);
    await teardown(sessionId, renderer);
  });

  it('an RXLOSS blocker also raises the separate RXLOSS safety notice', async () => {
    const sessionId = 'p1-rxloss';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({
        flightModeFlags: 0,
        armingDisableFlags: bitFor('RX_FAILSAFE'),
      }),
      boxIds: BOXIDS_WITH_ARM,
    });
    expect(has(renderer, 'setup-safety-notice-RX_LOSS')).toBe(true);
    expect(has(renderer, 'setup-safety-notice-FAILSAFE')).toBe(false);
    expect(has(renderer, 'setup-safety-notice-BOX_FAILSAFE')).toBe(false);
    await teardown(sessionId, renderer);
  });

  it('FAILSAFE and BOXFAILSAFE stay distinguishable from RXLOSS', async () => {
    const sessionId = 'p1-failsafe';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({
        flightModeFlags: 0,
        armingDisableFlags: bitFor('FAILSAFE') + bitFor('BOXFAILSAFE'),
      }),
      boxIds: BOXIDS_WITH_ARM,
    });
    expect(has(renderer, 'setup-safety-notice-FAILSAFE')).toBe(true);
    expect(has(renderer, 'setup-safety-notice-BOX_FAILSAFE')).toBe(true);
    expect(has(renderer, 'setup-safety-notice-RX_LOSS')).toBe(false);
    await teardown(sessionId, renderer);
  });

  it('a clean aircraft raises no safety notices at all - no permanent wall of warnings', async () => {
    const sessionId = 'p1-quiet';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({flightModeFlags: 0, armingDisableFlags: 0}),
      boxIds: BOXIDS_WITH_ARM,
    });
    expect(has(renderer, 'setup-safety-notices')).toBe(false);
    await teardown(sessionId, renderer);
  });

  it('reboot-required is surfaced from the status frame Setup already polls', async () => {
    const sessionId = 'p1-reboot-true';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({
        flightModeFlags: 0,
        armingDisableFlags: 0,
        rebootRequired: true,
      }),
      boxIds: BOXIDS_WITH_ARM,
    });
    expect(has(renderer, 'setup-safety-notice-REBOOT_REQUIRED')).toBe(true);
    await teardown(sessionId, renderer);
  });

  it('reboot-required false raises no notice', async () => {
    const sessionId = 'p1-reboot-false';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({
        flightModeFlags: 0,
        armingDisableFlags: 0,
        rebootRequired: false,
      }),
      boxIds: BOXIDS_WITH_ARM,
    });
    expect(has(renderer, 'setup-safety-notice-REBOOT_REQUIRED')).toBe(false);
    await teardown(sessionId, renderer);
  });

  it('a status frame with no readiness tail is UNKNOWN, never guessed and never READY', async () => {
    const sessionId = 'p1-no-tail';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({flightModeFlags: 0, omitTail: true}),
      boxIds: BOXIDS_WITH_ARM,
    });
    // Armed itself is provable (BOXIDS + flight-mode flags are in the
    // fixed prefix), but the blocker evidence never arrived.
    expect(has(renderer, 'safety-strip-ready')).toBe(false);
    expect(has(renderer, 'safety-strip-unknown')).toBe(true);
    expect(has(renderer, 'setup-safety-notice-REBOOT_REQUIRED')).toBe(false);
    await teardown(sessionId, renderer);
  });

  it('no BOXARM in the mapping means armed is UNPROVEN - UNKNOWN, never DISARMED', async () => {
    const sessionId = 'p1-no-boxarm';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({flightModeFlags: 0, armingDisableFlags: 0}),
      boxIds: BOXIDS_WITHOUT_ARM,
    });
    expect(has(renderer, 'safety-strip-unknown')).toBe(true);
    expect(has(renderer, 'safety-strip-ready')).toBe(false);
    await teardown(sessionId, renderer);
  });

  it('a board outside the pinned API contract reports UNKNOWN rather than a guess', async () => {
    const sessionId = 'p1-other-api';
    const {renderer} = await mountWithSession(sessionId, {
      statusEx: statusExPayload({flightModeFlags: 0, armingDisableFlags: 0}),
      boxIds: BOXIDS_WITH_ARM,
      apiMinor: 48,
    });
    // No BOXIDS acquisition is authorized off-contract, so armed cannot
    // be proven - and an unprovable armed state is never READY.
    expect(has(renderer, 'safety-strip-unknown')).toBe(true);
    expect(has(renderer, 'safety-strip-ready')).toBe(false);
    await teardown(sessionId, renderer);
  });

  it('with no session at all, everything is UNKNOWN and nothing is claimed', async () => {
    const sessionId = 'p1-no-session';
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <SetupScreen {...makeProps(sessionId)} />,
      );
    });
    await act(async () => {
      await flushAsync();
    });
    expect(has(renderer, 'safety-strip-unknown')).toBe(true);
    expect(has(renderer, 'safety-strip-ready')).toBe(false);
    expect(has(renderer, 'safety-strip-armed')).toBe(false);
    act(() => {
      renderer.unmount();
    });
  });

  it('an ARMED state from a closed session does not survive into a new one', async () => {
    const sessionId = 'p1-epoch';
    const first = await mountWithSession(sessionId, {
      statusEx: statusExPayload({flightModeFlags: ARMED_BIT}),
      boxIds: BOXIDS_WITH_ARM,
    });
    expect(has(first.renderer, 'safety-strip-armed')).toBe(true);
    await teardown(sessionId, first.renderer);

    // A NEW physical session for a different id, with no BOXIDS scripted:
    // the previous session's armed proof must not carry over.
    const secondId = 'p1-epoch-2';
    const second = await mountWithSession(secondId, {
      statusEx: statusExPayload({flightModeFlags: ARMED_BIT}),
    });
    expect(has(second.renderer, 'safety-strip-armed')).toBe(false);
    expect(has(second.renderer, 'safety-strip-unknown')).toBe(true);
    await teardown(secondId, second.renderer);
  });

  it('the FC-tool gate and the safety strip consume the SAME armed value', () => {
    // The half the screen-level test above cannot observe under Jest,
    // proven directly against the real gate: one ArmedState, two
    // surfaces, no second derivation anywhere.
    const gate = {
      connected: true,
      appActive: true,
      recovering: false,
      compatibility: 'BETAFLIGHT_API_1_47' as const,
      dataState: 'FRESH' as const,
      readingMalformed: false,
      sensors: undefined,
      busy: false,
    };
    for (const tool of FC_TOOL_IDS) {
      expect(
        resolveFcToolAvailability(tool, {...gate, armedState: 'ARMED'}).reason,
      ).toBe('ARMED');
      expect(
        resolveFcToolAvailability(tool, {...gate, armedState: 'UNKNOWN'}).reason,
      ).not.toBe('ARMED');
    }
    // And the strip's own rule, over that same value.
    expect(
      deriveSetupArmingReadiness('ARMED', {kind: 'NONE_IN_THIS_READING'}).status,
    ).toBe('ARMED');
    expect(
      deriveSetupArmingReadiness('UNKNOWN', {kind: 'NONE_IN_THIS_READING'}).status,
    ).toBe('UNKNOWN');
  });

  it('the sensor summary names every canonical sensor, so a missing gyro is visible', async () => {
    const sessionId = 'p1-sensors';
    const {renderer} = await mountWithSession(sessionId, {
      // ACC only: no gyro, no baro, no mag, no GPS.
      statusEx: statusExPayload({flightModeFlags: 0, sensorMask: 0x01}),
      boxIds: BOXIDS_WITH_ARM,
    });
    const text = allText(renderer).join('|');
    expect(text).toContain(
      i18n.t('diagnostics.sensorLine', {
        token: 'GYRO',
        state: i18n.t('diagnostics.sensorNotDetected'),
      }),
    );
    expect(text).toContain(
      i18n.t('diagnostics.sensorLine', {
        token: 'ACC',
        state: i18n.t('diagnostics.sensorDetected'),
      }),
    );
    // No health vocabulary anywhere.
    expect(text).not.toMatch(/سليم|صحي/);
    await teardown(sessionId, renderer);
  });
});
