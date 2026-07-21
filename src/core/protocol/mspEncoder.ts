/**
 * Builds outgoing MSP request frames.
 *
 * Byte layouts are mirrored from Betaflight's own `mspSerialEncode()`,
 * src/main/msp/msp_serial.c:
 * https://github.com/betaflight/betaflight/blob/master/src/main/msp/msp_serial.c
 *
 * This module is request-only by design (Pass 6.1 review, point 4): this
 * client library only ever sends MSP requests. Nothing here encodes
 * 'response'/'error' direction frames — those bytes only need to exist as
 * test fixtures for exercising mspStreamParser.ts, and that fixture builder
 * lives strictly under __testUtils__/, never exported from this module or
 * from src/core/protocol/index.ts.
 */

import { crc8DvbS2, xorChecksum } from './mspChecksum';
import {
  MSP_MAX_PAYLOAD_BYTES_DEFAULT,
  MSP_PROTOCOL_SIZE_FIELD_CEILING,
  MSP_V2_FRAME_ID,
  type MspWireFormat,
} from './mspTypes';

const DOLLAR = 0x24; // '$'
const MAGIC_V1 = 0x4d; // 'M'
const MAGIC_V2_NATIVE = 0x58; // 'X'
const DIRECTION_REQUEST = 0x3c; // '<'
const JUMBO_SIZE_MARKER = 0xff;
const V2_HEADER_SIZE = 5; // flags(1) + cmd LE16(2) + size LE16(2)

export interface MspEncodeOptions {
  /** Required, never inferred or defaulted — explicit wire-format selection is a
   * standing architectural decision for this foundation; auto-negotiation is
   * deferred to a later pass. */
  wireFormat: MspWireFormat;
  /** MSP v2 flags byte. Must be omitted or 0 when wireFormat is 'v1' (v1 has no
   * flags byte). Defaults to 0. */
  flags?: number;
  /** Payload size cap, checked before any frame bytes are built. Defaults to
   * MSP_MAX_PAYLOAD_BYTES_DEFAULT. */
  maxPayloadBytes?: number;
}

function concatBytes(chunks: ReadonlyArray<ReadonlyArray<number> | Uint8Array>): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function le16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function assertValidCommand(command: number, maxValue: number): void {
  if (!Number.isInteger(command) || command < 0 || command > maxValue) {
    throw new RangeError(`MSP command ${command} out of range [0, ${maxValue}]`);
  }
}

function assertValidPayloadLength(payload: Uint8Array, maxPayloadBytes: number): void {
  if (payload.length > maxPayloadBytes) {
    throw new RangeError(
      `MSP payload length ${payload.length} exceeds maxPayloadBytes (${maxPayloadBytes})`,
    );
  }
  if (payload.length > MSP_PROTOCOL_SIZE_FIELD_CEILING) {
    throw new RangeError(
      `MSP payload length ${payload.length} exceeds the protocol's own ${MSP_PROTOCOL_SIZE_FIELD_CEILING}-byte size-field ceiling`,
    );
  }
}

function encodeV1Native(command: number, payload: Uint8Array): Uint8Array {
  assertValidCommand(command, 0xff);
  if (command === MSP_V2_FRAME_ID) {
    throw new RangeError(
      `MSP command ${MSP_V2_FRAME_ID} is reserved for MSP v2-over-v1 encapsulation; use wireFormat "v2-over-v1" instead of "v1"`,
    );
  }

  const dataLen = payload.length;
  const sizeField =
    dataLen >= JUMBO_SIZE_MARKER ? [JUMBO_SIZE_MARKER, command, ...le16(dataLen)] : [dataLen, command];

  const checksummed = concatBytes([sizeField, payload]);
  const checksum = xorChecksum(checksummed);

  return concatBytes([[DOLLAR, MAGIC_V1, DIRECTION_REQUEST], checksummed, [checksum]]);
}

function buildV2Header(command: number, flags: number, dataLen: number): number[] {
  assertValidCommand(command, 0xffff);
  return [flags & 0xff, ...le16(command), ...le16(dataLen)];
}

function encodeV2Native(command: number, payload: Uint8Array, flags: number): Uint8Array {
  const header = buildV2Header(command, flags, payload.length);
  const crc = crc8DvbS2(concatBytes([header, payload]));

  return concatBytes([[DOLLAR, MAGIC_V2_NATIVE, DIRECTION_REQUEST], header, payload, [crc]]);
}

function encodeV2OverV1(command: number, payload: Uint8Array, flags: number): Uint8Array {
  const header = buildV2Header(command, flags, payload.length);
  const innerCrc = crc8DvbS2(concatBytes([header, payload]));

  // "V1 payload" for the outer envelope is: v2 header + v2 payload + v2 CRC byte.
  const v1PayloadSize = V2_HEADER_SIZE + payload.length + 1;
  const outerSizeField =
    v1PayloadSize >= JUMBO_SIZE_MARKER
      ? [JUMBO_SIZE_MARKER, MSP_V2_FRAME_ID, ...le16(v1PayloadSize)]
      : [v1PayloadSize, MSP_V2_FRAME_ID];

  const outerChecksummed = concatBytes([outerSizeField, header, payload, [innerCrc]]);
  const outerChecksum = xorChecksum(outerChecksummed);

  return concatBytes([[DOLLAR, MAGIC_V1, DIRECTION_REQUEST], outerChecksummed, [outerChecksum]]);
}

export function encode(command: number, payload: Uint8Array, options: MspEncodeOptions): Uint8Array {
  const { wireFormat } = options;
  const flags = options.flags ?? 0;
  const maxPayloadBytes = options.maxPayloadBytes ?? MSP_MAX_PAYLOAD_BYTES_DEFAULT;

  if (flags !== 0 && wireFormat === 'v1') {
    throw new RangeError('MSP v1 has no flags byte; flags must be 0 (or omitted) for wireFormat "v1"');
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new RangeError(`MSP flags ${flags} out of range [0, 255]`);
  }

  assertValidPayloadLength(payload, maxPayloadBytes);

  switch (wireFormat) {
    case 'v1':
      return encodeV1Native(command, payload);
    case 'v2':
      return encodeV2Native(command, payload, flags);
    case 'v2-over-v1':
      return encodeV2OverV1(command, payload, flags);
    default:
      // wireFormat is a required, non-optional field with no default value.
      // TypeScript rejects an omitted wireFormat at compile time; this branch
      // is the runtime backstop for a plain-JS caller bypassing that check.
      throw new RangeError(`MSP encode() requires an explicit wireFormat; got ${String(wireFormat)}`);
  }
}
