/**
 * THE LEDGER A MULTI-STAGE CONFIGURATION SAVE KEEPS OF ITSELF.
 *
 * =====================================================================
 * WHY THIS EXISTS
 * =====================================================================
 *
 * A configuration save is not one operation. It is an ordered sequence
 * of mutations followed by a persistence step:
 *
 *     SET group A  ->  SET group B  ->  ...  ->  EEPROM_WRITE
 *
 * Every one of those frames can succeed on its own, and the flight
 * controller applies each to its RAM the moment it acknowledges it.
 * Collapsing the sequence into a single `success: boolean` therefore
 * destroys the only fact the operator needs when it goes wrong:
 *
 *     WHICH writes did the aircraft actually accept, and did any of
 *     them survive into flash?
 *
 * Two confirmed defects came from that collapse.
 *
 *   A sequence that kept writing across a flight controller RESTART
 *   sent its later frames to a board that had come back with different
 *   RAM, and the EEPROM write then persisted only the surviving half -
 *   one operator intent split durably across two FC lifetimes.
 *
 *   A sequence whose EEPROM write was REFUSED reported an ordinary
 *   failure, which reads as "nothing happened" - while the SET frames
 *   before it had already been acknowledged and the aircraft was flying
 *   the new values until its next power cycle.
 *
 * This ledger is the shared answer to both. It records what was
 * acknowledged, so a stop at any later stage can say so precisely, and
 * it is what the per-stage liveness checks report against.
 *
 * =====================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * =====================================================================
 *
 * It does not roll back. After a restart, a disconnect or an ambiguous
 * frame, the controller no longer knows which RAM image the board is
 * holding, and "undoing" would mean issuing MORE writes down a link
 * that has just proven unreliable - possibly onto a session that is no
 * longer the one the values came from. The firmware offers no
 * transactional abort and inventing one would risk a state neither the
 * operator nor this code can predict.
 *
 * It does not retry. Same reason.
 *
 * It does not upgrade an AMBIGUOUS result into an acknowledged one. A
 * frame whose reply never came may or may not have been applied; that
 * is a third state, and it stays a third state.
 */

/**
 * An append-only record of one save's mutating stages.
 *
 * `TStage` is each controller's own write-group union - this module
 * deliberately does not impose a shared stage vocabulary, because the
 * groups are the controller's own domain (`SERIAL_CONFIG`,
 * `MODE_RANGE`, `BATTERY_CONFIG`) and flattening them would lose the
 * attribution the operator is being shown.
 */
export class MutationLedger<TStage> {
  private readonly stages: TStage[] = [];
  private persistedFlag = false;

  /**
   * Record a mutation the board ANSWERED. Only ever called after a
   * request resolves: an ambiguous or refused frame must not appear
   * here, which is the whole point of the ledger.
   */
  acknowledge(stage: TStage): void {
    this.stages.push(stage);
  }

  /** Record that the EEPROM write itself was acknowledged. */
  markPersisted(): void {
    this.persistedFlag = true;
  }

  /** The mutations this save has proof the board accepted, in order. */
  get acknowledgedStages(): readonly TStage[] {
    return Object.freeze([...this.stages]);
  }

  /**
   * True once the EEPROM write has been acknowledged.
   *
   * Nothing after this may lower it. A readback that fails, or a reboot
   * that goes unanswered, says nothing about whether the flash write
   * happened - it already did, and the board said so.
   */
  get persisted(): boolean {
    return this.persistedFlag;
  }

  /**
   * True once ANY mutation was acknowledged.
   *
   * This is the question that separates "the save was refused and the
   * aircraft is untouched" from "the aircraft's RAM has already moved".
   * A failure before this is an ordinary failure; a failure after it
   * never is.
   */
  get hasMutated(): boolean {
    return this.stages.length > 0;
  }
}

/**
 * The shape every affected controller's ambiguous-write cause carries so
 * its outcome can name a partial application.
 *
 * `partial` is not derivable from `confirmedStages.length > 0` alone at
 * the point of consumption, because the EEPROM stage is deliberately NOT
 * partial: by the time it runs, every RAM write is confirmed and the
 * flight controller holds the complete intended state - only
 * PERSISTENCE is in doubt, which the existing `UNCONFIRMED(EEPROM)`
 * answer already states precisely. The flag records that decision where
 * it is made rather than re-deriving it in each screen.
 */
export interface PartialApplyEvidence<TStage> {
  readonly confirmedStages: readonly TStage[];
  readonly partial: boolean;
  /** The frame provably never reached the flight controller. */
  readonly definitelyNotSent: boolean;
}

/**
 * A mutation sequence STOPPED because the session, the client, the epoch
 * or the app state changed after at least one write had already been
 * acknowledged.
 *
 * This is NOT an ordinary preflight refusal. A preflight refusal means
 * the aircraft was never touched; this means it was, and then the thing
 * being written to stopped being the thing the values were read from.
 * Reporting it as `DISCONNECTED` would tell the operator nothing
 * happened, which is exactly the lie this phase exists to remove.
 *
 * Carrying the ledger on the error is what lets the controller answer
 * with the acknowledged groups instead of a bare failure.
 */
export class MutationStoppedError<TStage> extends Error {
  constructor(
    readonly stage: TStage,
    readonly confirmedStages: readonly TStage[],
    readonly cause: unknown,
  ) {
    super(
      'Configuration mutation stopped: the session changed after a write was acknowledged.',
    );
    this.name = 'MutationStoppedError';
  }
}
