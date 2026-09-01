import {decodeOsdCanvas, decodeOsdConfiguration} from './decodeOsdConfiguration';

function payload(): Uint8Array {
  const bytes = new Uint8Array(64); const view = new DataView(bytes.buffer); let o = 0;
  bytes[o++] = 0x61; bytes[o++] = 3; bytes[o++] = 1; bytes[o++] = 30;
  view.setUint16(o, 1400, true); o += 2; bytes[o++] = 0; bytes[o++] = 2; view.setUint16(o, 120, true); o += 2;
  view.setUint16(o, 0x0805, true); o += 2; view.setUint16(o, 0xc426, true); o += 2;
  bytes[o++] = 2; bytes[o++] = 1; bytes[o++] = 0;
  bytes[o++] = 2; view.setUint16(o, 0x0a21, true); o += 2; view.setUint16(o, 0x1422, true); o += 2;
  view.setUint16(o, 3, true); o += 2; bytes[o++] = 4; view.setUint32(o, 5, true); o += 4;
  bytes[o++] = 3; bytes[o++] = 2; bytes[o++] = 1; bytes[o++] = 24; bytes[o++] = 11;
  const result = new Uint8Array(o + 4); result.set(bytes.slice(0, o)); const final = new DataView(result.buffer); final.setUint16(o, 70, true); final.setInt16(o + 2, -95, true); return result;
}

describe('OSD API 1.47 decoding', () => {
  it('decodes dynamic elements, statistics, timers, profiles and signed dBm', () => {const value = decodeOsdConfiguration(payload()); expect(value.elementPositions).toEqual([0x0805, 0xc426]); expect(value.statistics).toEqual([true, false]); expect(value.timers).toEqual([0x0a21, 0x1422]); expect(value.enabledWarnings).toBe(5); expect(value.profileCount).toBe(3); expect(value.selectedProfile).toBe(2); expect(value.rssiDbmAlarm).toBe(-95);});
  it('falls back to the standard HD grid rather than closing the screen', () => {
    // MSP_OSD_CANVAS is display geometry only - it sizes the preview and is
    // never written to the flight controller - so an absent or nonsensical
    // answer has no safety meaning. 53x20 is the value Betaflight itself
    // starts from (src/js/tabs/osd.js VIDEO_COLS.HD / VIDEO_ROWS.HD).
    expect(decodeOsdCanvas(Uint8Array.from([53, 20]))).toEqual({columns: 53, rows: 20});
    expect(decodeOsdCanvas(Uint8Array.from([53]))).toEqual({columns: 53, rows: 20});
    expect(decodeOsdCanvas(Uint8Array.from([0, 20]))).toEqual({columns: 53, rows: 20});
    expect(decodeOsdCanvas(new Uint8Array(0))).toEqual({columns: 53, rows: 20});
  });

  it('loads a config payload longer OR shorter than this build knows about', () => {
    // Every count in MSP_OSD_CONFIG - elements, statistics, timers - is
    // declared by the firmware and grows between releases.
    const full = payload();
    expect(decodeOsdConfiguration(Uint8Array.from([...full, 7, 7])).rssiDbmAlarm).toBe(-95);
    expect(() => decodeOsdConfiguration(full.slice(0, 12))).not.toThrow();
  });
});
