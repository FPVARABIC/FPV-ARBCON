/**
 * THE SENSORS CONTROLLER, DRIVEN THROUGH THE REAL STACK.
 *
 * A virtual flight controller answers real MSP frames over the real
 * MspSessionCoordinator; the controller under test is the production one.
 * Nothing about the controller is mocked - only the USB device is.
 *
 * THE FACTS THIS SUITE EXISTS TO HOLD DOWN:
 *
 *   BYTE 3 OF THE ALIGNMENT WRITE IS THE ENABLE MASK, NOT THE DETECTED
 *   FLAGS. The read puts detected flags there and the enable mask one byte
 *   later. Our board reports two gyros found and one enabled, so any code
 *   that echoed the read would visibly write 0b11 where 0b01 belongs.
 *
 *   THE FRAME'S WIDTH IS THE BOARD'S. A board that answers three bytes
 *   gets a three-byte write, never a five-byte one padded with guesses.
 *
 *   AN ACK IS NOT AN APPLY, and a persist is not a reboot survival.
 *
 * Every expected payload below is hand-written from the firmware handlers.
 */

import {
  SensorsConfigurationController,
  type SensorsHardwareDraft,
  type SensorsSnapshot,
} from './SensorsConfigurationController';
import {MspSessionCoordinator} from './MspSessionCoordinator';
import {
  VirtualSensorsFc,
  MSP_ACC_TRIM,
  MSP_BOARD_ALIGNMENT_CONFIG,
  MSP_COMPASS_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_SENSOR_ALIGNMENT,
  MSP_SENSOR_CONFIG,
  MSP_SET_ACC_TRIM,
  MSP_SET_BOARD_ALIGNMENT_CONFIG,
  MSP_SET_COMPASS_CONFIG,
  MSP_SET_SENSOR_ALIGNMENT,
  MSP_SET_SENSOR_CONFIG,
  MSP_STATUS_EX,
  MSP2_GYRO_SENSOR_ACTIVE,
  MSP2_SENSOR_CONFIG_ACTIVE,
  type SensorsFcBehaviour,
} from './__testUtils__/virtualSensorsFc';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let sessionSeq = 0;

async function connect(behaviour: SensorsFcBehaviour = {}) {
  sessionSeq += 1;
  const sessionId = `sensors-${sessionSeq}`;
  const fc = new VirtualSensorsFc(sessionId, behaviour);
  const coordinator = new MspSessionCoordinator();
  coordinator.openSession(fc.client, sessionId);
  await sleep(400);
  const key = coordinator.getSessionKey(sessionId);
  if (key === undefined) throw new Error('no session key after identification');
  return {fc, coordinator, sessionId, key};
}

function controllerFor(
  coordinator: MspSessionCoordinator,
  options: {readonly reboots?: {sessionId: string; reason: string}[]} = {},
) {
  return new SensorsConfigurationController({
    coordinator,
    appStateOwner: {getPhase: () => 'ACTIVE'},
    rebootLifecycle: {
      expectReboot: (sessionId, reason) => {
        options.reboots?.push({sessionId, reason});
      },
    },
  });
}

async function loadOrThrow(
  controller: SensorsConfigurationController,
  key: {sessionId: string; generation: number},
): Promise<SensorsSnapshot> {
  const loaded = await controller.load(key);
  if (loaded.kind !== 'LOADED') {
    throw new Error(`load failed: ${JSON.stringify(loaded)}`);
  }
  return loaded.snapshot;
}

/** A draft names only what the operator is setting; everything else is
 *  left alone and comes from the controller's own fresh read. */
const hardwareDraft = (
  _snapshot: SensorsSnapshot,
  over: SensorsHardwareDraft = {},
): SensorsHardwareDraft => over;

/* ================================================================== *
 * LOAD
 * ================================================================== */

