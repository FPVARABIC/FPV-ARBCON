/**
 * MSP_COMPASS_CONFIG (133) - magnetic declination, and nothing else.
 *
 * THE PAYLOAD, from the API-1.47 serializer at firmware revision
 * 7348054f268f0058574719c134e9f149565bb8ea (src/main/msp/msp.c, case
 * MSP_COMPASS_CONFIG):
 *
 *     sbufWriteU16(dst, imuConfig()->mag_declination);
 *
 * Two bytes. One field. The command is named for the compass but carries
 * no hardware selection, no alignment and no calibration state - those
 * are MSP_SENSOR_CONFIG, MSP_SENSOR_ALIGNMENT and MSP_MAG_CALIBRATION
 * respectively. A decoder that offered more here would be offering
 * fields the board never sent.
 *
 * TENTHS OF A DEGREE, SIGNED. `imuConfig_t` declares
 * `int16_t mag_declination; // Magnetic declination in degrees * 10`
 * (src/main/flight/imu.h), and the CLI bounds it at
 * `VAR_INT16 | MASTER_VALUE, .config.minmax = { -300, 300 }`
 * (src/main/cli/settings.c) - that is +/-30.0 degrees, which comfortably
 * covers the real range of magnetic declination on Earth. Read unsigned,
 * a western declination of -5.0 degrees comes back as 6548.6.
 *
 * NO DEGREES HERE. The reference client divides by ten inside its parser
 * and carries a float from there on. This decoder does not. The wire unit
 * is a signed tenth of a degree and an integer; dividing at the wire
 * layer loses the exact value the board holds and puts a float where a
 * frame has to be rebuilt from later. Whoever displays it can divide.
 *
 * TWO BYTES AT MINIMUM. More are recorded and ignored so a firmware that
 * appends a field still yields a correct declination.
 */

import {MspPayloadReader, MspPayloadReadError} from './MspPayloadReader';

export const COMPASS_CONFIG_PAYLOAD_BYTES = 2;

export interface CompassConfig {
  /** Signed tenths of a degree, exactly as the wire carries it. */
  readonly magDeclinationDecidegrees: number;
  /** Bytes past the second, if a newer firmware appended any. */
  readonly trailingByteCount: number;
}

export function decodeCompassConfig(payload: Uint8Array): CompassConfig {
  if (payload.length < COMPASS_CONFIG_PAYLOAD_BYTES) {
    throw new MspPayloadReadError(
      `MSP_COMPASS_CONFIG needs ${COMPASS_CONFIG_PAYLOAD_BYTES} bytes (mag_declination); ` +
        `received ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const magDeclinationDecidegrees = reader.readS16LE();
  return Object.freeze({
    magDeclinationDecidegrees,
    trailingByteCount: reader.remaining(),
  });
}
