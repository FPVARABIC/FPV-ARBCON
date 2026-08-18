import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import '../../i18n';
import type {MspFailsafeSnapshot} from '../../core';
import {decodeGpsRescue} from '../../core';
import {gpsRescuePayload} from '../../core/protocol/__testUtils__/gpsRescueFixtures';
import FailsafeScreen, {type FailsafeControllerPort} from './FailsafeScreen';

const snapshot: MspFailsafeSnapshot = {config: {delayDeciseconds: 15, landingTimeSeconds: 60, throttle: 1000, switchMode: 0, rawSwitchMode: 0, throttleLowDelayDeciseconds: 100, procedure: 1, rawProcedure: 1, truncated: false}, channels: [{mode: 0, rawMode: 0, value: 1500, outOfRange: false}, {mode: 0, rawMode: 0, value: 1500, outOfRange: false}, {mode: 0, rawMode: 0, value: 1500, outOfRange: false}, {mode: 0, rawMode: 0, value: 1000, outOfRange: false}, {mode: 1, rawMode: 1, value: 1500, outOfRange: false}], supportsGpsRescue: true, gpsRescue: decodeGpsRescue(gpsRescuePayload()), gpsRescueAvailability: 'PRESENT'};
async function render(controller: FailsafeControllerPort) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {renderer = ReactTestRenderer.create(<FailsafeScreen sessionKey={{sessionId: 'fc', generation: 1}} active onOpenReceiver={() => {}} onOpenMotors={() => {}} controller={controller} />); await Promise.resolve();});
  return {
    renderer,
    find: (testID: string) => renderer.root.findAllByProps({testID})[0],
    findAll: (testID: string) => renderer.root.findAllByProps({testID}),
    /**
     * The STEPPER, not the field wrapper around it. A testID passed to a
     * wrapper component appears on the wrapper's own props too, and that
     * one carries the raw number - so asking for [0] silently reads the
     * unformatted value and finds no press handlers.
     */
    stepper: (testID: string) => {
      const node = renderer.root.findAllByProps({testID}).find(candidate => typeof candidate.props.onIncrement === 'function');
      if (node === undefined) throw new Error(`no stepper for ${testID}`);
      return node.props as {value: string; onIncrement: () => void; onDecrement: () => void};
    },
    press: async (testID: string) => ReactTestRenderer.act(async () => {renderer.root.findAllByProps({testID})[0].props.onPress(); await Promise.resolve();}),
    unmount: () => ReactTestRenderer.act(() => renderer.unmount()),
  };
}
function loader(board: MspFailsafeSnapshot): FailsafeControllerPort {return {load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: board})), save: jest.fn()};}

describe('FailsafeScreen', () => {
  it('renders every real channel and exposes GPS Rescue only with build evidence', async () => {const controller: FailsafeControllerPort = {load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot})), save: jest.fn()}; const screen = await render(controller); expect(screen.find('failsafe-channel-5')).toBeDefined(); expect(screen.find('failsafe-procedure-2')).toBeDefined(); screen.unmount();});
  it('edits a channel and sends a verified draft', async () => {const saved: MspFailsafeSnapshot = {...snapshot, channels: [...snapshot.channels.slice(0, 4), {mode: 2, rawMode: 2, value: 1500, outOfRange: false}]}; const controller: FailsafeControllerPort = {load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot})), save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: saved}))}; const screen = await render(controller); await screen.press('failsafe-channel-5-mode-2'); const bar = screen.find('failsafe-save-bar'); await ReactTestRenderer.act(async () => {await bar.props.onSave();}); expect(controller.save).toHaveBeenCalledWith(expect.anything(), snapshot, expect.objectContaining({channels: expect.arrayContaining([expect.objectContaining({mode: 2})])})); screen.unmount();});
});

/**
 * THE RESCUE CARD IS THE POINT OF THE SCREEN FOR A LONG-RANGE PILOT.
 *
 * Until this existed the screen could SELECT GPS Rescue as the stage-2
 * procedure and could not configure a single parameter of it, so the
 * aircraft flew home on whatever defaults the board carried. These check
 * the three things that decide whether the card is worth having: the
 * numbers are the board's own, the units are the ones a pilot thinks in,
 * and a control appears only when the board can actually store it.
 */
