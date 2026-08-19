/* eslint-disable no-bitwise -- this file is about a shared bit mask. */
/**
 * CROSS-SCREEN DESTRUCTIVE WRITES: WHAT ONE SCREEN CAN COST ANOTHER.
 *
 * Five controllers in this application write MSP_SET_FEATURE_CONFIG, and
 * that command carries ONE 32-BIT MASK for the whole aircraft:
 *
 *   GeneralConfigurationController   MotorConfigurationController
 *   GpsConfigurationController       PortsConfigurationController
 *   ReceiverConfigurationController
 *
 * Two of them write MSP_SET_ADVANCED_CONFIG, which likewise carries gyro
 * fields that the Motors page has no business changing, and two write
 * MSP_SET_RX_CONFIG.
 *
 * There is no way to set one bit of a shared mask over MSP. Every writer
 * must send the WHOLE value, which makes each of them capable of undoing
 * every other one - not by writing a wrong number, but by writing a
 * correct number that is simply OLD. That failure is completely silent:
 * the write is acknowledged, the EEPROM commit succeeds, the readback of
 * the fields the screen owns matches perfectly, and the screen reports
 * success. The bit that vanished belonged to somebody else.
 *
 * These tests interleave two screens over one board and then ask the board
 * what it actually holds.
 */

import {
  MSP_FEATURE_CONFIG,
  MSP_SET_FEATURE_CONFIG,
} from '../../../core/protocol/msp/commands/mspCommands';
import {decodeFeatureConfig} from '../../../core/protocol/msp/decoding/decodeFeatureConfig';
import {createMotorConfigurationDraft} from '../../../core/state/motorConfigurationModel';
import {MotorConfigurationController} from './MotorConfigurationController';
import {
  DRONE_SPECS,
  FEATURE_GPS,
  FEATURE_TELEMETRY,
  buildFactoryBoard,
  type DroneSpec,
} from './__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from './__testUtils__/virtualFlightController';
import {VirtualSession} from './__testUtils__/virtualSession';

function spec(key: string): DroneSpec {
  const found = DRONE_SPECS.find(candidate => candidate.key === key);
  if (found === undefined) throw new Error(`no drone spec ${key}`);
  return found;
}

function rig(droneKey = 'LONG_RANGE', apiMinor = 47) {
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(spec(droneKey)),
  });
  const session = new VirtualSession({
    sessionId: `cross-screen-${droneKey}`,
    board,
    apiMinor,
  });
  return {
    board,
    session,
    motors: new MotorConfigurationController(session.options),
  };
}

/** The feature mask the board is holding right now. */
function liveFeatureMask(board: VirtualFlightController): number {
  const bytes = board.readParameter(MSP_FEATURE_CONFIG);
  if (bytes === undefined) throw new Error('board has no feature config');
  return decodeFeatureConfig(bytes).enabledFeaturesRaw;
}

/** Writes a whole feature mask to the board the way ANOTHER screen would -
 *  through MSP, so the board's own request log records it. */
async function anotherScreenSetsFeatureMask(
  board: VirtualFlightController,
  mask: number,
): Promise<void> {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, mask, true);
  await board.request(MSP_SET_FEATURE_CONFIG, payload, {wireFormat: 'v1'});
}

/* ==================================================================== *
 * THE FEATURE MASK, SHARED FIVE WAYS
 * ==================================================================== */

describe('a Motors save must not undo another screen s feature bits', () => {
  /**
   * THE SCENARIO, in the order an operator would actually do it:
   *
   *   1. open Motors        - loads the feature mask as it is now
   *   2. go to GPS          - enables FEATURE_GPS, mask changes on the board
   *   3. come back to Motors - the editor still holds the mask from step 1
   *   4. toggle motor stop and save
   *
   * Step 4 must not take FEATURE_GPS away with it. The Motors page never
   * showed a GPS control, the operator never touched one, and nothing in
   * the result would say the aircraft just lost its GPS feature.
   */
  it('keeps a feature another screen enabled between load and save', async () => {
    const {board, session, motors} = rig();

    const loaded = await motors.load(session.sessionId);
    expect(loaded.kind).toBe('LOADED');
    if (loaded.kind !== 'LOADED') return;
    const baseMask = loaded.snapshot.feature.enabledFeaturesRaw;

    // ---- another screen, same board, between load and save ----------
    await anotherScreenSetsFeatureMask(board, baseMask | FEATURE_GPS);
    expect(liveFeatureMask(board) & FEATURE_GPS).toBe(FEATURE_GPS);

    // ---- the Motors save, touching only a bit Motors owns ------------
    const outcome = await motors.save(session.sessionId, loaded.snapshot, {
      ...createMotorConfigurationDraft(loaded.snapshot),
      motorStopEnabled: true,
    });

    // Whatever the save decided, the aircraft must not have silently
    // lost a feature the operator turned on.
    expect({
      outcome: outcome.kind,
      gpsStillEnabled: (liveFeatureMask(board) & FEATURE_GPS) !== 0,
    }).toEqual({
      outcome: outcome.kind,
      gpsStillEnabled: true,
    });
  });

  it('keeps a feature another screen DISABLED between load and save', async () => {
    // The mirror image: a bit that was on when Motors loaded and was
    // turned off elsewhere must not come back from the dead.
    const {board, session, motors} = rig();
    await anotherScreenSetsFeatureMask(
      board,
      liveFeatureMask(board) | FEATURE_TELEMETRY,
    );

    const loaded = await motors.load(session.sessionId);
    expect(loaded.kind).toBe('LOADED');
    if (loaded.kind !== 'LOADED') return;
    expect(loaded.snapshot.feature.enabledFeaturesRaw & FEATURE_TELEMETRY).toBe(
      FEATURE_TELEMETRY,
    );

    await anotherScreenSetsFeatureMask(
      board,
      liveFeatureMask(board) & ~FEATURE_TELEMETRY,
    );

    const outcome = await motors.save(session.sessionId, loaded.snapshot, {
      ...createMotorConfigurationDraft(loaded.snapshot),
      motorStopEnabled: true,
    });

    expect({
      outcome: outcome.kind,
      telemetryResurrected: (liveFeatureMask(board) & FEATURE_TELEMETRY) !== 0,
    }).toEqual({
      outcome: outcome.kind,
      telemetryResurrected: false,
    });
  });

  /**
   * The already-guarded case, kept as the control: when the other screen
   * changed a field MOTORS ITSELF owns, the stale-base re-read sees it and
   * refuses. If this ever stops passing, the guard has been lost entirely
   * rather than merely being too narrow.
   */
  it('still refuses when the other screen changed a bit Motors owns', async () => {
    const {board, session, motors} = rig();
    const loaded = await motors.load(session.sessionId);
    if (loaded.kind !== 'LOADED') throw new Error('expected LOADED');

    // FEATURE_MOTOR_STOP is one of the three bits the Motors draft covers.
    await anotherScreenSetsFeatureMask(
      board,
      loaded.snapshot.feature.enabledFeaturesRaw | (1 << 4),
    );

    const outcome = await motors.save(session.sessionId, loaded.snapshot, {
      ...createMotorConfigurationDraft(loaded.snapshot),
      escSensorEnabled: true,
    });
    expect(outcome).toEqual({kind: 'REJECTED', reason: 'STALE_BASE'});
  });
});
