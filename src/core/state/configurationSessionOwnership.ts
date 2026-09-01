/**
 * WHICH FLIGHT-CONTROLLER SESSION DOES THIS DRAFT BELONG TO?
 *
 * =====================================================================
 * THE DEFECT THIS EXISTS FOR
 * =====================================================================
 *
 * Two flight controllers can be the same target, the same firmware, the
 * same API version, the same capabilities, the same build options, the
 * same UART inventory, the same motor count, and byte-identical in both
 * RAM and EEPROM - and still be two different aircraft.
 *
 * Every guard this application had before this module compared either
 * CONFIGURATION (stale-base) or LIVENESS (is the session still the one I
 * captured). Neither answers "was this draft made for the board I am
 * about to write". Measured consequence, not a hypothetical one: a draft
 * created against board A, submitted with board B's freshly-minted
 * session key, wrote to B on ALL NINE save-capable screens - 2 to 21
 * mutating frames each - because every individual check passed. B's key
 * was current, B's link was live, and B's bytes matched the snapshot
 * exactly, so stale-base had nothing to object to.
 *
 * =====================================================================
 * WHAT COUNTS AS IDENTITY HERE, AND WHAT DELIBERATELY DOES NOT
 * =====================================================================
 *
 * The authority is `SetupUiSessionKey` - `{sessionId, generation}` -
 * because the application already mints exactly one of those per
 * physical session, in `MspSessionCoordinator.openSession()`, and
 * deletes it on detach. Both halves are compared. `sessionId` alone is
 * not enough: the native layer is explicitly allowed to reuse a
 * sessionId string, which is the whole reason `generation` exists.
 *
 * NOT used, on purpose:
 *
 *   - target name, board identifier, manufacturer, MCU class, API
 *     version, firmware version - these name a MODEL, not a unit;
 *   - configuration bytes - byte-identical is the case that broke;
 *   - MSP_BOARD_INFO's 32-byte board signature. It reads like an
 *     identity and is not one. Traced at the pinned Betaflight commit:
 *     it lives in `boardConfig_t`, a parameter group (pg/board.h), so it
 *     is SAVED CONFIGURATION; `fc/board_info.c` never derives it from an
 *     MCU UID; `msp.c` writes 32 zero bytes when `USE_SIGNATURE` is not
 *     compiled, and an unprovisioned board reports the same zeros
 *     because the static buffer lives in .bss; and `MSP_SET_SIGNATURE`
 *     lets any MSP client provision it once. Two boards restored from
 *     one configuration backup therefore carry one signature. A guard
 *     built on it would authorise exactly the case it was meant to stop.
 *
 * =====================================================================
 * WHY OWNERSHIP RIDES ON THE SNAPSHOT OBJECT
 * =====================================================================
 *
 * Every save-capable screen holds the snapshot object its controller
 * returned and hands that same object back as `original` when it saves.
 * The snapshot IS the baseline the draft was built from, so binding
 * ownership to it binds the draft too, without changing nine snapshot
 * types or asking nine screens to remember one more field correctly.
 *
 * The binding is a WeakMap keyed on object identity: it cannot be forged
 * by minting a fresh key, it disappears with the snapshot, and a
 * snapshot this module never saw is UNKNOWN rather than owned - which
 * `isOwnedBy` reports as "not owned", so the failure direction is
 * refusal, never a silent write.
 *
 * THIS IS THE SECOND LAYER, NOT THE ONLY ONE. The screens refuse first,
 * and the application already unregisters the whole configuration
 * workspace when a session ends. This layer exists so that a future
 * navigation change which keeps a screen mounted across a reconnect
 * cannot silently re-open the defect.
 */

/**
 * The identity of one activation of one session - structurally the same
 * shape as `SetupUiSessionKey`, declared here so `src/core` keeps its
 * no-platform-imports rule. The coordinator's type is assignable to it.
 */
