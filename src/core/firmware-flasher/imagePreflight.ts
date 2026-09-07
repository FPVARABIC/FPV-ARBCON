/**
 * STAGE A - THE AUTHORITATIVE, DEVICE-INDEPENDENT IMAGE PREFLIGHT.
 *
 * Everything decidable from the firmware image ALONE is decided here,
 * before a port is opened and long before an erase can be emitted. Three of
 * the six confirmed defects were reachable only because these questions
 * were asked - if at all - after the board had already been erased.
 *
 * THIS MUST RUN ON THE FINAL COMPOSED IMAGE. Unified Config is injected by
 * insertCustomDefaults() at flash time, and it appends a segment of
 * arbitrary length, so an image that was well-formed at file-load time can
 * become unwritable afterwards. A preflight that ran at file load would be
 * checking bytes that are not the bytes sent.
 *
 * The accepted snapshot OWNS COPIES of every byte it plans to write.
 * `readonly` is erased at runtime and a Uint8Array subarray is a live view;
 * neither prevents a later mutation of the source image from changing what
 * actually goes on the wire. Copying at acceptance time is what makes the
 * snapshot mean something.
 *
 * Nothing here consults a chip profile. Capacity and page geometry belong
 * to the device stage, behind a supported-part contract this project does
 * not yet have.
 */

import type {IntelHexImage} from './intelHex';
import type {ByteRange} from './byteRange';
import {containsAddress, makeRange, rangesOverlap} from './byteRange';
import type {FlashErrorCode} from './flashErrorCodes';

/**
 * The address this application launches from after a serial flash.
 *
 * It is NOT a field of any chip profile - the profiles carry only
 * flashBytes, pageBytes and a label. It is a policy of this application:
 * the ARM Cortex-M vector-table base at which STM32 internal flash is
 * aliased, which is where this product has always sent GO. It is named and
 * owned here so exactly one place decides it, and so the plan can prove the
 * image actually covers it.
 *
 * The Intel-HEX type-05 start-linear-address record is deliberately NOT
 * used as this value: it describes a reset-handler PC, not a vector-table
 * base. It is carried as diagnostics only.
 */
export const FIXED_APPLICATION_BASE_ADDRESS = 0x08000000;

/** AN3155 write command: at most 256 data bytes per frame. */
export const MAX_WRITE_BLOCK_BYTES = 256;

export interface PlannedWriteBlock {
  readonly range: ByteRange;
  /** An owned copy. Never a view onto the source image. */
  readonly bytes: Uint8Array;
}

export interface ImagePreflightRejection {
  readonly code: FlashErrorCode;
  readonly detail: string;
}

export interface AcceptedImageSnapshot {
  /** The exact ordered write blocks, with owned bytes. */
  readonly blocks: readonly PlannedWriteBlock[];
  /** Sum of block lengths - the ONLY total the progress relay may use. */
  readonly totalBytes: number;
  /** The merged, sorted, non-overlapping regions the image declares. */
  readonly coverage: readonly ByteRange[];
  readonly goPolicy: {readonly kind: 'FIXED_APPLICATION_BASE'; readonly address: number};
  readonly goCoverage: {readonly covered: boolean; readonly contiguousBytesAtGo: number};
  /** HEX type-05, for diagnostics only. Never used as the GO target. */
  readonly declaredEntryPoint?: number;
  /** Highest planned address, exclusive - for the device-stage window check. */
  readonly highestAddressExclusive: number;
  readonly lowestAddress: number;
}

export type ImagePreflightResult =
  | {readonly accepted: true; readonly snapshot: AcceptedImageSnapshot}
  | {readonly accepted: false; readonly rejections: readonly ImagePreflightRejection[]};

/**
 * How many planned bytes run contiguously from `address`, across adjacent
 * blocks. The plan commits only to "at least one byte at GO"; this count is
 * recorded so a future supported-part contract can raise the bar to a full
 * vector-table prefix without redesigning anything.
 */
function contiguousBytesFrom(blocks: readonly PlannedWriteBlock[], address: number): number {
  let cursor = address;
  let total = 0;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const block of blocks) {
      if (containsAddress(block.range, cursor)) {
        const available = block.range.endExclusive - cursor;
        total += available;
        cursor += available;
        progressed = true;
        break;
      }
    }
  }
  return total;
}

/**
 * Runs the authoritative preflight over the FINAL composed image.
 *
 * Every rejection here happens with no transport open, so an image-local
 * fault can never be discovered after the board has been erased.
 */
