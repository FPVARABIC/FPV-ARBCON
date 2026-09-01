/**
 * P2-ii - THE PROFESSIONAL MOTOR-COMMAND ENGINE.
 *
 * SAFETY-CRITICAL: calling into this module can put a real motor value on
 * the wire.
 *
 * WHAT THIS IS. The DRIVER half of the professional motor-control path. It
 * is `MotorTestController`'s tightly-owned helper - constructed by the
 * controller, handed the controller's own lease and official authority, and
 * reachable from nowhere else. It exists as its own module for one reason:
 * the cross-layer stop-domination proof needs a surface that can be driven
 * with deterministic deferred promises, and burying it inside a 3,900-line
 * controller would have made that proof impossible to write honestly.
 *
 * THE DIVISION OF LABOUR, WHICH IS THE WHOLE POINT
 * ------------------------------------------------
 * `motorControlStateMachine.ts` is the pure AUTHORITY: it decides whether a
 * command may be submitted at all, and its SD1-SD5 rules are proven against
 * the transition table with no driver involved. This module is the DRIVER:
 * it owns everything the reducer deliberately refuses to own - the desired
 * vector, the coalescing buffer, the in-flight request, the command
 * generation and the transport calls.
 *
 * The reducer emits `SUBMIT_COMMAND_INTENT`, which carries NO vector. This
 * module is what turns "your latest desired vector is now eligible" into
 * bytes. That separation is why a stop can dominate: the reducer stops
 * saying "eligible" synchronously, and every continuation in this file
 * re-asks before it sends.
 *
 * THE FOUR VALUE STATES ARE NOT INTERCHANGEABLE
 * ---------------------------------------------
 *   desiredValues          - what the operator has asked for. Local intent.
 *   lastDispatchedValues   - what was handed to the leased FIFO. Proves a
 *                            frame was submitted, nothing more.
 *   lastAcknowledgedValues - what the flight controller answered for. Proves
 *                            the frame was received and processed.
 *   PHYSICAL MOTOR STATE   - DOES NOT EXIST HERE, and no field may be added
 *                            for it unless it is sourced from real
 *                            telemetry. There is deliberately no
 *                            `actualMotorValues`.
 *
 * An acknowledgement is metadata. It is never motion, never RPM, never
 * direction, and never a physical stop. Physical behaviour remains
 * REQUIRES HARDWARE TEST throughout this file.
 *
 * COMMAND GENERATION - THE CROSS-LAYER DEFENCE
 * --------------------------------------------
 * A submitted vector cannot be recalled, and a promise created before a
 * stop will still settle after it. So every continuation that could
 * dispatch another vector re-proves three things before sending:
 *
 *   1. the official authority is still this engine's authority, by
 *      reference, and the lease is still active;
 *   2. `commandGeneration` still equals the generation the continuation
 *      was created under;
 *   3. the pure reducer is still in a phase that permits commanding.
 *
 * `stopAll`, `disable` and session replacement all bump the generation
 * SYNCHRONOUSLY, so a continuation created before them fails check (2) and
 * returns without touching the transport. That is the primary defence
 * against delayed promises, and it is deliberately independent of the
 * reducer check rather than a duplicate of it: two different mechanisms
 * must both agree before a vector may follow a stop.
 *
 * ONE REQUEST IN FLIGHT, ONE VECTOR WAITING - NEVER A BACKLOG
 * -----------------------------------------------------------
 * Coalescing is LAST-VALUE-WINS with a depth of exactly one. Twenty slider
 * updates during one in-flight write produce one pending vector, not twenty
 * queued frames. There is NO periodic heartbeat and NO resend timer in this
 * module: a professional workspace has no touch to hold, so nothing here
 * schedules work on a clock.
 *
 * NO SECOND ENGINE. Every request travels the injected `MotorTestLease` -
 * the same lease the configuration reads, the box read, the safety monitor
 * and the emergency stop all use, and therefore the same serialized FIFO.
 * This module constructs no client, no transport, no queue and no writer,
 * and it holds no timer.
 */

import {
  buildAllStopVectorForDomain,
  buildMotorVector,
} from '../firmware-adapters/betaflightMotorVectorsV147';
import type {MotorTestValueDomain} from '../firmware-adapters/betaflightMotorDomainV147';
// M-C: every MSP_SET_MOTOR payload this engine puts on the wire is built
// and encoded HERE, at the canonical eight-slot width. The engine keeps
// its per-motor intent `motorCount` long - that is the operator's mental
// model and the shape the sliders produce - and widens it at exactly the
// two dispatch sites below. See motorTestCommandVector.ts for why a
// short payload is the dangerous direction on API 1.47.
import {
  buildAllStopCommandVector,
  buildCommandVectorFromValues,
  encodeMotorTestCommandVector,
} from './motorTestCommandVector';
import {encodeDshotMotorStopCommand} from '../protocol/msp/encoding/encodeDshotEscDirection';
import {MSP_SET_MOTOR} from '../protocol/msp/commands/motorTestCommands';
import {MSP2_SEND_DSHOT_COMMAND} from '../protocol/msp/commands/mspCommands';
import type {
  MotorTestLease,
  MspOfficialSessionAuthority,
} from '../protocol/motorTestLease';
import type {MspRequestOptions} from '../protocol/mspClient';
import {
  initialMotorControlState,
  reduceMotorControl,
  type MotorControlEffect,
  type MotorControlFaultReason,
  type MotorControlPhase,
  type MotorControlState,
  type MotorControlStopReason,
} from './motorControlStateMachine';

