/**
 * MSP_SET_COMPASS_CONFIG (224) - writing the magnetic declination.
 *
 * THE PAYLOAD, from the firmware handler at revision
 * 7348054f268f0058574719c134e9f149565bb8ea (src/main/msp/msp.c, case
 * MSP_SET_COMPASS_CONFIG):
 *
 *     imuConfigMutable()->mag_declination = sbufReadU16(src);
 *
 * Two bytes, one field, mirroring the read exactly.
 *
 * THE HANDLER DOES NOT CLAMP. It assigns whatever 16-bit value arrives.
 * The `{ -300, 300 }` range is declared only in the CLI's settings table
 * (src/main/cli/settings.c, PARAM_NAME_IMU_MAG_DECLINATION), so a frame
 * carrying 20000 is accepted and stored by the board. Refusing it here
 * means the app cannot ask a flight controller to believe magnetic north
 * is somewhere it is not.
 *
 * TENTHS OF A DEGREE, AND ONLY TENTHS. This function takes an integer
 * number of decidegrees because that is what the field is. It does not
 * take degrees and multiply: a degrees-in, rounding-inside API is exactly
 * how 4.55 degrees becomes 45 decidegrees on one platform and 46 on
 * another, and the operator never learns which value the board stored.
 *
 * `setInt16` RATHER THAN `setUint16`, because western declinations are
 * negative and are the ordinary case for half the planet.
 *
 * NO SENDER. Nothing in this pass calls this function.
 */

export const COMPASS_CONFIG_WRITE_BYTES = 2;

/** From PARAM_NAME_IMU_MAG_DECLINATION in src/main/cli/settings.c:
 *  +/-300 decidegrees, i.e. +/-30.0 degrees. */
export const MAG_DECLINATION_DECIDEGREE_LIMIT = 300;

export interface CompassConfigWrite {
  readonly magDeclinationDecidegrees: number;
}

export function encodeCompassConfig(write: CompassConfigWrite): Uint8Array {
  const value = write.magDeclinationDecidegrees;
  if (
    !Number.isInteger(value) ||
    value < -MAG_DECLINATION_DECIDEGREE_LIMIT ||
    value > MAG_DECLINATION_DECIDEGREE_LIMIT
  ) {
    throw new RangeError(
      `MSP_SET_COMPASS_CONFIG magDeclinationDecidegrees must be a whole number of ` +
        `decidegrees within +/-${MAG_DECLINATION_DECIDEGREE_LIMIT}; received ${String(value)}.`,
    );
  }
  const payload = new Uint8Array(COMPASS_CONFIG_WRITE_BYTES);
  new DataView(payload.buffer).setInt16(0, value, true);
  return payload;
}
