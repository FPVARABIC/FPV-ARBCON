/**
 * Pass 7.3: core types/contracts for MspOperationCoordinator - the
 * mutual-exclusion + session-identity-aware wrapper around a single
 * "exclusive" MSP write/command operation at a time (MSP_SET_* writes,
 * reboot, bootloader entry, etc.). Zero React/RN/Android dependency,
 * same convention as every other file under src/core/protocol.
 */

import type {MspClientState} from '../mspClient';
import type {MspRequester} from '../msp/identification/MspIdentificationService';

export type ExclusiveOperationState =
  | {status: 'IDLE'}
  | {status: 'RUNNING'; operationId: string; startedAtMs: number};

export type OperationExecutionPhase =
  | 'NOT_STARTED'
  | 'WAITING_FOR_IDLE'
  | 'DISPATCHING'
  | 'AWAITING_CONFIRMATION'
  | 'SUCCESS_CONFIRMED';

/**
 * Deliberately minimal/generic for THIS pass - a placeholder later
 * passes will extend once real operations and their real validation
 * needs exist as concrete code, not a final domain model.
 *
 * clientState: lets validate() decline to even attempt an operation
 * against a link that isn't READY (e.g. mid-recovery) - the single most
 * basic precondition almost any real MSP write operation will want to
 * check before anything else.
 *
 * isArmed: the single most safety-critical piece of context any FPV
 * flight-controller configurator needs before allowing most MSP_SET_*
 * writes (motor/mixer/PID-adjacent settings must never be touched while
 * armed). Chosen as the other field specifically because it is both (a)
 * universally relevant across almost any real exclusive operation this
 * coordinator will eventually run, and (b) trivial to represent today
 * with zero real operations yet written (a plain boolean, no
 * decoder/domain type needed).
 *
 * Both fields are supplied by the coordinator's caller via the required
 * getContext option - see MspOperationCoordinator.ts's own class-level
 * doc comment for why that had to be added beyond this pass's explicit
 * 3-positional-parameter constructor list (this file's types have no way
 * to derive either field themselves).
 */
export type MspOperationContext = {
  clientState: MspClientState;
  isArmed: boolean;
};

export type MspOperationValidationResult = {allowed: true} | {allowed: false; error: unknown};

export type MspExclusiveOperation<TResult> = {
  id: string;
  validate(context: MspOperationContext): MspOperationValidationResult;
  execute(requester: MspRequester): Promise<TResult>;
  /** Telemetry poll ids (Pass 7.2's MspTelemetryScheduler) to mark
   * immediately due once this operation succeeds and the session is
   * still current. Only ever consulted for sessionEffect ===
   * 'KEEP_SESSION' - never for the three session-ending effects below,
   * regardless of whether it is set (see
   * MspOperationCoordinator.ts's own doc comment on execute()'s exact
   * success-path ordering). */
  refreshAfterSuccess?: readonly string[];
  sessionEffect: 'KEEP_SESSION' | 'EXPECT_REBOOT' | 'EXPECT_BOOTLOADER' | 'EXPECT_DISCONNECT';
};

export type SetupOperationResult<TResult> =
  | {status: 'SUCCEEDED'; result: TResult}
  | {status: 'FAILED'; error: unknown}
  | {status: 'OUTCOME_UNKNOWN'; reason: unknown}
  | {status: 'SESSION_ENDED'; reason: 'DEVICE_DETACHED' | 'SESSION_CLOSED' | 'SESSION_REPLACED'};

/**
 * Thrown by an operation's OWN execute() - never by the coordinator
 * itself - specifically when the OPERATION AUTHOR (who has domain
 * knowledge the coordinator doesn't) knows a failure might still have
 * reached the FC (e.g. a WRITE_FAILED-classified MspClientError per
 * mspClient.ts's own error taxonomy, where the physical write may have
 * landed on the wire despite a lost confirmation). Any OTHER thrown
 * error is treated by the coordinator as a confirmed, definite failure
 * (FAILED).
 *
 * Design note (per this pass's own "report the reasoning, don't
 * silently assume" instruction): a sentinel-subclass thrown through the
 * existing Promise<TResult> rejection channel was chosen over an
 * alternative like execute() returning a three-way discriminated union
 * itself, because execute()'s signature is fixed by this pass's own
 * spec as `(requester: MspRequester) => Promise<TResult>` - a plain
 * Promise only has two channels (resolve/reject), and distinguishing
 * FAILED from OUTCOME_UNKNOWN within the single rejection channel
 * requires SOME marker. A dedicated subclass is the least invasive way
 * to do that: every existing/ordinary error an operation's execute()
 * might propagate unchanged (a rejected requester.request() call, e.g.)
 * needs no special handling at all and is correctly treated as FAILED
 * by default; only the genuinely ambiguous cases need to be explicitly
 * wrapped by the operation author. This matches the "any OTHER thrown
 * error is a confirmed, definite failure" default stated in this pass's
 * own instructions.
 */
export class MspOperationOutcomeUnknownError extends Error {
  constructor(public readonly cause: unknown) {
    super('MSP exclusive operation outcome unknown - execute() failed after dispatch may have reached the FC');
    this.name = 'MspOperationOutcomeUnknownError';
  }
}
