/**
 * Phase 2E (P4) - tests for the authoritative motor-test session binding.
 *
 * NO HARDWARE: no flight controller, no USB, no serial session, no motor,
 * no LiPo, no device. The transport is the repository's existing
 * FakeMspTransport; the `MspClient`s, the telemetry registry, the real
 * scheduler factory and the real controller are all production objects.
 *
 * The claim under test is structural: the A-scheduler / B-anchor / B-lease
 * composition that the P4 probe built from the low-level registry API has
 * NO REPRESENTATION through this production path.
 */

import {
  createMotorTestSessionBinding,
  type MotorTestSessionCapability,
} from './motorTestSessionBinding';
import {MotorTestTelemetryRegistry} from '../../../core/protocol/telemetry/motorTestTelemetryBarrier';
import {MspClient} from '../../../core/protocol/mspClient';
import {createMotorTestController} from '../../../core/state/motorTestController';
import {FakeMspTransport} from '../../../core/protocol/__testUtils__/mspFakeTransport';
import type {MspSessionCompositeIdentity} from '../../../core/protocol/motorTestLease';

const IDENTITY: MspSessionCompositeIdentity = {
  physicalGeneration: 3,
  mspEpoch: 0,
};

let counter = 0;
function makeClient(): MspClient {
  counter += 1;
  return new MspClient(new FakeMspTransport(), `binding-client-${counter}`);
}

function portInput() {
  return {
    readCurrentIdentity: () => ({...IDENTITY}),
    subscribeSessionInvalidated: () => () => undefined,
  };
}

describe('createMotorTestSessionBinding - A/A construction', () => {
  it('mints the anchor for the exact captured client', async () => {
    const registry = new MotorTestTelemetryRegistry();
    const clientA = makeClient();
    const binding = createMotorTestSessionBinding(clientA, {registry});

    // The registry accepts the anchor only for that very reference, so a
    // successful acquisition IS the ownership proof.
    const held = await registry.acquireBarrier(
      binding.telemetrySession,
      clientA,
    );
    expect(held.kind).toBe('ACQUIRED');
    if (held.kind === 'ACQUIRED') {
      held.release();
    }
    binding.close();
  });

  it('gives the controller the same client reference throughout', () => {
    const registry = new MotorTestTelemetryRegistry();
    const clientA = makeClient();
    const binding = createMotorTestSessionBinding(clientA, {registry});

    const deps = binding.controllerDependencies(portInput(), () => 0);
    expect(deps.session.client).toBe(clientA);
    expect(deps.telemetrySession).toBe(binding.telemetrySession);
    expect(deps.telemetryRegistry).toBe(registry);
    binding.close();
  });

  it('registers every scheduler it creates under its own anchor', async () => {
    const registry = new MotorTestTelemetryRegistry();
    const clientA = makeClient();
    const binding = createMotorTestSessionBinding(clientA, {registry});

    expect(registry.registeredSchedulerCount(binding.telemetrySession)).toBe(0);
    binding.createScheduler({singleFlight: true});
    expect(registry.registeredSchedulerCount(binding.telemetrySession)).toBe(1);
    binding.createScheduler();
    expect(registry.registeredSchedulerCount(binding.telemetrySession)).toBe(2);

    // And both are genuinely held by a barrier taken for the same client.
    const held = await registry.acquireBarrier(
      binding.telemetrySession,
      clientA,
    );
    expect(held.kind).toBe('ACQUIRED');
    if (held.kind === 'ACQUIRED') {
      held.release();
    }
    binding.close();
  });

  it('drives the real controller to Ready-eligible dependencies', () => {
    const registry = new MotorTestTelemetryRegistry();
    const clientA = makeClient();
    const binding = createMotorTestSessionBinding(clientA, {registry});
    const controller = createMotorTestController(
      binding.controllerDependencies(portInput(), () => 0),
    );
    // The public surface is unchanged by the binding.
    expect(Object.keys(controller).sort()).toEqual([
      'close',
      'getSnapshot',
      'initializeSession',
      // Phase 2G's one activating operation. The binding does not add,
      // remove or wrap it - it is the controller's own surface, unchanged.
      'pulseMotor',
      'requestStop',
      'subscribe',
    ]);
    binding.close();
  });
});

