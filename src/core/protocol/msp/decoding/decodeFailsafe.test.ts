import {decodeFailsafeConfiguration, decodeRxFailsafeConfiguration} from './decodeFailsafe';

describe('failsafe MSP decoders', () => {
  it('decodes the exact API 1.47 main payload', () => {
    expect(decodeFailsafeConfiguration(Uint8Array.from([15, 60, 232, 3, 0, 100, 0, 1]))).toEqual({delayDeciseconds: 15, landingTimeSeconds: 60, throttle: 1000, switchMode: 0, throttleLowDelayDeciseconds: 100, procedure: 1});
    expect(() => decodeFailsafeConfiguration(new Uint8Array(7))).toThrow(/exactly 8/);
    expect(() => decodeFailsafeConfiguration(Uint8Array.from([15, 60, 232, 3, 9, 100, 0, 1]))).toThrow(/switch mode/);
  });
  it('decodes channel records and rejects invalid grids', () => {
    expect(decodeRxFailsafeConfiguration(Uint8Array.from([0, 220, 5, 1, 232, 3]))).toEqual([{mode: 0, value: 1500}, {mode: 1, value: 1000}]);
    expect(() => decodeRxFailsafeConfiguration(Uint8Array.from([1, 0]))).toThrow(/three-byte/);
    expect(() => decodeRxFailsafeConfiguration(Uint8Array.from([2, 221, 5]))).toThrow(/invalid value/);
  });
});
