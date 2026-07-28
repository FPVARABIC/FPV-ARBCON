/**
 * Phase 2E - adversarial tests for the lifecycle / navigation stop bridge.
 *
 * NO HARDWARE: no flight controller, no USB, no serial session, no motor,
 * no LiPo, no device. The REAL `MotorTestController` (built through the
 * REAL P4 binding, over REAL `MspClient`s and the REAL registry) is driven
 * to a genuine authority; only the platform event sources are doubles,
 * and they are pure subscription seams that cannot send anything.
 *
 * No stop EXECUTOR is faked. The bridge's only outbound call is the
 * controller's own accepted `requestStop`, and that is what these tests
 * exercise.
 */

import {
  createMotorTestLifecycleBridge,
  MOTOR_TEST_LIFECYCLE_TRIGGERS,
  type MotorTestAppStateStatus,
  type MotorTestLifecycleBridgeHandle,
  type MotorTestLifecycleSources,
  type MotorTestSubscription,
} from './motorTestLifecycleBridge';
import {createMotorTestSessionBinding} from '../protocol/motorTestSessionBinding';
import {MotorTestTelemetryRegistry} from '../../../core/protocol/telemetry/motorTestTelemetryBarrier';
import {MspClient} from '../../../core/protocol/mspClient';
import {
  createMotorTestController,
  type MotorTestController,
  type MotorTestControllerSnapshot,
} from '../../../core/state/motorTestController';
import {
  createMotorTestState,
  motorTestTransition,
  type MotorTestState,
} from '../../../core/state/motorTestStateMachine';
import {FakeMspTransport} from '../../../core/protocol/__testUtils__/mspFakeTransport';

/* ------------------------------------------------------------------ *
 * Platform doubles - pure subscription seams
 * ------------------------------------------------------------------ */

class FakeSources implements MotorTestLifecycleSources {
  backListeners: (() => boolean)[] = [];
  appStateListeners: ((status: MotorTestAppStateStatus) => void)[] = [];
  blurListeners: (() => void)[] = [];
  beforeRemoveListeners: ((event: {preventDefault?: () => void}) => void)[] = [];
  removals = 0;
  failOnAppState = false;

  addBackHandler(listener: () => boolean): MotorTestSubscription {
    this.backListeners.push(listener);
    return {
      remove: () => {
        this.removals += 1;
        this.backListeners = this.backListeners.filter(l => l !== listener);
      },
    };
  }

  addAppStateListener(
    listener: (status: MotorTestAppStateStatus) => void,
  ): MotorTestSubscription {
    if (this.failOnAppState) {
      throw new Error('AppState registration failed');
    }
    this.appStateListeners.push(listener);
    return {
      remove: () => {
        this.removals += 1;
        this.appStateListeners = this.appStateListeners.filter(
          l => l !== listener,
        );
      },
    };
  }

  addBlurListener(listener: () => void): () => void {
    this.blurListeners.push(listener);
    return () => {
      this.removals += 1;
      this.blurListeners = this.blurListeners.filter(l => l !== listener);
    };
  }

  addBeforeRemoveListener(
    listener: (event: {preventDefault?: () => void}) => void,
  ): () => void {
    this.beforeRemoveListeners.push(listener);
    return () => {
      this.removals += 1;
      this.beforeRemoveListeners = this.beforeRemoveListeners.filter(
        l => l !== listener,
      );
    };
  }

  /** Mirrors BackHandler.android.js: last registered first, first `true`
   * consumes the event. */
  pressBack(): boolean {
    for (let i = this.backListeners.length - 1; i >= 0; i--) {
      if (this.backListeners[i]()) {
        return true;
      }
    }
    return false;
  }

  emitAppState(status: MotorTestAppStateStatus): void {
    for (const listener of [...this.appStateListeners]) {
      listener(status);
    }
  }

  emitBlur(): void {
    for (const listener of [...this.blurListeners]) {
      listener();
    }
  }

  emitBeforeRemove(event: {preventDefault?: () => void}): void {
    for (const listener of [...this.beforeRemoveListeners]) {
      listener(event);
    }
  }

  get listenerCount(): number {
    return (
      this.backListeners.length +
      this.appStateListeners.length +
      this.blurListeners.length +
      this.beforeRemoveListeners.length
    );
  }
}

