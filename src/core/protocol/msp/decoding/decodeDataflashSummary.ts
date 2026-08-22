import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

/**
 * MSP_DATAFLASH_SUMMARY (70) - the wire read.
 *
 * Layout derived from Betaflight's serializeDataflashSummaryReply() at
 * commit 7348054f268f0058574719c134e9f149565bb8ea (API 1.47), unchanged on
 * master (API 1.49):
 *
 *   offset 0   u8   flags
 *   offset 1   u32  FLASH_PARTITION_SECTOR_COUNT(flashPartition)
 *   offset 5   u32  flashfsGetSize()    - total bytes of the volume
 *   offset 9   u32  flashfsGetOffset()  - bytes currently stored
 *
 * THIRTEEN BYTES, ALL REQUIRED. The no-flash branch of the same function
 * writes the same thirteen bytes as zeros, so a shorter frame is a
 * malformed response rather than an older layout.
 *
 * THE FLAG BITS ARE THE ONLY AUTHORITY ON PRESENCE. Bit 0 is READY and
 * bit 1 is SUPPORTED (the firmware's mspFlashFsFlags_e). A configurator
 * that inferred "there is a flash chip" from a non-zero total size would
 * be reading a consequence instead of the fact: SUPPORTED is
 * flashfsIsSupported(), and READY additionally requires the volume to be
 * idle and the chip to answer - which is exactly the state an erase in
 * progress clears while the sizes stay populated.
 */

/** Payload length the API-1.47 serializer always writes. */
export const DATAFLASH_SUMMARY_PAYLOAD_BYTES = 13;

/** Byte 0, bit 0 - the volume is idle and the chip answers. */
export const DATAFLASH_FLAG_READY = 1;
/** Byte 0, bit 1 - a flash filesystem exists on this board. */
export const DATAFLASH_FLAG_SUPPORTED = 2;

export interface MspDataflashSummary {
  /** Byte 0 verbatim; bits beyond the two modelled ones are preserved. */
  readonly flagsRaw: number;
  /** bit 1. There is a flash filesystem. */
  readonly supported: boolean;
  /** bit 0. It is idle and answering right now. */
  readonly ready: boolean;
  readonly sectorCount: number;
  /** u32 LE, unsigned, bytes. */
  readonly totalBytes: number;
  /** u32 LE, unsigned, bytes currently stored. */
  readonly usedBytes: number;
}

export function decodeDataflashSummary(
  payload: Uint8Array,
): MspDataflashSummary {
  if (payload.length < DATAFLASH_SUMMARY_PAYLOAD_BYTES) {
    throw new MspPayloadReadError(
      `MSP_DATAFLASH_SUMMARY: expected at least ` +
        `${DATAFLASH_SUMMARY_PAYLOAD_BYTES} byte(s), received ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const flagsRaw = reader.readU8();
  return Object.freeze({
    flagsRaw,
    supported: (flagsRaw & DATAFLASH_FLAG_SUPPORTED) !== 0,
    ready: (flagsRaw & DATAFLASH_FLAG_READY) !== 0,
    sectorCount: reader.readU32LE(),
    totalBytes: reader.readU32LE(),
    usedBytes: reader.readU32LE(),
  });
}