describe('loading sensor state', () => {
  it('reads the seven commands it needs', async () => {
    const {fc, coordinator, key} = await connect();
    const loaded = await controllerFor(coordinator).load(key);
    expect(loaded.kind).toBe('LOADED');
    for (const command of [
      MSP_SENSOR_CONFIG,
      MSP2_SENSOR_CONFIG_ACTIVE,
      MSP2_GYRO_SENSOR_ACTIVE,
      MSP_SENSOR_ALIGNMENT,
      MSP_ACC_TRIM,
      MSP_COMPASS_CONFIG,
      MSP_STATUS_EX,
    ]) {
      expect([command, fc.requested.includes(command)]).toEqual([command, true]);
    }
  });

  it('never asks the board how it is mounted', async () => {
    // Board alignment is Setup's. Reading it here would be the first step
    // towards owning it, and the write is not even importable from this
    // module.
    const {fc, coordinator, key} = await connect();
    await controllerFor(coordinator).load(key);
    expect(fc.requested).not.toContain(MSP_BOARD_ALIGNMENT_CONFIG);
    expect(fc.requested).not.toContain(MSP_SET_BOARD_ALIGNMENT_CONFIG);
  });

  it('keeps configured, detected and present as three separate answers', async () => {
    // baro CONFIGURED to DEFAULT(0), DETECTED as a DPS310(8), and PRESENT
    // in the status mask. All three are true at once, and none of them
    // replaces another.
    const {coordinator, key} = await connect({
      baro: 0,
      detectedBaro: 8,
      sensorMask: 0b0100011,
    });
    const snapshot = await loadOrThrow(controllerFor(coordinator), key);
    expect(snapshot.configured.baro).toEqual({
      raw: 0,
      modelled: 'BARO_DEFAULT',
      kind: 'DEFAULT',
    });
    expect(
      snapshot.detected.kind === 'READ' ? snapshot.detected.value.baro : null,
    ).toEqual({raw: 8, modelled: 'BARO_DPS310', kind: 'KNOWN'});
    expect(snapshot.truth.BARO.configured).toEqual({kind: 'DEFAULT'});
    expect(snapshot.truth.BARO.detected).toEqual({
      kind: 'DETECTED',
      hardware: {raw: 8, modelled: 'BARO_DPS310', kind: 'KNOWN'},
    });
    expect(snapshot.truth.BARO.present).toEqual({kind: 'PRESENT'});
    expect(snapshot.truth.BARO.contradictions).toEqual([]);
  });

  it('publishes no health field of any kind', async () => {
    const {coordinator, key} = await connect();
    const snapshot = await loadOrThrow(controllerFor(coordinator), key);
    const forbidden = /^(healthy|health|ok|working|good|fault|faulty|broken)$/i;
    for (const name of Object.keys(snapshot)) {
      expect(name).not.toMatch(forbidden);
    }
  });

  it('still loads on a build that answers none of the optional commands', async () => {
    // MSP_ACC_TRIM is inside #if defined(USE_ACC), MSP_COMPASS_CONFIG inside
    // #ifdef USE_MAG, and the two MSP2 commands post-date API 1.45. A board
    // without them is a capability, not a fault.
    const {coordinator, key} = await connect({
      noMsp2SensorCommands: true,
      noAccTrimCommand: true,
      noCompassCommand: true,
    });
    const snapshot = await loadOrThrow(controllerFor(coordinator), key);
    expect(snapshot.detected).toEqual({kind: 'NOT_AVAILABLE_ON_THIS_BOARD'});
    expect(snapshot.gyros).toEqual({kind: 'NOT_AVAILABLE_ON_THIS_BOARD'});
    expect(snapshot.accTrim).toEqual({kind: 'NOT_AVAILABLE_ON_THIS_BOARD'});
    expect(snapshot.compass).toEqual({kind: 'NOT_AVAILABLE_ON_THIS_BOARD'});
    // And the mandatory reads still landed.
    expect(snapshot.configured.contract).toBe(
      'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW',
    );
    expect(snapshot.alignment.gyroEnabledBitmaskRaw).toBe(0b01);
  });

  it('reports a detected sensor that is not what was configured, without merging them', async () => {
    const {coordinator, key} = await connect({
      baro: 8, // pinned to DPS310
      detectedBaro: 10, // an LPS22DF answered
      sensorMask: 0b0100011,
    });
    const snapshot = await loadOrThrow(controllerFor(coordinator), key);
    expect(snapshot.truth.BARO.contradictions).toEqual([
      'CONFIGURED_DEVICE_DIFFERS_FROM_DETECTED',
    ]);
    // The configured value is still the configured value.
    expect(snapshot.configured.baro.raw).toBe(8);
  });
});

/* ================================================================== *
 * HARDWARE SELECTION
 * ================================================================== */

