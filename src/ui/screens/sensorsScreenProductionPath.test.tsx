/**
 * THE SENSORS SCREEN OVER A REAL BOARD.
 *
 * SENSORS B-5 §54-§57. Nothing is mocked between the button and the
 * bytes: the screen renders the production SensorsConfigurationController,
 * which runs over the real MspSessionCoordinator, the real MspClient with
 * its real FIFO and its real 2000 ms response timeout, and the real
 * telemetry scheduler. Only the USB device is a fake, and it is a virtual
 * flight controller that answers hand-written MSP frames.
 *
 * So each scenario below is the same round trip an operator makes: a
 * press, real frames on the wire, and whatever the board then says.
 *
 * SCOPE HONESTY: this is still JavaScript. It proves the app's own
 * behaviour end to end. It does NOT prove that any physical flight
 * controller behaves this way - that is hardware evidence and is reported
 * separately.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import SensorsScreen from './SensorsScreen';
import '../../i18n';
import i18n from '../../i18n';
import {sensorsPendingSave} from '../session/sensorsPendingSave';
import {
  SensorsConfigurationController,
  MspSessionCoordinator,
} from '../../platforms/react-native/protocol';
import {
  VirtualSensorsFc,
  MSP_ACC_CALIBRATION,
  MSP_EEPROM_WRITE,
  MSP_MAG_CALIBRATION,
  MSP_SET_COMPASS_CONFIG,
  MSP_SET_SENSOR_ALIGNMENT,
  MSP_SET_SENSOR_CONFIG,
} from '../../platforms/react-native/protocol/__testUtils__/virtualSensorsFc';
import type {SetupUiSessionKey} from '../../platforms/react-native/protocol';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Bit 12 of the arming-disable tail: fc/core.c's isCalibrating(). */
const CALIBRATING = 1 << 12;

/** The virtual board reports ACC|BARO|GYRO by default; a magnetometer
 *  calibration needs the board to say it HAS one, so bit 2 is added. */
const MAG_PRESENT_MASK = 0b0100111;

let sessionSeq = 0;
let mounted: ReactTestRenderer.ReactTestRenderer[] = [];
const openCoordinators: Array<{coordinator: MspSessionCoordinator; sessionId: string}> = [];

async function connect(behaviour: ConstructorParameters<typeof VirtualSensorsFc>[1] = {}) {
  sessionSeq += 1;
  const sessionId = `sensors-ui-${sessionSeq}`;
  const fc = new VirtualSensorsFc(sessionId, behaviour);
  const coordinator = new MspSessionCoordinator();
  coordinator.openSession(fc.client, sessionId);
  openCoordinators.push({coordinator, sessionId});
  await sleep(400);
  const key = coordinator.getSessionKey(sessionId);
  if (key === undefined) throw new Error('no session key after identification');
  return {fc, coordinator, sessionId, key};
}

function controllerFor(
  coordinator: MspSessionCoordinator,
  reboots: Array<{sessionId: string; reason: string}> = [],
) {
  return new SensorsConfigurationController({
    coordinator,
    appStateOwner: {getPhase: () => 'ACTIVE'},
    rebootLifecycle: {
      expectReboot: (sessionId: string, reason: string) => {
        reboots.push({sessionId, reason});
      },
    },
  });
}

async function mountScreen(
  controller: SensorsConfigurationController,
  key: SetupUiSessionKey,
) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <SensorsScreen
        sessionKey={key}
        active
        onOpenSetup={jest.fn()}
        controller={controller}
      />,
    );
    await sleep(0);
  });
  mounted.push(renderer);
  await settle(150);
  return renderer;
}

/** Real time, deliberately: this suite uses the real MspClient timeout
 *  and the controller's real poll intervals, so its waits are real too. */
async function settle(ms = 120): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
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

function changeText(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  text: string,
): void {
  renderer.root
    .findAll(
      node => node.props.testID === testID && typeof node.props.onChangeText === 'function',
    )[0]
    .props.onChangeText(text);
}

function textOf(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): string {
  const node = byTestID(renderer, testID);
  if (node === undefined) return '';
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
  mounted = [];
});

afterEach(async () => {
  const trees = mounted;
  mounted = [];
  await act(async () => {
    for (const tree of trees) {
      if (tree.toJSON() !== null) tree.unmount();
    }
    await sleep(0);
  });
  while (openCoordinators.length > 0) {
    const entry = openCoordinators.pop();
    entry?.coordinator.deactivateMspSession(entry.sessionId);
  }
  sensorsPendingSave.clear();
});

