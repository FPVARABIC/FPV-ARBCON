import { MspPayloadReader } from './MspPayloadReader';

export interface MspBeeperConfig {
  /** Bits set here are muted/disabled. */
  readonly disabledMask: number;
  /** 0 disables the beacon; 1..5 select a DShot tone. */
  readonly dshotBeaconTone: number;
  /** Bits set here are disabled DShot beacon conditions. */
  readonly disabledDshotBeaconMask: number;
}

/** Betaflight MSP_BEEPER_CONFIG: u32 + u8 + u32, little-endian. */
export function decodeBeeperConfig(payload: Uint8Array): MspBeeperConfig {
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    disabledMask: reader.readU32LE(),
    dshotBeaconTone: reader.readU8(),
    disabledDshotBeaconMask: reader.readU32LE(),
  });
}