describe('saving the hardware selection', () => {
  it('writes exactly three bytes to a board that answers three', async () => {
    const {fc, coordinator, key} = await connect({sensorConfigWidth: 3});
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: 5}),
    );
    expect(result.kind).toBe('AWAITING_REBOOT_VERIFICATION');
    expect(fc.payloadsFor(MSP_SET_SENSOR_CONFIG)).toEqual([[0, 0, 5]]);
  });

  it('writes exactly four bytes to a board that answers four', async () => {
    const {fc, coordinator, key} = await connect({
      sensorConfigWidth: 4,
      rangefinder: 4,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: 5}),
    );
    expect(fc.payloadsFor(MSP_SET_SENSOR_CONFIG)).toEqual([[0, 0, 5, 4]]);
  });

  it('writes exactly five bytes to a board that answers five', async () => {
    const {fc, coordinator, key} = await connect({
      sensorConfigWidth: 5,
      rangefinder: 4,
      opticalflow: 1,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: 5}),
    );
    expect(fc.payloadsFor(MSP_SET_SENSOR_CONFIG)).toEqual([[0, 0, 5, 4, 1]]);
  });

  it('refuses a draft that names a field the board did not offer', async () => {
    const {fc, coordinator, key} = await connect({sensorConfigWidth: 3});
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveHardwareSelection(key, snapshot, {
      acc: 0,
      baro: 0,
      mag: 5,
      rangefinder: 4,
    });
    expect(result).toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_CONTRACT_FIELD',
    });
    expect(fc.requested).not.toContain(MSP_SET_SENSOR_CONFIG);
  });

  it('preserves a hardware index this build cannot name', async () => {
    // A board configured for a barometer newer than our tables. Changing
    // the accelerometer must not quietly reset it to DEFAULT.
    const {fc, coordinator, key} = await connect({
      sensorConfigWidth: 5,
      acc: 0,
      baro: 42,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    expect(snapshot.configured.baro).toEqual({
      raw: 42,
      modelled: 'UNKNOWN(42)',
      kind: 'UNKNOWN',
    });
    const result = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {acc: 12}),
    );
    expect(result.kind).toBe('AWAITING_REBOOT_VERIFICATION');
    expect(fc.payloadsFor(MSP_SET_SENSOR_CONFIG)).toEqual([[12, 42, 1, 0, 0]]);
    expect(fc.configuredHardware().baro).toBe(42);
  });

  it('refuses to introduce a hardware index this build cannot name', async () => {
    const {fc, coordinator, key} = await connect({sensorConfigWidth: 5});
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {baro: 200}),
    );
    expect(result).toEqual({kind: 'REJECTED', reason: 'UNSUPPORTED_VALUE'});
    expect(fc.requested).not.toContain(MSP_SET_SENSOR_CONFIG);
  });

  it('keeps a field that changed on the board after the snapshot was taken', async () => {
    /**
     * The screen loaded, then something else moved the barometer, then the
     * operator changed the accelerometer and pressed save.
     *
     * MSP_SET_SENSOR_CONFIG has no per-field write, so the frame must
     * restate the barometer whatever happens. Taking that value from the
     * caller's snapshot would silently revert the other change and the
     * save would still look perfect. It comes from the fresh read instead.
     */
    const {fc, coordinator, key} = await connect({
      sensorConfigWidth: 5,
      baro: 0,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    expect(snapshot.configured.baro.raw).toBe(0);

    fc.setBaro(8);
    const result = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {acc: 12}),
    );
    expect(result.kind).toBe('AWAITING_REBOOT_VERIFICATION');
    expect(fc.payloadsFor(MSP_SET_SENSOR_CONFIG)).toEqual([[12, 8, 1, 0, 0]]);
    expect(fc.configuredHardware().baro).toBe(8);
  });

  it('stops before EEPROM and before the reboot when the board ignores the write', async () => {
    const reboots: {sessionId: string; reason: string}[] = [];
    const {fc, coordinator, key} = await connect({
      sensorConfigWidth: 5,
      silentlyRejectSensorConfigWrite: true,
    });
    const controller = controllerFor(coordinator, {reboots});
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: 5}),
    );
    expect(result.kind).toBe('READBACK_MISMATCH');
    if (result.kind === 'READBACK_MISMATCH') {
      expect(result.expected.mag).toBe(5);
      expect(result.observed.mag).toBe(1);
    }
    expect(fc.requested).not.toContain(MSP_EEPROM_WRITE);
    expect(reboots).toEqual([]);
  });

  it('sends nothing at all when the draft matches the board', async () => {
    const reboots: {sessionId: string; reason: string}[] = [];
    const {fc, coordinator, key} = await connect({sensorConfigWidth: 5});
    const controller = controllerFor(coordinator, {reboots});
    const snapshot = await loadOrThrow(controller, key);
    const before = fc.requested.length;
    const result = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: snapshot.configured.mag.raw}),
    );
    expect(result.kind).toBe('NO_CHANGES');
    expect(fc.requested.length).toBe(before);
    expect(reboots).toEqual([]);
  });

  it('persists and hands the reboot to the app lifecycle, and returns no success', async () => {
    const reboots: {sessionId: string; reason: string}[] = [];
    const {fc, coordinator, key, sessionId} = await connect({
      sensorConfigWidth: 5,
    });
    const controller = controllerFor(coordinator, {reboots});
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: 5}),
    );
    expect(result.kind).toBe('AWAITING_REBOOT_VERIFICATION');
    expect(fc.requested).toContain(MSP_EEPROM_WRITE);
    expect(reboots).toEqual([{sessionId, reason: 'CLI_SAVE'}]);
    // A sensor selection is read once, at boot. There is no success here
    // and there cannot be one.
    expect(result).not.toHaveProperty('snapshot');
  });

  it('refuses to verify persistence against the session that wrote', async () => {
    const {coordinator, key} = await connect({sensorConfigWidth: 5});
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const saved = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: 5}),
    );
    if (saved.kind !== 'AWAITING_REBOOT_VERIFICATION') {
      throw new Error('expected a pending persistence token');
    }
    // The same generation: the board never went away, so a matching
    // readback would only be reading the RAM the write already changed.
    const verified = await controller.verifyHardwarePersistence(
      key,
      saved.pending,
    );
    expect(verified).toEqual({kind: 'STALE_SESSION'});
  });

  it('confirms persistence on a new session, and reports detection separately', async () => {
    const {coordinator, key, sessionId} = await connect({
      sensorConfigWidth: 5,
      // Configured for a magnetometer the aircraft does not have: the save
      // will persist perfectly and the board will still find nothing.
      mag: 5,
      detectedMag: 1,
      sensorMask: 0b0100011,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const saved = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: 9}),
    );
    if (saved.kind !== 'AWAITING_REBOOT_VERIFICATION') {
      throw new Error('expected a pending persistence token');
    }

    // A genuinely new session over the same virtual board.
    const newKey = {sessionId, generation: key.generation + 1};
    const facade = new Proxy(coordinator, {
      get(target, property) {
        if (property === 'getSessionKey') {
          return () => newKey;
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as MspSessionCoordinator;
    const afterReboot = controllerFor(facade);

    const verified = await afterReboot.verifyHardwarePersistence(
      newKey,
      saved.pending,
    );
    expect(verified.kind).toBe('SUCCEEDED');
    if (verified.kind !== 'SUCCEEDED') return;
    // PERSISTENCE says the stored value is what was asked for.
    expect(verified.snapshot.configured.mag.raw).toBe(9);
    // DETECTION says the board still found nothing, and that is a separate
    // sentence rather than a failed save.
    expect(
      verified.runtime.contradictions.map(entry => [
        entry.family,
        ...entry.contradictions,
      ]),
    ).toEqual([['MAG', 'CONFIGURED_ON_BUT_NONE_DETECTED']]);
  });

  it('reports a persistence mismatch when the board did not keep the value', async () => {
    const {coordinator, key, sessionId} = await connect({
      sensorConfigWidth: 5,
      mag: 1,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const saved = await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: 5}),
    );
    if (saved.kind !== 'AWAITING_REBOOT_VERIFICATION') {
      throw new Error('expected a pending persistence token');
    }
    const newKey = {sessionId, generation: key.generation + 1};
    const facade = new Proxy(coordinator, {
      get(target, property) {
        if (property === 'getSessionKey') return () => newKey;
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as MspSessionCoordinator;
    // The board forgot: pretend the reboot restored the old selection.
    const verified = await controllerFor(facade).verifyHardwarePersistence(
      newKey,
      {...saved.pending, expected: {...saved.pending.expected, mag: 9}},
    );
    expect(verified.kind).toBe('PERSISTENCE_MISMATCH');
    if (verified.kind === 'PERSISTENCE_MISMATCH') {
      expect(verified.observed.mag).toBe(5);
      expect(verified.expected.mag).toBe(9);
    }
  });
});

/* ================================================================== *
 * MAGNETOMETER ALIGNMENT - THE P0
 * ================================================================== */

describe('saving the magnetometer alignment', () => {
  const DUAL_GYRO: SensorsFcBehaviour = {
    detectedFlags: 0b11, // two gyros found
    enabledMask: 0b01, // one deliberately enabled
    magAlign: 1,
  };

  it('carries the ENABLED gyro mask across, never the DETECTED flags', async () => {
    /**
     * THE P0, AS A TEST. The read frame puts getGyroDetectedFlags() at
     * byte 3 and gyro_enabled_bitmask at byte 4; the WRITE frame puts the
     * enable mask at byte 3. Echoing the read would store 0b11 into the
     * enable mask and start the gyro the operator switched off.
     */
    const {fc, coordinator, key} = await connect(DUAL_GYRO);
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    expect(snapshot.alignment.gyroDetectedFlagsRaw).toBe(0b11);
    expect(snapshot.alignment.gyroEnabledBitmaskRaw).toBe(0b01);

    const result = await controller.saveMagAlignment(key, snapshot, {
      magAlignmentRaw: 3,
    });
    expect(result.kind).toBe('SUCCEEDED');
    const [payload] = fc.payloadsFor(MSP_SET_SENSOR_ALIGNMENT);
    expect(payload[3]).toBe(0b01);
    expect(payload[3]).not.toBe(snapshot.alignment.gyroDetectedFlagsRaw);
    expect(fc.alignmentState().enabledMask).toBe(0b01);
  });

  it('takes the enable mask from a fresh read, not from the caller snapshot', async () => {
    /**
     * The screen loaded while one gyro was enabled; something else then
     * switched to the other one. A save built from the stale snapshot
     * would put the operator's gyro selection back.
     */
    const {fc, coordinator, key} = await connect(DUAL_GYRO);
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    expect(snapshot.alignment.gyroEnabledBitmaskRaw).toBe(0b01);

    fc.setEnabledMask(0b10);
    const result = await controller.saveMagAlignment(key, snapshot, {
      magAlignmentRaw: 3,
    });
    expect(result.kind).toBe('SUCCEEDED');
    const [payload] = fc.payloadsFor(MSP_SET_SENSOR_ALIGNMENT);
    expect(payload[3]).toBe(0b10);
    expect(fc.alignmentState().enabledMask).toBe(0b10);
  });

  it('takes the custom angles from the fresh read too, not from the snapshot', async () => {
    /**
     * The same reasoning as the enable mask, one field along. This frame
     * has no per-field write either: changing the alignment ENUM restates
     * all three angles, so a draft that does not name them must take them
     * from the board as it is now, not as the screen last saw it.
     */
    const {fc, coordinator, key} = await connect({
      ...DUAL_GYRO,
      magAlign: 9,
      customRoll: 0,
      customPitch: 0,
      customYaw: 0,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    expect(snapshot.alignment.magCustom.rollDecidegrees).toBe(0);

    fc.setCustomAngles(450, -450, 900);
    const result = await controller.saveMagAlignment(key, snapshot, {
      magAlignmentRaw: 3,
    });
    expect(result.kind).toBe('SUCCEEDED');
    const [payload] = fc.payloadsFor(MSP_SET_SENSOR_ALIGNMENT);
    // 450 = 0x01C2, -450 = 0xFE3E, 900 = 0x0384 - the board's own values,
    // carried across rather than reverted to the snapshot's zeros.
    expect(payload.slice(4, 10)).toEqual([
      0xc2, 0x01, 0x3e, 0xfe, 0x84, 0x03,
    ]);
    expect(fc.alignmentState()).toMatchObject({
      roll: 450,
      pitch: -450,
      yaw: 900,
    });
  });

  it('zeroes the two bytes the firmware reads and discards', async () => {
    const {fc, coordinator, key} = await connect(DUAL_GYRO);
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    await controller.saveMagAlignment(key, snapshot, {magAlignmentRaw: 3});
    const [payload] = fc.payloadsFor(MSP_SET_SENSOR_ALIGNMENT);
    expect([payload[0], payload[1]]).toEqual([0, 0]);
    expect(payload).toHaveLength(10);
  });

  it('round-trips signed custom angles without losing the sign', async () => {
    const {fc, coordinator, key} = await connect({
      ...DUAL_GYRO,
      magAlign: 9, // ALIGN_CUSTOM
      customRoll: 0,
      customPitch: 0,
      customYaw: 0,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveMagAlignment(key, snapshot, {
      magAlignmentRaw: 9,
      customDecidegrees: {
        rollDecidegrees: 100,
        pitchDecidegrees: -900,
        yawDecidegrees: 1800,
      },
    });
    expect(result.kind).toBe('SUCCEEDED');
    if (result.kind === 'SUCCEEDED') {
      expect(result.observed).toEqual({
        magAlignmentRaw: 9,
        rollDecidegrees: 100,
        pitchDecidegrees: -900,
        yawDecidegrees: 1800,
      });
    }
    // -900 decidegrees on the wire is 0xFC7C; read unsigned it would be
    // 64636, and the board would be told the magnetometer is rotated
    // 6463.6 degrees.
    const [payload] = fc.payloadsFor(MSP_SET_SENSOR_ALIGNMENT);
    expect(payload.slice(6, 8)).toEqual([0x7c, 0xfc]);
    expect(fc.alignmentState().pitch).toBe(-900);
  });

  it('stops before EEPROM when the board ignores the write', async () => {
    const {fc, coordinator, key} = await connect({
      ...DUAL_GYRO,
      silentlyRejectAlignmentWrite: true,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveMagAlignment(key, snapshot, {
      magAlignmentRaw: 3,
    });
    expect(result.kind).toBe('READBACK_MISMATCH');
    expect(fc.requested).not.toContain(MSP_EEPROM_WRITE);
  });

  it('sends nothing when the draft matches the board', async () => {
    const {fc, coordinator, key} = await connect(DUAL_GYRO);
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const before = fc.requested.length;
    const result = await controller.saveMagAlignment(key, snapshot, {
      magAlignmentRaw: snapshot.alignment.mag.raw,
    });
    expect(result.kind).toBe('NO_CHANGES');
    expect(fc.requested.length).toBe(before);
  });

  it('does not reboot for an alignment change', async () => {
    const reboots: {sessionId: string; reason: string}[] = [];
    const {coordinator, key} = await connect(DUAL_GYRO);
    const controller = controllerFor(coordinator, {reboots});
    const snapshot = await loadOrThrow(controller, key);
    await controller.saveMagAlignment(key, snapshot, {magAlignmentRaw: 3});
    expect(reboots).toEqual([]);
  });
});

/* ================================================================== *
 * ACCELEROMETER TRIM
 * ================================================================== */

describe('saving the accelerometer trim', () => {
  it('preserves the field the operator did not touch', async () => {
    const {fc, coordinator, key} = await connect({
      accTrimPitch: -100,
      accTrimRoll: 100,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveAccTrim(key, snapshot, {
      pitch: -100,
      roll: 50,
    });
    expect(result.kind).toBe('SUCCEEDED');
    if (result.kind === 'SUCCEEDED') {
      expect(result.observed).toEqual({pitch: -100, roll: 50});
    }
    expect(fc.accTrimState()).toEqual({pitch: -100, roll: 50});
  });

  it('writes pitch first and roll second, in signed bytes', async () => {
    // flightDynamicsTrims_def_t declares roll first and the wire does not.
    // A swap here silently trims the wrong axis of a real aircraft.
    const {fc, coordinator, key} = await connect({
      accTrimPitch: 0,
      accTrimRoll: 0,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    await controller.saveAccTrim(key, snapshot, {pitch: -100, roll: 200});
    expect(fc.payloadsFor(MSP_SET_ACC_TRIM)).toEqual([
      [0x9c, 0xff, 0xc8, 0x00],
    ]);
  });

  it('refuses a value past the firmware limit before anything reaches the wire', async () => {
    // The MSP handler does not clamp; the {-300, 300} range lives only in
    // the CLI settings table, so this refusal is the only guard there is.
    const {fc, coordinator, key} = await connect();
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveAccTrim(key, snapshot, {
      pitch: 301,
      roll: 0,
    });
    expect(result).toEqual({kind: 'REJECTED', reason: 'UNSUPPORTED_VALUE'});
    expect(fc.requested).not.toContain(MSP_SET_ACC_TRIM);
  });

  it('reports a value the board lost across the persist', async () => {
    const {coordinator, key} = await connect({
      accTrimPitch: 0,
      accTrimRoll: 0,
      loseValueOnEepromWrite: true,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveAccTrim(key, snapshot, {
      pitch: 100,
      roll: 0,
    });
    expect(result.kind).toBe('PERSISTENCE_MISMATCH');
  });

  it('refuses when the board has no accelerometer trim command at all', async () => {
    const {coordinator, key} = await connect({noAccTrimCommand: true});
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveAccTrim(key, snapshot, {
      pitch: 10,
      roll: 10,
    });
    expect(result).toEqual({kind: 'REJECTED', reason: 'CAPABILITY_ABSENT'});
  });
});

/* ================================================================== *
 * MAGNETIC DECLINATION
 * ================================================================== */

describe('saving the magnetic declination', () => {
  it('reads a western declination as negative and never as 65486', async () => {
    const {coordinator, key} = await connect({declinationDecidegrees: -50});
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    expect(
      snapshot.compass.kind === 'READ'
        ? snapshot.compass.value.magDeclinationDecidegrees
        : null,
    ).toBe(-50);
  });

  it('writes a new declination and reads it back unchanged', async () => {
    const {fc, coordinator, key} = await connect({
      declinationDecidegrees: -50,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveCompassDeclination(key, snapshot, {
      magDeclinationDecidegrees: 25,
    });
    expect(result.kind).toBe('SUCCEEDED');
    if (result.kind === 'SUCCEEDED') {
      expect(result.observed).toEqual({magDeclinationDecidegrees: 25});
    }
    expect(fc.payloadsFor(MSP_SET_COMPASS_CONFIG)).toEqual([[0x19, 0x00]]);
    expect(fc.declinationState()).toBe(25);
  });

  it('writes a negative declination as two-s-complement bytes', async () => {
    const {fc, coordinator, key} = await connect({declinationDecidegrees: 0});
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveCompassDeclination(key, snapshot, {
      magDeclinationDecidegrees: -50,
    });
    expect(result.kind).toBe('SUCCEEDED');
    expect(fc.payloadsFor(MSP_SET_COMPASS_CONFIG)).toEqual([[0xce, 0xff]]);
    expect(fc.declinationState()).toBe(-50);
  });

  it('refuses a declination past the firmware limit', async () => {
    const {fc, coordinator, key} = await connect();
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    const result = await controller.saveCompassDeclination(key, snapshot, {
      magDeclinationDecidegrees: 301,
    });
    expect(result).toEqual({kind: 'REJECTED', reason: 'UNSUPPORTED_VALUE'});
    expect(fc.requested).not.toContain(MSP_SET_COMPASS_CONFIG);
  });

  it('does not reboot for a declination change', async () => {
    const reboots: {sessionId: string; reason: string}[] = [];
    const {coordinator, key} = await connect({declinationDecidegrees: 0});
    const controller = controllerFor(coordinator, {reboots});
    const snapshot = await loadOrThrow(controller, key);
    await controller.saveCompassDeclination(key, snapshot, {
      magDeclinationDecidegrees: 25,
    });
    expect(reboots).toEqual([]);
  });
});

/* ================================================================== *
 * THE NEGATIVE PROOF
 * ================================================================== */

describe('what the sensors controller never sends', () => {
  it('never writes board alignment on any path', async () => {
    const {fc, coordinator, key} = await connect({
      sensorConfigWidth: 5,
      declinationDecidegrees: 0,
      accTrimPitch: 0,
      accTrimRoll: 0,
    });
    const controller = controllerFor(coordinator);
    const snapshot = await loadOrThrow(controller, key);
    await controller.saveHardwareSelection(
      key,
      snapshot,
      hardwareDraft(snapshot, {mag: 5}),
    );
    await controller.saveMagAlignment(key, snapshot, {magAlignmentRaw: 3});
    await controller.saveAccTrim(key, snapshot, {pitch: 10, roll: 20});
    await controller.saveCompassDeclination(key, snapshot, {
      magDeclinationDecidegrees: 25,
    });
    expect(fc.requested).not.toContain(MSP_BOARD_ALIGNMENT_CONFIG);
    expect(fc.requested).not.toContain(MSP_SET_BOARD_ALIGNMENT_CONFIG);
  });
});
