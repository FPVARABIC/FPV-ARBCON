import {MspPayloadReader} from './MspPayloadReader';

/**
 * Pass 7.6a - wire decoder for MSP_BATTERY_STATE (130), verified verbatim
 * against src/main/msp/msp.c `case MSP_BATTERY_STATE:` @
 * BETAFLIGHT_PINNED_COMMIT (see ../commands/mspCommandSources.ts for the
 * full citation record, including the cross-version guarantee that every
 * Betaflight API version this app accepts - >= 1.42 - emits the identical
 * 11-byte little-endian layout):
 *
 *   offset 0  u8   cell count ("0 indicates battery not detected.")
 *   offset 1  u16  CONFIGURED battery capacity, mAh (configuration, NOT
 *                  remaining capacity)
 *   offset 3  u8   legacy voltage, 0.1V steps - saturates at 25.5V,
 *                  compatibility-only; never canonical
 *   offset 4  u16  consumed capacity (mAh drawn)
 *   offset 6  s16  current, 0.01A steps - genuinely SIGNED two's
 *                  complement ("range is -320A to 320A"); sbufWriteU16 is
 *                  only the byte-writing primitive's name, exactly the
 *                  MSP_ATTITUDE lesson (decodeAttitude.ts)
 *   offset 8  u8   firmware batteryState_e (raw enum value - NOT
 *                  interpreted here; see batteryTelemetry.ts)
 *   offset 9  u16  voltage, 0.01V steps - the canonical voltage field
 *
 * All 11 bytes are REQUIRED (every accepted firmware version writes them
 * unconditionally - a shorter payload is corruption/truncation and throws
 * MspPayloadReadError via the reader's own bounds check). Trailing bytes
 * beyond offset 10 are permitted and ignored, matching decodeBoardInfo's
 * established forward-compatibility posture.
 *
 * This decoder reports WIRE TRUTH only: raw zeros stay zeros, the enum
 * byte stays numeric, and no availability/health/threshold semantics are
 * applied here - that separation lives in src/core/state/batteryTelemetry.ts.
 */
export interface MspBatteryState {
  /** u8. Firmware meaning (verified encoder comment): 0 indicates
   * battery not detected. */
  cellCount: number;
  /** u16, mAh. The CONFIGURED capacity - configuration data, never a
   * remaining-capacity measurement. */
  configuredCapacityMah: number;
  /** u8, 0.1V steps, saturates at 255 (25.5V) - compatibility-only. */
  legacyVoltageDecivolts: number;
  /** u16, mAh drawn from the battery. */
  consumedMah: number;
  /** SIGNED 16-bit, 0.01A steps (negative = charging/regenerative). */
  amperageCentiamps: number;
  /** u8 - raw batteryState_e value, deliberately uninterpreted here. */
  batteryStateRaw: number;
  /** u16, 0.01V steps - the canonical voltage field. */
  voltageCentivolts: number;
}

export function decodeBatteryState(payload: Uint8Array): MspBatteryState {
  const reader = new MspPayloadReader(payload);
  return {
    cellCount: reader.readU8(),
    configuredCapacityMah: reader.readU16LE(),
    legacyVoltageDecivolts: reader.readU8(),
    consumedMah: reader.readU16LE(),
    amperageCentiamps: reader.readS16LE(),
    batteryStateRaw: reader.readU8(),
    voltageCentivolts: reader.readU16LE(),
  };
}
