import type {CarriesOperatorMessage, OperatorMessage} from './operatorMessage';

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

export class IntelHexError extends Error implements Partial<CarriesOperatorMessage> {
  /**
   * The catalogue key for the operator line. `message` stays the diagnostic
   * sentence so logs and reports are unchanged; only the trust decision
   * moved, from "does this text look Arabic" to "did this application name
   * a reviewed string".
   */
  readonly operatorMessage?: OperatorMessage;

  constructor(message: string, operatorMessage?: OperatorMessage) {
    super(message);
    this.name = 'IntelHexError';
    this.operatorMessage = operatorMessage;
  }
}

function parseHexByte(text: string, lineNumber: number): number {
  if (!/^[0-9a-fA-F]{2}$/.test(text)) {
    throw new IntelHexError(`Lijn HEX nummer ${lineNumber} bevat een niet-hexagenaire waarde.`, {key: 'intelHex.e01', values: {v0: lineNumber}});
  }
  return Number.parseInt(text, 16);
}

function checkedAddress(value: number, lineNumber: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new IntelHexError(`Een buiten het domein adres in de rij HEX nummer ${lineNumber}.`, {key: 'intelHex.e02', values: {v0: lineNumber}});
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
      throw new IntelHexError(`Er zijn gegevens na het eindregister van het bestand in de rij ${lineNumber}.`, {key: 'intelHex.e03', values: {v0: lineNumber}});
    }
    if (!line.startsWith(':') || line.length < 11 || (line.length - 1) % 2 !== 0) {
      throw new IntelHexError(`Intel HEX is niet geldig in de ${lineNumber}-lijn.`, {key: 'intelHex.e04', values: {v0: lineNumber}});
    }

    const encoded = line.slice(1);
    const bytes = new Uint8Array(encoded.length / 2);
    for (let offset = 0; offset < encoded.length; offset += 2) {
      bytes[offset / 2] = parseHexByte(encoded.slice(offset, offset + 2), lineNumber);
    }
    const byteCount = bytes[0];
    if (bytes.length !== byteCount + 5) {
      throw new IntelHexError(`Intel HEX record lengte niet overeenkomt met de inhoud van de ${lineNumber} lijn.`, {key: 'intelHex.e05', values: {v0: lineNumber}});
    }
    let checksum = 0;
    for (const byte of bytes) {
      checksum = (checksum + byte) & 0xff;
    }
    if (checksum !== 0) {
      throw new IntelHexError(`Checksum is niet geldig op lijn HEX nummer ${lineNumber}.`, {key: 'intelHex.e06', values: {v0: lineNumber}});
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
          throw new IntelHexError(`Register het eind van een ongeldig bestand in de rij ${lineNumber}.`, {key: 'intelHex.e07', values: {v0: lineNumber}});
        }
        sawEndOfFile = true;
        break;
      case 0x02:
        if (byteCount !== 2 || relativeAddress !== 0) {
          throw new IntelHexError(`Schrijf een niet geldig snippet in de rij ${lineNumber}.`, {key: 'intelHex.e08', values: {v0: lineNumber}});
        }
        baseAddress = ((data[0] << 8) | data[1]) << 4;
        break;
      case 0x03:
        if (byteCount !== 4 || relativeAddress !== 0) {
          throw new IntelHexError(`${lineNumber} is een niet geldige start.`, {key: 'intelHex.e09', values: {v0: lineNumber}});
        }
        entryPoint = checkedAddress(
          (((data[0] << 8) | data[1]) << 4) + ((data[2] << 8) | data[3]),
          lineNumber,
        );
        break;
      case 0x04:
        if (byteCount !== 2 || relativeAddress !== 0) {
          throw new IntelHexError(`Schrijf een ongeldig lijnadres in op de rij ${lineNumber}.`, {key: 'intelHex.e10', values: {v0: lineNumber}});
        }
        baseAddress = ((data[0] << 8) | data[1]) * 0x10000;
        break;
      case 0x05:
        if (byteCount !== 4 || relativeAddress !== 0) {
          throw new IntelHexError(`Begin met een ongeldige lijn in lijn ${lineNumber}.`, {key: 'intelHex.e11', values: {v0: lineNumber}});
        }
        entryPoint = checkedAddress(
          data[0] * 0x1000000 + data[1] * 0x10000 + data[2] * 0x100 + data[3],
          lineNumber,
        );
        break;
      default:
        throw new IntelHexError(
          `Intel HEX niet-ondersteunde recordtype (0x${recordType.toString(16)}) in de rij ${lineNumber}.`,
          {key: 'intelHex.e15', values: {v0: recordType.toString(16), v1: lineNumber}},
        );
    }
  }

  if (!sawEndOfFile) {
    throw new IntelHexError("Intel HEX heeft geen eindregister.", {key: 'intelHex.e12'});
  }
  if (records.length === 0) {
    throw new IntelHexError("Intel HEX heeft geen Firmware.-gegevens.", {key: 'intelHex.e13'});
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
        throw new IntelHexError("Het Intel HEX bestand bevat overlappende geheugengebieden.", {key: 'intelHex.e14'});
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
