/**
 * Phase 2E - the AUTHORITATIVE MOTOR-TEST SESSION BINDING (P4).
 *
 * WHAT THIS CLOSES
 * ----------------
 * Phase 2D's correction B-1 made the registry reject an anchor that
 * belongs to a different client. That closed the *composition* the
 * controller could see, but not the one an assembler could still build:
 * the low-level registry API let a caller register schedulers polling
 * client A under an anchor minted for client B, hand the controller B,
 * and reach `Ready` - every individual check passing while the paused
 * schedulers described a different link from the leased one.
 *
 * The fix is to remove the assembler. This module is the ONLY production
 * path to a motor-test telemetry session, and it is built around one
 * captured `MspClient` reference:
 *
 *   - the client is a CONSTRUCTOR argument and is never a parameter of
 *     anything a consumer calls afterwards;
 *   - the anchor is minted here, by `openSession(client)`, for that exact
 *     reference;
 *   - schedulers are CREATED here, from that exact reference, and
 *     registered here. `registerScheduler` is never exposed, so a
 *     foreign scheduler has no way in;
 *   - the controller's dependency object is assembled here, with the
 *     client filled in by this module rather than by its caller.
 *
 * So the A/B composition is not "rejected at runtime" - it is
 * UNREPRESENTABLE through the production API. There is no argument a
 * caller can pass that would name a second client.
 *
 * REFERENCE IDENTITY, NOT VALUES. Everything above turns on the object
 * reference. Two genuinely different clients routinely report equal
 * `physicalGeneration`/`mspEpoch` scalars (a fresh client starts at epoch
 * 0), so a value comparison would accept exactly the incoherence this
 * exists to prevent.
 *
 * WHAT IT IS NOT. It constructs no MSP frame, owns no transport, sends
 * nothing, and confers no motor capability. It can create polls and hold
 * a telemetry anchor; it can never write.
 */

// Deep imports on purpose. The motor-test modules are deliberately ABSENT
// from `src/core`'s public barrel (a Phase 2D containment property), and
// Phase 2E does not relax that: making the binding reachable must not also
// publish the controller, the registry or the reducer to every consumer of
// `../../../core`.
import {
  createMspTelemetryScheduler,
  type MspTelemetryScheduler,
  type MspTelemetrySchedulerOptions,
} from '../../../core/protocol/telemetry/MspTelemetryScheduler';
import {
  MotorTestTelemetryRegistry,
  type MotorTestTelemetrySession,
} from '../../../core/protocol/telemetry/motorTestTelemetryBarrier';
import type { MspClient } from '../../../core/protocol/mspClient';
import {
  isMotorConfigurationTransactionActive,
  MotorConfigurationTransactionInProgressError,
} from './motorConfigurationInterlock';
import {
  createMotorTestController,
  type MotorTestController,
  type MotorTestControllerDependencies,
  type MotorTestControllerSessionPort,
  type MotorTestControllerSnapshot,
  type MotorTestControllerUnsubscribe,
  type MotorTestPulseRequestResult,
  type MotorTestStopRequestResult,
} from '../../../core/state/motorTestController';
import type { MotorTestStopTriggerReason } from '../../../core/state/motorTestStateMachine';

/**
 * The session port members a consumer is allowed to supply.
 *
 * `client` is deliberately ABSENT. It is not "optional" or "overridable";
 * the type makes it impossible to name, and this module fills it in from
 * the captured reference. That is the whole P4 guarantee expressed in the
 * type system as well as at runtime.
 */
export type MotorTestSessionPortInput = Omit<
  MotorTestControllerSessionPort,
  'client'
>;

/**
 * B-2E-1 / Option C - the OPERATOR CONTROL PORT.
 *
 * A sealed facade over the ONE controller this capability owns. It is the
 * only place in the application permitted to INITIATE a motor-test
 * session, and `beginSession()` is the only method that can do it.
 *
 * Nothing about it exposes the controller, the client, the lease, the
 * authority token or any mutable internal - a holder can start, read,
 * observe and end, and nothing else.
 */
