import {MspPayloadReader} from './MspPayloadReader';

/**
 * Pass 7.6c - wire decoder for MSP_ANALOG (110), verified DIRECTLY at
 * the immutable API-1.47 authority (release 2025.12.5, commit
 * BETAFLIGHT_API147_COMMIT, msp.c:764-770 - the API version the bench
 * reports; matching reads at API 1.46/1.48 are secondary regression
 * comparisons only, never proof of 1.47 - see mspCommandSources.ts).
 * Exactly 9 mandatory little-endian bytes:
 *
 *   offset 0  u8   legacy vbat, 0.1V (saturates at 25.5V)
 *   offset 1  u16  mAh drawn
 *   offset 3  u16  RSSI - getRssi(), range 0..1023 (RSSI_MAX_VALUE,
 *                  rx/rx.h:188 @ 2025.12.5). RSSI, NOT link quality.
 *   offset 5  s16  amperage, 0.01A (signed two's complement)
 *   offset 7  u16  vbat, 0.01V
 *
 * All 9 bytes required; trailing bytes permitted and ignored. ONLY the
 * RSSI field feeds the Receiver card - the duplicate battery/current
 * fields are decoded for structural integrity but must never replace or
 * reinterpret the MSP_BATTERY_STATE channel (Pass 7.6b preservation
 * rule); they are still exposed raw for diagnostics-grade completeness.
 */
export interface MspAnalog {
  legacyVoltageDecivolts: number;
  consumedMah: number;
  /** 0..1023 (RSSI_MAX_VALUE). 0 is ambiguous on the wire: no configured
   * RSSI source and a genuine zero-signal reading are indistinguishable
   * by this command alone - see auxTelemetrySemantics.ts. */
  rssi: number;
  amperageCentiamps: number;
  voltageCentivolts: number;
}

export function decodeAnalog(payload: Uint8Array): MspAnalog {
  const reader = new MspPayloadReader(payload);
  return {
    legacyVoltageDecivolts: reader.readU8(),
    consumedMah: reader.readU16LE(),
    rssi: reader.readU16LE(),
    amperageCentiamps: reader.readS16LE(),
    voltageCentivolts: reader.readU16LE(),
  };
}
