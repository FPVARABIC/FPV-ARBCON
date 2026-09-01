import {decodeBoardInfo} from './decodeBoardInfo';

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

/** The 9 guaranteed-prefix fields every MSP_BOARD_INFO response has,
 * regardless of firmware/API version - see decodeBoardInfo.ts's own doc
 * comment. Total: 4 + 2 + 1 + 1 + pstring("TEST") + pstring("MyBoard") +
 * pstring("MTKS") + 32 + 1 = 4+2+1+1+5+8+5+32+1 = 59 bytes. */
function baseFields(): number[] {
  return [
    ...ascii('AFF3'), // boardIdentifier
    ...u16le(7), // hardwareRevision
    2, // boardType (2 == FC with MAX7456)
    0b01000011, // targetCapabilities (arbitrary bitflags)
    ...pstring('TEST'), // targetName
    ...pstring('MyBoard'), // boardName
    ...pstring('MTKS'), // manufacturerId
    ...new Array(32).fill(0xaa), // signature
    5, // mcuTypeId
  ];
}

describe('decodeBoardInfo - full/minimal/extra optional-field payloads', () => {
  it('decodes a realistic full payload (all 5 optional fields present)', () => {
    const bytes = Uint8Array.from([
      ...baseFields(),
      42, // configurationState
      ...u16le(8000), // gyroSampleRateHz
      ...u32le(0b11), // configurationProblems
      3, // spiRegisteredDeviceCount
      2, // i2cRegisteredDeviceCount
    ]);

    const result = decodeBoardInfo(bytes);

    expect(result.boardIdentifier).toBe('AFF3');
    expect(result.hardwareRevision).toBe(7);
    expect(result.boardType).toBe(2);
    expect(result.targetCapabilities).toBe(0b01000011);
    expect(result.targetName).toBe('TEST');
    expect(result.boardName).toBe('MyBoard');
    expect(result.manufacturerId).toBe('MTKS');
    expect(result.signature).toEqual(new Uint8Array(32).fill(0xaa));
    expect(result.mcuTypeId).toBe(5);
    expect(result.configurationState).toBe(42);
    expect(result.gyroSampleRateHz).toBe(8000);
    expect(result.configurationProblems).toBe(0b11);
    expect(result.spiRegisteredDeviceCount).toBe(3);
    expect(result.i2cRegisteredDeviceCount).toBe(2);
    expect(result.trailingBytes).toEqual(new Uint8Array(0));
  });

  it('decodes a minimal/older-API payload lacking every optional field', () => {
    const bytes = Uint8Array.from(baseFields());

    const result = decodeBoardInfo(bytes);

    expect(result.boardIdentifier).toBe('AFF3');
    expect(result.mcuTypeId).toBe(5);
    expect(result.configurationState).toBeUndefined();
    expect(result.gyroSampleRateHz).toBeUndefined();
    expect(result.configurationProblems).toBeUndefined();
    expect(result.spiRegisteredDeviceCount).toBeUndefined();
    expect(result.i2cRegisteredDeviceCount).toBeUndefined();
    expect(result.trailingBytes).toEqual(new Uint8Array(0));
  });

  it('captures extra trailing bytes beyond every known field, without error', () => {
    const extra = [0xde, 0xad, 0xbe, 0xef, 0x01];
    const bytes = Uint8Array.from([
      ...baseFields(),
      1, // configurationState
      ...u16le(4000), // gyroSampleRateHz
      ...u32le(0), // configurationProblems
      1, // spiRegisteredDeviceCount
      1, // i2cRegisteredDeviceCount
      ...extra, // a hypothetical newer firmware's not-yet-understood fields
    ]);

    const result = decodeBoardInfo(bytes);

    expect(result.spiRegisteredDeviceCount).toBe(1);
    expect(result.i2cRegisteredDeviceCount).toBe(1);
    expect(result.trailingBytes).toEqual(Uint8Array.from(extra));
  });

  it('TOLERATES a payload shorter than the guaranteed prefix, exactly as Betaflight does', () => {
    // This used to assert a throw. The pinned Betaflight Configurator
    // decodes MSP_BOARD_INFO with a reader that returns null past the end
    // (src/js/injected_methods.js) and a handler that reads every field
    // unconditionally (src/js/msp/MSPHelper.js), so a short response makes
    // it connect with partial metadata rather than fail. Throwing here
    // meant refusing a flight controller Betaflight can read, which is the
    // defect this decoder was changed to fix - so the contract, and this
    // test with it, is now tolerance plus an explicit `truncated` fact.
    const bytes = Uint8Array.from(baseFields().slice(0, 3));
    const result = decodeBoardInfo(bytes);
    expect(result.truncated).toBe(true);
    expect(result.boardName).toBe('');
    expect(result.targetName).toBe('');
  });
});

describe('decodeBoardInfo - strict sequential-stop algorithm for optional fields', () => {
  it('stops exactly where the wire data ends: configurationState and gyroSampleRateHz fit, but only 1 of configurationProblems\' 4 bytes remain - that 1 byte becomes trailingBytes, and spiRegisteredDeviceCount/i2cRegisteredDeviceCount are both absent (never "borrowed" from the leftover byte)', () => {
    const bytes = Uint8Array.from([
      ...baseFields(),
      7, // configurationState (1 byte) - fits
      ...u16le(9000), // gyroSampleRateHz (2 bytes) - fits
      0x99, // only 1 of configurationProblems' required 4 bytes
    ]);

    const result = decodeBoardInfo(bytes);

    expect(result.configurationState).toBe(7);
    expect(result.gyroSampleRateHz).toBe(9000);
    expect(result.configurationProblems).toBeUndefined();
    expect(result.spiRegisteredDeviceCount).toBeUndefined();
    expect(result.i2cRegisteredDeviceCount).toBeUndefined();
    expect(result.trailingBytes).toEqual(Uint8Array.from([0x99]));
  });
});