export interface MotorTestOperatorPort {
  /**
   * THE ONLY INITIATION POINT. Must be reached from explicit operator
   * action after the screen's safety gate; nothing may call it on mount.
   * Idempotent - the controller returns the same operation.
   */
  beginSession(): Promise<MotorTestControllerSnapshot>;
  getSnapshot(): MotorTestControllerSnapshot;
  subscribe(listener: () => void): MotorTestControllerUnsubscribe;
  /**
   * Phase 2H - the ONE activating operation, forwarded unchanged from the
   * controller. It takes an MSP output slot (1..4) and nothing else: the
   * magnitude, the duration, the vector, the command and the encoding are
   * all fixed by the controller and cannot be influenced from here or
   * from any consumer of this port.
   *
   * Present on the OPERATOR port only. The lifecycle stop port below
   * deliberately does not have it - a navigation, back or AppState
   * listener must remain structurally incapable of starting a motor.
   */
  pulseMotor(motorNumber: number): MotorTestPulseRequestResult;
  /** Renews only an already-live pulse's touch-owner fail-safe. */
  renewPulseHold(): import('../../../core/state/motorTestController').MotorTestHoldHeartbeatResult;
  setEscDirection(
    motorNumber: number,
    direction: import('../../../core').DshotEscDirection,
  ): Promise<import('../../../core/state/motorTestController').MotorTestEscDirectionOutcome>;
  refreshDiagnostics(): Promise<import('../../../core/state/motorTestController').MotorTestDiagnosticsSnapshot>;
  /**
   * Phase 2H - the operator's own stop route, forwarded unchanged. The
   * screen that can activate must be able to stop; whitelist-only, exactly
   * as on the lifecycle port.
   */
  requestStop(trigger: MotorTestStopTriggerReason): MotorTestStopRequestResult;
  /** Idempotent teardown of the same controller. */
  endSession(): Promise<MotorTestControllerSnapshot>;

  /* ---- P3: the professional facade, forwarded unchanged. ------------
   * Thin passthroughs to the controller's own frozen surface - the port
   * adds nothing and hides nothing. No long press, no heartbeat, no
   * fixed magnitude and no one-motor restriction exist on this path. */
  setMotorValues(
    values: readonly number[],
  ): import('../../../core/state/motorControlCommandEngine').MotorControlCommandResult;
  setMotorValue(
    motorIndex: number,
    value: number,
  ): import('../../../core/state/motorControlCommandEngine').MotorControlCommandResult;
  setMaster(
    value: number,
  ): import('../../../core/state/motorControlCommandEngine').MotorControlCommandResult;
  /** The canonical professional stop, same funnel as every stop source. */
  stopAll(): MotorTestStopRequestResult;
}

/**
 * B-2E-1 / Option C - the LIFECYCLE STOP PORT.
 *
 * A second sealed facade over the SAME controller instance and the SAME
 * authority. Deliberately narrower than the operator port: it can read
 * and it can request a whitelisted stop. It cannot initialize, cannot
 * close, and cannot reach anything that could start a motor.
 */
export interface MotorTestLifecycleStopPort {
  getSnapshot(): MotorTestControllerSnapshot;
  requestStop(trigger: MotorTestStopTriggerReason): MotorTestStopRequestResult;
}

/**
 * A pre-coherent capability. A consumer may hold it, read from it and
 * close it; it cannot relabel its client or substitute its schedulers.
 */
