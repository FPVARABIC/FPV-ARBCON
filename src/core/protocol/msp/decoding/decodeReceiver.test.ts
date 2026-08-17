import {RECEIVER_CHANNEL_MAX_COUNT, decodeRcChannels, decodeReceiverDeadband, decodeReceiverMap, decodeRssiConfig} from './decodeReceiver';

describe('receiver MSP decoders', () => {
  it('decodes real u16 channel values', () => {
    expect(decodeRcChannels(Uint8Array.from([220, 5, 232, 3])).channels).toEqual([1500, 1000]);
  });
  it('integer-divides a partial channel word away, as Betaflight does', () => {
    // `FC.RC.active_channels = data.byteLength / 2` - no evenness check.
    expect(decodeRcChannels(Uint8Array.from([1])).channels).toEqual([]);
    expect(decodeRcChannels(Uint8Array.from([220, 5, 9])).channels).toEqual([1500]);
  });
  it('CLAMPS to 18 channels rather than blanking the stick bars', () => {
    // These are the live stick bars an operator uses to diagnose a bad link. A
    // firmware compiled for more channels than this build knows about must not
    // blank them; the cap survives as a bound on allocation.
    expect(RECEIVER_CHANNEL_MAX_COUNT).toBe(18);
    expect(decodeRcChannels(new Uint8Array(18 * 2)).channels).toHaveLength(18);
    expect(decodeRcChannels(new Uint8Array(19 * 2)).channels).toHaveLength(18);
  });
  it('decodes map and RSSI configuration', () => {
    expect(decodeReceiverMap(Uint8Array.from([0, 1, 3, 2, 4, 5, 6, 7]))).toEqual([0, 1, 3, 2, 4, 5, 6, 7]);
    expect(decodeRssiConfig(Uint8Array.from([8]))).toBe(8);
  });
  it('decodes deadband including u16 3D throttle', () => {
    expect(decodeReceiverDeadband(Uint8Array.from([2, 3, 4, 44, 1]))).toEqual({deadband: 2, yawDeadband: 3, altitudeHoldDeadband: 4, throttle3dDeadband: 300});
  });
});