describe('the GPS Rescue card', () => {
  it('shows the board’s own values, converted to the units a pilot uses', async () => {
    const screen = await render(loader(snapshot));

    // 120 m return altitude, straight from the payload.
    expect(screen.stepper('failsafe-gps-return-altitude').value).toBe('120 م');
    // 850 cm/s on the wire is 8.5 m/s to a pilot - the conversion
    // Betaflight's own UI makes, and the one that stops a return speed
    // from reading like a satellite count.
    expect(screen.stepper('failsafe-gps-ground-speed').value).toBe('8.5 م/ث');
    expect(screen.stepper('failsafe-gps-ascend-rate').value).toBe('6.4 م/ث');
    // 155 cm/s is 1.55 m/s, NOT 1.6. Rounding a rate to one decimal
    // turned the firmware's own 25 cm/s floor into "0.3 m/s" - a number
    // the board would refuse.
    expect(screen.stepper('failsafe-gps-descend-rate').value).toBe('1.55 م/ث');
    screen.unmount();
  });

  it('sends an edited rescue parameter through the same save as the rest of the screen', async () => {
    const controller = loader(snapshot);
    controller.save = jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot}));
    const screen = await render(controller);

    await ReactTestRenderer.act(async () => {
      screen.stepper('failsafe-gps-return-altitude').onIncrement();
      await Promise.resolve();
    });
    await ReactTestRenderer.act(async () => {
      await screen.find('failsafe-save-bar').props.onSave();
    });

    expect(controller.save).toHaveBeenCalledWith(
      expect.anything(),
      snapshot,
      expect.objectContaining({gpsRescue: expect.objectContaining({returnAltitudeM: 121})}),
    );
    screen.unmount();
  });

  it('hides the controls a shorter payload cannot store', async () => {
    // A 16-byte board has no ascend rate and no altitude mode. A stepper
    // for one would be a control that cannot reach the aircraft.
    const older: MspFailsafeSnapshot = {...snapshot, gpsRescue: decodeGpsRescue(gpsRescuePayload({}, 16))};
    const screen = await render(loader(older));

    expect(screen.findAll('failsafe-gps-min-sats')).not.toHaveLength(0);
    expect(screen.findAll('failsafe-gps-ascend-rate')).toHaveLength(0);
    expect(screen.findAll('failsafe-gps-altitude-mode-0')).toHaveLength(0);
    expect(screen.findAll('failsafe-gps-initial-climb')).toHaveLength(0);
    screen.unmount();
  });

  it('says why the card is missing instead of quietly leaving it out', async () => {
    const absent: MspFailsafeSnapshot = {...snapshot, gpsRescue: undefined, gpsRescueAvailability: 'COMMAND_UNSUPPORTED'};
    const screen = await render(loader(absent));

    expect(screen.findAll('failsafe-gps-rescue')).toHaveLength(0);
    expect(screen.findAll('failsafe-gps-rescue-absent')).not.toHaveLength(0);
    screen.unmount();
  });

  it('does not raise the question at all on a build without GPS', async () => {
    const noGps: MspFailsafeSnapshot = {...snapshot, supportsGpsRescue: false, gpsRescue: undefined, gpsRescueAvailability: 'NO_GPS_IN_BUILD'};
    const screen = await render(loader(noGps));

    expect(screen.findAll('failsafe-gps-rescue')).toHaveLength(0);
    expect(screen.findAll('failsafe-gps-rescue-absent')).toHaveLength(0);
    screen.unmount();
  });

  it('snaps a stored value that is outside the firmware range into it on the first press', async () => {
    // A board can hold a value a later firmware would refuse. A one-sided
    // clamp would walk down one metre at a time; the operator needs the
    // control to reach a legal value immediately.
    const wide: MspFailsafeSnapshot = {...snapshot, gpsRescue: decodeGpsRescue(gpsRescuePayload({minStartDistM: 100}))};
    const controller = loader(wide);
    const screen = await render(controller);
    expect(screen.stepper('failsafe-gps-min-start-distance').value).toBe('100 م');

    await ReactTestRenderer.act(async () => {
      screen.stepper('failsafe-gps-min-start-distance').onDecrement();
      await Promise.resolve();
    });

    expect(screen.stepper('failsafe-gps-min-start-distance').value).toBe('30 م');
    screen.unmount();
  });
});

/**
 * UNITS ARE A DISPLAY CONCERN. THE PAYLOAD IS NOT.
 *
 * The board stores failsafe timings in tenths of a second and the screen
 * used to print that storage unit at the pilot: "15 ×0.1s". The fix is
 * purely presentational, and this suite exists to keep it that way - the
 * dangerous version of this change is one where the formatter quietly
 * becomes the source of truth and a 1.5-second guard time is saved as 1.
 */
describe('failsafe timings read as seconds and save as deciseconds', () => {
  it('shows the pilot seconds, not the storage unit', async () => {
    const screen = await render(loader(snapshot));

    // 15 deciseconds IS 1.5 seconds. The old copy said "15 ×0.1s".
    expect(screen.stepper('failsafe-delay').value).toBe('1.5 ثانية');
    // 100 deciseconds is a round 10 seconds - and must not read "10.0".
    expect(screen.stepper('failsafe-throttle-low-delay').value).toBe('10 ثانية');
    screen.unmount();
  });

  it('states the range in seconds too, so the label and the value agree', async () => {
    const screen = await render(loader(snapshot));
    const shown = JSON.stringify(screen.renderer.toJSON());
    expect(shown).toContain('0.1–20 ثانية');
    expect(shown).not.toContain('×0.1s');
    screen.unmount();
  });

  it('SAVES THE WIRE VALUE, not the number on screen', async () => {
    // The assertion the whole change lives or dies on. One press moves
    // the draft by one DECISECOND (15 -> 16, displayed 1.5 -> 1.6); the
    // controller must receive 16, never 1.6.
    const controller = loader(snapshot);
    controller.save = jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot}));
    const screen = await render(controller);

    await ReactTestRenderer.act(async () => {
      screen.stepper('failsafe-delay').onIncrement();
      await Promise.resolve();
    });
    expect(screen.stepper('failsafe-delay').value).toBe('1.6 ثانية');

    await ReactTestRenderer.act(async () => {
      await screen.find('failsafe-save-bar').props.onSave();
    });

    expect(controller.save).toHaveBeenCalledWith(
      expect.anything(),
      snapshot,
      expect.objectContaining({delayDeciseconds: 16}),
    );
    screen.unmount();
  });

  it('holds the stepper to the wire range, not to a rounded second', async () => {
    // The minimum is 1 decisecond - 0.1 s - and a formatter that rounded
    // to whole seconds would make the floor unreachable.
    const low = {...snapshot, config: {...snapshot.config, delayDeciseconds: 1}};
    const screen = await render(loader(low));
    expect(screen.stepper('failsafe-delay').value).toBe('0.1 ثانية');
    screen.unmount();
  });
});