export function runImagePreflight(image: IntelHexImage): ImagePreflightResult {
  const rejections: ImagePreflightRejection[] = [];
  const coverage: ByteRange[] = [];
  const blocks: PlannedWriteBlock[] = [];

  for (const segment of image.segments) {
    if (segment.data.length === 0) continue;

    const segmentRange = makeRange(segment.address, segment.data.length);
    if (!segmentRange.ok) {
      rejections.push({
        code: 'FLASH_PLAN_ADDRESS_RANGE_INVALID',
        detail: `segment at 0x${segment.address.toString(16)} length ${segment.data.length}: ${segmentRange.rejection}`,
      });
      continue;
    }

    if (segment.address < FIXED_APPLICATION_BASE_ADDRESS) {
      rejections.push({
        code: 'FLASH_PLAN_SEGMENT_BELOW_FLASH_BASE',
        detail: `segment at 0x${segment.address.toString(16)} starts below 0x${FIXED_APPLICATION_BASE_ADDRESS.toString(16)}`,
      });
    }

    /* parseIntelHex already merges contiguous records and rejects
     * overlapping ones, but insertCustomDefaults composes a NEW segment
     * list afterwards, so the invariant is re-proven on what will actually
     * be written rather than assumed from an earlier stage. */
    for (const existing of coverage) {
      if (rangesOverlap(existing, segmentRange.range)) {
        rejections.push({
          code: 'FLASH_PLAN_ADDRESS_RANGE_INVALID',
          detail:
            `segment [0x${segmentRange.range.start.toString(16)}, 0x${segmentRange.range.endExclusive.toString(16)}) ` +
            `overlaps [0x${existing.start.toString(16)}, 0x${existing.endExclusive.toString(16)})`,
        });
      }
    }
    coverage.push(segmentRange.range);

    for (let offset = 0; offset < segment.data.length; offset += MAX_WRITE_BLOCK_BYTES) {
      const length = Math.min(MAX_WRITE_BLOCK_BYTES, segment.data.length - offset);
      const blockRange = makeRange(segment.address + offset, length);
      if (!blockRange.ok) {
        rejections.push({
          code: 'FLASH_PLAN_ADDRESS_RANGE_INVALID',
          detail: `block at 0x${(segment.address + offset).toString(16)} length ${length}: ${blockRange.rejection}`,
        });
        continue;
      }
      if (length > MAX_WRITE_BLOCK_BYTES || length % 4 !== 0) {
        /* AN3155: the write command's actual data length must be a multiple
         * of four and at most 256. Padding is NOT applied - the fill value,
         * the ownership of the added bytes and the capacity headroom all
         * depend on a supported-part contract this project does not have,
         * and inventing any of them would write bytes nobody authorised. */
        rejections.push({
          code: 'FLASH_PLAN_UNENCODABLE_BLOCK',
          detail: `block at 0x${blockRange.range.start.toString(16)} has length ${length}`,
        });
      }
      blocks.push({
        range: blockRange.range,
        /* OWNED COPY - the constructor form that allocates, not subarray. */
        bytes: new Uint8Array(segment.data.subarray(offset, offset + length)),
      });
    }
  }

  if (blocks.length === 0) {
    rejections.push({
      code: 'FLASH_PLAN_ADDRESS_RANGE_INVALID',
      detail: 'the composed image declares no writable bytes',
    });
  }

  const goAddress = FIXED_APPLICATION_BASE_ADDRESS;
  const contiguousBytesAtGo = contiguousBytesFrom(blocks, goAddress);
  const covered = contiguousBytesAtGo > 0;
  if (!covered) {
    rejections.push({
      code: 'FLASH_PLAN_GO_NOT_COVERED',
      detail: `0x${goAddress.toString(16)} is not covered by the planned bytes`,
    });
  }

  if (rejections.length > 0) return {accepted: false, rejections};

  const totalBytes = blocks.reduce((sum, block) => sum + block.bytes.length, 0);
  return {
    accepted: true,
    snapshot: {
      blocks,
      totalBytes,
      coverage,
      goPolicy: {kind: 'FIXED_APPLICATION_BASE', address: goAddress},
      goCoverage: {covered, contiguousBytesAtGo},
      ...(image.entryPoint === undefined ? {} : {declaredEntryPoint: image.entryPoint}),
      highestAddressExclusive: coverage.reduce(
        (highest, range) => Math.max(highest, range.endExclusive),
        FIXED_APPLICATION_BASE_ADDRESS,
      ),
      lowestAddress: coverage.reduce(
        (lowest, range) => Math.min(lowest, range.start),
        Number.MAX_SAFE_INTEGER,
      ),
    },
  };
}
