/**
 * FAILSAFE READS TOLERATE WHAT BETAFLIGHT TOLERATES.
 *
 * These tests previously pinned the opposite contract: an exact 8-byte
 * MSP_FAILSAFE_CONFIG, a throw on any switch mode or procedure above 2, a
 * throw on a partial RXFAIL record and a throw on any channel value off
 * the 25us grid. Every one of those turned a single unexpected byte into
 * "the Failsafe screen will not load at all" - so the operator could
 * neither see the offending value nor fix it.
 *
 * The pinned Betaflight Configurator does none of it. MSPHelper.js reads
 * the six failsafe fields positionally over a reader that returns null
 * past the end (injected_methods.js), and derives the RXFAIL channel
 * count from `data.byteLength / 3` with no validation of mode or value at
 * all. Range and grid are WRITE constraints, enforced on the way out.
 */

import {decodeFailsafeConfiguration, decodeRxFailsafeConfiguration} from './decodeFailsafe';

describe('MSP_FAILSAFE_CONFIG', () => {
  it('decodes the API 1.47 payload', () => {
    expect(decodeFailsafeConfiguration(Uint8Array.from([15, 60, 232, 3, 0, 100, 0, 1]))).toEqual({
      delayDeciseconds: 15,
      landingTimeSeconds: 60,
      throttle: 1000,
      switchMode: 0,
      rawSwitchMode: 0,
      throttleLowDelayDeciseconds: 100,
      procedure: 1,
      rawProcedure: 1,
      truncated: false,
    });
  });

  it('accepts a LONGER payload - a future firmware appending a field must not break the screen', () => {
    const withExtraField = Uint8Array.from([15, 60, 232, 3, 0, 100, 0, 1, 42, 7]);
    const decoded = decodeFailsafeConfiguration(withExtraField);
    expect(decoded.procedure).toBe(1);
    expect(decoded.truncated).toBe(false);
  });

  it('accepts a SHORTER payload, keeping defaults for the fields that never arrived', () => {
    const decoded = decodeFailsafeConfiguration(Uint8Array.from([15, 60, 232, 3]));
    expect(decoded.delayDeciseconds).toBe(15);
    expect(decoded.landingTimeSeconds).toBe(60);
    expect(decoded.truncated).toBe(true);
  });

  it('PRESERVES an unrecognized switch mode instead of refusing to load', () => {
    const decoded = decodeFailsafeConfiguration(Uint8Array.from([15, 60, 232, 3, 9, 100, 0, 1]));
    expect(decoded.rawSwitchMode).toBe(9);
    // Clamped to Stage 1 for the typed field, so nothing downstream has to
    // handle a value outside the union.
    expect(decoded.switchMode).toBe(0);
  });

  it('PRESERVES an unrecognized procedure, clamping the typed field to Drop', () => {
    // GPS Rescue itself arrived as procedure 2; assuming 0-2 is permanent
    // is how a future procedure would have bricked this screen. Drop is
    // the clamp because it is the one procedure that cannot fly the
    // aircraft anywhere on its own.
    const decoded = decodeFailsafeConfiguration(Uint8Array.from([15, 60, 232, 3, 0, 100, 0, 7]));
    expect(decoded.rawProcedure).toBe(7);
    expect(decoded.procedure).toBe(1);
  });
});

describe('MSP_RXFAIL_CONFIG', () => {
  it('decodes complete channel records', () => {
    expect(decodeRxFailsafeConfiguration(Uint8Array.from([0, 220, 5, 1, 232, 3]))).toEqual([
      {mode: 0, rawMode: 0, value: 1500, outOfRange: false},
      {mode: 1, rawMode: 1, value: 1000, outOfRange: false},
    ]);
  });

  it('ignores a trailing PARTIAL record, exactly as Betaflight integer-divides it away', () => {
    expect(decodeRxFailsafeConfiguration(Uint8Array.from([0, 220, 5, 1, 0]))).toEqual([
      {mode: 0, rawMode: 0, value: 1500, outOfRange: false},
    ]);
  });

  it('SHOWS an off-grid stored value rather than refusing to load the screen', () => {
    // 1501us: inside the range but off the 25us grid. The operator needs
    // to see it - it is what their board actually holds - and the save
    // path is what corrects it.
    const [channel] = decodeRxFailsafeConfiguration(Uint8Array.from([2, 221, 5]));
    expect(channel.value).toBe(1501);
    expect(channel.outOfRange).toBe(true);
  });

  it('marks an out-of-range value without discarding it', () => {
    const [channel] = decodeRxFailsafeConfiguration(Uint8Array.from([2, 0, 0]));
    expect(channel.value).toBe(0);
    expect(channel.outOfRange).toBe(true);
  });

  it('preserves an unrecognized channel mode, clamping the typed field to HOLD', () => {
    const [channel] = decodeRxFailsafeConfiguration(Uint8Array.from([9, 220, 5]));
    expect(channel.rawMode).toBe(9);
    expect(channel.mode).toBe(1);
  });

  it('an empty payload is simply no channels', () => {
    expect(decodeRxFailsafeConfiguration(new Uint8Array(0))).toEqual([]);
  });
});