/* ------------------------------------------------------------------ *
 * Port - the only things the engine may reach
 * ------------------------------------------------------------------ */

/**
 * Everything the engine needs from its owning controller, and nothing
 * else. There is deliberately no `MspClient`, no transport, no timer
 * factory and no React binding on this interface: the engine physically
 * cannot construct a second command path.
 */
export interface MotorControlEnginePort {
  /** The controller's own lease. Every request travels it. */
  readonly lease: MotorTestLease;
  /** Captured once by the controller, compared by REFERENCE. */
  readonly authority: MspOfficialSessionAuthority;
  /** The P1-resolved domain for this exact configuration. */
  readonly domain: MotorTestValueDomain;
  /** Request options the controller already uses for its own reads. */
  readonly requestOptions: MspRequestOptions;
  /**
   * The controller's armed-state gate. Must answer `'FRESH_DISARMED'`
   * before any active vector is built. UNKNOWN and STALE are NOT disarmed
   * and must not be treated as one - see P2-ii-J.
   */
  readonly readArmedStateEvidence: () => 'FRESH_DISARMED' | 'FC_ARMED' | 'UNKNOWN_OR_STALE';
  /**
   * Suspends the safety monitor before a priority stop. A read this
   * controller displaced with its own stop is an expected cancellation,
   * never evidence the aircraft became unsafe.
   */
  readonly suspendSafetyMonitor: () => void;
  /** Rebuilds and publishes the controller snapshot. */
  readonly publish: () => void;
  /** Reports a terminal fault to the controller. */
  readonly onFault: (reason: MotorControlFaultReason) => void;
  /**
   * P2-ii Step 4. Reports what happened to ONE dispatched vector, so the
   * legacy compatibility adapter can keep its own PROJECTION in step.
   *
   * It is a notification, not a decision: the engine has already decided
   * and already acted by the time this runs. `SUPERSEDED` means the
   * response arrived for a vector that is no longer current - a stop
   * dominated it, the generation moved, or the authority changed - and it
   * exists precisely so a late acknowledgement can be attributed to the
   * right episode instead of the wrong one.
   */
  readonly onCommandOutcome?: (
    outcome: 'ACKNOWLEDGED' | 'FAILED' | 'SUPERSEDED',
    vector: readonly number[],
  ) => void;
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export type MotorControlCommandRefusal =
  /** The professional path is not enabled, or a stop/fault is in force. */
  | 'NOT_COMMANDABLE'
  /** Lease released, replaced, or the authority moved. */
  | 'AUTHORITY_STALE'
  /** Wrong length, sparse, non-finite, or outside the command domain. */
  | 'INVALID_VECTOR'
  /** Motor index outside 0..motorCount-1. */
  | 'INVALID_MOTOR_INDEX'
  /** The flight controller reported ARMED. */
  | 'FC_ARMED'
  /** No fresh reading proves DISARMED. UNKNOWN is never DISARMED. */
  | 'ARMED_STATE_UNKNOWN_OR_STALE';

export type MotorControlCommandResult =
  /** Submitted now, or coalesced as the single pending vector. */
  | {readonly kind: 'ACCEPTED'; readonly coalesced: boolean}
  | {readonly kind: 'REFUSED'; readonly reason: MotorControlCommandRefusal};

const REFUSED = (
  reason: MotorControlCommandRefusal,
): MotorControlCommandResult => Object.freeze({kind: 'REFUSED' as const, reason});

const ACCEPTED = (coalesced: boolean): MotorControlCommandResult =>
  Object.freeze({kind: 'ACCEPTED' as const, coalesced});

/**
 * What a stop episode achieved. `ACKNOWLEDGED` means the flight controller
 * processed the all-stop frame - it is NEVER a claim that a motor stopped.
 */
/**
 * P2-ii projection facts - the SEMANTIC record of what one stop episode
 * did on the wire, carried on EVERY outcome including the failures.
 *
 * WHY IT EXISTS. The legacy `stopExecution` record needs facts that only
 * the engine can observe, because they come from `MspEmergencyStopDispatch`
 * flags returned at registration time and are gone by the time the frame
 * settles. A previous attempt tried to reconstruct them in the controller
 * and got them wrong - so they are surfaced here, at the only layer that
 * actually knows them.
 *
 * IT IS SEMANTIC, NOT TRANSPORT. No payload, no lease, no client, no frame
 * and no byte appears on this type, and none may be added.
 */
export interface MotorControlStopAttribution {
  /**
   * A real transport write was still in flight when this stop registered.
   * While true, NO deterministic latency bound may be claimed for the stop
   * - the uncancellable write ahead of it settles on the transport's own
   * schedule.
   */
  readonly deferredBehindActiveWrite: boolean;
  /**
   * The stop displaced an already-written request carrying the SAME
   * command, so the first frame that resolved is byte-indistinguishable
   * from this stop's own acknowledgement and proves nothing on its own.
   */
  readonly attributionAmbiguous: boolean;
  /**
   * The ambiguity above was RESOLVED by a second, independently issued
   * all-stop whose acknowledgement could not have been the displaced
   * request's response. The first frame is still never counted as proof -
   * this records that something else supplied it.
   */
  readonly resolvedByConfirmation: boolean;
  /** How many all-stop frames this episode put on the wire: 1, or 2 when
   * a confirmation was required. Zero when nothing was attempted. */
  readonly stopFramesDispatched: number;
}

/**
 * The SUPPLEMENTAL DShot stop, tracked separately from the primary stop.
 *
 * DSHOT_CMD_MOTOR_STOP is additional DShot-specific stop signalling. It is
 * NOT what establishes that the motors were commanded to stop - the
 * MSP_SET_MOTOR all-stop transaction is, including its attribution
 * confirmation where one was required. No pinned firmware evidence
 * establishes that this command is required for correctness, so it may
 * never downgrade a primary stop that was acknowledged.
 */
export type MotorControlDshotSupplementalState =
  /** Not a DShot runtime. No such command exists. */
  | 'NOT_APPLICABLE'
  /** Submitted through the same lease; its response has not arrived. */
  | 'PENDING'
  | 'ACKNOWLEDGED'
  /** The flight controller rejected MSP2 or the command. Expected on
   * firmware without MSP2 support, and never a stop failure. */
  | 'UNSUPPORTED'
  | 'FAILED'
  /** The response arrived after the session it belonged to was replaced,
   * or the primary stop never reached the point of sending it. Recorded
   * rather than attributed to whatever session exists now. */
  | 'SKIPPED_SESSION_INVALID';

export const NO_STOP_ATTRIBUTION: MotorControlStopAttribution = Object.freeze({
  deferredBehindActiveWrite: false,
  attributionAmbiguous: false,
  resolvedByConfirmation: false,
  stopFramesDispatched: 0,
});

export type MotorControlStopOutcome =
  | {
      readonly kind: 'NOT_ATTEMPTED';
      readonly reason: 'AUTHORITY_STALE';
      readonly attribution: MotorControlStopAttribution;
    }
  | {
      readonly kind: 'SCOPE_REJECTED';
      readonly attribution: MotorControlStopAttribution;
    }
  | {
      readonly kind: 'ACKNOWLEDGED';
      /**
       * The supplemental DShot stop's state AT THE MOMENT THE PRIMARY STOP
       * SETTLED - normally `PENDING` or `NOT_APPLICABLE`, because the
       * primary stop deliberately does not wait for it. Its final value
       * lands on the engine snapshot, never on this outcome.
       */
      readonly dshotSupplemental: MotorControlDshotSupplementalState;
      readonly attribution: MotorControlStopAttribution;
    }
  | {
      readonly kind: 'FAILED';
      readonly reason:
        | 'REQUEST_FAILED'
        | 'AUTHORITY_CHANGED'
        /** The stop displaced an already-written MSP_SET_MOTOR and a
         * second all-stop could not disambiguate it. Never a stop. */
        | 'ATTRIBUTION_AMBIGUOUS';
      readonly attribution: MotorControlStopAttribution;
    };

/**
 * The engine's contribution to the controller snapshot.
 *
 * Every field is a fact about THIS process. None is a claim about the
 * aircraft, and there is deliberately no field for physical motor state.
 */
export interface MotorControlEngineSnapshot {
  readonly phase: MotorControlPhase;
  readonly commandable: boolean;
  readonly motorCount: number;
  readonly commandDomainMin: number;
  readonly commandDomainMax: number;
  readonly stopValue: number;
  readonly desiredValues: readonly number[];
  readonly lastDispatchedValues: readonly number[] | undefined;
  readonly lastAcknowledgedValues: readonly number[] | undefined;
  /** True while one vector is waiting behind an in-flight write. */
  readonly pendingCoalescedVector: boolean;
  /** Monotonic. Bumped by every stop, disable and fault. */
  readonly commandGeneration: number;
  readonly stopOutcome: MotorControlStopOutcome | undefined;
  /** Live state of the supplemental DShot stop. Diagnostics only - no UI
   * behaviour depends on it in P2. */
  readonly dshotSupplemental: MotorControlDshotSupplementalState;
  readonly faultReason: MotorControlFaultReason | undefined;
  /** Permanently false. No acknowledgement is mechanical proof. */
  readonly physicalStopConfirmed: false;
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export class MotorControlCommandEngine {
  private readonly port: MotorControlEnginePort;
  private readonly domain: MotorTestValueDomain;

  private state: MotorControlState;

  /** Local intent. Always dense and always motorCount long. */
  private desiredValues: readonly number[];
  private lastDispatchedValues: readonly number[] | undefined;
  private lastAcknowledgedValues: readonly number[] | undefined;

  /**
   * The single coalesced vector waiting behind an in-flight write. Depth
   * one by construction - there is no array and therefore no backlog.
   */
  private pendingDesired: readonly number[] | undefined;

  private activeRequest: Promise<void> | undefined;

  /**
   * Monotonic. Every continuation captures it and re-compares before it
   * dispatches. Bumped synchronously by stop, disable and fault.
   */
  private commandGeneration = 0;

  private stopInFlight: Promise<MotorControlStopOutcome> | undefined;
  private stopOutcome: MotorControlStopOutcome | undefined;
  private faultReason: MotorControlFaultReason | undefined;

  /**
   * Latched true the instant the first active vector is submitted, and
   * NEVER cleared. A submitted vector cannot be recalled, so from here on
   * an unconfirmed stop is unsafe rather than merely unproven.
   */
  private commandMayHaveReachedFc = false;

  /** The supplemental DShot stop's live state. Diagnostics only. */
  private dshotSupplemental: MotorControlDshotSupplementalState =
    'NOT_APPLICABLE';

  constructor(port: MotorControlEnginePort) {
    this.port = port;
    this.domain = port.domain;
    this.state = initialMotorControlState(port.authority);
    this.desiredValues = buildAllStopVectorForDomain(port.domain);
  }

  /* --- lifecycle -------------------------------------------------- */

  /**
   * Marks the professional path enabled. Called by the controller ONLY
   * after its whole enable sequence has succeeded - including the proven
   * disarmed observation and the arming restriction. The reducer lands
   * `EnabledIdle`, never `EnabledCommanding`: the enable flow establishes
   * an all-stop desired vector and sends no active value.
   */
  markEnabled(): void {
    this.apply({authority: this.port.authority, kind: 'ENABLE_REQUESTED'});
    this.apply({authority: this.port.authority, kind: 'ENABLE_COMPLETED'});
  }

  /** Marks an enable attempt failed. Provably no vector was submitted. */
  markEnableFailed(): void {
    this.apply({authority: this.port.authority, kind: 'ENABLE_REQUESTED'});
    this.apply({
      authority: this.port.authority,
      kind: 'ENABLE_FAILED',
      reason: 'ENABLE_FAILED',
    });
  }

  /* --- observation ------------------------------------------------- */

  get phase(): MotorControlPhase {
    return this.state.phase;
  }

  /** True only when the reducer permits commanding right now. */
  isCommandable(): boolean {
    return (
      this.state.phase === 'EnabledIdle' ||
      this.state.phase === 'EnabledCommanding'
    );
  }

  /** True once any active vector has been submitted. Never cleared. */
  get mayHaveReachedFc(): boolean {
    return this.commandMayHaveReachedFc;
  }

  get generation(): number {
    return this.commandGeneration;
  }

  snapshot(): MotorControlEngineSnapshot {
    return Object.freeze({
      phase: this.state.phase,
      commandable: this.isCommandable(),
      motorCount: this.domain.motorCount,
      commandDomainMin: this.domain.commandDomainMin,
      commandDomainMax: this.domain.commandDomainMax,
      stopValue: this.domain.stopValue,
      desiredValues: this.desiredValues,
      lastDispatchedValues: this.lastDispatchedValues,
      lastAcknowledgedValues: this.lastAcknowledgedValues,
      pendingCoalescedVector: this.pendingDesired !== undefined,
      commandGeneration: this.commandGeneration,
      stopOutcome: this.stopOutcome,
      dshotSupplemental: this.dshotSupplemental,
      faultReason: this.faultReason,
      physicalStopConfirmed: false as const,
    });
  }

  /* --- professional command API ------------------------------------ */

  /**
   * THE full-vector operation. Every other command operation reduces to
   * this one - there is no single-motor writer anywhere in this module.
   */
  setMotorValues(values: readonly number[]): MotorControlCommandResult {
    const refusal = this.refuseCommand();
    if (refusal !== undefined) {
      return refusal;
    }

    let vector: readonly number[];
    try {
      // The P1 builder is the validator: exact length, dense, finite,
      // integral and inside the resolved command domain. Nothing is
      // clamped here - a value outside the domain is refused, never
      // silently corrected into a different command.
      vector = buildMotorVector(this.domain, values);
    } catch {
      return REFUSED('INVALID_VECTOR');
    }

    this.desiredValues = vector;
    return this.submitDesired();
  }

  /**
   * Convenience mutation of ONE entry of the desired FULL vector. It
   * travels the identical full-vector path: `[1100,1200,1000,1000]` with
   * `setMotorValue(2, 1300)` becomes `[1100,1200,1300,1000]`, encoded as
   * one MSP_SET_MOTOR frame for every motor.
   */
  setMotorValue(motorIndex: number, value: number): MotorControlCommandResult {
    if (
      !Number.isInteger(motorIndex) ||
      motorIndex < 0 ||
      motorIndex >= this.domain.motorCount
    ) {
      return REFUSED('INVALID_MOTOR_INDEX');
    }
    const next = Array.from(this.desiredValues);
    next[motorIndex] = value;
    return this.setMotorValues(next);
  }

  /**
   * Sets every motor to one value. There is no special MSP command for
   * this and no four-motor assumption - it is `[value x motorCount]`
   * through the same full-vector path.
   */
  setMaster(value: number): MotorControlCommandResult {
    const next: number[] = [];
    for (let index = 0; index < this.domain.motorCount; index++) {
      next.push(value);
    }
    return this.setMotorValues(next);
  }

  /**
   * Sets every motor to the DOMAIN's stop value as an ordinary command.
   *
   * NOT a safety stop: reaching stop deliberately is an ordinary
   * completion, and the reducer classifies `VALUES_TO_STOP` accordingly.
   * A safety stop is `stopAll()`, which takes the priority route.
   *
   * The value is `domain.stopValue`, never a literal. For digital 3D that
   * is PWM_RANGE_MIDDLE (1500), not 1000 - assuming 1000 there would
   * command FULL REVERSE.
   */
  setValuesToStop(): MotorControlCommandResult {
    return this.setMaster(this.domain.stopValue);
  }

  /* --- stop -------------------------------------------------------- */

  /**
   * THE DOMINATING STOP. Everything that makes a stop dominate happens
   * SYNCHRONOUSLY, before this method returns and before any await:
   *
   *   1. the reducer moves to `Stopping`, so it stops authorizing commands;
   *   2. the command generation is bumped, so every continuation created
   *      under the old generation is already invalid;
   *   3. the coalesced pending vector is DISCARDED - it never goes on the
   *      wire, whatever settles afterwards;
   *   4. the desired vector becomes all-stop, so nothing later re-derives
   *      an active value from it;
   *   5. the stop request is REGISTERED, not merely planned.
   *
   * (5) is why this is not left to teardown: a stop that is only scheduled
   * is not a stop.
   */
  stopAll(reason: MotorControlStopReason): Promise<MotorControlStopOutcome> {
    // (1) The reducer first - from this instant SD1 refuses commands.
    this.apply({authority: this.port.authority, kind: 'STOP_TRIGGERED', reason});
    // (2) Every in-flight continuation is now stale.
    this.commandGeneration += 1;
    // (3) The coalesced vector is discarded, never sent.
    this.pendingDesired = undefined;
    // (4) Nothing may re-derive an active value from desired.
    this.desiredValues = buildAllStopVectorForDomain(this.domain);

    // (5) Join an episode already running rather than putting a second
    // stop on the wire behind the first.
    //
    // The JOINED promise is the fully CHAINED one, not the raw operation.
    // Handing a later caller the unchained promise would give two callers
    // two different objects for one episode, and the joiner would observe
    // the outcome BEFORE the reducer had been told about it - so a stop
    // could look settled while the machine was still in `Stopping`.
    const existing = this.stopInFlight;
    if (existing !== undefined) {
      return existing;
    }
    const chained = this.runStop()
      .then(outcome => {
        this.stopInFlight = undefined;
        this.stopOutcome = outcome;
        if (outcome.kind === 'ACKNOWLEDGED') {
          this.apply({
            authority: this.port.authority,
            kind: 'STOP_ACKNOWLEDGED',
          });
        } else {
          // An unconfirmed stop while a vector may be live is exactly the
          // case the operator must be told about. The reducer decides
          // whether that warning is emitted; this only reports the fault.
          this.apply({
            authority: this.port.authority,
            kind: 'FAULT_RAISED',
            reason:
              outcome.kind === 'FAILED' ? 'STOP_FAILED' : 'STOP_UNCONFIRMED',
          });
        }
        this.port.publish();
        return outcome;
      })
      .catch((error: unknown) => {
        this.stopInFlight = undefined;
        this.apply({
          authority: this.port.authority,
          kind: 'FAULT_RAISED',
          reason: 'STOP_UNCONFIRMED',
        });
        this.port.publish();
        throw error;
      });
    // Assigned before any handler can run: `runStop` is async, so its
    // promise cannot settle synchronously and cannot clear this first.
    this.stopInFlight = chained;
    return chained;
  }

  /**
   * Invalidates every continuation without issuing traffic.
   *
   * For paths where the transport is already gone: a stop cannot be
   * attempted, and faking an acknowledgement would be a lie. The engine
   * simply becomes non-commandable.
   */
  invalidateForSessionLoss(reason: MotorControlFaultReason): void {
    this.commandGeneration += 1;
    this.pendingDesired = undefined;
    this.desiredValues = buildAllStopVectorForDomain(this.domain);
    this.apply({authority: this.port.authority, kind: 'FAULT_RAISED', reason});
  }

  /* --- internals --------------------------------------------------- */

  private apply(event: Parameters<typeof reduceMotorControl>[1]): void {
    const transition = reduceMotorControl(this.state, event);
    this.state = transition.state;
    if (this.state.phase === 'Fault') {
      this.faultReason = this.state.faultReason;
    }
    this.consumeEffects(transition.effects);
  }

  /**
   * Effects are recorded, never executed here.
   *
   * `SUBMIT_COMMAND_INTENT` is deliberately NOT acted on inside the
   * reducer callback: the caller that produced the intent is the one
   * holding the vector, and it dispatches explicitly. Turning an intent
   * into a send from inside `apply` would let a reducer transition
   * triggered by an unrelated event resurrect a vector.
   */
  private consumeEffects(effects: readonly MotorControlEffect[]): void {
    for (const effect of effects) {
      if (effect.kind === 'SHOW_STOP_UNCONFIRMED_WARNING') {
        this.port.onFault('STOP_UNCONFIRMED');
      }
    }
  }

  /** Every precondition a command must satisfy, evaluated at CALL TIME. */
  private refuseCommand(): MotorControlCommandResult | undefined {
    if (!this.isCommandable()) {
      return REFUSED('NOT_COMMANDABLE');
    }
    if (!this.isAuthorityCurrent()) {
      return REFUSED('AUTHORITY_STALE');
    }
    const evidence = this.port.readArmedStateEvidence();
    if (evidence === 'FC_ARMED') {
      return REFUSED('FC_ARMED');
    }
    if (evidence !== 'FRESH_DISARMED') {
      // UNKNOWN is NOT DISARMED. P2-ii-J.
      return REFUSED('ARMED_STATE_UNKNOWN_OR_STALE');
    }
    return undefined;
  }

  private isAuthorityCurrent(): boolean {
    const lease = this.port.lease;
    return (
      lease.isActive() &&
      lease.officialSessionAuthority() === this.port.authority
    );
  }

  /**
   * Submits `desiredValues`, or coalesces it behind the in-flight write.
   *
   * LAST-VALUE-WINS, DEPTH ONE. A second call while a write is in flight
   * REPLACES the pending vector; it never appends. Twenty updates during
   * one write leave exactly one vector waiting.
   */
  private submitDesired(): MotorControlCommandResult {
    this.apply({authority: this.port.authority, kind: 'COMMAND_REQUESTED'});
    if (this.activeRequest !== undefined) {
      this.pendingDesired = this.desiredValues;
      this.port.publish();
      return ACCEPTED(true);
    }
    this.dispatch(this.desiredValues);
    this.port.publish();
    return ACCEPTED(false);
  }

  /**
   * Encodes and submits one vector through the ordinary leased FIFO.
   *
   * The stop deliberately does NOT share this route - it takes the
   * priority route, which is what lets it displace this very request.
   */
  private dispatch(vector: readonly number[]): void {
    const generation = this.commandGeneration;
    let payload: Uint8Array;
    try {
      payload = encodeMotorTestCommandVector(
        buildCommandVectorFromValues(this.domain, vector),
        this.domain,
      );
    } catch {
      // Zero transport traffic on an encoding refusal.
      this.apply({
        authority: this.port.authority,
        kind: 'COMMAND_FAILED',
        reason: 'COMMAND_FAILED',
      });
      return;
    }

    // Latched BEFORE the write call, never after: from the instant the
    // request is handed over, the vector may reach the aircraft.
    this.commandMayHaveReachedFc = true;
    this.lastDispatchedValues = vector;

    const request = this.port.lease
      .request(MSP_SET_MOTOR, payload, this.port.requestOptions)
      .then(() => {
        this.activeRequest = undefined;
        // THE CROSS-LAYER CHECK. All three must still hold, and they are
        // deliberately independent: a stop bumps the generation AND moves
        // the reducer, so either alone would already refuse.
        if (
          generation !== this.commandGeneration ||
          !this.isAuthorityCurrent() ||
          !this.isCommandable()
        ) {
          // A late acknowledgement for a superseded vector. Recorded
          // nowhere as an acknowledgement of the CURRENT desired state,
          // and never able to restore commanding, clear a stop, or
          // dispatch pending work. SD2.
          this.pendingDesired = undefined;
          this.port.onCommandOutcome?.('SUPERSEDED', vector);
          this.port.publish();
          return;
        }
        this.lastAcknowledgedValues = vector;
        this.port.onCommandOutcome?.('ACKNOWLEDGED', vector);
        this.apply({
          authority: this.port.authority,
          kind: 'COMMAND_ACKNOWLEDGED',
        });
        this.drainPending(generation);
        this.port.publish();
      })
      .catch(() => {
        this.activeRequest = undefined;
        if (generation !== this.commandGeneration) {
          // The failure belongs to a superseded generation. A stop has
          // already dominated; nothing further is owed.
          this.pendingDesired = undefined;
          this.port.onCommandOutcome?.('SUPERSEDED', vector);
          return;
        }
        this.port.onCommandOutcome?.('FAILED', vector);
        // A write that failed may still have reached the aircraft, so the
        // reducer takes the stop route rather than faulting immediately.
        this.pendingDesired = undefined;
        this.apply({
          authority: this.port.authority,
          kind: 'COMMAND_FAILED',
          reason: 'COMMAND_FAILED',
        });
        this.port.publish();
      });

    this.activeRequest = request;
  }

  /**
   * Sends the single coalesced vector, if one is still eligible.
   *
   * Re-proves the generation a second time even though the caller just
   * checked it: `apply` ran in between and could have moved the reducer.
   */
  private drainPending(generation: number): void {
    const pending = this.pendingDesired;
    if (pending === undefined) {
      return;
    }
    this.pendingDesired = undefined;
    if (
      generation !== this.commandGeneration ||
      !this.isCommandable() ||
      !this.isAuthorityCurrent()
    ) {
      return;
    }
    // Nothing to send when the acknowledged state already equals what the
    // operator wants - a redundant frame is traffic without meaning.
    if (vectorsEqual(pending, this.lastAcknowledgedValues)) {
      return;
    }
    this.apply({authority: this.port.authority, kind: 'COMMAND_REQUESTED'});
    this.dispatch(pending);
  }

  /**
   * THE CANONICAL STOP PATH.
   *
   * All-stop vector first, through the lease's PRIORITY route, then - for
   * a DShot runtime - the DShot MOTOR_STOP command through the SAME lease.
   * The order is deliberate: the vector is what the ordinary control path
   * understands, and the DShot command is an additional explicit stop for
   * the runtimes that define one. Neither is a claim that a motor stopped.
   */
  private async runStop(): Promise<MotorControlStopOutcome> {
    const lease = this.port.lease;

    /* THE ATTRIBUTION FACTS ARE ACCUMULATED WHERE THEY ARE OBSERVED.
     *
     * `deferredBehindActiveWrite` and `attributionAmbiguous` are reported
     * by the lease AT REGISTRATION TIME and are gone by the time the frame
     * settles, so they must be captured here rather than reconstructed by
     * a caller afterwards. Every exit below carries the facts true at that
     * exit - including the failures, which the legacy projection needs
     * just as much as the successes. */
    let deferredBehindActiveWrite = false;
    let attributionAmbiguous = false;
    let resolvedByConfirmation = false;
    let stopFramesDispatched = 0;
    const attribution = (): MotorControlStopAttribution =>
      Object.freeze({
        deferredBehindActiveWrite,
        attributionAmbiguous,
        resolvedByConfirmation,
        stopFramesDispatched,
      });

    if (!this.isAuthorityCurrent()) {
      return {
        kind: 'NOT_ATTEMPTED',
        reason: 'AUTHORITY_STALE',
        attribution: attribution(),
      };
    }

    let payload: Uint8Array;
    try {
      // The canonical stop: all eight slots at the resolved stop value.
      // It needs NO topology read of its own - the domain was captured at
      // activation - which is what lets a teardown stop the aircraft after
      // a mixer or motor-config read has already started failing.
      payload = encodeMotorTestCommandVector(
        buildAllStopCommandVector(this.domain),
        this.domain,
      );
    } catch {
      return {kind: 'SCOPE_REJECTED', attribution: attribution()};
    }

    // A read this controller displaced with its own stop is an expected
    // cancellation, never evidence the aircraft became unsafe.
    this.port.suspendSafetyMonitor();

    const dispatch = lease.emergencyStop(
      MSP_SET_MOTOR,
      payload,
      this.port.requestOptions,
    );
    stopFramesDispatched += 1;
    deferredBehindActiveWrite = dispatch.deferredBehindActiveWrite;
    attributionAmbiguous = dispatch.attributionAmbiguous;

    try {
      await dispatch.frame;
    } catch {
      return {
        kind: 'FAILED',
        reason: 'REQUEST_FAILED',
        attribution: attribution(),
      };
    }

    if (!this.isAuthorityCurrent()) {
      return {
        kind: 'FAILED',
        reason: 'AUTHORITY_CHANGED',
        attribution: attribution(),
      };
    }

    // ATTRIBUTION AMBIGUITY, AND WHY IT MATTERS MORE HERE THAN IT EVER DID
    // ON THE PULSE PATH.
    //
    // The priority stop purges the FIFO and displaces whatever request was
    // already written. When the displaced request carried MSP_SET_MOTOR -
    // which on this path is the COMMON case, because pressing STOP while a
    // slider write is in flight is ordinary use rather than an edge case -
    // a late frame belonging to the displaced write is byte-indistinguishable
    // from this stop's own acknowledgement and WILL match it. So the first
    // frame proves nothing and is discarded as proof.
    //
    // The resolution is a counting argument, not optimism: at most ONE
    // non-stop MSP_SET_MOTOR can be outstanding (the engine holds exactly
    // one request in flight and coalesces the rest), the link answers a
    // single serialized FIFO in order, and both writes carry the identical
    // all-stop payload. Issuing one more all-stop therefore buys an
    // acknowledgement that provably belongs to an all-stop frame.
    if (attributionAmbiguous) {
      const confirmation = lease.emergencyStop(
        MSP_SET_MOTOR,
        payload,
        this.port.requestOptions,
      );
      stopFramesDispatched += 1;
      try {
        await confirmation.frame;
      } catch {
        return {
          kind: 'FAILED',
          reason: 'REQUEST_FAILED',
          attribution: attribution(),
        };
      }
      if (!this.isAuthorityCurrent()) {
        return {
          kind: 'FAILED',
          reason: 'AUTHORITY_CHANGED',
          attribution: attribution(),
        };
      }
      if (confirmation.attributionAmbiguous) {
        // A second ambiguity would mean the counting argument does not
        // hold. This must fail closed rather than resolve on an
        // assumption, and the lease is failed closed so the identity
        // cannot be reused.
        lease.failClosed();
        return {
          kind: 'FAILED',
          reason: 'ATTRIBUTION_AMBIGUOUS',
          attribution: attribution(),
        };
      }
      resolvedByConfirmation = true;
    }

    /* THE PRIMARY STOP IS COMPLETE HERE, AND THAT IS THE WHOLE POINT.
     *
     * The all-stop transaction is acknowledged and, where attribution was
     * ambiguous, independently confirmed. The supplemental DShot command
     * is SUBMITTED but deliberately NOT awaited: it is best-effort
     * signalling that cannot repair an unresolved attribution and cannot
     * make an acknowledged stop unacknowledged, so letting it decide when
     * this promise settles would give an optional round trip control over
     * whether the whole session ever leaves Stopping.
     *
     * It is not fire-and-forget either. It travels the SAME lease under
     * the SAME authority, and its continuation re-proves the generation
     * and the authority before recording anything - so it can never write
     * into, or report against, a session that replaced this one. */
    this.beginSupplementalDshotStop(this.commandGeneration);
    return Object.freeze({
      kind: 'ACKNOWLEDGED' as const,
      dshotSupplemental: this.dshotSupplemental,
      attribution: attribution(),
    });
  }

  /**
   * Submits the supplemental DShot MOTOR_STOP, for DShot runtimes only.
   *
   * Returns immediately. The result lands on `dshotSupplemental` and on
   * the engine snapshot; it never reaches a `MotorControlStopOutcome`,
   * never changes the reducer, and never touches `desiredValues` or
   * `lastAcknowledgedValues` - those describe the MSP_SET_MOTOR vector,
   * which this command is not.
   */
  private beginSupplementalDshotStop(generation: number): void {
    if (this.domain.protocolFamily !== 'DSHOT') {
      this.dshotSupplemental = 'NOT_APPLICABLE';
      return;
    }
    let payload: Uint8Array;
    try {
      payload = encodeDshotMotorStopCommand();
    } catch {
      this.dshotSupplemental = 'FAILED';
      return;
    }
    if (!this.isAuthorityCurrent()) {
      this.dshotSupplemental = 'SKIPPED_SESSION_INVALID';
      return;
    }

    this.dshotSupplemental = 'PENDING';
    // The request is submitted NOW, on the same lease, while the authority
    // is still current. Only its RESULT is deferred - and both handlers
    // are attached immediately, so the promise can never become an
    // unhandled rejection.
    this.port.lease
      .requestOptional(MSP2_SEND_DSHOT_COMMAND, payload, {wireFormat: 'v2'})
      .then(
        () => {
          this.recordSupplementalResult(generation, 'ACKNOWLEDGED');
        },
        () => {
          // Rejected or unsupported. The all-stop vector already succeeded,
          // so this is never promoted into a stop failure.
          this.recordSupplementalResult(generation, 'UNSUPPORTED');
        },
      );
  }

  /**
   * Records a supplemental result, but only for the session it belonged
   * to. A response that outlived its generation or its authority is
   * recorded as skipped rather than attributed to whatever exists now.
   */
  private recordSupplementalResult(
    generation: number,
    result: MotorControlDshotSupplementalState,
  ): void {
    if (generation !== this.commandGeneration || !this.isAuthorityCurrent()) {
      this.dshotSupplemental = 'SKIPPED_SESSION_INVALID';
      return;
    }
    this.dshotSupplemental = result;
    this.port.publish();
  }
}

/** Structural equality for two command vectors. */
function vectorsEqual(
  left: readonly number[],
  right: readonly number[] | undefined,
): boolean {
  if (right === undefined || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