/* ================================================================== *
 * §54 - HARDWARE SAVE, ALL THE WAY TO THE BOARD
 * ================================================================== */

describe('§54 a hardware selection saved from the screen', () => {
  it('writes the frame the board can take, persists it, and reports awaiting verification - never success', async () => {
    const reboots: Array<{sessionId: string; reason: string}> = [];
    const {fc, coordinator, key} = await connect();
    const renderer = await mountScreen(controllerFor(coordinator, reboots), key);

    // Pin the barometer to raw 9 - 2SMPB_02B at API 1.47.
    await act(async () => {
      byTestID(renderer, 'sensors-hardware-baro').props.onSelect('9');
    });
    expect(byTestID(renderer, 'sensors-save-bar').props.visible).toBe(true);

    await act(async () => {
      byTestID(renderer, 'sensors-save-bar').props.onSave();
    });
    await settle(300);

    // The bytes: exactly one SET, carrying the board's own frame width.
    const writes = fc.payloadsFor(MSP_SET_SENSOR_CONFIG);
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0])[1]).toBe(9); // byte 1 is the barometer
    expect(fc.configuredHardware().baro).toBe(9);
    expect(fc.requested.filter(command => command === MSP_EEPROM_WRITE)).toHaveLength(1);

    // ...and the screen says what was actually established.
    expect(byTestID(renderer, 'sensors-save-bar').props.statusMessage).toBe(
      t('sensorsScreen.save.outcome.AWAITING_REBOOT_VERIFICATION'),
    );
    expect(texts(renderer)).not.toContain(t('sensorsScreen.save.outcome.SUCCEEDED'));
    // The reboot was declared through the ONE lifecycle, and the token
    // that outlives this screen was raised.
    expect(reboots).toHaveLength(1);
    expect(sensorsPendingSave.get()?.sessionId).toBe(key.sessionId);
  });

  it('a board that refuses to apply the change is reported as not saved, and nothing is persisted', async () => {
    const {fc, coordinator, key} = await connect({silentlyRejectSensorConfigWrite: true});
    const renderer = await mountScreen(controllerFor(coordinator), key);

    await act(async () => {
      byTestID(renderer, 'sensors-hardware-baro').props.onSelect('9');
    });
    await act(async () => {
      byTestID(renderer, 'sensors-save-bar').props.onSave();
    });
    await settle(300);

    expect(byTestID(renderer, 'sensors-save-bar').props.statusMessage).toBe(
      t('sensorsScreen.save.outcome.READBACK_MISMATCH'),
    );
    expect(fc.requested).not.toContain(MSP_EEPROM_WRITE);
  });
});

/* ================================================================== *
 * §55 - MAGNETOMETER ALIGNMENT: THE BYTE-3 TRAP
 * ================================================================== */

describe('§55 a magnetometer alignment saved from the screen', () => {
  it('writes the ENABLE mask at byte 3, never the detected flags, so the second gyro is not started', async () => {
    // Two gyros detected, one enabled: the exact board on which echoing
    // the read back would start a gyro nobody asked for.
    const {fc, coordinator, key} = await connect();
    fc.setDetectedFlags(0b11);
    fc.setEnabledMask(0b01);
    const renderer = await mountScreen(controllerFor(coordinator), key);

    await act(async () => {
      byTestID(renderer, 'sensors-alignment-preset').props.onSelect('4'); // CW270
    });
    await act(async () => {
      pressable(renderer, 'sensors-alignment-save').props.onPress();
    });
    await settle(300);

    const writes = fc.payloadsFor(MSP_SET_SENSOR_ALIGNMENT);
    expect(writes).toHaveLength(1);
    const frame = Array.from(writes[0]);
    expect(frame[3]).toBe(0b01); // the ENABLE mask, taken by name
    expect(frame[3]).not.toBe(0b11); // never the detected flags
    expect(fc.alignmentState().magAlign).toBe(4);
    expect(fc.alignmentState().enabledMask).toBe(0b01);
  });
});

/* ================================================================== *
 * §56 - ACCELEROMETER CALIBRATION, OBSERVED
 * ================================================================== */

