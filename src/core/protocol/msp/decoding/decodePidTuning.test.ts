import {
  decodeFilterConfiguration,
  decodePidTerms,
  decodePidTuningSnapshot,
  decodeRcTuning,
} from './decodePidTuning';

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}
const PROFILES = {pidProfileIndex: 1, pidProfileCount: 3, controlRateProfileIndex: 2} as const;

describe('PID tuning MSP decoding', () => {
  it('decodes the five official PID rows and API 1.47 feedforward offsets', () => {
    const pid = Uint8Array.from({length: 15}, (_, index) => index + 1);
    const advanced = new Uint8Array(61); writeU16(advanced, 32, 120); writeU16(advanced, 34, 130); writeU16(advanced, 36, 140);
    const snapshot = decodePidTuningSnapshot({pid, advanced, rates: new Uint8Array(24), filters: new Uint8Array(49), ...PROFILES});
    expect(snapshot.terms).toEqual([{p: 1, i: 2, d: 3}, {p: 4, i: 5, d: 6}, {p: 7, i: 8, d: 9}, {p: 10, i: 11, d: 12}, {p: 13, i: 14, d: 15}]);
    expect(snapshot.feedforward).toEqual([120, 130, 140]);
    expect(snapshot).toMatchObject(PROFILES);
  });

  it('decodes every API 1.47 rates field from its official offset', () => {
    const rates = Uint8Array.from({length: 24}, (_, index) => index + 1);
    writeU16(rates, 16, 500);
    writeU16(rates, 18, 600);
    writeU16(rates, 20, 700);

    expect(decodeRcTuning(rates)).toEqual({
      ratesType: 23,
      rcRate: [1, 13, 12],
      expo: [2, 14, 11],
      superRate: [3, 4, 5],
      throttleMid: 7,
      throttleExpo: 8,
      throttleHover: 24,
      throttleLimitType: 15,
      throttleLimitPercent: 16,
      rateLimit: [500, 600, 700],
    });
  });

  it('decodes only the reviewed API 1.47 filter fields', () => {
    const filters = new Uint8Array(49);
    writeU16(filters, 1, 120);
    writeU16(filters, 20, 250);
    writeU16(filters, 29, 180);
    writeU16(filters, 31, 420);
    writeU16(filters, 33, 90);
    writeU16(filters, 35, 180);
    writeU16(filters, 39, 350);
    writeU16(filters, 41, 150);
    writeU16(filters, 45, 600);
    filters[48] = 3;

    expect(decodeFilterConfiguration(filters)).toEqual({
      gyroLpf1StaticHz: 250,
      gyroLpf1DynamicMinHz: 180,
      gyroLpf1DynamicMaxHz: 420,
      dtermLpf1StaticHz: 120,
      dtermLpf1DynamicMinHz: 90,
      dtermLpf1DynamicMaxHz: 180,
      dynamicNotchQ: 350,
      dynamicNotchMinHz: 150,
      dynamicNotchMaxHz: 600,
      dynamicNotchCount: 3,
    });
  });

  it('TOLERATES a layout that is not exactly the pinned API 1.47 contract', () => {
    // Reversed deliberately. Betaflight reads MSP_PID, MSP_RC_TUNING and
    // MSP_FILTER_CONFIG positionally with no length assertion, so a
    // firmware that appends or omits a trailing field still opens its PID
    // tab. Exact-length gates here meant a future Betaflight release would
    // make PID tuning unreachable rather than showing one odd value.
    expect(() => decodePidTerms(new Uint8Array(14))).not.toThrow();
    expect(decodePidTerms(new Uint8Array(14))).toHaveLength(5);
    // A LONGER payload is equally survivable - the extra bytes are ignored.
    expect(() => decodePidTerms(new Uint8Array(18))).not.toThrow();
    // Rates and filters take the same posture.
    expect(() => decodeRcTuning(new Uint8Array(23))).not.toThrow();
    expect(() => decodeRcTuning(new Uint8Array(30))).not.toThrow();
    expect(() => decodeFilterConfiguration(new Uint8Array(48))).not.toThrow();
    expect(() => decodeFilterConfiguration(new Uint8Array(60))).not.toThrow();
  });
  it('rejects missing or inconsistent profile identity', () => {
    const base = {pid: new Uint8Array(15), advanced: new Uint8Array(61), rates: new Uint8Array(24), filters: new Uint8Array(49), ...PROFILES};
    expect(() => decodePidTuningSnapshot({...base, pidProfileIndex: 3})).toThrow('profile identity');
    expect(() => decodePidTuningSnapshot({...base, pidProfileCount: 0})).toThrow('profile identity');
    expect(() => decodePidTuningSnapshot({...base, controlRateProfileIndex: -1})).toThrow('profile identity');
  });
});
