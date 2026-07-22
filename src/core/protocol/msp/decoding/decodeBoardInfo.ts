import {MspPayloadReader} from './MspPayloadReader';

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_PINNED_COMMIT: `#define BOARD_IDENTIFIER_LENGTH 4`. */
const BOARD_IDENTIFIER_LENGTH = 4;
/** src/main/pg/board.h @ BETAFLIGHT_PINNED_COMMIT: `#define SIGNATURE_LENGTH 32` - not
 * co-located with the other MSP length constants in msp_protocol.h. */
const SIGNATURE_LENGTH = 32;

export interface MspBoardInfo {
  /** Raw 4-character ASCII board identifier. */
  boardIdentifier: string;
  hardwareRevision: number;
  /** msp.c's own comment: 0 = FC, 2 = FC with MAX7456 OSD. Kept as a raw
   * number this pass, per explicit scope decision - see decodeBoardInfo's
   * class-level doc comment below. */
  boardType: number;
  /** Raw bitflags byte (TARGET_HAS_VCP=bit0, TARGET_HAS_SOFTSERIAL=bit1,
   * TARGET_HAS_FLASH_BOOTLOADER=bit3, TARGET_SUPPORTS_RX_BIND=bit6, per
   * msp.c @ BETAFLIGHT_PINNED_COMMIT) - kept as a raw number this pass. */
  targetCapabilities: number;
  targetName: string;
  boardName: string;
  manufacturerId: string;
  signature: Uint8Array;
  mcuTypeId: number;
  /** Present only if the connected firmware's MSP_BOARD_INFO response is
   * long enough to include it - see this file's own doc comment for why
   * "present" is determined purely by remaining byte count, not by a
   * separately-fetched API version number. */
  configurationState?: number;
  gyroSampleRateHz?: number;
  /** Raw bitflags (PROBLEM_ACC_NEEDS_CALIBRATION=bit0,
   * PROBLEM_MOTOR_PROTOCOL_DISABLED=bit1, per msp.c @
   * BETAFLIGHT_PINNED_COMMIT) - kept as a raw number this pass. Unlike its
   * neighbors, msp.c carries no explicit "Added in API version X.Y"
   * comment on this specific field - it is still decoded as its own
   * independently remaining()-gated optional field (see this file's own
   * doc comment), not assumed to share gyroSampleRateHz's 1.43 threshold. */
  configurationProblems?: number;
  spiRegisteredDeviceCount?: number;
  i2cRegisteredDeviceCount?: number;
  /** Every byte left over after every field this decoder currently
   * understands - e.g. a newer firmware's fields this pass's pinned
   * commit doesn't yet know about. Never an error; see this file's own
   * doc comment. */
  trailingBytes: Uint8Array;
}

/**
 * src/main/msp/msp.c, `case MSP_BOARD_INFO:` @ BETAFLIGHT_PINNED_COMMIT
 * (see ../commands/mspCommandSources.ts) - the guaranteed prefix (fields
 * 1-9 below) is written unconditionally by every firmware build that
 * implements MSP_BOARD_INFO at all; fields 10-14 were added to
 * Betaflight's own source across releases (comments cite "Added in API
 * version 1.42/1.43/1.44"), but msp.c contains NO runtime
 * `if (apiVersion >= ...)` check for any of them - the CURRENT firmware
 * always writes all of them. An OLDER connected firmware build simply
 * doesn't have that code at all, so its response is that many bytes
 * shorter - the only way this decoder (or anything else) can detect which
 * optional fields are present is by how many bytes actually arrived.
 *
 * Fields 10-14, in strict wire order, verbatim byte sizes:
 *   10. configurationState        u8  (1 byte)  - "Added in API version 1.42"
 *   11. gyroSampleRateHz          u16 (2 bytes)  - "Added in API version 1.43"
 *   12. configurationProblems     u32 (4 bytes)  - no explicit version comment
 *   13. spiRegisteredDeviceCount  u8  (1 byte)  - "Added in MSP API 1.44"
 *   14. i2cRegisteredDeviceCount  u8  (1 byte)  - same 1.44 group, adjacent
 *
 * Decoding algorithm for fields 10-14 (strict, sequential, never skips
 * ahead): walk them IN WIRE ORDER; for each one, if reader.remaining() is
 * still >= that field's own exact byte size, read it and continue to the
 * next; the FIRST time a field doesn't fully fit (even by one byte),
 * STOP immediately without reading any part of it or attempting any field
 * after it - fields are strictly sequential, so running out mid-way
 * always means every subsequent field is absent too, by construction.
 * Whatever bytes remain at that stopping point (0 if every field fit, or
 * however many partial/leftover bytes are left) become trailingBytes.
 */
export function decodeBoardInfo(payload: Uint8Array): MspBoardInfo {
  const reader = new MspPayloadReader(payload);

  const boardIdentifier = reader.readFixedAscii(BOARD_IDENTIFIER_LENGTH);
  const hardwareRevision = reader.readU16LE();
  const boardType = reader.readU8();
  const targetCapabilities = reader.readU8();
  const targetName = reader.readLengthPrefixedString();
  const boardName = reader.readLengthPrefixedString();
  const manufacturerId = reader.readLengthPrefixedString();
  const signature = reader.readBytes(SIGNATURE_LENGTH);
  const mcuTypeId = reader.readU8();

  const result: MspBoardInfo = {
    boardIdentifier,
    hardwareRevision,
    boardType,
    targetCapabilities,
    targetName,
    boardName,
    manufacturerId,
    signature,
    mcuTypeId,
    trailingBytes: new Uint8Array(0),
  };

  const optionalFields: ReadonlyArray<{sizeBytes: number; read: () => void}> = [
    {sizeBytes: 1, read: () => { result.configurationState = reader.readU8(); }},
    {sizeBytes: 2, read: () => { result.gyroSampleRateHz = reader.readU16LE(); }},
    {sizeBytes: 4, read: () => { result.configurationProblems = reader.readU32LE(); }},
    {sizeBytes: 1, read: () => { result.spiRegisteredDeviceCount = reader.readU8(); }},
    {sizeBytes: 1, read: () => { result.i2cRegisteredDeviceCount = reader.readU8(); }},
  ];

  for (const field of optionalFields) {
    if (reader.remaining() < field.sizeBytes) {
      break;
    }
    field.read();
  }

  result.trailingBytes = reader.readBytes(reader.remaining());
  return result;
}
