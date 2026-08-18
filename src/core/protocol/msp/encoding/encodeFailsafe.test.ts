import type {MspFailsafeSnapshot} from '../decoding/decodeFailsafe';
import {createFailsafeConfigurationDraft} from '../../../state/failsafeConfigurationModel';
import {encodeChangedFailsafeConfiguration} from './encodeFailsafe';

const snapshot: MspFailsafeSnapshot = {config: {delayDeciseconds: 15, landingTimeSeconds: 60, throttle: 1000, switchMode: 0, rawSwitchMode: 0, throttleLowDelayDeciseconds: 100, procedure: 1, rawProcedure: 1, truncated: false}, channels: [{mode: 0, rawMode: 0, value: 1500, outOfRange: false}, {mode: 1, rawMode: 1, value: 1000, outOfRange: false}], supportsGpsRescue: true, gpsRescueAvailability: 'PRESENT'};
describe('encodeChangedFailsafeConfiguration', () => {
  it('writes only changed owned groups with exact indexed payloads', () => {
    const draft = createFailsafeConfigurationDraft(snapshot);
    const writes = encodeChangedFailsafeConfiguration(snapshot, {...draft, delayDeciseconds: 20, channels: [draft.channels[0], {mode: 2, value: 1250}]});
    expect(writes.map(write => write.group)).toEqual(['FAILSAFE_CONFIG', 'RXFAIL_CONFIG']);
    expect([...writes[0].payload]).toEqual([20, 60, 232, 3, 0, 100, 0, 1]);
    expect([...writes[1].payload]).toEqual([1, 2, 226, 4]);
  });
});
