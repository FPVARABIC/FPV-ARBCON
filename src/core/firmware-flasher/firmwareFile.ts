import {parseIntelHex} from './intelHex';
import type {IntelHexImage} from './intelHex';

export const MAX_FIRMWARE_FILE_BYTES = 16 * 1024 * 1024;

export type FirmwareKind = 'HEX' | 'UF2' | 'BIN';
export type Uf2Block = {
  readonly targetAddress: number;
  readonly payload: Uint8Array;
  readonly blockNumber: number;
};
export type Uf2Image = {
  readonly blocks: readonly Uf2Block[];
  readonly totalPayloadBytes: number;
  readonly familyId?: number;
  readonly lowestAddress: number;
  readonly highestAddressExclusive: number;
};
export type EspImageInfo = {
  readonly chipId: number;
  readonly segmentCount: number;
  readonly entryPoint: number;
  readonly checksumOffset: number;
  readonly imageBytes: number;
};
export type FirmwareImage =
  | {readonly kind: 'HEX'; readonly filename: string; readonly bytes: Uint8Array; readonly hex: IntelHexImage}
  | {readonly kind: 'UF2'; readonly filename: string; readonly bytes: Uint8Array; readonly uf2: Uf2Image}
  | {readonly kind: 'BIN'; readonly filename: string; readonly bytes: Uint8Array; readonly esp: EspImageInfo};

export class FirmwareFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirmwareFileError';
  }
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000 + bytes[offset + 3] * 0x1000000
  ) >>> 0;
}

function extensionFor(filename: string): FirmwareKind {
  const extension = /\.([^.]+)$/.exec(filename.trim())?.[1].toLowerCase();
  switch (extension) {
    case 'hex': return 'HEX';
    case 'uf2': return 'UF2';
    case 'bin': return 'BIN';
    default: throw new FirmwareFileError('الصيغ المقبولة هي .hex و .uf2 و .bin فقط.');
  }
}

function decodeAscii(bytes: Uint8Array): string {
  for (const byte of bytes) {
    if (!(byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126))) {
      throw new FirmwareFileError('ملف HEX يجب أن يكون نص Intel HEX صالحاً.');
    }
  }
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return text;
}

export function parseUf2(bytes: Uint8Array): Uf2Image {
  if (bytes.length === 0 || bytes.length % 512 !== 0) {
    throw new FirmwareFileError('حجم UF2 يجب أن يكون مضاعفاً صحيحاً لـ 512 بايت.');
  }
  const expectedBlocks = bytes.length / 512;
  const blocks = new Map<number, Uf2Block>();
  let declaredBlocks: number | undefined;
  let familyId: number | undefined;

  for (let offset = 0; offset < bytes.length; offset += 512) {
    if (
      readU32LE(bytes, offset) !== 0x0a324655 ||
      readU32LE(bytes, offset + 4) !== 0x9e5d5157 ||
      readU32LE(bytes, offset + 508) !== 0x0ab16f30
    ) {
      throw new FirmwareFileError(`توقيع UF2 غير صالح في الكتلة ${offset / 512}.`);
    }
    const flags = readU32LE(bytes, offset + 8);
    if ((flags & 0x00000001) !== 0 || (flags & 0x00001000) !== 0) {
      throw new FirmwareFileError('ملف UF2 ليس صورة Firmware لذاكرة المتحكم الرئيسية.');
    }
    const targetAddress = readU32LE(bytes, offset + 12);
    const payloadSize = readU32LE(bytes, offset + 16);
    const blockNumber = readU32LE(bytes, offset + 20);
    const numberOfBlocks = readU32LE(bytes, offset + 24);
    if (payloadSize === 0 || payloadSize > 476) {
      throw new FirmwareFileError(`حجم حمولة UF2 غير صالح في الكتلة ${blockNumber}.`);
    }
    if (numberOfBlocks === 0 || numberOfBlocks !== expectedBlocks || blockNumber >= numberOfBlocks) {
      throw new FirmwareFileError('ترقيم كتل UF2 أو عددها غير متسق مع حجم الملف.');
    }
    if (declaredBlocks !== undefined && declaredBlocks !== numberOfBlocks) {
      throw new FirmwareFileError('كتل UF2 تعلن أعداداً مختلفة للكتل.');
    }
    declaredBlocks = numberOfBlocks;
    if (blocks.has(blockNumber)) {
      throw new FirmwareFileError(`رقم كتلة UF2 مكرر: ${blockNumber}.`);
    }
    const blockFamilyId = readU32LE(bytes, offset + 28);
    if ((flags & 0x00002000) !== 0) {
      if (familyId !== undefined && familyId !== blockFamilyId) {
        throw new FirmwareFileError('معرّف عائلة المتحكم غير متسق بين كتل UF2.');
      }
      familyId = blockFamilyId;
    }
    const endAddress = targetAddress + payloadSize;
    if (!Number.isSafeInteger(endAddress) || endAddress > 0x100000000) {
      throw new FirmwareFileError('عنوان UF2 يتجاوز مجال العنوان 32-bit.');
    }
    blocks.set(blockNumber, {
      targetAddress,
      payload: bytes.slice(offset + 32, offset + 32 + payloadSize),
      blockNumber,
    });
  }

  const ordered = Array.from(blocks.values()).sort((left, right) => left.targetAddress - right.targetAddress);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    if (ordered[index].targetAddress < previous.targetAddress + previous.payload.length) {
      throw new FirmwareFileError('ملف UF2 يحتوي مناطق ذاكرة متداخلة.');
    }
  }
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    blocks: ordered,
    totalPayloadBytes: ordered.reduce((sum, block) => sum + block.payload.length, 0),
    ...(familyId === undefined ? {} : {familyId}),
    lowestAddress: first.targetAddress,
    highestAddressExclusive: last.targetAddress + last.payload.length,
  };
}

