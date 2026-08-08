import {decodePidTerms, decodePidTuningSnapshot} from './decodePidTuning';

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

describe('PID tuning MSP decoding', () => {
  it('decodes the five official PID rows and API 1.47 feedforward offsets', () => {
    const pid = Uint8Array.from({length: 15}, (_, index) => index + 1);
    const advanced = new Uint8Array(61); writeU16(advanced, 32, 120); writeU16(advanced, 34, 130); writeU16(advanced, 36, 140);
    const snapshot = decodePidTuningSnapshot({pid, advanced, rates: new Uint8Array(24), filters: new Uint8Array(49)});
    expect(snapshot.terms).toEqual([{p: 1, i: 2, d: 3}, {p: 4, i: 5, d: 6}, {p: 7, i: 8, d: 9}, {p: 10, i: 11, d: 12}, {p: 13, i: 14, d: 15}]);
    expect(snapshot.feedforward).toEqual([120, 130, 140]);
  });

  it('rejects layouts that are not the pinned API 1.47 contract', () => {
    expect(() => decodePidTerms(new Uint8Array(14))).toThrow('15 bytes');
    expect(() => decodePidTuningSnapshot({pid: new Uint8Array(15), advanced: new Uint8Array(60), rates: new Uint8Array(24), filters: new Uint8Array(49)})).toThrow('at least 61');
    expect(() => decodePidTuningSnapshot({pid: new Uint8Array(15), advanced: new Uint8Array(61), rates: new Uint8Array(23), filters: new Uint8Array(49)})).toThrow('24 bytes');
    expect(() => decodePidTuningSnapshot({pid: new Uint8Array(15), advanced: new Uint8Array(61), rates: new Uint8Array(24), filters: new Uint8Array(48)})).toThrow('49 bytes');
  });
});
