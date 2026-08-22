/**
 * MSP_SET_SENSOR_CONFIG (97) - writing the CONFIGURED sensor hardware.
 *
 * The firmware handler at revision 7348054f268f0058574719c134e9f149565bb8ea
 * (src/main/msp/msp.c, case MSP_SET_SENSOR_CONFIG) reads three bytes
 * unconditionally and then each of the last two only if a byte is
 * actually left:
 *
 *     acc_hardware  = sbufReadU8(src);
 *     baro_hardware = sbufReadU8(src);
 *     mag_hardware  = sbufReadU8(src);
 *     if (sbufBytesRemaining(src) >= 1) rangefinder_hardware = sbufReadU8(src);
 *     if (sbufBytesRemaining(src) >= 1) opticalflow_hardware = sbufReadU8(src);
 *
 * Same order as the read, same absence of a gyro byte.
 *
 * THE CALLER CHOOSES THE SHAPE. This encoder will build a three-, four-
 * or five-byte frame, and it will not decide which. It cannot: the only
 * evidence of what a board understands is what that board answered on
 * MSP_SENSOR_CONFIG, and that evidence lives with whoever did the read.
 * An encoder that guessed would be guessing on the operator's behalf
 * about a value that changes which sensor a flight controller uses.
 *
 * The natural caller therefore passes back the contract that came out of
 * `decodeSensorConfig`, which is exactly why that value is on the decoded
 * snapshot. `sensorConfigContractFor` below makes the round trip explicit
 * without letting the encoder infer anything by itself.
 *
 * A FIELD THE FRAME WILL NOT CARRY MUST NOT BE SUPPLIED. Asking for a
 * three-byte frame while handing over a rangefinder value is refused
 * rather than quietly dropped: the caller believes it is configuring a
 * rangefinder, and a silent drop would leave it believing that after the
 * board acknowledged a frame that never mentioned one. The reverse -
 * asking for a five-byte frame without an optical-flow value - is refused
 * for the same reason from the other side.
 *
 * ONE MORE THING THIS ENCODER WILL NOT DO. It does not send. Building a
 * frame is not authorization to change a flight controller's sensor
 * selection; there is no controller in this pass and no caller.
 */

import {
  SENSOR_CONFIG_CONTRACT_BYTES,
  NOT_AVAILABLE_IN_THIS_CONTRACT,
  type SensorConfig,
  type SensorConfigContract,
} from '../decoding/decodeSensorConfig';

/**
 * The hardware indices to write. Raw firmware enum indices, because that
 * is what the wire carries and what `settings.c` bounds-checks - modelled
 * names are a reading aid and would only add a lossy translation step on
 * the way out.
 */
export interface SensorConfigWrite {
  readonly acc: number;
  readonly baro: number;
  readonly mag: number;
  /** Required for the four- and five-byte contracts, forbidden otherwise. */
  readonly rangefinder?: number;
  /** Required for the five-byte contract, forbidden otherwise. */
  readonly opticalflow?: number;
}

const U8_MAX = 0xff;

function requireByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U8_MAX) {
    throw new RangeError(
      `MSP_SET_SENSOR_CONFIG ${name} must be an integer in 0..${U8_MAX}; received ${String(value)}.`,
    );
  }
}

function requirePresence(
  name: string,
  value: number | undefined,
  shouldBePresent: boolean,
  contract: SensorConfigContract,
): void {
  if (shouldBePresent && value === undefined) {
    throw new RangeError(
      `MSP_SET_SENSOR_CONFIG contract ${contract} carries ${name}, but no value was supplied.`,
    );
  }
  if (!shouldBePresent && value !== undefined) {
    throw new RangeError(
      `MSP_SET_SENSOR_CONFIG contract ${contract} has no ${name} byte, so a ${name} value cannot be written.`,
    );
  }
}

export function encodeSensorConfig(
  contract: SensorConfigContract,
  write: SensorConfigWrite,
): Uint8Array {
  const length = SENSOR_CONFIG_CONTRACT_BYTES[contract];
  if (length === undefined) {
    throw new RangeError(
      `MSP_SET_SENSOR_CONFIG has no contract named ${String(contract)}.`,
    );
  }
  const carriesRangefinder = length >= 4;
  const carriesOpticalflow = length >= 5;

  requirePresence('rangefinder', write.rangefinder, carriesRangefinder, contract);
  requirePresence('opticalflow', write.opticalflow, carriesOpticalflow, contract);

  requireByte('acc', write.acc);
  requireByte('baro', write.baro);
  requireByte('mag', write.mag);
  if (carriesRangefinder) requireByte('rangefinder', write.rangefinder as number);
  if (carriesOpticalflow) requireByte('opticalflow', write.opticalflow as number);

  const payload = new Uint8Array(length);
  payload[0] = write.acc;
  payload[1] = write.baro;
  payload[2] = write.mag;
  if (carriesRangefinder) payload[3] = write.rangefinder as number;
  if (carriesOpticalflow) payload[4] = write.opticalflow as number;
  return payload;
}

/**
 * The contract a board proved it speaks, taken from what it answered.
 *
 * This is the only sanctioned way to obtain a contract for a write, and
 * it is a lookup rather than an inference: the value was decided when the
 * board's own reply was measured, and this function just carries it
 * across. A caller with no prior read has nothing to pass here, which is
 * the correct outcome - it also has no business writing.
 */
export function sensorConfigContractFor(
  observed: SensorConfig,
): SensorConfigContract {
  return observed.contract;
}

/**
 * The values a board is currently configured with, in the shape this
 * encoder wants, so a caller can edit one field without re-deriving the
 * rest. Absent fields stay absent: a three-byte board yields no
 * rangefinder value, which then makes the matching three-byte frame the
 * only one that validates.
 */
export function sensorConfigWriteFrom(observed: SensorConfig): SensorConfigWrite {
  return Object.freeze({
    acc: observed.acc.raw,
    baro: observed.baro.raw,
    mag: observed.mag.raw,
    ...(observed.rangefinder === NOT_AVAILABLE_IN_THIS_CONTRACT
      ? {}
      : {rangefinder: observed.rangefinder.raw}),
    ...(observed.opticalflow === NOT_AVAILABLE_IN_THIS_CONTRACT
      ? {}
      : {opticalflow: observed.opticalflow.raw}),
  });
}