export function parseEspImage(bytes: Uint8Array): EspImageInfo {
  if (bytes.length < 32 || bytes[0] !== 0xe9) {
    throw new FirmwareFileError('BIN لا يبدأ بترويسة صورة ESP المدمجة الصحيحة (0xE9).');
  }
  const segmentCount = bytes[1];
  if (segmentCount < 1 || segmentCount > 16) {
    throw new FirmwareFileError('عدد مقاطع صورة ESP خارج المجال الآمن.');
  }
  const entryPoint = readU32LE(bytes, 4);
  const chipId = bytes[12] | (bytes[13] << 8);
  let cursor = 24;
  let checksum = 0xef;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    if (cursor + 8 > bytes.length) {
      throw new FirmwareFileError('ترويسة أحد مقاطع BIN مقطوعة.');
    }
    const length = readU32LE(bytes, cursor + 4);
    cursor += 8;
    if (length === 0 || length > MAX_FIRMWARE_FILE_BYTES || cursor + length > bytes.length) {
      throw new FirmwareFileError('طول أحد مقاطع BIN غير صالح أو يتجاوز الملف.');
    }
    for (let index = cursor; index < cursor + length; index += 1) {
      checksum ^= bytes[index];
    }
    cursor += length;
  }
  const checksumOffset = (Math.floor(cursor / 16) + 1) * 16 - 1;
  if (checksumOffset >= bytes.length || bytes[checksumOffset] !== checksum) {
    throw new FirmwareFileError('Checksum لصورة ESP غير صحيح.');
  }
  return {chipId, segmentCount, entryPoint, checksumOffset, imageBytes: bytes.length};
}

export function parseFirmwareFile(filename: string, input: Uint8Array): FirmwareImage {
  if (!(input instanceof Uint8Array) || input.length === 0) {
    throw new FirmwareFileError('ملف Firmware فارغ.');
  }
  if (input.length > MAX_FIRMWARE_FILE_BYTES) {
    throw new FirmwareFileError(`حجم Firmware يتجاوز الحد الآمن ${MAX_FIRMWARE_FILE_BYTES} بايت.`);
  }
  const bytes = input.slice();
  switch (extensionFor(filename)) {
    case 'HEX': return {kind: 'HEX', filename, bytes, hex: parseIntelHex(decodeAscii(bytes))};
    case 'UF2': return {kind: 'UF2', filename, bytes, uf2: parseUf2(bytes)};
    case 'BIN': return {kind: 'BIN', filename, bytes, esp: parseEspImage(bytes)};
  }
}
