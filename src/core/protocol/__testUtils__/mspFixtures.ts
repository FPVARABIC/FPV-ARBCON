/**
 * TEST-ONLY frame byte builder.
 *
 * mspEncoder.ts's public encode() is request-only by design (Pass 6.1 review,
 * point 4): production code never needs to construct 'response' or 'error'
 * direction MSP bytes — only mspStreamParser.ts (the decode side) ever sees
 * those. This file exists purely so parser tests can construct valid
 * response/error (and, for convenience, request) byte sequences to feed into
 * ingest().
 *
 * This file lives under __testUtils__/ (not __tests__/, so Jest's default
 * testMatch doesn't pick it up as a test file itself) and is not exported
 * from src/core/protocol/index.ts or src/core/index.ts — it is not reachable
 * from any production import path. It reuses mspChecksum.ts (pure checksum
 * math, not encoder- or decoder-specific) but does not import mspEncoder.ts,
 * so it stays independent of the production encoder's request-only
 * restriction.
 */

import { crc8DvbS2, xorChecksum } from '../mspChecksum';
import type { MspDirection, MspWireFormat } from '../mspTypes';
import { MSP_V2_FRAME_ID } from '../mspTypes';

const DOLLAR = 0x24;
const MAGIC_V1 = 0x4d;
const MAGIC_V2_NATIVE = 0x58;
const JUMBO_SIZE_MARKER = 0xff;
const V2_HEADER_SIZE = 5;

function directionByte(direction: MspDirection): number {
  switch (direction) {
    case 'request':
      return 0x3c; // '<'
    case 'response':
      return 0x3e; // '>'
    case 'error':
      return 0x21; // '!'
  }
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

export interface BuildMspFrameOptions {
  wireFormat: MspWireFormat;
  direction: MspDirection;
  flags?: number;
  /** Force an incorrect trailing checksum byte, for corrupted-checksum tests. */
  corruptChecksum?: boolean;
  /** Force an incorrect inner (v2) CRC8 byte, for v2-over-v1 inner-corruption tests. */
  corruptInnerChecksum?: boolean;
}

/** Builds a complete, well-formed (unless corruptChecksum/corruptInnerChecksum
 * is set) MSP frame's raw bytes, for any of the three wire formats/directions. */
export function buildMspFrameBytes(command: number, payload: Uint8Array, options: BuildMspFrameOptions): Uint8Array {
  const { wireFormat, direction } = options;
  const flags = options.flags ?? 0;
  const dir = directionByte(direction);

  if (wireFormat === 'v1') {
    const dataLen = payload.length;
    const sizeField =
      dataLen >= JUMBO_SIZE_MARKER ? [JUMBO_SIZE_MARKER, command, ...le16(dataLen)] : [dataLen, command];
    const checksummed = concatBytes([sizeField, payload]);
    let checksum = xorChecksum(checksummed);
    if (options.corruptChecksum) checksum ^= 0xff;
    return concatBytes([[DOLLAR, MAGIC_V1, dir], checksummed, [checksum]]);
  }

  if (wireFormat === 'v2') {
    const header = [flags & 0xff, ...le16(command), ...le16(payload.length)];
    let crc = crc8DvbS2(concatBytes([header, payload]));
    if (options.corruptChecksum) crc ^= 0xff;
    return concatBytes([[DOLLAR, MAGIC_V2_NATIVE, dir], header, payload, [crc]]);
  }

  // v2-over-v1
  const header = [flags & 0xff, ...le16(command), ...le16(payload.length)];
  let innerCrc = crc8DvbS2(concatBytes([header, payload]));
  if (options.corruptInnerChecksum) innerCrc ^= 0xff;

  const v1PayloadSize = V2_HEADER_SIZE + payload.length + 1;
  const outerSizeField =
    v1PayloadSize >= JUMBO_SIZE_MARKER
      ? [JUMBO_SIZE_MARKER, MSP_V2_FRAME_ID, ...le16(v1PayloadSize)]
      : [v1PayloadSize, MSP_V2_FRAME_ID];

  const outerChecksummed = concatBytes([outerSizeField, header, payload, [innerCrc]]);
  let outerChecksum = xorChecksum(outerChecksummed);
  if (options.corruptChecksum) outerChecksum ^= 0xff;

  return concatBytes([[DOLLAR, MAGIC_V1, dir], outerChecksummed, [outerChecksum]]);
}

/** Builds raw bytes for a v1-native frame whose outer size byte is the jumbo
 * marker (0xFF) with an explicit extended size that need not match
 * payload.length — for MSP_FRAME_TOO_LARGE / malformed-header edge-case tests
 * that must claim a size larger than the bytes actually supplied. */
export function buildV1JumboSizeOnlyBytes(command: number, declaredExtendedSize: number): Uint8Array {
  return concatBytes([[DOLLAR, MAGIC_V1, 0x3c, JUMBO_SIZE_MARKER, command], le16(declaredExtendedSize)]);
}

/** Builds raw bytes for just an MSP v2 native header declaring a given size,
 * without any payload/CRC bytes — for MSP_FRAME_TOO_LARGE proof tests. */
export function buildV2HeaderOnlyBytes(command: number, flags: number, declaredSize: number): Uint8Array {
  return concatBytes([[DOLLAR, MAGIC_V2_NATIVE, 0x3c, flags & 0xff], le16(command), le16(declaredSize)]);
}

/**
 * Builds raw bytes for a v2-over-v1 frame's OUTER v1 header + INNER v2 header
 * only (no payload, no inner CRC, no outer checksum) — with outerSize and
 * innerDeclaredSize specified INDEPENDENTLY, deliberately allowing them to be
 * inconsistent with each other. buildMspFrameBytes() always derives a
 * self-consistent outerSize from the real payload, so it can't construct the
 * "outer says X, inner header independently says Y" adversarial frames these
 * tests need (outerSize-within-bound-but-inner-too-large; outerSize doesn't
 * match the overhead formula). outerSize uses the real v1 jumbo mechanism
 * automatically once it reaches the 0xFF threshold, exactly like the encoder.
 */
export function buildV2OverV1HeaderOnlyBytes(
  outerSize: number,
  innerCommand: number,
  innerFlags: number,
  innerDeclaredSize: number,
): Uint8Array {
  const outerSizeField =
    outerSize >= JUMBO_SIZE_MARKER ? [JUMBO_SIZE_MARKER, MSP_V2_FRAME_ID, ...le16(outerSize)] : [outerSize, MSP_V2_FRAME_ID];
  const innerHeader = [innerFlags & 0xff, ...le16(innerCommand), ...le16(innerDeclaredSize)];
  return concatBytes([[DOLLAR, MAGIC_V1, 0x3c], outerSizeField, innerHeader]);
}
