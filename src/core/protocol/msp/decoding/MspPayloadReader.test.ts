import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

describe('MspPayloadReader.readU8', () => {
  it('reads exactly the remaining single byte successfully', () => {
    const reader = new MspPayloadReader(Uint8Array.from([0xab]));
    expect(reader.readU8()).toBe(0xab);
    expect(reader.remaining()).toBe(0);
  });

  it('throws MspPayloadReadError when reading one byte past the end', () => {
    const reader = new MspPayloadReader(new Uint8Array(0));
    expect(() => reader.readU8()).toThrow(MspPayloadReadError);
  });
});

describe('MspPayloadReader.readU16LE', () => {
  it('reads exactly the remaining two bytes successfully, little-endian', () => {
    const reader = new MspPayloadReader(Uint8Array.from([0x34, 0x12]));
    expect(reader.readU16LE()).toBe(0x1234);
    expect(reader.remaining()).toBe(0);
  });

  it('throws when only one byte remains (one short of the boundary)', () => {
    const reader = new MspPayloadReader(Uint8Array.from([0x34]));
    expect(() => reader.readU16LE()).toThrow(MspPayloadReadError);
  });
});

describe('MspPayloadReader.readU32LE', () => {
  it('reads exactly the remaining four bytes successfully, little-endian', () => {
    const reader = new MspPayloadReader(Uint8Array.from([0x78, 0x56, 0x34, 0x12]));
    expect(reader.readU32LE()).toBe(0x12345678);
    expect(reader.remaining()).toBe(0);
  });

  it('throws when only three bytes remain (one short of the boundary)', () => {
    const reader = new MspPayloadReader(Uint8Array.from([0x78, 0x56, 0x34]));
    expect(() => reader.readU32LE()).toThrow(MspPayloadReadError);
  });
});

describe('MspPayloadReader.readBytes', () => {
  it('reads exactly the remaining bytes successfully', () => {
    const reader = new MspPayloadReader(Uint8Array.from([1, 2, 3]));
    expect(reader.readBytes(3)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(reader.remaining()).toBe(0);
  });

  it('throws when requesting one byte more than remains', () => {
    const reader = new MspPayloadReader(Uint8Array.from([1, 2, 3]));
    expect(() => reader.readBytes(4)).toThrow(MspPayloadReadError);
  });
});

describe('MspPayloadReader.readFixedAscii', () => {
  it('reads exactly the remaining bytes successfully as ASCII', () => {
    const reader = new MspPayloadReader(Uint8Array.from([0x42, 0x54, 0x46, 0x4c])); // "BTFL"
    expect(reader.readFixedAscii(4)).toBe('BTFL');
    expect(reader.remaining()).toBe(0);
  });

  it('throws when requesting one byte more than remains', () => {
    const reader = new MspPayloadReader(Uint8Array.from([0x42, 0x54, 0x46]));
    expect(() => reader.readFixedAscii(4)).toThrow(MspPayloadReadError);
  });
});

describe('MspPayloadReader.remaining', () => {
  it('is accurate after every read type, in sequence', () => {
    // 1 (u8) + 2 (u16) + 4 (u32) + 3 (bytes) + 2 (fixedAscii) = 12 bytes total
    const reader = new MspPayloadReader(
      Uint8Array.from([0xff, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 1, 2, 3, 0x41, 0x42]),
    );
    expect(reader.remaining()).toBe(12);
    reader.readU8();
    expect(reader.remaining()).toBe(11);
    reader.readU16LE();
    expect(reader.remaining()).toBe(9);
    reader.readU32LE();
    expect(reader.remaining()).toBe(5);
    reader.readBytes(3);
    expect(reader.remaining()).toBe(2);
    reader.readFixedAscii(2);
    expect(reader.remaining()).toBe(0);
  });
});

describe('MspPayloadReader.readLengthPrefixedString', () => {
  it('reads a normal length-prefixed string correctly', () => {
    // length byte (3) followed by "ABC"
    const reader = new MspPayloadReader(Uint8Array.from([3, 0x41, 0x42, 0x43]));
    expect(reader.readLengthPrefixedString()).toBe('ABC');
    expect(reader.remaining()).toBe(0);
  });

  it('reads a zero-length string correctly (just the length-prefix byte)', () => {
    const reader = new MspPayloadReader(Uint8Array.from([0]));
    expect(reader.readLengthPrefixedString()).toBe('');
    expect(reader.remaining()).toBe(0);
  });

  it('throws when the length prefix exceeds what actually remains', () => {
    // length byte claims 5 bytes follow, but only 2 actually remain
    const reader = new MspPayloadReader(Uint8Array.from([5, 0x41, 0x42]));
    expect(() => reader.readLengthPrefixedString()).toThrow(MspPayloadReadError);
  });

  it('throws (rather than reading a garbage length) when even the length-prefix byte itself is missing', () => {
    const reader = new MspPayloadReader(new Uint8Array(0));
    expect(() => reader.readLengthPrefixedString()).toThrow(MspPayloadReadError);
  });
});
