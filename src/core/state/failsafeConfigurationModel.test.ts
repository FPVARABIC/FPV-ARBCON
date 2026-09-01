import type {MspFailsafeSnapshot} from '../protocol/msp/decoding/decodeFailsafe';
import {createFailsafeConfigurationDraft, validateFailsafeDraft} from './failsafeConfigurationModel';

const snapshot: MspFailsafeSnapshot = {config: {delayDeciseconds: 15, landingTimeSeconds: 60, throttle: 1000, switchMode: 0, rawSwitchMode: 0, throttleLowDelayDeciseconds: 100, procedure: 1, rawProcedure: 1, truncated: false}, channels: [{mode: 0, rawMode: 0, value: 1500, outOfRange: false}, {mode: 0, rawMode: 0, value: 1500, outOfRange: false}, {mode: 0, rawMode: 0, value: 1500, outOfRange: false}, {mode: 0, rawMode: 0, value: 1000, outOfRange: false}, {mode: 1, rawMode: 1, value: 1500, outOfRange: false}], supportsGpsRescue: false, gpsRescueAvailability: 'NO_GPS_IN_BUILD'};
describe('failsafe configuration model', () => {
  it('accepts the firmware defaults', () => expect(validateFailsafeDraft(createFailsafeConfigurationDraft(snapshot), snapshot)).toEqual([]));
  it('rejects GPS rescue without build evidence and AUTO on AUX', () => {
    const draft = createFailsafeConfigurationDraft(snapshot);
    expect(validateFailsafeDraft({...draft, procedure: 2}, snapshot)).toContain('GPS_RESCUE_UNSUPPORTED');
    expect(validateFailsafeDraft({...draft, channels: [...draft.channels.slice(0, 4), {mode: 0, value: 1500}]}, snapshot)).toContain('AUX_AUTO_FORBIDDEN');
  });
});
