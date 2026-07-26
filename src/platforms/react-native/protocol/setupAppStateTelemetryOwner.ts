/**
 * Pass 7.7 - the SINGLE AppState owner for telemetry pause/resume.
 *
 * CONFIRMED baseline gap (grep of the whole Pass 7.6c source tree: zero
 * `AppState` references outside node_modules): backgrounding the app kept
 * the coordinator's 50ms tick driver running and kept dispatching MSP
 * requests to a flight controller the user cannot see. Nothing paused, and
 * nothing was truthful about it.
 *
 * DESIGN - deliberately minimal and non-competing:
 *  - exactly ONE owner instance exists (module singleton, mirroring
 *    mspSessionCoordinator/setupUiSessionStore precedent); it attaches one
 *    AppState listener and never a second one, so repeated
 *    background/active cycles cannot create duplicate listeners, pollers
 *    or schedulers;
 *  - it does NOT create, own or restart schedulers. It pauses through the
 *    scheduler's OWN existing reference-counted lease API
 *    (acquirePauseLease('APP_BACKGROUND') - telemetryTypes.ts already
 *    defines exactly that reason), so MspClient, its FIFO queue and the
 *    single-in-flight rule are untouched: a request already dispatched
 *    settles normally through its existing bounded path, and only NEW
 *    dispatches stop;
 *  - it never closes a healthy physical USB session, never fabricates a
 *    disconnection, and publishes no telemetry values of its own -
 *    freshness/staleness continue to be decided solely by each sample's
 *    own updatedAtMs, so a stale sample can never be re-presented as
 *    newly FRESH on resume;
 *  - resume releases the lease ONLY for a session whose generation is
 *    still the ACTIVE one; a session that was detached or replaced while
 *    backgrounded simply has no lease to release (its scheduler is gone),
 *    so old work can never resume.
 */

import {AppState} from 'react-native';
import type {AppStateStatus, NativeEventSubscription} from 'react-native';

import {mspSessionCoordinator} from './MspSessionCoordinator';
import type {MspSessionCoordinator} from './MspSessionCoordinator';
import type {MspTelemetryScheduler, TelemetryPauseLease} from '../../../core';

export type SetupAppStatePhase = 'ACTIVE' | 'APP_BACKGROUND';

export interface SetupAppStateTelemetryOwnerOptions {
  /** Injectable for tests; defaults to the real singleton. */
  coordinator?: MspSessionCoordinator;
  /** Injectable AppState-like source; defaults to React Native's. */
  appState?: {
    currentState: AppStateStatus;
    addEventListener: (type: 'change', listener: (status: AppStateStatus) => void) => NativeEventSubscription;
  };
}

export class SetupAppStateTelemetryOwner {
  private readonly coordinator: MspSessionCoordinator;
  private readonly appState: NonNullable<SetupAppStateTelemetryOwnerOptions['appState']>;
  private subscription: NativeEventSubscription | undefined;
  /** One lease per paused sessionId - never more than one, so repeated
   * background events cannot stack leases. The owning SCHEDULER instance
   * is stored with it: a sessionId can be reused by a replacement
   * generation whose scheduler is a different object, and a lease taken
   * on the dead scheduler must never be mistaken for "already paused". */
  private readonly leases = new Map<string, {scheduler: MspTelemetryScheduler; lease: TelemetryPauseLease}>();
  private phase: SetupAppStatePhase = 'ACTIVE';
  private readonly listeners = new Set<() => void>();

  constructor(options: SetupAppStateTelemetryOwnerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appState = options.appState ?? AppState;
  }

  /** Idempotent: a second start() call never adds a second listener. */
  start(): void {
    if (this.subscription !== undefined) {
      return;
    }
    this.phase = this.appState.currentState === 'active' ? 'ACTIVE' : 'APP_BACKGROUND';
    this.subscription = this.appState.addEventListener('change', status => this.handleChange(status));
  }

  /** Releases every lease and detaches the single listener. */
  stop(): void {
    this.subscription?.remove();
    this.subscription = undefined;
    this.releaseAll();
    this.phase = 'ACTIVE';
    this.notify();
  }

  getPhase(): SetupAppStatePhase {
    return this.phase;
  }

  /** True while THIS owner holds a background pause lease for the session. */
  isPausedFor(sessionId: string): boolean {
    return this.leases.has(sessionId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Registers a session so backgrounding pauses it. Safe to call
   * repeatedly for the same id (e.g. on every screen mount): if the app is
   * already backgrounded the session is paused immediately, and an
   * existing lease is never duplicated. */
  track(sessionId: string): void {
    if (this.phase === 'APP_BACKGROUND') {
      this.pauseSession(sessionId);
    }
  }

  private handleChange(status: AppStateStatus): void {
    const next: SetupAppStatePhase = status === 'active' ? 'ACTIVE' : 'APP_BACKGROUND';
    if (next === this.phase) {
      return; // no duplicate work on repeated same-phase events
    }
    this.phase = next;
    if (next === 'APP_BACKGROUND') {
      for (const sessionId of this.coordinator.listSessionIds()) {
        this.pauseSession(sessionId);
      }
    } else {
      this.resumeAll();
    }
    this.notify();
  }

  private pauseSession(sessionId: string): void {
    const scheduler = this.coordinator.getTelemetryScheduler(sessionId);
    if (scheduler === undefined) {
      return; // nothing running for this id - nothing to pause
    }
    const existing = this.leases.get(sessionId);
    if (existing !== undefined) {
      if (existing.scheduler === scheduler) {
        return; // already paused - never stack a second lease
      }
      // Stale lease from a replaced/torn-down generation: it died with its
      // scheduler, so simply drop it and pause the CURRENT one.
      this.leases.delete(sessionId);
    }
    this.leases.set(sessionId, {scheduler, lease: scheduler.acquirePauseLease('APP_BACKGROUND')});
  }

  private resumeAll(): void {
    for (const [sessionId, held] of Array.from(this.leases)) {
      this.leases.delete(sessionId);
      // Only a session that is STILL the active one, on the SAME scheduler
      // instance the lease was taken against, may resume: a detached or
      // replaced generation has a different (or no) scheduler, and its
      // lease dies with it rather than reviving old work.
      if (
        this.coordinator.getOwnershipState(sessionId) === 'ACTIVE' &&
        this.coordinator.getTelemetryScheduler(sessionId) === held.scheduler
      ) {
        held.lease.release();
      }
    }
  }

  private releaseAll(): void {
    for (const [sessionId, held] of Array.from(this.leases)) {
      this.leases.delete(sessionId);
      held.lease.release();
    }
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        // Best-effort - same convention as the coordinator's own notifiers.
      }
    }
  }
}

export const setupAppStateTelemetryOwner = new SetupAppStateTelemetryOwner();