export interface MotorTestSessionCapability {
  /** The anchor minted for the captured client. Exposed for diagnostics
   * and for the controller dependency object built below - it is inert on
   * its own, and the registry refuses it for any other client. */
  readonly telemetrySession: MotorTestTelemetrySession;
  /**
   * Creates a telemetry scheduler FROM the captured client and registers
   * it under this session's anchor, atomically.
   *
   * This is the only way a scheduler can join the motor-test anchor, so
   * every registered scheduler provably polls the same link the anchor
   * names. The caller chooses poll behaviour; it does not choose the
   * client.
   */
  createScheduler(
    options?: MspTelemetrySchedulerOptions,
  ): MspTelemetryScheduler;
  /**
   * Assembles the controller's dependencies with the captured client and
   * this anchor. The caller supplies only the read/lifecycle members.
   */
  controllerDependencies(
    port: MotorTestSessionPortInput,
    readMonotonicMillis: () => number,
  ): MotorTestControllerDependencies;
  /**
   * B-2E-1: returns the operator facade over THE ONE controller this
   * capability owns, constructing that controller on first call and
   * reusing it forever after. A second call with different arguments gets
   * the SAME controller - first construction wins - so no consumer can
   * cause a parallel controller to exist for one session.
   *
   * Constructing does NOT initiate: no lease, no telemetry pause, no
   * command 99, no transport write. Only `beginSession()` does that.
   */
  operatorPort(
    port: MotorTestSessionPortInput,
    readMonotonicMillis: () => number,
  ): MotorTestOperatorPort;
  /**
   * B-2E-1: the lifecycle facade over that SAME controller, or undefined
   * when no controller exists yet (nobody has taken the operator port).
   * Never constructs one - a lifecycle listener must never be able to
   * bring a motor-test controller into existence.
   */
  lifecycleStopPort(): MotorTestLifecycleStopPort | undefined;
  /** Whether this capability is still usable. */
  isOpen(): boolean;
  /**
   * Ends the binding: unregisters every scheduler this capability
   * created, then closes the anchor. Idempotent. After this, the anchor
   * can never satisfy an acquisition - including one attempted with a
   * newer client.
   */
  close(): void;
}

/** Test-visible seam for the registry, so a suite can drive a real
 * registry it also inspects. Production passes the coordinator's own. */
export interface MotorTestSessionBindingOptions {
  readonly registry?: MotorTestTelemetryRegistry;
}

/**
 * Whether a controller has finished its life and can host nothing further.
 *
 * CLOSED is terminal for a controller, but "closed" alone is not enough to
 * retire it: a close that FAILED also ends here, and that state must keep
 * blocking rather than be swept away by a fresh instance. `teardown.complete`
 * is the controller's own report that exclusivity was released and every
 * teardown step finished - the same signal isMotorTestSnapshotActive() uses
 * to decide a session is genuinely over.
 */
export function isSpentController(controller: {
  getSnapshot(): MotorTestControllerSnapshot;
}): boolean {
  return isSpentSnapshot(controller.getSnapshot());
}

/**
 * The same judgement, from a snapshot the SCREEN already holds.
 *
 * MotorsScreen has to answer two questions a controller cannot answer for
 * it - "may another session start?" and "is this a reason to ask for a new
 * connection?" - and it was answering both from `phase === 'CLOSED'`
 * alone. That is why a healthy, cleanly closed session told the operator
 * to unplug the cable. Exported so the screen and the binding decide with
 * ONE rule instead of two that can drift.
 */
export function isSpentSnapshot(
  snapshot: MotorTestControllerSnapshot | undefined,
): boolean {
  return snapshot?.phase === 'CLOSED' && snapshot.teardown?.complete === true;
}

class MotorTestSessionBinding implements MotorTestSessionCapability {
  readonly telemetrySession: MotorTestTelemetrySession;

  private readonly registry: MotorTestTelemetryRegistry;
  /** The ONE captured reference. Private, never re-assigned, never
   * exposed, and never a parameter of any method below. */
  private readonly client: MspClient;
  private readonly registrations: { unregister(): void }[] = [];
  private closed = false;
  /**
   * The controller this capability is CURRENTLY driving. At most one at a
   * time, never exposed - but no longer "constructed once, forever after".
   * See ensureController() for why a spent one is replaced.
   */
  private controller: MotorTestController | undefined;
  /**
   * Facade subscribers, held here rather than on the controller.
   *
   * A consumer subscribes ONCE, through a frozen facade it keeps for the
   * life of the screen. If that subscription lived on the controller
   * directly, retiring a spent controller would silently orphan it - the
   * screen would go permanently deaf to a session it had just started.
   * The binding owns the listeners and re-attaches them to whichever
   * controller is live, so a swap is invisible from outside.
   */
  private readonly listeners = new Set<() => void>();
  /** Detaches the fan-out from the outgoing controller. */
  private detachFanOut: (() => void) | undefined;

