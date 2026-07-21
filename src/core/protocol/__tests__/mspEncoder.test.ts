import { encode } from '../mspEncoder';
import { createMspStreamParser } from '../mspStreamParser';
import { MSP_V2_FRAME_ID } from '../mspTypes';

function decodeOne(bytes: Uint8Array) {
  const parser = createMspStreamParser();
  const result = parser.ingest(bytes);
  expect(result.diagnostics).toEqual([]);
  expect(result.frames).toHaveLength(1);
  return result.frames[0];
}

describe('encode() — wireFormat is required, never inferred/defaulted', () => {
  it('rejects a call missing wireFormat at compile time', () => {
    expect(() => {
      // @ts-expect-error wireFormat is a required field with no default
      encode(100, new Uint8Array(0), {});
    }).toThrow(/wireFormat/);
  });

  it('throws at runtime for a plain-JS caller that bypasses the type check', () => {
    expect(() => encode(100, new Uint8Array(0), {} as never)).toThrow(/wireFormat/);
  });
});

describe('encode() round-trips through the parser', () => {
  it('v1 native, non-empty payload', () => {
    const payload = Uint8Array.from([1, 2, 3, 4]);
    const bytes = encode(100, payload, { wireFormat: 'v1' });
    const frame = decodeOne(bytes);
    expect(frame).toEqual({
      protocolVersion: 'v1',
      wireFormat: 'v1',
      direction: 'request',
      command: 100,
      flags: 0,
      payload,
    });
  });

  it('v1 native, zero-length payload', () => {
    const bytes = encode(1, new Uint8Array(0), { wireFormat: 'v1' });
    const frame = decodeOne(bytes);
    expect(frame.command).toBe(1);
    expect(frame.payload).toEqual(new Uint8Array(0));
  });

  it('v2 native, with flags and a multi-byte command', () => {
    const payload = Uint8Array.from([9, 8, 7]);
    const bytes = encode(0x1234, payload, { wireFormat: 'v2', flags: 0x07 });
    const frame = decodeOne(bytes);
    expect(frame).toEqual({
      protocolVersion: 'v2',
      wireFormat: 'v2',
      direction: 'request',
      command: 0x1234,
      flags: 0x07,
      payload,
    });
  });

  it('v2-over-v1, inner command carried correctly (never the outer 255)', () => {
    const payload = Uint8Array.from([1, 2, 3]);
    const bytes = encode(0x2000, payload, { wireFormat: 'v2-over-v1', flags: 0x01 });
    const frame = decodeOne(bytes);
    expect(frame.wireFormat).toBe('v2-over-v1');
    expect(frame.protocolVersion).toBe('v2');
    expect(frame.command).toBe(0x2000);
    expect(frame.command).not.toBe(MSP_V2_FRAME_ID);
    expect(frame.flags).toBe(0x01);
    expect(frame.payload).toEqual(payload);
  });

  it('v1 native jumbo (payload >= 255 bytes)', () => {
    const payload = new Uint8Array(300).map((_, i) => i & 0xff);
    const bytes = encode(50, payload, { wireFormat: 'v1' });
    const frame = decodeOne(bytes);
    expect(frame.wireFormat).toBe('v1');
    expect(frame.payload).toEqual(payload);
  });

  it('v2-over-v1 with an outer-jumbo-sized wrapped payload', () => {
    const payload = new Uint8Array(300).map((_, i) => i & 0xff);
    const bytes = encode(0x3000, payload, { wireFormat: 'v2-over-v1' });
    const frame = decodeOne(bytes);
    expect(frame.wireFormat).toBe('v2-over-v1');
    expect(frame.command).toBe(0x3000);
    expect(frame.payload).toEqual(payload);
  });
});

describe('encode() validation', () => {
  it('rejects a nonzero flags value for wireFormat "v1"', () => {
    expect(() => encode(1, new Uint8Array(0), { wireFormat: 'v1', flags: 1 })).toThrow(/flags/);
  });

  it('rejects command 255 for wireFormat "v1" (reserved for v2-over-v1)', () => {
    expect(() => encode(MSP_V2_FRAME_ID, new Uint8Array(0), { wireFormat: 'v1' })).toThrow(/255/);
  });

  it('rejects a payload longer than maxPayloadBytes', () => {
    expect(() =>
      encode(1, new Uint8Array(10), { wireFormat: 'v1', maxPayloadBytes: 5 }),
    ).toThrow(/maxPayloadBytes/);
  });
});
