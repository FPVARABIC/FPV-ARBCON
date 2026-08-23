/* eslint-disable no-bitwise -- every discriminator in this file IS a bit in a
   firmware payload byte. Writing them as arithmetic would hide what they are. */
import type {PidApiContract} from '../decoding/pidWireContracts';

/**
 * THE PROFILE COMMANDS, AND THE SAFETY BOUNDARY BETWEEN TWO KINDS OF RESET.
 *
 * Four separate wire contracts live here because they share one subject - the
 * profile - and because keeping the destructive one visibly apart from the
 * harmless ones is itself the point.
 *
 * MSP_SELECT_SETTING (210) is one byte with a discriminator that GREW.
 *
 *   API 1.47   bit 7 set  -> rate profile     otherwise -> PID profile
 *   API 1.48+  bit 6 set  -> battery profile  tested FIRST
 *              bit 7 set  -> rate profile
 *              neither    -> PID profile
 *
 * The 1.48 firmware tests the battery bit before the rate bit, so 0x42 is a
 * battery profile there and would be PID profile 66 under a 1.47 reading.
 * This module refuses to guess: decoding takes a contract, and encoding
 * refuses any index that would collide with a discriminator instead of
 * relying on the firmware silently coercing it to zero.
 */

export const SELECT_SETTING_RATE_PROFILE_BIT = 0x80;
/** msp.c BATTERYPROFILE_MASK, present from API 1.48. */
export const SELECT_SETTING_BATTERY_PROFILE_BIT = 0x40;

/** target/common_pre.h */
export const PID_PROFILE_COUNT = 4;
export const CONTROL_RATE_PROFILE_COUNT = 4;

export type ProfileKind = 'PID' | 'RATE' | 'BATTERY';

export type DecodedSelectSetting =
  | {readonly kind: 'PID'; readonly index: number}
  | {readonly kind: 'RATE'; readonly index: number}
  | {readonly kind: 'BATTERY'; readonly index: number}
  | {readonly kind: 'UNREPRESENTABLE'; readonly raw: number};

/**
 * Read a select byte the way a given firmware would.
 *
 * Note this reports the index the FIRMWARE WILL EXTRACT, which is not always
 * the index it will end up using: an out-of-range index is silently coerced
 * to 0 by the handler. That coercion is modelled separately, in
 * `projectSelectSetting`, so the two facts stay distinguishable.
 */
export function decodeSelectSetting(raw: number, contract: PidApiContract): DecodedSelectSetting {
  if (!Number.isInteger(raw) || raw < 0 || raw > 0xff) {
    return Object.freeze({kind: 'UNREPRESENTABLE', raw});
  }
  if (contract !== 'API_1_47' && (raw & SELECT_SETTING_BATTERY_PROFILE_BIT) !== 0) {
    return Object.freeze({kind: 'BATTERY', index: raw & ~SELECT_SETTING_BATTERY_PROFILE_BIT});
  }
  if ((raw & SELECT_SETTING_RATE_PROFILE_BIT) !== 0) {
    return Object.freeze({kind: 'RATE', index: raw & ~SELECT_SETTING_RATE_PROFILE_BIT});
  }
  return Object.freeze({kind: 'PID', index: raw});
}

/**
 * The index the firmware will ACTUALLY activate.
 *
 * Both branches of the handler replace an out-of-range index with 0 and carry
 * on without an error. That is real behaviour and a readback has to expect
 * it - but it is not behaviour to lean on, which is why the encoder below
 * refuses rather than relying on it.
 */
export function projectSelectSetting(request: DecodedSelectSetting): DecodedSelectSetting {
  if (request.kind === 'UNREPRESENTABLE') return request;
  const count = request.kind === 'RATE' ? CONTROL_RATE_PROFILE_COUNT : PID_PROFILE_COUNT;
  if (request.kind === 'BATTERY') return request;
  return request.index >= count
    ? Object.freeze({kind: request.kind, index: 0})
    : request;
}

export function isEncodableSelectSettingIndex(kind: ProfileKind, index: number): boolean {
  if (!Number.isInteger(index) || index < 0) return false;
  // An index that reaches a discriminator bit is not an index at all.
  if (index >= SELECT_SETTING_BATTERY_PROFILE_BIT) return false;
  if (kind === 'PID') return index < PID_PROFILE_COUNT;
  if (kind === 'RATE') return index < CONTROL_RATE_PROFILE_COUNT;
  return true;
}

export function encodeSelectSettingVersioned(
  kind: ProfileKind,
  index: number,
  contract: PidApiContract,
): Uint8Array {
  if (kind === 'BATTERY' && contract === 'API_1_47') {
    throw new RangeError('Battery-profile selection does not exist before API 1.48.');
  }
  if (!isEncodableSelectSettingIndex(kind, index)) {
    throw new RangeError(`Profile index ${index} is not encodable as a ${kind} profile.`);
  }
  if (kind === 'RATE') return Uint8Array.from([index | SELECT_SETTING_RATE_PROFILE_BIT]);
  if (kind === 'BATTERY') return Uint8Array.from([index | SELECT_SETTING_BATTERY_PROFILE_BIT]);
  return Uint8Array.from([index]);
}

/**
 * MSP_COPY_PROFILE (183): three bytes, and the ORDER IS DESTINATION FIRST.
 *
 *   [0] 0 = PID profile, 1 = rate profile
 *   [1] destination index
 *   [2] source index
 *
 * Getting these the natural way round - source then destination - would
 * overwrite the wrong profile without any error, which is why the encoder
 * takes named fields and never a positional pair.
 */
