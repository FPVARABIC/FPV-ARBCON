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
import type {MspClient} from '../../../core/protocol/mspClient';
import type {
  MotorTestControllerDependencies,
  MotorTestControllerSessionPort,
} from '../../../core/state/motorTestController';

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
  createScheduler(options?: MspTelemetrySchedulerOptions): MspTelemetryScheduler;
  /**
   * Assembles the controller's dependencies with the captured client and
   * this anchor. The caller supplies only the read/lifecycle members.
   */
  controllerDependencies(
    port: MotorTestSessionPortInput,
    readMonotonicMillis: () => number,
  ): MotorTestControllerDependencies;
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

class MotorTestSessionBinding implements MotorTestSessionCapability {
  readonly telemetrySession: MotorTestTelemetrySession;

  private readonly registry: MotorTestTelemetryRegistry;
  /** The ONE captured reference. Private, never re-assigned, never
   * exposed, and never a parameter of any method below. */
  private readonly client: MspClient;
  private readonly registrations: {unregister(): void}[] = [];
  private closed = false;

  constructor(client: MspClient, registry: MotorTestTelemetryRegistry) {
    this.client = client;
    this.registry = registry;
    this.telemetrySession = registry.openSession(client);
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

  isOpen(): boolean {
    return !this.closed && this.registry.isSessionOpen(this.telemetrySession);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Schedulers first, so nothing is left accounted against a session
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
    isOpen: () => binding.isOpen(),
    close: () => {
      binding.close();
    },
  });
}
