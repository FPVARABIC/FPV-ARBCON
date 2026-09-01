import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

/**
 * MSP_SDCARD_SUMMARY (79) - the wire read.
 *
 * Layout derived from Betaflight's serializeSDCardSummaryReply() at commit
 * 7348054f268f0058574719c134e9f149565bb8ea (API 1.47), unchanged on master
 * (API 1.49):
 *
 *   offset 0   u8   flags
 *   offset 1   u8   merged card + filesystem state
 *   offset 2   u8   afatfs_getLastError()
 *   offset 3   u32  free space, KILOBYTES
 *   offset 7   u32  total space, KILOBYTES
 *
 * ELEVEN BYTES, ALL REQUIRED.
 *
 * FLAG BIT 0 IS "CONFIGURED", NOT "CARD PRESENT". The firmware sets it
 * from sdcardConfig()->mode != SDCARD_MODE_NONE - that is, this board has
 * an SD slot wired up as a logging destination. Whether a card is in it is
 * the STATE byte's job, and the two are routinely different: a configured
 * slot with no card reports flags=1 with state=0.
 *
 * THE CAPACITIES ARE WRITTEN ONLY IN THE READY STATE. Every other state
 * leaves the firmware's local freeSpace/totalSpace at their initial zero,
 * so a zero here is "not measured", never "zero kilobytes". This decoder
 * reports the bytes as they arrived; deciding when they may be shown is
 * blackboxStorageSemantics.ts's job, and it is the whole reason that
 * module exists.
 */

/** Payload length the API-1.47 serializer always writes. */
export const SDCARD_SUMMARY_PAYLOAD_BYTES = 11;

/** Byte 0, bit 0 - an SD slot is configured as a logging destination. */
export const SDCARD_FLAG_CONFIGURED = 1;

export interface MspSdcardSummary {
  /** Byte 0 verbatim. */
  readonly flagsRaw: number;
  /** bit 0. The slot is configured - it says nothing about a card. */
  readonly configured: boolean;
  /** u8, raw merged state. Mapped by the semantic layer, never here. */
  readonly stateRaw: number;
  /** u8, afatfs_getLastError(). Opaque to us; carried verbatim. */
  readonly filesystemLastError: number;
  /** u32 LE, unsigned, KILOBYTES. Meaningful only in the READY state. */
  readonly freeKilobytes: number;
  /** u32 LE, unsigned, KILOBYTES. Meaningful only in the READY state. */
  readonly totalKilobytes: number;
}

export function decodeSdcardSummary(payload: Uint8Array): MspSdcardSummary {
  if (payload.length < SDCARD_SUMMARY_PAYLOAD_BYTES) {
    throw new MspPayloadReadError(
      `MSP_SDCARD_SUMMARY: expected at least ${SDCARD_SUMMARY_PAYLOAD_BYTES} ` +
        `byte(s), received ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const flagsRaw = reader.readU8();
  return Object.freeze({
    flagsRaw,
    configured: (flagsRaw & SDCARD_FLAG_CONFIGURED) !== 0,
    stateRaw: reader.readU8(),
    filesystemLastError: reader.readU8(),
    freeKilobytes: reader.readU32LE(),
    totalKilobytes: reader.readU32LE(),
  });
}
