/**
 * CHANGING WHICH RATE FORMULA A PROFILE USES - AND NOTHING ELSE.
 *
 * `rates_type` is one byte at offset 22 of MSP_RC_TUNING. It does not scale
 * anything: it selects which of the five formulas in `fc/rc.c` interprets the
 * rate numbers already stored in the profile. So changing it changes how the
 * aircraft flies without changing a single stored value, and the ONE thing
 * this encoder must never do is quietly "convert" those numbers to keep the
 * curve looking the same. Betaflight does not do that, the firmware has no
 * such conversion, and inventing one here would be this app deciding a pilot's
 * rates for them.
 *
 * The encoder therefore patches byte 22 of the payload the board just gave us
 * and leaves the other twenty-three exactly as they were.
 */

import {MSP_RC_TUNING_BYTES} from '../decoding/pidWireContracts';
import {RC_TUNING_OFFSETS} from '../decoding/decodeRcTuningFull';

/** `controlRateConfig_t.rates_type`, `controlrate_profile.h` RATES_TYPE_*. */
export const RATES_TYPE_RAW_BETAFLIGHT = 0;
export const RATES_TYPE_RAW_RACEFLIGHT = 1;
export const RATES_TYPE_RAW_KISS = 2;
export const RATES_TYPE_RAW_ACTUAL = 3;
export const RATES_TYPE_RAW_QUICK = 4;
/**
 * `RATES_TYPE_COUNT` is the enum's terminator, not a rate type. A board that
 * stored it would be broken; a client that SENT it would be asking for a
 * formula that does not exist.
 */
export const RATES_TYPE_COUNT_SENTINEL = 5;

export const ENCODABLE_RATES_TYPES: readonly number[] = Object.freeze([
  RATES_TYPE_RAW_BETAFLIGHT,
  RATES_TYPE_RAW_RACEFLIGHT,
  RATES_TYPE_RAW_KISS,
  RATES_TYPE_RAW_ACTUAL,
  RATES_TYPE_RAW_QUICK,
]);

/**
 * Whether this raw value names a formula that exists in the pinned trees.
 *
 * Deliberately an inclusion test against the five known values rather than a
 * range check: a range check would silently start accepting a sixth type the
 * day the enum grows, before anybody has read what it means.
 */
export function isEncodableRatesType(ratesTypeRaw: number): boolean {
  return ENCODABLE_RATES_TYPES.includes(ratesTypeRaw);
}

/**
 * The full 24-byte payload with ONLY `rates_type` changed.
 *
 * `observed` must be the payload the board answered MSP_RC_TUNING with, so
 * every byte this app does not own travels back unchanged - including the
 * three the firmware discards, which it will overwrite with zeros anyway.
 */
export function encodeRcTuningRatesType(observed: Uint8Array, ratesTypeRaw: number): Uint8Array {
  if (observed.length < MSP_RC_TUNING_BYTES) {
    throw new RangeError(
      `Cannot patch rates_type into a ${observed.length}-byte MSP_RC_TUNING observation.`,
    );
  }
  if (!isEncodableRatesType(ratesTypeRaw)) {
    throw new RangeError(
      `rates_type ${ratesTypeRaw} is not one of the five formulas this build has read from source.`,
    );
  }
  const payload = observed.slice(0, MSP_RC_TUNING_BYTES);
  payload[RC_TUNING_OFFSETS.ratesType] = ratesTypeRaw;
  return payload;
}

/**
 * The bytes a rates-type change is allowed to move.
 *
 * Exported so a readback check can assert that nothing else did, rather than
 * trusting the encoder that produced the payload.
 */
export const RATES_TYPE_OWNED_OFFSETS: readonly number[] = Object.freeze([
  RC_TUNING_OFFSETS.ratesType,
]);
