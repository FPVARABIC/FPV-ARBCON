/**
 * MSP_ACC_TRIM (240) - the accelerometer angle trim.
 *
 * THE PAYLOAD, from the API-1.47 serializer at firmware revision
 * 7348054f268f0058574719c134e9f149565bb8ea (src/main/msp/msp.c, case
 * MSP_ACC_TRIM):
 *
 *     sbufWriteU16(dst, accelerometerConfig()->accelerometerTrims.values.pitch);
 *     sbufWriteU16(dst, accelerometerConfig()->accelerometerTrims.values.roll);
 *
 * PITCH FIRST. ROLL SECOND.
 *
 * That ordering is worth a paragraph because the struct it comes from
 * declares them the other way round. `flightDynamicsTrims_def_t`
 * (src/main/sensors/sensors.h) is `{ int16_t roll; int16_t pitch; int16_t
 * yaw; int16_t calibrationCompleted; }` - roll is the first MEMBER, but
 * the MSP handler names the fields explicitly and writes pitch first. The
 * reference client reads it the same way and annotates each line
 * ("// pitch", "// roll"). Anyone who transcribes the struct order into a
 * decoder swaps a drone's trim axes.
 *
 * SIGNED, DESPITE `sbufWriteU16`. That function is the byte-writing
 * primitive, not a claim about the value. The stored type is `int16_t`
 * and the CLI declares both settings as
 * `VAR_INT16 | MASTER_VALUE` with `.config.minmax = { -300, 300 }`
 * (src/main/cli/settings.c, `acc_trim_pitch` and `acc_trim_roll`). Read
 * unsigned, a trim of -100 comes back as 65436.
 *
 * NO UNITS ARE INVENTED HERE. The wire carries two integers; what a unit
 * of trim corresponds to is a presentation question, and converting it
 * inside a decoder would put a derived number where a measured one
 * belongs.
 *
 * READ-FORWARD-COMPATIBLE. Four bytes are required; more are recorded and
 * ignored so a firmware that appends a third axis still yields correct
 * pitch and roll instead of failing. Fewer than four is a truncation and
 * is refused - a missing roll is not a roll of zero, and zero is a
 * perfectly plausible-looking trim that would be quietly wrong.
 */

import {MspPayloadReader, MspPayloadReadError} from './MspPayloadReader';

export const ACC_TRIM_PAYLOAD_BYTES = 4;

export interface AccTrim {
  /** Wire field 0. Signed. */
  readonly pitch: number;
  /** Wire field 1. Signed. */
  readonly roll: number;
  /** Bytes past the fourth, if a newer firmware appended any. */
  readonly trailingByteCount: number;
}

export function decodeAccTrim(payload: Uint8Array): AccTrim {
  if (payload.length < ACC_TRIM_PAYLOAD_BYTES) {
    throw new MspPayloadReadError(
      `MSP_ACC_TRIM needs ${ACC_TRIM_PAYLOAD_BYTES} bytes (pitch, roll); received ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const pitch = reader.readS16LE();
  const roll = reader.readS16LE();
  return Object.freeze({pitch, roll, trailingByteCount: reader.remaining()});
}
