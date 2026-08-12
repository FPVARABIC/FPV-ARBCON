import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

/**
 * RECEIVER P2 - wire decoder for MSP_TX_INFO (187).
 *
 * FIRMWARE FACT, verified verbatim against the pinned Betaflight API 1.47
 * authority (79065c96ba0bb5cdc675e67d7093e05dab8b330e),
 * src/main/msp/msp.c:2164-2176:
 *
 *   case MSP_TX_INFO:
 *       sbufWriteU8(dst, rssiSource);
 *       uint8_t rtcDateTimeIsSet = 0;
 *       ...
 *       sbufWriteU8(dst, rtcDateTimeIsSet);
 *       break;
 *
 * so: offset 0 u8 rssiSource, offset 1 u8 rtcDateTimeIsSet. The command
 * number is msp_protocol.h:230 @ the same pin.
 *
 * WHAT THIS IS NOT. `rssiSource` names WHERE the firmware takes RSSI
 * from; it is not a signal strength, not a percentage, and emphatically
 * not link quality - the pinned firmware serialises no link-quality
 * value through any MSP command (verified by exhaustive grep of msp.c at
 * both 1.47 and 1.48), so none may be displayed.
 *
 * Only the first byte is interpreted. `rtcDateTimeIsSet` concerns the
 * flight controller's real-time clock and has nothing to do with the
 * receiver; it is read past rather than exposed. Trailing bytes beyond
 * offset 1 are permitted and ignored, matching the forward-compatibility
 * posture of decodeBoardInfo/decodeFeatureConfig.
 */
export interface MspTxInfo {
  /** Raw `rssiSource_e` value exactly as the FC reported it. Mapped to a
   * token by receiverRuntimeSemantics.resolveRssiSource(), which owns the
   * enum table; this decoder reports wire truth only and applies no
   * policy. */
  readonly rssiSource: number;
}

export function decodeTxInfo(payload: Uint8Array): MspTxInfo {
  if (payload.length < 2) {
    throw new MspPayloadReadError(
      `MSP_TX_INFO requires 2 bytes; received ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  return Object.freeze({rssiSource: reader.readU8()});
}