/* ------------------------------------------------------------------ *
 * A controller stand-in that exposes a REAL reducer state
 *
 * The reducer, its authority, its transitions and its whitelist are the
 * genuine accepted objects; only `requestStop`'s bookkeeping is observed.
 * Nothing here reimplements the bridge, the reducer or the lease.
 * ------------------------------------------------------------------ */

class ReducerBackedController implements MotorTestController {
  state: MotorTestState;
  readonly authority: object;
  readonly stopCalls: string[] = [];
  refuse: 'ACCEPTED' | 'UNRECOGNIZED_STOP_TRIGGER' | 'CONTROLLER_CLOSED' =
    'ACCEPTED';
  throwOnStop = false;

  constructor(authority: object = {}) {
    this.authority = authority;
    this.state = createMotorTestState(authority);
  }

  /** Drives the REAL reducer along its own accepted path. */
  advance(kind: 'GATES_PASSED' | 'ACTIVATION_ACCEPTED' | 'START_WRITE_CALLED'): void {
    this.state = motorTestTransition(this.state, {
      authority: this.authority,
      kind,
    }).state;
  }

  fault(reason: 'USB_DETACHED' | 'MSP_RESPONSE_TIMEOUT'): void {
    this.state = motorTestTransition(this.state, {
      authority: this.authority,
      kind: 'FAULT_RAISED',
      reason,
    }).state;
  }