describe('createMotorTestSessionBinding - A/B is unrepresentable', () => {
  it('exposes no member that could name a second client', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});
    const surface = binding as unknown as Record<string, unknown>;

    expect(Object.keys(binding).sort()).toEqual([
      'close',
      'controllerDependencies',
      'createScheduler',
      'isOpen',
      'lifecycleStopPort',
      'operatorPort',
      'telemetrySession',
    ]);
    for (const forbidden of [
      'client',
      'setClient',
      'registerScheduler',
      'attachScheduler',
      'adoptScheduler',
      'openSession',
      'rebind',
      'withClient',
    ]) {
      expect(surface[forbidden]).toBeUndefined();
    }
    binding.close();
  });

  it('cannot have a foreign client smuggled in through the port input', () => {
    const registry = new MotorTestTelemetryRegistry();
    const clientA = makeClient();
    const clientB = makeClient();
    const binding = createMotorTestSessionBinding(clientA, {registry});

    // A caller may try; the type has no `client` member and the binding
    // overwrites it from the captured reference regardless.
    const smuggled = {
      ...portInput(),
      client: clientB,
    } as unknown as ReturnType<typeof portInput>;
    const deps = binding.controllerDependencies(smuggled, () => 0);

    expect(deps.session.client).toBe(clientA);
    expect(deps.session.client).not.toBe(clientB);
    binding.close();
  });

  it("a foreign client cannot acquire this binding's anchor", async () => {
    const registry = new MotorTestTelemetryRegistry();
    const clientA = makeClient();
    const clientB = makeClient();
    const binding = createMotorTestSessionBinding(clientA, {registry});

    const attempt = await registry.acquireBarrier(
      binding.telemetrySession,
      clientB,
    );
    expect(attempt.kind).toBe('NOT_ACQUIRED');
    if (attempt.kind === 'NOT_ACQUIRED') {
      expect(attempt.reason).toBe('SESSION_CLIENT_MISMATCH');
    }
    binding.close();
  });

  it('equal composite values do not substitute for reference identity', async () => {
    const registry = new MotorTestTelemetryRegistry();
    const clientA = makeClient();
    const clientB = makeClient();
    // Structurally indistinguishable: both fresh clients are at epoch 0.
    expect(clientA.getEpoch()).toBe(clientB.getEpoch());
    expect({physicalGeneration: 3, mspEpoch: clientA.getEpoch()}).toEqual({
      physicalGeneration: 3,
      mspEpoch: clientB.getEpoch(),
    });
    expect(clientA).not.toBe(clientB);

    const binding = createMotorTestSessionBinding(clientA, {registry});
    const attempt = await registry.acquireBarrier(
      binding.telemetrySession,
      clientB,
    );
    expect(attempt.kind).toBe('NOT_ACQUIRED');
    binding.close();
  });
});

