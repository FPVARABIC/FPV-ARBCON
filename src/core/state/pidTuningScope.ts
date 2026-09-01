/**
 * WHO OWNS A SETTING, AND WHICH PROFILE A DRAFT BELONGS TO.
 *
 * The PID page edits three different things at once and Betaflight's own
 * client does not distinguish them: one dirty flag covers PID gains, rate
 * settings and filters alike, and a write is bound to no profile at all. P-A
 * found the consequence in the reference implementation - a radio switch can
 * change the active profile while a draft is open, and the next save lands in
 * the profile the pilot was not editing.
 *
 * The scope model is the fix, and it starts here as pure types with no
 * controller behaviour attached. Three scopes, because the firmware has
 * three:
 *
 *   PID_PROFILE    four of them, indexed 0-3, selected by MSP_SELECT_SETTING
 *   RATE_PROFILE   four of them, indexed 0-3, selected independently
 *   GLOBAL         one, belonging to no profile
 *
 * MSP_FILTER_CONFIG spans PID_PROFILE and GLOBAL in a single payload, which
 * is exactly why flattening these into "the current profile" is wrong.
 */

export type PidTuningScope =
  | {readonly kind: 'PID_PROFILE'; readonly index: number}
  | {readonly kind: 'RATE_PROFILE'; readonly index: number}
  | {readonly kind: 'GLOBAL'};

export const GLOBAL_SCOPE: PidTuningScope = Object.freeze({kind: 'GLOBAL'});

export function pidProfileScope(index: number): PidTuningScope {
  return Object.freeze({kind: 'PID_PROFILE', index});
}

export function rateProfileScope(index: number): PidTuningScope {
  return Object.freeze({kind: 'RATE_PROFILE', index});
}

export function scopesEqual(a: PidTuningScope, b: PidTuningScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'GLOBAL' || b.kind === 'GLOBAL') return true;
  return a.index === b.index;
}

/**
 * A profile identity, as read from the board.
 *
 * The count travels with the index on purpose: an index alone cannot say
 * whether it is valid, and a selector that offers four slots to a board that
 * reports three is inventing a profile.
 */
export interface PidProfileIdentity {
  readonly kind: 'PID_PROFILE';
  readonly index: number;
  readonly count: number;
}

export interface RateProfileIdentity {
  readonly kind: 'RATE_PROFILE';
  readonly index: number;
  /**
   * MSP_STATUS_EX only began reporting this at API 1.47. Absent means the
   * board did not say - which is a reason to offer no selector, never a
   * reason to assume four.
   */
  readonly count: number | undefined;
}

export type ProfileIdentity = PidProfileIdentity | RateProfileIdentity;

export function pidProfileIdentity(index: number, count: number): PidProfileIdentity {
  return Object.freeze({kind: 'PID_PROFILE', index, count});
}

export function rateProfileIdentity(index: number, count: number | undefined): RateProfileIdentity {
  return Object.freeze({kind: 'RATE_PROFILE', index, count});
}

export function profileIdentitiesEqual(a: ProfileIdentity, b: ProfileIdentity): boolean {
  return a.kind === b.kind && a.index === b.index && a.count === b.count;
}

/**
 * A draft bound to the identity it was taken from.
 *
 * P-C will refuse to write a binding whose identity no longer matches the
 * board's. P-B only defines what "matches" means, and deliberately treats a
 * changed COUNT as a mismatch too: a board that suddenly reports a different
 * number of profiles is not the board the draft was read from.
 */
export interface ScopedDraftBinding<TDraft> {
  readonly identity: ProfileIdentity;
  readonly draft: TDraft;
}

export function bindDraft<TDraft>(identity: ProfileIdentity, draft: TDraft): ScopedDraftBinding<TDraft> {
  return Object.freeze({identity, draft});
}

export type BindingCheck =
  | {readonly kind: 'BOUND'}
  | {readonly kind: 'PROFILE_CHANGED'; readonly was: ProfileIdentity; readonly now: ProfileIdentity};

export function checkBinding<TDraft>(
  binding: ScopedDraftBinding<TDraft>,
  observed: ProfileIdentity,
): BindingCheck {
  return profileIdentitiesEqual(binding.identity, observed)
    ? Object.freeze({kind: 'BOUND'})
    : Object.freeze({kind: 'PROFILE_CHANGED', was: binding.identity, now: observed});
}

/**
 * APPLIED IS NOT PERSISTED.
 *
 * Every SET on this page takes effect in RAM immediately - each handler ends
 * in a re-initialisation call - and none of them writes EEPROM. Profile
 * switches, profile copies and the PID-profile reset are all RAM-only too, so
 * a reset that is not followed by a save is gone at the next power cycle.
 * These are two independent facts about one value and the types keep them
 * that way; P-C owns the lifecycle that moves between them.
 */
export type AppliedState = 'NOT_SENT' | 'APPLIED_UNVERIFIED' | 'APPLIED_VERIFIED';
export type PersistenceState = 'NOT_PERSISTED' | 'PERSIST_UNVERIFIED' | 'PERSISTED_VERIFIED';

export interface WriteLifecycleState {
  readonly applied: AppliedState;
  readonly persisted: PersistenceState;
}

export function initialWriteLifecycle(): WriteLifecycleState {
  return Object.freeze({applied: 'NOT_SENT', persisted: 'NOT_PERSISTED'});
}

/**
 * WHAT A ZERO ON THE WIRE PROVES, WHICH IS USUALLY NOTHING.
 *
 * When a firmware feature is compiled out, its serialiser writes a literal 0
 * and its parser discards the byte. When a feature is retired, the same thing
 * happens. So a zero can mean "off", "not built", or "no longer exists", and
 * only one of those is a setting. The one case where absence really does
 * prove something is a whole command family: MSP_SIMPLIFIED_TUNING and its
 * relatives do not exist at all without USE_SIMPLIFIED_TUNING, so a board
 * that rejects the command has genuinely told us something.
 */
export type CapabilityEvidence =
  | {readonly kind: 'SUPPORTED'; readonly because: 'COMMAND_ANSWERED' | 'FIELD_LIVE_IN_CONTRACT'}
  | {readonly kind: 'UNSUPPORTED'; readonly because: 'COMMAND_ABSENT' | 'RETIRED_IN_CONTRACT'}
  | {readonly kind: 'NOT_PROVEN'; readonly because: 'ZERO_IS_AMBIGUOUS' | 'NOT_OBSERVED' };

export function capabilitySupported(
  because: 'COMMAND_ANSWERED' | 'FIELD_LIVE_IN_CONTRACT',
): CapabilityEvidence {
  return Object.freeze({kind: 'SUPPORTED', because});
}

export function capabilityUnsupported(
  because: 'COMMAND_ABSENT' | 'RETIRED_IN_CONTRACT',
): CapabilityEvidence {
  return Object.freeze({kind: 'UNSUPPORTED', because});
}

export function capabilityNotProven(
  because: 'ZERO_IS_AMBIGUOUS' | 'NOT_OBSERVED' = 'ZERO_IS_AMBIGUOUS',
): CapabilityEvidence {
  return Object.freeze({kind: 'NOT_PROVEN', because});
}