  constructor(client: MspClient, registry: MotorTestTelemetryRegistry) {
    this.client = client;
    this.registry = registry;
    this.telemetrySession = registry.openSession(client);
  }

  /** Points the fan-out at `controller` and notifies once, so a consumer
   * re-reads immediately after a swap instead of waiting for the next
   * publication. */
  private attachFanOut(controller: MotorTestController): void {
    this.detachFanOut?.();
    this.detachFanOut = controller.subscribe(() => {
      // Snapshot first: a listener may unsubscribe during dispatch.
      for (const listener of Array.from(this.listeners)) {
        listener();
      }
    });
  }

  createScheduler(
    options: MspTelemetrySchedulerOptions = {},
  ): MspTelemetryScheduler {
    // Constructed from the captured client - the caller cannot name a
    // different one - and registered in the same statement pair, so a
    // scheduler is never observable outside the anchor it belongs to.
    const scheduler = createMspTelemetryScheduler(this.client, options);
    if (!this.closed) {
      this.registrations.push(
        this.registry.registerScheduler(this.telemetrySession, scheduler),
      );
    }
    return scheduler;
  }

  controllerDependencies(
    port: MotorTestSessionPortInput,
    readMonotonicMillis: () => number,
  ): MotorTestControllerDependencies {
    return Object.freeze({
      // The client comes from HERE, never from `port`. A consumer that
      // tried to smuggle one in would find no field to put it in.
      session: Object.freeze({
        client: this.client,
        readCurrentIdentity: () => port.readCurrentIdentity(),
        readFirmwareIdentification: () =>
          port.readFirmwareIdentification(),
        subscribeFirmwareIdentification: (
          listener: Parameters<
            MotorTestControllerSessionPort['subscribeFirmwareIdentification']
          >[0],
        ) => port.subscribeFirmwareIdentification(listener),
        subscribeSessionInvalidated: (
          listener: Parameters<
            MotorTestControllerSessionPort['subscribeSessionInvalidated']
          >[0],
        ) => port.subscribeSessionInvalidated(listener),
      }),
      telemetryRegistry: this.registry,
      telemetrySession: this.telemetrySession,
      readMonotonicMillis,
    });
  }

