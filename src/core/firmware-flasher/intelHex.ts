export type IntelHexSegment = {
  readonly address: number;
  readonly data: Uint8Array;
};

export type IntelHexImage = {
  readonly segments: readonly IntelHexSegment[];
  readonly totalBytes: number;
  readonly lowestAddress: number;
  readonly highestAddressExclusive: number;
  readonly entryPoint?: number;
};

export class IntelHexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntelHexError';
  }
}

function parseHexByte(text: string, lineNumber: number): number {
  if (!/^[0-9a-fA-F]{2}$/.test(text)) {
    throw new IntelHexError(`سطر HEX رقم ${lineNumber} يحتوي قيمة غير سداسية.`);
  }
  return Number.parseInt(text, 16);
}

function checkedAddress(value: number, lineNumber: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new IntelHexError(`عنوان خارج المجال في سطر HEX رقم ${lineNumber}.`);
  }
  return value;
}

/** Strict Intel HEX parser shared by the DFU and STM32-ROM paths. */
export function parseIntelHex(source: string): IntelHexImage {
  const records: IntelHexSegment[] = [];
  let baseAddress = 0;
  let entryPoint: number | undefined;
  let sawEndOfFile = false;

  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (line.length === 0) {
      continue;
    }
    if (sawEndOfFile) {
      throw new IntelHexError(`توجد بيانات بعد سجل نهاية الملف في السطر ${lineNumber}.`);
    }
    if (!line.startsWith(':') || line.length < 11 || (line.length - 1) % 2 !== 0) {
      throw new IntelHexError(`بنية Intel HEX غير صالحة في السطر ${lineNumber}.`);
    }

    const encoded = line.slice(1);
    const bytes = new Uint8Array(encoded.length / 2);
    for (let offset = 0; offset < encoded.length; offset += 2) {
      bytes[offset / 2] = parseHexByte(encoded.slice(offset, offset + 2), lineNumber);
    }
    const byteCount = bytes[0];
    if (bytes.length !== byteCount + 5) {
      throw new IntelHexError(`طول سجل Intel HEX لا يطابق محتواه في السطر ${lineNumber}.`);
    }
    let checksum = 0;
    for (const byte of bytes) {
      checksum = (checksum + byte) & 0xff;
    }
    if (checksum !== 0) {
      throw new IntelHexError(`Checksum غير صحيح في سطر HEX رقم ${lineNumber}.`);
    }

    const relativeAddress = (bytes[1] << 8) | bytes[2];
    const recordType = bytes[3];
    const data = bytes.slice(4, 4 + byteCount);
    switch (recordType) {
      case 0x00: {
        const address = checkedAddress(baseAddress + relativeAddress, lineNumber);
        checkedAddress(address + data.length - (data.length === 0 ? 0 : 1), lineNumber);
        if (data.length > 0) {
          records.push({address, data});
        }
        break;
      }
      case 0x01:
        if (byteCount !== 0 || relativeAddress !== 0) {
          throw new IntelHexError(`سجل نهاية ملف غير صالح في السطر ${lineNumber}.`);
        }
        sawEndOfFile = true;
        break;
      case 0x02:
        if (byteCount !== 2 || relativeAddress !== 0) {
          throw new IntelHexError(`سجل عنوان مقطعي غير صالح في السطر ${lineNumber}.`);
        }
        baseAddress = ((data[0] << 8) | data[1]) << 4;
        break;
      case 0x03:
        if (byteCount !== 4 || relativeAddress !== 0) {
          throw new IntelHexError(`سجل بدء مقطعي غير صالح في السطر ${lineNumber}.`);
        }
        entryPoint = checkedAddress(
          (((data[0] << 8) | data[1]) << 4) + ((data[2] << 8) | data[3]),
          lineNumber,
        );
        break;
      case 0x04:
        if (byteCount !== 2 || relativeAddress !== 0) {
          throw new IntelHexError(`سجل عنوان خطي غير صالح في السطر ${lineNumber}.`);
        }
        baseAddress = ((data[0] << 8) | data[1]) * 0x10000;
        break;
      case 0x05:
        if (byteCount !== 4 || relativeAddress !== 0) {
          throw new IntelHexError(`سجل بدء خطي غير صالح في السطر ${lineNumber}.`);
        }
        entryPoint = checkedAddress(
          data[0] * 0x1000000 + data[1] * 0x10000 + data[2] * 0x100 + data[3],
          lineNumber,
        );
        break;
      default:
        throw new IntelHexError(
          `نوع سجل Intel HEX غير مدعوم (0x${recordType.toString(16)}) في السطر ${lineNumber}.`,
        );
    }
  }

  if (!sawEndOfFile) {
    throw new IntelHexError('ملف Intel HEX لا يحتوي سجل نهاية الملف.');
  }
  if (records.length === 0) {
    throw new IntelHexError('ملف Intel HEX لا يحتوي بيانات Firmware.');
  }

  records.sort((left, right) => left.address - right.address);
  const merged: IntelHexSegment[] = [];
  let groupStart = 0;
  while (groupStart < records.length) {
    let groupEnd = groupStart + 1;
    let groupBytes = records[groupStart].data.length;
    let endAddress = records[groupStart].address + records[groupStart].data.length;
    while (groupEnd < records.length) {
      const next = records[groupEnd];
      if (next.address < endAddress) {
        throw new IntelHexError('ملف Intel HEX يحتوي مناطق ذاكرة متداخلة.');
      }
      if (next.address !== endAddress) break;
      groupBytes += next.data.length;
      endAddress += next.data.length;
      groupEnd += 1;
    }
    // Allocate each contiguous region exactly once. Appending record by
    // record would copy the full prefix repeatedly (quadratic on normal
    // 16-byte HEX records) and could freeze the UI on ordinary FC images.
    const data = new Uint8Array(groupBytes);
    let outputOffset = 0;
    for (let index = groupStart; index < groupEnd; index += 1) {
      data.set(records[index].data, outputOffset);
      outputOffset += records[index].data.length;
    }
    merged.push({address: records[groupStart].address, data});
    groupStart = groupEnd;
  }

  const totalBytes = merged.reduce((sum, segment) => sum + segment.data.length, 0);
  const final = merged[merged.length - 1];
  return {
    segments: merged,
    totalBytes,
    lowestAddress: merged[0].address,
    highestAddressExclusive: final.address + final.data.length,
    ...(entryPoint === undefined ? {} : {entryPoint}),
  };
}
