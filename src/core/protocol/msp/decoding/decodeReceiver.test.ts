import {RECEIVER_CHANNEL_MAX_COUNT, decodeRcChannels, decodeReceiverDeadband, decodeReceiverMap, decodeRssiConfig} from './decodeReceiver';

describe('receiver MSP decoders', () => {
  it('decodes real u16 channel values', () => {
    expect(decodeRcChannels(Uint8Array.from([220, 5, 232, 3])).channels).toEqual([1500, 1000]);
  });
  it('rejects a partial channel word', () => {
    expect(() => decodeRcChannels(Uint8Array.from([1]))).toThrow();
  });
  it('enforces Betaflight API 1.47 maximum of 18 channels', () => {
    expect(RECEIVER_CHANNEL_MAX_COUNT).toBe(18);
    expect(decodeRcChannels(new Uint8Array(18 * 2)).channels).toHaveLength(18);
    expect(() => decodeRcChannels(new Uint8Array(19 * 2))).toThrow(/maximum is 18/);
  });
  it('decodes map and RSSI configuration', () => {
    expect(decodeReceiverMap(Uint8Array.from([0, 1, 3, 2, 4, 5, 6, 7]))).toEqual([0, 1, 3, 2, 4, 5, 6, 7]);
    expect(decodeRssiConfig(Uint8Array.from([8]))).toBe(8);
  });
  it('decodes deadband including u16 3D throttle', () => {
    expect(decodeReceiverDeadband(Uint8Array.from([2, 3, 4, 44, 1]))).toEqual({deadband: 2, yawDeadband: 3, altitudeHoldDeadband: 4, throttle3dDeadband: 300});
  });
});
