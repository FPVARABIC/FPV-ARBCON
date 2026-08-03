import {FirmwareFileError, parseEspImage, parseFirmwareFile, parseUf2} from './firmwareFile';

function setU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function uf2Block(blockNumber = 0, blocks = 1, address = 0x10000000): Uint8Array {
  const bytes = new Uint8Array(512);
  setU32(bytes, 0, 0x0a324655);
  setU32(bytes, 4, 0x9e5d5157);
  setU32(bytes, 8, 0x2000);
  setU32(bytes, 12, address);
  setU32(bytes, 16, 4);
  setU32(bytes, 20, blockNumber);
  setU32(bytes, 24, blocks);
  setU32(bytes, 28, 0xe48bff56);
  bytes.set([1, 2, 3, 4], 32);
  setU32(bytes, 508, 0x0ab16f30);
  return bytes;
}

function espImage(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes[0] = 0xe9;
  bytes[1] = 1;
  setU32(bytes, 4, 0x40000000);
  bytes[12] = 9;
  setU32(bytes, 24, 0x3f400020);
  setU32(bytes, 28, 3);
  bytes.set([1, 2, 3], 32);
  bytes[47] = 0xef ^ 1 ^ 2 ^ 3;
  return bytes;
}

describe('firmware file validation', () => {
  it('validates and describes a UF2 image', () => {
    const parsed = parseUf2(uf2Block());
    expect(parsed.familyId).toBe(0xe48bff56);
    expect(parsed.totalPayloadBytes).toBe(4);
    expect(parsed.lowestAddress).toBe(0x10000000);
  });

  it('rejects malformed UF2 block counts, signatures, and overlapping targets', () => {
    expect(() => parseUf2(new Uint8Array(511))).toThrow(FirmwareFileError);
    const badCount = uf2Block(0, 2);
    expect(() => parseUf2(badCount)).toThrow(/ترقيم/);
    const combined = new Uint8Array(1024);
    combined.set(uf2Block(0, 2), 0);
    combined.set(uf2Block(1, 2, 0x10000002), 512);
    expect(() => parseUf2(combined)).toThrow(/متداخلة/);
  });

  it('validates the ESP header, segments, and aligned checksum', () => {
    expect(parseEspImage(espImage())).toMatchObject({segmentCount: 1, chipId: 9, checksumOffset: 47});
    const corrupt = espImage();
    corrupt[47] ^= 0xff;
    expect(() => parseEspImage(corrupt)).toThrow(/Checksum/);
    const truncated = espImage().slice(0, 30);
    expect(() => parseEspImage(truncated)).toThrow();
  });

  it('uses the exact filename extension and copies caller-owned bytes', () => {
    const bytes = espImage();
    const parsed = parseFirmwareFile('BETAFPV.BIN', bytes);
    bytes[0] = 0;
    expect(parsed.kind).toBe('BIN');
    expect(parsed.bytes[0]).toBe(0xe9);
    expect(() => parseFirmwareFile('firmware.bin.txt', espImage())).toThrow(/الصيغ/);
  });
});