export interface ConfigurationSessionOwner {
  readonly sessionId: string;
  readonly generation: number;
}

/**
 * THE ONE COMPARISON. Both halves, always.
 *
 * Deliberately not exported as "sessionsEqual": this answers a narrower
 * question - may work created under `owner` be submitted under
 * `current`? - and reads that way at every call site.
 */
export function sameConfigurationSession(
  owner: ConfigurationSessionOwner | undefined,
  current: ConfigurationSessionOwner | undefined,
): boolean {
  if (owner === undefined || current === undefined) {
    return false;
  }
  return (
    owner.sessionId === current.sessionId && owner.generation === current.generation
  );
}

/* A WeakMap, so a snapshot the screen has dropped costs nothing and
   nothing here can keep a board's configuration alive. */
const owners = new WeakMap<object, ConfigurationSessionOwner>();

/**
 * Records the session a snapshot was produced under, and returns the
 * snapshot unchanged so call sites read as `return remember(snapshot,
 * key)` rather than growing a statement.
 *
 * Called on every path that hands a screen a NEW baseline: a load, and
 * a save that returns the configuration it just verified. A save's own
 * snapshot must be registered too - the screen adopts it as its next
 * baseline, and an unregistered one would refuse the operator's very
 * next edit.
 */
export function rememberConfigurationSession<T extends object>(
  snapshot: T,
  owner: ConfigurationSessionOwner,
): T {
  owners.set(snapshot, {sessionId: owner.sessionId, generation: owner.generation});
  return snapshot;
}

/** The session a snapshot was produced under, or undefined if unknown. */
export function configurationSessionOwnerOf(
  snapshot: object | undefined,
): ConfigurationSessionOwner | undefined {
  return snapshot === undefined ? undefined : owners.get(snapshot);
}

/**
 * May work built on `snapshot` be submitted under `current`?
 *
 * An unregistered snapshot answers false. That is the safe direction and
 * it is also the honest one: this module cannot say a baseline it never
 * issued belongs to this session.
 */
export function isOwnedByConfigurationSession(
  snapshot: object | undefined,
  current: ConfigurationSessionOwner | undefined,
): boolean {
  return sameConfigurationSession(configurationSessionOwnerOf(snapshot), current);
}

/**
 * Is `snapshot` PROVEN to have come from a different session?
 *
 * THE TWO LAYERS ASK DIFFERENT QUESTIONS, ON PURPOSE.
 *
 * The controller asks `isOwnedBy` - "prove this baseline is mine" - and
 * refuses everything it cannot place, because it is the last thing before
 * the wire and the cost of being wrong there is a write to the wrong
 * aircraft. That is where the safety guarantee lives.
 *
 * A screen asks this instead - "prove this baseline is somebody else's" -
 * because a screen does not only block, it SPEAKS. Telling an operator
 * «تغيّرت جلسة المتحكم» about a snapshot whose origin this module never
 * recorded would be asserting a fact not in evidence, which is the one
 * thing this codebase does not do. Unknown provenance is not a session
 * change; it is silence, and the controller still refuses it.
 *
 * In the product the two agree on every real case: every baseline a
 * screen holds came from a controller load or a verified save, so it is
 * always registered, and "not mine" and "somebody else's" are the same
 * set. They differ only for a snapshot this module never issued.
 */
export function isOwnedByDifferentConfigurationSession(
  snapshot: object | undefined,
  current: ConfigurationSessionOwner | undefined,
): boolean {
  const owner = configurationSessionOwnerOf(snapshot);
  return owner !== undefined && !sameConfigurationSession(owner, current);
}

/**
 * TEST-ONLY. Drops one binding so a suite can construct the "screen
 * holds a snapshot this process never issued" case explicitly rather
 * than relying on a WeakMap having been collected.
 */
export function forgetConfigurationSessionForTests(snapshot: object): void {
  owners.delete(snapshot);
}
