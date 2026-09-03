/**
 * THE SESSION PLUMBING A CONTROLLER NEEDS, wired to a virtual board.
 *
 * Every configuration controller in this directory takes the same three
 * ports - a session coordinator, an app-state owner and a motor-test
 * predicate - and this builds them around a VirtualFlightController so a
 * scenario can drive the REAL controller singletons rather than a mock of
 * them.
 *
 * The generation and the client identity are held here, not in the
 * controller, so a scenario can do the two things the app's guards exist
 * for: reconnect (new generation, new client) and lose the link mid
 * transaction.
 */

import type {MspClientState} from '../../../../core/protocol/mspClient';
import type {MspTelemetryScheduler} from '../../../../core/protocol/telemetry';
import type {
  MspIdentificationState,
  MspSessionOwnershipState,
  SetupUiSessionKey,
} from '../MspSessionCoordinator';
import {VirtualFlightController} from './virtualFlightController';

export interface VirtualSessionOptions {
  readonly sessionId: string;
  readonly board: VirtualFlightController;
  readonly apiMinor: number;
  readonly firmwareIdentifier?: string;
}

/** The shape every controller's `coordinator` option satisfies. */
export interface VirtualCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): VirtualFlightController | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

/** `jest.fn(impl)` where Jest exists, `impl` where it does not. */
function spy<T extends (...args: never[]) => unknown>(implementation: T): T {
  const runner = (globalThis as unknown as {jest?: {fn?: unknown}}).jest;
  return typeof runner?.fn === 'function'
    ? ((runner.fn as (fn: T) => T)(implementation) as T)
    : implementation;
}

export class VirtualSession {
  readonly sessionId: string;
  board: VirtualFlightController;
  generation = 1;
  ownership: MspSessionOwnershipState = 'ACTIVE';
  recovery: MspClientState = 'READY';
  appPhase: 'ACTIVE' | 'BACKGROUND' = 'ACTIVE';
  motorTestActive = false;
  apiMinor: number;
  firmwareIdentifier: string;
  readonly telemetry: MspTelemetryScheduler;
  readonly coordinator: VirtualCoordinator;

  constructor(options: VirtualSessionOptions) {
    this.sessionId = options.sessionId;
    this.board = options.board;
    this.apiMinor = options.apiMinor;
    this.firmwareIdentifier = options.firmwareIdentifier ?? 'BTFL';
    /* THE SCHEDULER STUB HAS TO EXIST OUTSIDE JEST TOO.
       These fixtures are mounted by the Jest censuses AND, through
       e2e/touch-targets, by a real Chromium build - and `jest` is not a
       global there. Under Jest these stay `jest.fn()`, so anything that
       inspects their calls is unchanged; in a browser they are the same
       no-ops without the recorder. */
    this.telemetry = {
      acquirePauseLease: spy(() => ({release: spy(() => undefined)})),
      discardPendingDemands: spy(() => undefined),
      waitUntilIdle: spy(() => Promise.resolve()),
      requestRefresh: spy(() => undefined),
    } as unknown as MspTelemetryScheduler;
    this.coordinator = {
      getOwnershipState: () => this.ownership,
      getIdentificationState: () => this.identification(),
      getSessionKey: sessionId => ({sessionId, generation: this.generation}),
      getActiveMspClient: () => this.board,
      getTelemetryScheduler: () => this.telemetry,
      getMspRecoveryState: () => this.recovery,
    };
  }

  get key(): SetupUiSessionKey {
    return {sessionId: this.sessionId, generation: this.generation};
  }

  /** The three options every controller constructor accepts. */
  get options() {
    return {
      coordinator: this.coordinator as never,
      appStateOwner: {getPhase: () => this.appPhase as 'ACTIVE'},
      isMotorTestActive: () => this.motorTestActive,
      // MotorConfigurationController asks a narrower question than the
      // other controllers - "could a motor be TURNING" rather than "is a
      // Motors session open" - under its own option name.
      isMotorOutputEngaged: () => this.motorTestActive,
    };
  }

  /**
   * A reconnect: the board restarts, the physical generation moves, and
   * the app is handed what is, as far as its guards are concerned, a
   * different flight controller until it has read one again.
   */
  reconnect(): void {
    this.board.powerCycle();
    this.generation += 1;
  }

  identification(): MspIdentificationState {
    return {
      status: 'SUCCEEDED',
      identity: {
        firmware: {
          identifier: this.firmwareIdentifier,
          knownFamily:
            this.firmwareIdentifier === 'BTFL' ? 'BETAFLIGHT' : 'INAV',
        },
        apiVersion: {
          mspProtocolVersion: 0,
          apiVersionMajor: 1,
          apiVersionMinor: this.apiMinor,
        },
        board: {},
      },
    } as MspIdentificationState;
  }
}