export const COPY_PROFILE_TYPE_PID = 0;
export const COPY_PROFILE_TYPE_RATE = 1;

export interface CopyProfileRequest {
  readonly kind: 'PID' | 'RATE';
  readonly destinationIndex: number;
  readonly sourceIndex: number;
}

export function encodeCopyProfile(request: CopyProfileRequest): Uint8Array {
  const count = request.kind === 'RATE' ? CONTROL_RATE_PROFILE_COUNT : PID_PROFILE_COUNT;
  const valid = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < count;
  if (!valid(request.destinationIndex) || !valid(request.sourceIndex)) {
    throw new RangeError(
      `MSP_COPY_PROFILE indexes must be 0-${count - 1}; got destination ${request.destinationIndex}, source ${request.sourceIndex}.`,
    );
  }
  return Uint8Array.from([
    request.kind === 'RATE' ? COPY_PROFILE_TYPE_RATE : COPY_PROFILE_TYPE_PID,
    request.destinationIndex,
    request.sourceIndex,
  ]);
}

/**
 * What MSP_COPY_PROFILE will actually do.
 *
 * The firmware copies only when both indexes are in range AND they differ; a
 * same-index request is a silent no-op with a perfectly ordinary
 * acknowledgement. It does NOT exclude the active profile - the Configurator
 * removes the active entry from its dialog, but that is a UI rule, not a
 * firmware one. Copying onto the active profile writes straight through the
 * pointer the runtime is holding, and because the handler runs no
 * re-initialisation afterwards, the stored configuration and the running
 * behaviour disagree until something else re-inits: for a rate profile that
 * includes which rate formula is in use.
 */
export type CopyProfileOutcome =
  | {readonly kind: 'NO_OP_SAME_INDEX'}
  | {readonly kind: 'NO_OP_OUT_OF_RANGE'}
  | {readonly kind: 'COPIED'; readonly writesActiveProfile: boolean; readonly runtimeReinitialised: false};

export function projectCopyProfile(
  request: CopyProfileRequest,
  activeIndexOfThatKind: number,
): CopyProfileOutcome {
  const count = request.kind === 'RATE' ? CONTROL_RATE_PROFILE_COUNT : PID_PROFILE_COUNT;
  const inRange = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < count;
  if (!inRange(request.destinationIndex) || !inRange(request.sourceIndex)) {
    return Object.freeze({kind: 'NO_OP_OUT_OF_RANGE'});
  }
  if (request.destinationIndex === request.sourceIndex) {
    return Object.freeze({kind: 'NO_OP_SAME_INDEX'});
  }
  return Object.freeze({
    kind: 'COPIED',
    writesActiveProfile: request.destinationIndex === activeIndexOfThatKind,
    runtimeReinitialised: false,
  });
}

/**
 * TWO RESETS THAT MUST NEVER BE CONFUSED.
 *
 * MSP_SET_RESET_CURR_PID (219) resets the CURRENT PID profile to firmware
 * defaults, in RAM, touching nothing else and rebooting nothing.
 *
 * MSP_RESET_CONF (208) resets the ENTIRE configuration and reboots the flight
 * controller.
 *
 * They are deliberately not two members of one enum and there is deliberately
 * no shared "reset" function: the only way to reach the destructive one is to
 * name it. `PidProfileResetRequest` carries no parameters at all, because the
 * command has none - the target is whichever profile is active.
 */
export interface PidProfileResetRequest {
  readonly scope: 'CURRENT_PID_PROFILE_ONLY';
  readonly persists: false;
  readonly reboots: false;
}

export function pidProfileResetRequest(): PidProfileResetRequest {
  return Object.freeze({scope: 'CURRENT_PID_PROFILE_ONLY', persists: false, reboots: false});
}

export function encodePidProfileReset(): Uint8Array {
  return new Uint8Array(0);
}

/**
 * MSP2_GET_TEXT / MSP2_SET_TEXT profile names.
 *
 * Both selectors address the ACTIVE profile only - the firmware resolves them
 * through `currentPidProfile` and `currentControlRateProfile` - so naming a
 * profile you are not on requires switching to it first. The stored array is
 * `char[MAX_PROFILE_NAME_LENGTH + 1]` and the setter allows
 * `sizeof(array) - 1` characters, which is eight, with the final byte kept
 * for the terminator.
 */
export const MSP2TEXT_PID_PROFILE_NAME = 3;
export const MSP2TEXT_RATE_PROFILE_NAME = 4;
export const MAX_PROFILE_NAME_LENGTH = 8;

export function encodeGetProfileName(kind: 'PID' | 'RATE'): Uint8Array {
  return Uint8Array.from([kind === 'PID' ? MSP2TEXT_PID_PROFILE_NAME : MSP2TEXT_RATE_PROFILE_NAME]);
}

/**
 * `[selector, length, ...ascii]`. The firmware stores at most eight
 * characters; anything longer is a caller error rather than something to
 * silently truncate, because a truncated name is a different name.
 */
export function encodeSetProfileName(kind: 'PID' | 'RATE', name: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      throw new RangeError('Profile names are stored as single-byte characters by the flight controller.');
    }
    bytes.push(code);
  }
  if (bytes.length > MAX_PROFILE_NAME_LENGTH) {
    throw new RangeError(
      `Profile names hold at most ${MAX_PROFILE_NAME_LENGTH} characters; got ${bytes.length}.`,
    );
  }
  return Uint8Array.from([
    kind === 'PID' ? MSP2TEXT_PID_PROFILE_NAME : MSP2TEXT_RATE_PROFILE_NAME,
    bytes.length,
    ...bytes,
  ]);
}