  operatorPort(
    port: MotorTestSessionPortInput,
    readMonotonicMillis: () => number,
  ): MotorTestOperatorPort {
    // Exists, but is NOT retired here - taking a port is an observation,
    // not a request for a new session.
    this.ensureControllerExists(port, readMonotonicMillis);
    /**
     * The live controller, resolved AT CALL TIME rather than captured.
     *
     * The facade is frozen and a consumer keeps it for the life of the
     * screen, so a captured reference would go on driving a controller
     * that had been retired - every read reporting the dead session's
     * final state and every command landing on an object that refuses
     * them. Reading resolves the current one; it never builds one, so a
     * getSnapshot() still cannot bring a controller into existence.
     */
    const live = (): MotorTestController =>
      this.ensureControllerExists(port, readMonotonicMillis);
    /**
     * Starting a session is the ONE call allowed to retire a spent
     * controller and build its replacement - see ensureController().
     */
    const forNewSession = (): MotorTestController =>
      this.ensureController(port, readMonotonicMillis);
    // A frozen, capability-scoped facade: no controller, no
    // client, no lease, no authority token, no mutable internal.
    return Object.freeze({
      beginSession: () =>
        isMotorConfigurationTransactionActive(this.client)
          ? Promise.reject(new MotorConfigurationTransactionInProgressError())
          : forNewSession().initializeSession(),
      getSnapshot: () => live().getSnapshot(),
      // Registered with the BINDING, not the controller, so the
      // subscription survives a controller swap - see `listeners`.
      subscribe: (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      pulseMotor: (motorNumber: number) => live().pulseMotor(motorNumber),
      renewPulseHold: () => live().renewPulseHold(),
      setEscDirection: (
        motorNumber: number,
        direction: import('../../../core').DshotEscDirection,
      ) =>
        live().setEscDirection(motorNumber, direction),
      refreshDiagnostics: () => live().refreshDiagnostics(),
      requestStop: (trigger: MotorTestStopTriggerReason) =>
        live().requestStop(trigger),
      endSession: () => live().close(),
      // P3: professional facade forwards.
      setMotorValues: (values: readonly number[]) =>
        live().setMotorValues(values),
      setMotorValue: (motorIndex: number, value: number) =>
        live().setMotorValue(motorIndex, value),
      setMaster: (value: number) => live().setMaster(value),
      stopAll: () => live().stopAll(),
    });
  }

  lifecycleStopPort(): MotorTestLifecycleStopPort | undefined {
    // A closed binding exposes nothing, even though it still holds its
    // last controller so an outstanding facade can read the final state.
    const controller = this.closed ? undefined : this.controller;
    if (controller === undefined) {
      // No controller means no motor-test session was ever initiated. A
      // lifecycle listener must not be the thing that creates one.
      return undefined;
    }
    return Object.freeze({
      getSnapshot: () => controller.getSnapshot(),
      requestStop: (trigger: MotorTestStopTriggerReason) =>
        controller.requestStop(trigger),
    });
  }

  /**
   * The controller to use for a NEW session, building one when the
   * current one cannot host another.
   *
   * THE DEFECT THIS CLOSES. A controller runs IDLE -> PREPARING -> ACTIVE
   * -> CLOSING -> CLOSED and never returns to IDLE; CLOSED is terminal, by
   * design. This method used to return the first controller "forever
   * after", so once a session had been closed the capability was left
   * holding a spent controller, and the screen's own gate - which starts a
   * session only from IDLE - refused every further attempt. Turning the
   * session off and on again did nothing at all, and the only way back was
   * to leave the Motors screen entirely so the whole capability was rebuilt.
   *
   * A spent controller is therefore retired and a fresh one built.
   *
   * ONLY A CLEANLY SPENT ONE. `teardown.complete` is the controller's own
   * statement that exclusivity was released AND every teardown step
   * finished. Anything else - a close that failed, one still in progress,
   * one that never reported - keeps the existing controller, so its
   * unresolved state goes on blocking exactly as before. That matters far
   * more than the convenience: a controller whose stop was never confirmed
   * may correspond to a motor that is still turning, and replacing it with
   * a fresh IDLE one would launder that into "nothing has ever been
   * commanded" for both this gate and the output-engagement predicate.
   * Recovery from a failed close stays where it was - a real teardown, or
   * a new connection.
   */
  private ensureController(
    port: MotorTestSessionPortInput,
    readMonotonicMillis: () => number,
  ): MotorTestController {
    const existing = this.controller;
    // A CLOSED BINDING NEVER BUILDS ANOTHER ONE. Without this, a facade
    // handed out earlier would quietly resurrect the capability: the first
    // read after close() found no controller, built a fresh one, and
    // reported IDLE - a torn-down session presenting itself as a new,
    // never-commanded one. That is the exact laundering the
    // output-engagement predicate exists to prevent.
    if (existing !== undefined && (this.closed || !isSpentController(existing))) {
      return existing;
    }
    return this.buildController(port, readMonotonicMillis);
  }

  /**
   * The controller this capability already has, building one only when it
   * has none at all. NEVER retires a spent one.
   *
   * Taking an operator port, or reading through one, is an OBSERVATION -
   * a screen may hold a port purely to watch a session it did not start.
   * Retiring on that path replaced a just-closed controller the moment
   * anything looked at it, so a self-closed session read back as a fresh
   * IDLE one and its terminal state disappeared. Only starting a new
   * session may retire; see ensureController().
   */
  private ensureControllerExists(
    port: MotorTestSessionPortInput,
    readMonotonicMillis: () => number,
  ): MotorTestController {
    return this.controller ?? this.buildController(port, readMonotonicMillis);
  }

  private buildController(
    port: MotorTestSessionPortInput,
    readMonotonicMillis: () => number,
  ): MotorTestController {
    // Construction alone performs NO I/O: createMotorTestController
    // only wires dependencies. Everything that touches the link happens
    // inside initializeSession(), which only the operator port exposes.
    const controller = createMotorTestController(
      this.controllerDependencies(port, readMonotonicMillis),
    );
    this.controller = controller;
    this.attachFanOut(controller);
    return controller;
  }

  isOpen(): boolean {
    return !this.closed && this.registry.isSessionOpen(this.telemetrySession);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Detach the fan-out before the controller goes: a closing controller
    // may publish, and there is nothing left for a listener to read.
    this.detachFanOut?.();
    this.detachFanOut = undefined;
    this.listeners.clear();
    // The controller first: it owns the lease and the barrier token, and
    // its own seven-step teardown must run while both are still valid.
    // Errors are absorbed so one failure cannot skip the rest.
    //
    // THE REFERENCE IS KEPT, deliberately. A facade already handed out
    // must go on reporting this controller's FINAL state - CLOSED - and
    // clearing the field made the next read build a replacement that
    // reported IDLE instead. `closed` is what prevents anything new being
    // constructed; lifecycleStopPort() below is what stops the retained
    // controller being handed to a lifecycle listener.
    const controller = this.controller;
    if (controller !== undefined) {
      try {
        const closing = controller.close();
        closing.catch(() => undefined);
      } catch {
        // absorbed - the anchor close below must still happen
      }
    }
    // Schedulers next, so nothing is left accounted against a session
    // that is about to disappear; then the anchor, which also releases
    // any barrier still held for it (see closeSession()).
    for (const registration of this.registrations.splice(0)) {
      try {
        registration.unregister();
      } catch {
        // One failed unregistration must never skip the rest, nor the
        // anchor close below.
      }
    }
    this.registry.closeSession(this.telemetrySession);
  }
}

/**
 * The production factory - the only way to obtain a motor-test session
 * capability.
 *
 * There is no exported class and no other entry point, so every
 * capability in existence was built around exactly one client reference.
 */
export function createMotorTestSessionBinding(
  client: MspClient,
  options: MotorTestSessionBindingOptions = {},
): MotorTestSessionCapability {
  const registry = options.registry ?? new MotorTestTelemetryRegistry();
  const binding = new MotorTestSessionBinding(client, registry);
  // A FROZEN FACADE, exactly as `createMotorTestController` does.
  //
  // TypeScript's `private` is erased at runtime: the instance's own
  // `client`, `registry`, `registrations` and `closed` fields would
  // otherwise be plain enumerable properties, and a consumer could read
  // the captured client straight off the capability - or worse, reach the
  // registry and re-pair it by hand. That is precisely the assembler P4
  // exists to remove, so the object handed out carries the five contract
  // members and nothing else.
  return Object.freeze({
    telemetrySession: binding.telemetrySession,
    createScheduler: (options_?: MspTelemetrySchedulerOptions) =>
      binding.createScheduler(options_),
    controllerDependencies: (
      port: MotorTestSessionPortInput,
      readMonotonicMillis: () => number,
    ) => binding.controllerDependencies(port, readMonotonicMillis),
    operatorPort: (
      port: MotorTestSessionPortInput,
      readMonotonicMillis: () => number,
    ) => binding.operatorPort(port, readMonotonicMillis),
    lifecycleStopPort: () => binding.lifecycleStopPort(),
    isOpen: () => binding.isOpen(),
    close: () => {
      binding.close();
    },
  });
}