  getSnapshot(): MotorTestControllerSnapshot {
    return {
      phase: 'ACTIVE',
      setupStep: 'READY',
      machine: this.state,
      outcome: {kind: 'READY'},
      capabilities: undefined,
      staticCompatibility: undefined,
      dynamicEvaluation: undefined,
      armingRestriction: {kind: 'NOT_ATTEMPTED'},
      telemetryHeld: true,
      warnings: [],
      stopDescriptors: [],
      teardown: undefined,
      stopExecution: {
        attempts: 0,
        commandDispatched: false,
        commandAcknowledged: false,
        physicalStopConfirmed: false,
        deferredBehindActiveWrite: false,
        attributionAmbiguous: false,
        wirePreemptionClaimed: false,
        submittedNextOnTransport: false,
        episodeId: 0,
        outcome: undefined,
      },
      activation: {allowed: false, reasons: ['MACHINE_NOT_READY']},
      verificationReceipt: undefined,
      pulse: {
        attemptId: 0,
        motorNumber: undefined,
        submitted: false,
        acknowledged: false,
        deadlineArmedAtSubmission: false,
        mayHaveReachedFc: false,
        outcome: undefined,
      },
      continuousSafetyMonitoring: 'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    };
  }

  requestStop(trigger: string): 'ACCEPTED' | 'UNRECOGNIZED_STOP_TRIGGER' | 'CONTROLLER_CLOSED' {
    if (this.throwOnStop) {
      throw new Error('controller exploded');
    }
    this.stopCalls.push(trigger);
    if (this.refuse === 'ACCEPTED') {
      this.state = motorTestTransition(this.state, {
        authority: this.authority,
        kind: 'STOP_TRIGGERED',
        reason: trigger as 'ANDROID_BACK',
      }).state;
    }
    return this.refuse;
  }

  /** Phase 2G: present only to satisfy the interface. This double exists
   * to observe the bridge's stop path, and the bridge is structurally
   * incapable of activating anything - so this must never succeed. */
  pulseMotor(): 'GATES_NOT_SATISFIED' {
    return 'GATES_NOT_SATISFIED';
  }

  initializeSession(): Promise<MotorTestControllerSnapshot> {
    return Promise.resolve(this.getSnapshot());
  }

  subscribe(): () => void {
    return () => undefined;
  }

  close(): Promise<MotorTestControllerSnapshot> {
    return Promise.resolve(this.getSnapshot());
  }
}

function pulsingController(): ReducerBackedController {
  const controller = new ReducerBackedController();
  controller.advance('GATES_PASSED');
  controller.advance('ACTIVATION_ACCEPTED');
  controller.advance('START_WRITE_CALLED');
  expect(controller.state.name).toBe('Pulsing');
  return controller;
}

function startingController(): ReducerBackedController {
  const controller = new ReducerBackedController();
  controller.advance('GATES_PASSED');
  controller.advance('ACTIVATION_ACCEPTED');
  expect(controller.state.name).toBe('Starting');
  return controller;
}

interface Rig {
  readonly controller: ReducerBackedController;
  readonly sources: FakeSources;
  readonly bridge: MotorTestLifecycleBridgeHandle;
  readonly replays: number[];
}

function rigFor(controller: ReducerBackedController): Rig {
  const sources = new FakeSources();
  const replays: number[] = [];
  const bridge = createMotorTestLifecycleBridge({
    controller,
    sources,
    replayNavigation: () => {
      replays.push(1);
    },
  });
  bridge.attach();
  return {controller, sources, bridge, replays};
}

/* ------------------------------------------------------------------ *
 * Source coverage
 * ------------------------------------------------------------------ */

describe('lifecycle bridge - source coverage', () => {
  it('blur in Starting raises the obligation', () => {
    const rig = rigFor(startingController());
    rig.sources.emitBlur();
    const obligation = rig.bridge.getSnapshot().obligation;
    expect(obligation?.triggers).toEqual(['NAVIGATION_BLURRED']);
    expect(obligation?.requestAccepted).toBe(true);
    expect(rig.controller.state.name).toBe('Stopping');
  });

  it('blur in Pulsing raises the obligation', () => {
    const rig = rigFor(pulsingController());
    rig.sources.emitBlur();
    expect(rig.bridge.getSnapshot().obligation?.triggers).toEqual([
      'NAVIGATION_BLURRED',
    ]);
    expect(rig.controller.state.name).toBe('Stopping');
  });

  it('blur while already Stopping reinforces the same obligation', () => {
    const rig = rigFor(pulsingController());
    rig.sources.emitBlur();
    const first = rig.bridge.getSnapshot().obligation;
    rig.sources.emitBlur();
    const second = rig.bridge.getSnapshot().obligation;
    expect(second?.triggers).toEqual([
      'NAVIGATION_BLURRED',
      'NAVIGATION_BLURRED',
    ]);
    expect(second?.authority).toBe(first?.authority);
    expect(rig.controller.state.name).toBe('Stopping');
  });

  it('Android Back while active raises the obligation and consumes the event', () => {
    const rig = rigFor(pulsingController());
    expect(rig.sources.pressBack()).toBe(true);
    expect(rig.controller.stopCalls).toEqual(['ANDROID_BACK']);
    expect(rig.bridge.getSnapshot().consumedNavigationEvents).toBe(1);
  });

  it('committed Predictive Back reaches the same path (shared event)', () => {
    // Verified in the installed sources: a committed predictive-back
    // gesture and a classic press converge on `hardwareBackPress`, so
    // delivering that ONE event is the honest test. No synthetic
    // ANDROID_PREDICTIVE_BACK is emitted anywhere.
    const rig = rigFor(pulsingController());
    expect(rig.sources.pressBack()).toBe(true);
    expect(rig.controller.stopCalls).toEqual(['ANDROID_BACK']);
    expect(rig.bridge.getSnapshot().obligation?.triggers).toEqual([
      'ANDROID_BACK',
    ]);
    expect(rig.controller.stopCalls).not.toContain('ANDROID_PREDICTIVE_BACK');
  });

  it('cancellable removal is prevented while active', () => {
    const rig = rigFor(pulsingController());
    let prevented = 0;
    rig.sources.emitBeforeRemove({
      preventDefault: () => {
        prevented += 1;
      },
    });
    expect(prevented).toBe(1);
    expect(rig.controller.stopCalls).toEqual(['ANDROID_BACK']);
  });

  it('AppState inactive raises the obligation', () => {
    const rig = rigFor(pulsingController());
    rig.sources.emitAppState('inactive');
    expect(rig.controller.stopCalls).toEqual(['APP_STATE_BACKGROUNDED']);
  });

  it('AppState background raises the obligation', () => {
    const rig = rigFor(pulsingController());
    rig.sources.emitAppState('background');
    expect(rig.controller.stopCalls).toEqual(['APP_STATE_BACKGROUNDED']);
  });

  it('AppState active alone never fabricates a stop', () => {
    const rig = rigFor(pulsingController());
    rig.sources.emitAppState('active');
    expect(rig.controller.stopCalls).toEqual([]);
    expect(rig.bridge.getSnapshot().obligation).toBeUndefined();
  });

  it('a null or unknown AppState fails closed', () => {
    const rig = rigFor(pulsingController());
    rig.sources.emitAppState(null as unknown as MotorTestAppStateStatus);
    rig.sources.emitAppState('unknown');
    expect(rig.controller.stopCalls).toEqual([
      'APP_STATE_BACKGROUNDED',
      'APP_STATE_BACKGROUNDED',
    ]);
  });

  it('a rapid active/inactive/background sequence stays idempotent', () => {
    const rig = rigFor(pulsingController());
    rig.sources.emitAppState('active');
    rig.sources.emitAppState('inactive');
    rig.sources.emitAppState('background');
    rig.sources.emitAppState('active');
    const obligation = rig.bridge.getSnapshot().obligation;
    // ONE obligation, reinforced twice; `active` contributed nothing.
    expect(obligation?.triggers).toEqual([
      'APP_STATE_BACKGROUNDED',
      'APP_STATE_BACKGROUNDED',
    ]);
    expect(rig.controller.state.name).toBe('Stopping');
  });

  it('unmount and remount leaves exactly one live listener set', () => {
    const rig = rigFor(pulsingController());
    expect(rig.sources.listenerCount).toBe(4);
    rig.bridge.detach();
    expect(rig.sources.listenerCount).toBe(0);
    rig.bridge.attach();
    expect(rig.sources.listenerCount).toBe(4);
    rig.bridge.detach();
    expect(rig.sources.listenerCount).toBe(0);
  });

  it('a double attach (Strict Mode) does not duplicate subscriptions', () => {
    const rig = rigFor(pulsingController());
    rig.bridge.attach();
    rig.bridge.attach();
    expect(rig.sources.listenerCount).toBe(4);
    rig.sources.emitBlur();
    // One listener set means ONE request, not three.
    expect(rig.controller.stopCalls).toEqual(['NAVIGATION_BLURRED']);
  });

  it('a listener-registration failure rolls back earlier registrations', () => {
    const controller = pulsingController();
    const sources = new FakeSources();
    sources.failOnAppState = true;
    const bridge = createMotorTestLifecycleBridge({controller, sources});
    expect(() => bridge.attach()).toThrow();
    expect(sources.listenerCount).toBe(0);
    expect(bridge.getSnapshot().attached).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Authority and races
 * ------------------------------------------------------------------ */

describe('lifecycle bridge - authority and races', () => {
  it('Back plus blur in one turn share a single obligation', () => {
    const rig = rigFor(pulsingController());
    rig.sources.pressBack();
    rig.sources.emitBlur();
    const obligation = rig.bridge.getSnapshot().obligation;
    expect(obligation?.triggers).toEqual(['ANDROID_BACK', 'NAVIGATION_BLURRED']);
    expect(rig.controller.state.name).toBe('Stopping');
  });

  it('Back plus AppState background share a single obligation', () => {
    const rig = rigFor(pulsingController());
    rig.sources.pressBack();
    rig.sources.emitAppState('background');
    expect(rig.bridge.getSnapshot().obligation?.triggers).toEqual([
      'ANDROID_BACK',
      'APP_STATE_BACKGROUNDED',
    ]);
  });

  it('duplicate trigger delivery never creates a second obligation', () => {
    const rig = rigFor(pulsingController());
    for (let i = 0; i < 5; i++) {
      rig.sources.pressBack();
    }
    const obligation = rig.bridge.getSnapshot().obligation;
    expect(obligation?.triggers).toHaveLength(5);
    expect(new Set(obligation?.triggers)).toEqual(new Set(['ANDROID_BACK']));
    // Still exactly one obligation object, one authority.
    expect(obligation?.authority).toBe(rig.controller.authority);
  });

  it('a fault with a possibly-live command still keeps navigation held', () => {
    const rig = rigFor(pulsingController());
    rig.controller.fault('MSP_RESPONSE_TIMEOUT');
    expect(rig.controller.state).toMatchObject({
      name: 'Fault',
      startMayHaveReachedFc: true,
    });
    expect(rig.sources.pressBack()).toBe(true);
    // Fault is NOT recovered - it stays terminal - but the obligation was
    // still recorded rather than silently dropped.
    expect(rig.controller.state.name).toBe('Fault');
    expect(rig.bridge.getSnapshot().obligation?.triggers).toEqual([
      'ANDROID_BACK',
    ]);
  });

  it('an idle fault does not hold navigation', () => {
    const controller = new ReducerBackedController();
    controller.advance('GATES_PASSED');
    controller.fault('USB_DETACHED');
    expect(controller.state).toMatchObject({
      name: 'Fault',
      startMayHaveReachedFc: false,
    });
    const rig = rigFor(controller);
    expect(rig.sources.pressBack()).toBe(false);
    expect(rig.bridge.getSnapshot().consumedNavigationEvents).toBe(0);
  });

  it('USB detach plus AppState background stays one obligation', () => {
    const rig = rigFor(pulsingController());
    rig.controller.fault('USB_DETACHED');
    rig.sources.emitAppState('background');
    expect(rig.bridge.getSnapshot().obligation?.triggers).toEqual([
      'APP_STATE_BACKGROUNDED',
    ]);
    expect(rig.controller.state.name).toBe('Fault');
  });

  it('a replaced session starts a new obligation, never reinforcing the old', () => {
    const rig = rigFor(pulsingController());
    rig.sources.pressBack();
    const first = rig.bridge.getSnapshot().obligation;

    // The session is replaced: a genuinely new authority and machine.
    const replacement = pulsingController();
    (rig.controller as {state: MotorTestState}).state = replacement.state;
    Object.defineProperty(rig.controller, 'authority', {
      value: replacement.authority,
      configurable: true,
    });

    rig.sources.pressBack();
    const second = rig.bridge.getSnapshot().obligation;
    expect(second?.authority).not.toBe(first?.authority);
    expect(second?.triggers).toEqual(['ANDROID_BACK']);
  });

  it('a stale completion cannot replay navigation into a new session', () => {
    const rig = rigFor(pulsingController());
    rig.sources.pressBack();
    expect(rig.bridge.getSnapshot().consumedNavigationEvents).toBe(1);

    // A new session becomes active before the held navigation is released.
    const replacement = pulsingController();
    Object.defineProperty(rig.controller, 'authority', {
      value: replacement.authority,
      configurable: true,
    });
    (rig.controller as {state: MotorTestState}).state = replacement.state;

    expect(rig.bridge.releaseHeldNavigation()).toBe(false);
    expect(rig.bridge.getSnapshot().navigationReplays).toBe(0);
    expect(rig.replays).toHaveLength(0);
  });

  it('a rejected stop is never converted into successful navigation', () => {
    const rig = rigFor(pulsingController());
    rig.controller.refuse = 'UNRECOGNIZED_STOP_TRIGGER';
    rig.sources.pressBack();
    expect(rig.bridge.getSnapshot().obligation?.requestAccepted).toBe(false);
    expect(rig.bridge.releaseHeldNavigation()).toBe(false);
    expect(rig.replays).toHaveLength(0);
  });

  it('a controller exception fails closed and still consumes navigation', () => {
    const rig = rigFor(pulsingController());
    rig.controller.throwOnStop = true;
    expect(rig.sources.pressBack()).toBe(true);
    expect(rig.bridge.getSnapshot().consumedNavigationEvents).toBe(1);
    expect(rig.bridge.releaseHeldNavigation()).toBe(false);
  });

  it('navigation replay happens at most once and cannot recurse', () => {
    const rig = rigFor(pulsingController());
    rig.sources.pressBack();
    expect(rig.bridge.releaseHeldNavigation()).toBe(true);
    expect(rig.replays).toHaveLength(1);
    expect(rig.bridge.releaseHeldNavigation()).toBe(false);
    expect(rig.bridge.releaseHeldNavigation()).toBe(false);
    expect(rig.bridge.getSnapshot().navigationReplays).toBe(1);
    expect(rig.replays).toHaveLength(1);
  });

  it('teardown during trigger handling leaks no listener', () => {
    const rig = rigFor(pulsingController());
    rig.sources.pressBack();
    rig.bridge.detach();
    expect(rig.sources.listenerCount).toBe(0);
    // Post-detach events reach nothing.
    const before = rig.controller.stopCalls.length;
    rig.sources.emitAppState('background');
    rig.sources.emitBlur();
    expect(rig.controller.stopCalls).toHaveLength(before);
  });

  it('a trigger with no live authority records nothing', () => {
    const controller = new ReducerBackedController();
    const noMachine = {
      ...controller,
      getSnapshot: () => ({...controller.getSnapshot(), machine: undefined}),
    } as unknown as MotorTestController;
    const sources = new FakeSources();
    const bridge = createMotorTestLifecycleBridge({controller: noMachine, sources});
    bridge.attach();
    sources.emitBlur();
    expect(bridge.getSnapshot().obligation).toBeUndefined();
    bridge.detach();
  });
});

/* ------------------------------------------------------------------ *
 * Containment and activation-ineligibility
 * ------------------------------------------------------------------ */

describe('lifecycle bridge - containment', () => {
  it('never emits a trigger outside its own whitelist', () => {
    const rig = rigFor(pulsingController());
    rig.sources.pressBack();
    rig.sources.emitBlur();
    rig.sources.emitAppState('background');
    for (const call of rig.controller.stopCalls) {
      expect(MOTOR_TEST_LIFECYCLE_TRIGGERS).toContain(call);
    }
    expect(MOTOR_TEST_LIFECYCLE_TRIGGERS).not.toContain(
      'ANDROID_PREDICTIVE_BACK',
    );
  });

  it('never claims a physical stop', () => {
    const rig = rigFor(pulsingController());
    rig.sources.pressBack();
    const snapshot = rig.bridge.getSnapshot();
    expect(snapshot.physicalStopConfirmed).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    // The obligation records only that a request was ACCEPTED.
    expect(snapshot.obligation?.outcomes).toEqual(['REQUEST_ACCEPTED']);
  });

  it('exposes exactly five frozen operations and no writer', () => {
    const rig = rigFor(pulsingController());
    expect(Object.keys(rig.bridge).sort()).toEqual([
      'attach',
      'detach',
      'getSnapshot',
      'handleTrigger',
      'releaseHeldNavigation',
    ]);
    expect(Object.isFrozen(rig.bridge)).toBe(true);
    const surface = rig.bridge as unknown as Record<string, unknown>;
    for (const forbidden of [
      'controller',
      'sources',
      'client',
      'request',
      'write',
      'send',
      'start',
      'pulse',
      'activate',
      'setMotor',
    ]) {
      expect(surface[forbidden]).toBeUndefined();
    }
  });

  it('unavailable continuous monitoring is not activation permission', () => {
    // Even with the setup outcome named READY, the disclosures stand and
    // the bridge exposes nothing that could act on them.
    const rig = rigFor(pulsingController());
    const snapshot = rig.controller.getSnapshot();
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.continuousSafetyMonitoring).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
    const surface = rig.bridge as unknown as Record<string, unknown>;
    expect(surface.activate).toBeUndefined();
    expect(surface.canActivate).toBeUndefined();
    expect(surface.isSafe).toBeUndefined();
    expect(rig.bridge.getSnapshot().physicalStopConfirmed).toBe(false);
  });

  it('a real binding-built controller exposes the same disclosures', async () => {
    // The REAL production path: real client, real registry, real binding,
    // real controller. The bridge attaches to it without weakening
    // anything.
    const registry = new MotorTestTelemetryRegistry();
    const client = new MspClient(new FakeMspTransport(), 'lifecycle-real');
    const binding = createMotorTestSessionBinding(client, {registry});
    const controller = createMotorTestController(
      binding.controllerDependencies(
        {
          readCurrentIdentity: () => ({physicalGeneration: 1, mspEpoch: 0}),
          subscribeSessionInvalidated: () => () => undefined,
        },
        () => 0,
      ),
    );
    const sources = new FakeSources();
    const bridge = createMotorTestLifecycleBridge({controller, sources});
    bridge.attach();

    const snapshot = controller.getSnapshot();
    expect(snapshot.continuousSafetyMonitoring).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
    expect(snapshot.teardown?.armingRestrictionRemovalSupported).toBeUndefined();

    // No authority yet, so a lifecycle event records nothing and sends
    // nothing.
    sources.emitBlur();
    expect(bridge.getSnapshot().obligation).toBeUndefined();

    bridge.detach();
    const closed = await controller.close();
    expect(closed.teardown?.armingRestrictionRemovalSupported).toBe(false);
    expect(closed.teardown?.armingRestrictionRemovalPerformed).toBe(false);
    binding.close();
  });
});