describe('createMotorTestSessionBinding - lifetime', () => {
  it('close() unregisters schedulers, closes the anchor and is idempotent', async () => {
    const registry = new MotorTestTelemetryRegistry();
    const clientA = makeClient();
    const binding = createMotorTestSessionBinding(clientA, {registry});
    binding.createScheduler();
    binding.createScheduler();
    expect(registry.registeredSchedulerCount(binding.telemetrySession)).toBe(2);
    expect(binding.isOpen()).toBe(true);

    binding.close();
    expect(binding.isOpen()).toBe(false);
    expect(registry.isSessionOpen(binding.telemetrySession)).toBe(false);
    expect(registry.registeredSchedulerCount(binding.telemetrySession)).toBe(0);

    binding.close();
    expect(binding.isOpen()).toBe(false);

    const afterClose = await registry.acquireBarrier(
      binding.telemetrySession,
      clientA,
    );
    expect(afterClose.kind).toBe('NOT_ACQUIRED');
    if (afterClose.kind === 'NOT_ACQUIRED') {
      expect(afterClose.reason).toBe('SESSION_UNKNOWN');
    }
  });

  it('releases every pause token held when the anchor closes', async () => {
    const registry = new MotorTestTelemetryRegistry();
    const clientA = makeClient();
    const binding = createMotorTestSessionBinding(clientA, {registry});
    const scheduler = binding.createScheduler();

    const held = await registry.acquireBarrier(
      binding.telemetrySession,
      clientA,
    );
    expect(held.kind).toBe('ACQUIRED');
    // A paused scheduler dispatches nothing; closing must give it back.
    binding.close();
    if (held.kind === 'ACQUIRED') {
      expect(held.isHeld()).toBe(false);
    }
    // The scheduler object survives; it is simply no longer held.
    expect(typeof scheduler.tick).toBe('function');
  });

  it('a closed binding cannot be revived by a newer client', async () => {
    const registry = new MotorTestTelemetryRegistry();
    const oldClient = makeClient();
    const binding = createMotorTestSessionBinding(oldClient, {registry});
    binding.close();

    // Reconnect: same textual session id, brand-new client.
    const newClient = new MspClient(
      new FakeMspTransport(),
      'binding-client-reused-id',
    );
    const revived = await registry.acquireBarrier(
      binding.telemetrySession,
      newClient,
    );
    expect(revived.kind).toBe('NOT_ACQUIRED');

    // The replacement gets its own capability, and it works.
    const replacement = createMotorTestSessionBinding(newClient, {registry});
    expect(replacement.telemetrySession).not.toBe(binding.telemetrySession);
    const held = await registry.acquireBarrier(
      replacement.telemetrySession,
      newClient,
    );
    expect(held.kind).toBe('ACQUIRED');
    if (held.kind === 'ACQUIRED') {
      held.release();
    }
    replacement.close();
  });

  it('creating a scheduler after close does not resurrect the anchor', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding: MotorTestSessionCapability = createMotorTestSessionBinding(
      makeClient(),
      {registry},
    );
    binding.close();
    binding.createScheduler();
    expect(registry.isSessionOpen(binding.telemetrySession)).toBe(false);
    expect(registry.registeredSchedulerCount(binding.telemetrySession)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * B-2E-1 - one controller per session, two sealed facades
 * ------------------------------------------------------------------ */

describe('B-2E-1 - single authoritative controller', () => {
  const portArgs = () => [portInput(), () => 0] as const;

  it('constructs exactly one controller and reuses it', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});

    const first = binding.operatorPort(...portArgs());
    const second = binding.operatorPort(...portArgs());
    // Different facades, SAME underlying controller: their snapshots are
    // the same object, which only one controller instance can produce.
    expect(first).not.toBe(second);
    expect(first.getSnapshot()).toBe(second.getSnapshot());
    binding.close();
  });

  it('the lifecycle port shares the operator port controller and authority', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});
    const operator = binding.operatorPort(...portArgs());
    const lifecycle = binding.lifecycleStopPort();
    expect(lifecycle).toBeDefined();
    expect(lifecycle?.getSnapshot()).toBe(operator.getSnapshot());
    binding.close();
  });

  it('a lifecycle listener can never bring a controller into existence', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});
    // No operator port taken yet -> no controller -> no stop port.
    expect(binding.lifecycleStopPort()).toBeUndefined();
    // Asking again still does not create one.
    expect(binding.lifecycleStopPort()).toBeUndefined();
    binding.close();
  });

  it('constructing the operator port performs no transport write', async () => {
    const registry = new MotorTestTelemetryRegistry();
    const transport = new FakeMspTransport();
    const client = new MspClient(transport, 'operator-no-write');
    const binding = createMotorTestSessionBinding(client, {registry});

    const operator = binding.operatorPort(...portArgs());
    operator.getSnapshot();
    binding.lifecycleStopPort()?.getSnapshot();
    await Promise.resolve();

    // Zero bytes: no lease, no telemetry pause, no command 99.
    expect(transport.writes).toHaveLength(0);
    expect(operator.getSnapshot().telemetryHeld).toBe(false);
    expect(operator.getSnapshot().machine).toBeUndefined();
    binding.close();
  });

  it('beginSession is the only member that can initiate', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});
    const operator = binding.operatorPort(...portArgs());
    expect(Object.keys(operator).sort()).toEqual([
      'beginSession',
      'endSession',
      'getSnapshot',
      // Phase 2H forwards the controller's ONE activating operation here,
      // on the operator port only. `beginSession` is still the only
      // INITIATION point - pulseMotor cannot create a controller, cannot
      // acquire a lease, cannot pause telemetry and cannot establish
      // command 99; it is refused outright by the controller's own
      // activation gate until beginSession has done all of that.
      'pulseMotor',
      'requestStop',
      'subscribe',
    ]);
    expect(Object.isFrozen(operator)).toBe(true);
    // Proven, not asserted by naming: a freshly bound capability whose
    // session was never begun refuses activation and writes nothing.
    expect(operator.pulseMotor(1)).not.toBe('ACCEPTED');
    binding.close();
  });

  it('keeps the lifecycle stop port structurally incapable of activating a motor', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});
    binding.operatorPort(...portArgs());
    const lifecycle = binding.lifecycleStopPort();
    // Phase 2H: pulseMotor is deliberately ABSENT here. A navigation,
    // back or AppState listener must never be able to start a motor.
    expect(Object.keys(lifecycle ?? {})).not.toContain('pulseMotor');
    expect(
      (lifecycle as unknown as Record<string, unknown>).pulseMotor,
    ).toBeUndefined();
    binding.close();
  });

  it('the lifecycle facade cannot initialize, close or reach internals', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});
    binding.operatorPort(...portArgs());
    const lifecycle = binding.lifecycleStopPort();
    expect(Object.keys(lifecycle ?? {}).sort()).toEqual([
      'getSnapshot',
      'requestStop',
    ]);
    expect(Object.isFrozen(lifecycle)).toBe(true);
    const surface = lifecycle as unknown as Record<string, unknown>;
    for (const forbidden of [
      'beginSession',
      'initializeSession',
      'close',
      'endSession',
      'client',
      'controller',
      'subscribe',
    ]) {
      expect(surface[forbidden]).toBeUndefined();
    }
    binding.close();
  });

  it('closing the binding also closes the controller it owned', async () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});
    const operator = binding.operatorPort(...portArgs());
    binding.close();
    // Phase 2F made teardown genuinely asynchronous (it awaits the
    // command-214 stop attempt), so settling now takes more than one
    // microtask. The assertion itself is unchanged.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    expect(operator.getSnapshot().phase).toBe('CLOSED');
    // And the shared facade is gone with it.
    expect(binding.lifecycleStopPort()).toBeUndefined();
  });

  it('a replacement session gets a different controller entirely', () => {
    const registry = new MotorTestTelemetryRegistry();
    const first = createMotorTestSessionBinding(makeClient(), {registry});
    const firstSnapshot = first.operatorPort(...portArgs()).getSnapshot();
    first.close();

    const second = createMotorTestSessionBinding(makeClient(), {registry});
    const secondSnapshot = second.operatorPort(...portArgs()).getSnapshot();
    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(second.telemetrySession).not.toBe(first.telemetrySession);
    second.close();
  });
});

