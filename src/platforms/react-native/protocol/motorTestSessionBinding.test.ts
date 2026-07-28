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