describe('§56 an accelerometer calibration started from the screen', () => {
  it('sends the command once, shows no success while the board is calibrating, and only reports one when the board stops', async () => {
    const {fc, coordinator, key} = await connect({armingDisableFlags: 0});
    // The board stays in calibration for several polls, then finishes.
    fc.scriptedArmingFlags.push(
      ...new Array(6).fill(CALIBRATING),
      ...new Array(6).fill(0),
    );
    const renderer = await mountScreen(controllerFor(coordinator), key);

    await act(async () => {
      pressable(renderer, 'sensors-calibrate-acc-start').props.onPress();
    });
    await settle(200);

    expect(fc.requested.filter(command => command === MSP_ACC_CALIBRATION)).toHaveLength(1);
    // Mid-run: a stage, an elapsed count, and NO completion sentence.
    expect(texts(renderer)).not.toContain(
      t('sensorsScreen.calibration.outcome.SUCCEEDED.ACCELEROMETER'),
    );

    await settle(1_500);
    expect(textOf(renderer, 'sensors-calibrate-acc-outcome')).toContain(
      t('sensorsScreen.calibration.outcome.SUCCEEDED.ACCELEROMETER'),
    );
    // The command was never resent while the app was watching.
    expect(fc.requested.filter(command => command === MSP_ACC_CALIBRATION)).toHaveLength(1);
  });

  it('an ARMED board is refused, and nothing is sent at all', async () => {
    const {fc, coordinator, key} = await connect({flightModeFlagsLow32: 1});
    const renderer = await mountScreen(controllerFor(coordinator), key);

    await act(async () => {
      pressable(renderer, 'sensors-calibrate-acc-start').props.onPress();
    });
    await settle(300);

    expect(fc.requested).not.toContain(MSP_ACC_CALIBRATION);
    expect(textOf(renderer, 'sensors-calibrate-acc-outcome')).toContain(
      t('sensorsScreen.calibration.outcome.REFUSED_ARMED'),
    );
  });
});

/* ================================================================== *
 * §57 - MAGNETOMETER CALIBRATION, AND THE 15-SECOND FAILURE
 * ================================================================== */

describe('§57 a magnetometer calibration started from the screen', () => {
  it('stopping the watch says the board may still be calibrating, and never that the calibration was cancelled', async () => {
    /* A magnetometer that is BOTH configured to something real and
       reported present: with the default configured value of NONE the
       screen correctly offers no calibration at all. */
    const {fc, coordinator, key} = await connect({
      armingDisableFlags: 0,
      sensorMask: MAG_PRESENT_MASK,
      mag: 2,
    });
    fc.scriptedArmingFlags.push(...new Array(200).fill(CALIBRATING));
    const renderer = await mountScreen(controllerFor(coordinator), key);

    await act(async () => {
      pressable(renderer, 'sensors-calibrate-mag-start').props.onPress();
    });
    await settle(1_200);
    expect(fc.requested.filter(command => command === MSP_MAG_CALIBRATION)).toHaveLength(1);

    await act(async () => {
      pressable(renderer, 'sensors-calibrate-mag-stop').props.onPress();
    });
    await settle(900);

    const outcome = textOf(renderer, 'sensors-calibrate-mag-outcome');
    expect(outcome).toContain(t('sensorsScreen.calibration.outcome.OBSERVATION_CANCELLED'));
    expect(outcome).not.toContain('تم إلغاء المعايرة');
    // The firmware has no "stop calibrating" command, and none was invented.
    expect(fc.requested.filter(command => command === MSP_MAG_CALIBRATION)).toHaveLength(1);
  });
});

/* ================================================================== *
 * DECLINATION, END TO END
 * ================================================================== */

describe('the magnetic declination saved from the screen', () => {
  it('sends decidegrees for the degrees that were typed, and reads back what the board holds', async () => {
    const {fc, coordinator, key} = await connect();
    const renderer = await mountScreen(controllerFor(coordinator), key);

    await act(async () => {
      changeText(renderer, 'sensors-declination-input', '-5.0');
    });
    await act(async () => {
      pressable(renderer, 'sensors-declination-save').props.onPress();
    });
    await settle(300);

    const writes = fc.payloadsFor(MSP_SET_COMPASS_CONFIG);
    expect(writes).toHaveLength(1);
    // -50 decidegrees, little-endian two's complement: CE FF.
    expect(Array.from(writes[0])).toEqual([0xce, 0xff]);
    expect(fc.declinationState()).toBe(-50);
    expect(byTestID(renderer, 'sensors-declination-input').props.value).toBe('-5.0');
  });
});