/* ------------------------------------------------------------------ *
 * REPAIR PASS R1 - THE REAL PRODUCTION BINDING CANNOT ACTIVATE
 *
 * This file deliberately does NOT mock the continuous-safety-monitor
 * module. Everything below runs against the REAL production reader, the
 * REAL binding, the REAL controller and the REAL request engine, so it
 * proves the shipped path - not a test-configured one.
 *
 * NO HARDWARE: FakeMspTransport only; no USB, FC, ESC, LiPo or motor.
 * ------------------------------------------------------------------ */

describe('R1 - production binding fails closed without continuous monitoring', () => {
  const portArgs = () => [portInput(), () => 0] as const;

  it('refuses activation through the real operator port and writes nothing', async () => {
    const registry = new MotorTestTelemetryRegistry();
    const client = makeClient();
    const binding = createMotorTestSessionBinding(client, {registry});
    const operator = binding.operatorPort(...portArgs());

    // Before any session work: already blocked, and blocked for THIS
    // reason - not merely "not ready yet".
    const initial = operator.getSnapshot();
    expect(initial.continuousSafetyMonitoring).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
    expect(initial.activation.allowed).toBe(false);
    expect(initial.activation.reasons).toContain(
      'CONTINUOUS_SAFETY_MONITORING_UNAVAILABLE',
    );

    // Activation is refused, and refused BEFORE any transport traffic.
    expect(operator.pulseMotor(1)).not.toBe('ACCEPTED');
    for (const motor of [1, 2, 3, 4]) {
      expect(operator.pulseMotor(motor)).not.toBe('ACCEPTED');
    }

    const after = operator.getSnapshot();
    expect(after.pulse.attemptId).toBe(0);
    expect(after.pulse.submitted).toBe(false);
    expect(after.pulse.mayHaveReachedFc).toBe(false);
    expect(after.pulse.deadlineArmedAtSubmission).toBe(false);
    expect(after.verificationReceipt).toBeUndefined();

    binding.close();
  });

  it('keeps the reason present on the real binding no matter how the port is taken', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});
    // Both facades read the SAME controller, so both must agree.
    const operator = binding.operatorPort(...portArgs());
    const lifecycle = binding.lifecycleStopPort();

    expect(operator.getSnapshot().activation.reasons).toContain(
      'CONTINUOUS_SAFETY_MONITORING_UNAVAILABLE',
    );
    expect(lifecycle?.getSnapshot().activation.reasons).toContain(
      'CONTINUOUS_SAFETY_MONITORING_UNAVAILABLE',
    );
    expect(operator.getSnapshot().activation.allowed).toBe(false);
    expect(lifecycle?.getSnapshot().activation.allowed).toBe(false);
    binding.close();
  });

  it('exposes no way through the binding to mark monitoring available', () => {
    const registry = new MotorTestTelemetryRegistry();
    const binding = createMotorTestSessionBinding(makeClient(), {registry});
    const operator = binding.operatorPort(...portArgs());

    const surface = operator as unknown as Record<string, unknown>;
    for (const forbidden of [
      'setContinuousSafetyMonitoring',
      'continuousSafetyMonitoring',
      'setMonitoring',
      'enableMonitoring',
      'overrideActivation',
      'setActivationAllowed',
    ]) {
      expect(surface[forbidden]).toBeUndefined();
    }
    const bindingSurface = binding as unknown as Record<string, unknown>;
    for (const forbidden of [
      'setContinuousSafetyMonitoring',
      'enableMonitoring',
      'overrideActivation',
    ]) {
      expect(bindingSurface[forbidden]).toBeUndefined();
    }
    binding.close();
  });
});
