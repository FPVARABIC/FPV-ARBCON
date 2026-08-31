/**
 * Independent, session-bound Motor/ESC configuration transaction.
 *
 * This controller does not share state with MotorTestController and never
 * sends MSP_SET_MOTOR. It reuses the canonical MspClient and telemetry
 * scheduler, takes an exclusive pause lease, rejects any active motor-test
 * lifecycle, verifies a fresh DISARMED reading immediately before the first
 * write, writes only changed groups, persists once, and reads back once.
 *
 * No write is retried automatically. A timeout, detach, or unknown transport
 * outcome after dispatch is reported as UNCONFIRMED because the value may
 * already be in FC RAM or EEPROM.
 */

import {
  MSP_ADVANCED_CONFIG,
  MSP2_MOTOR_OUTPUT_REORDERING,
  MSP2_SET_MOTOR_OUTPUT_REORDERING,
  MSP2_SEND_DSHOT_COMMAND,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR_3D_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_REBOOT,
  MSP_SET_ADVANCED_CONFIG,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_MIXER_CONFIG,
  MSP_SET_MOTOR_3D_CONFIG,
  MSP_SET_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import { decodeAdvancedConfig } from '../../../core/protocol/msp/decoding/decodeAdvancedConfig';
import {
  isOwnedByConfigurationSession,
  rememberConfigurationSession,
} from '../../../core/state/configurationSessionOwnership';
import { decodeFeatureConfig } from '../../../core/protocol/msp/decoding/decodeFeatureConfig';
import { decodeMixerConfig } from '../../../core/protocol/msp/decoding/decodeMixerConfig';
import { decodeMotor3dConfig } from '../../../core/protocol/msp/decoding/decodeMotor3dConfig';
import { decodeMotorConfig } from '../../../core/protocol/msp/decoding/decodeMotorConfig';
import { decodeMotorOutputOrder } from '../../../core/protocol/msp/decoding/decodeMotorOutputOrder';
import { decodeStatusExDiagnostics } from '../../../core/protocol/msp/decoding/decodeStatusExDiagnostics';
import { BoxIdsAcquisition } from '../../../core/protocol/msp/identification/BoxIdsAcquisition';
import type {
  BoxIdsOwnerIdentity,
  MspRequester,
} from '../../../core/protocol/msp';
import {
  MspOperationOutcomeUnknownError,
  createMspOperationCoordinator,
} from '../../../core/protocol/telemetry';
import type { MspTelemetryScheduler } from '../../../core/protocol/telemetry';
import type { MspClientState } from '../../../core/protocol/mspClient';
import {
  encodeChangedMotorConfiguration,
  type MotorConfigurationWriteGroup,
} from '../../../core/protocol/msp/encoding/encodeMotorConfiguration';
import { encodeMotorOutputOrder } from '../../../core/protocol/msp/encoding/encodeMotorOutputOrder';
import {
  encodeDshotEscDirection,
  type DshotEscDirection,
} from '../../../core/protocol/msp/encoding/encodeDshotEscDirection';
import {
  createMotorConfigurationDraft,
  motorConfigurationDraftsEqual,
  validateMotorConfigurationDraft,
  type MotorConfigurationDraft,
  type MotorConfigurationSnapshot,
  type MotorConfigurationValidationIssue,
} from '../../../core/state/motorConfigurationModel';
import { deriveArmedState } from '../../../core/state/armingBlockers';
import {
  motorFirmwareSupports,
  resolveMotorFirmwareCompatibility,
  type MotorFirmwareCapability,
} from '../../../core/firmware-adapters/motorFirmwareCompatibility';
import {
  isMotorOutputEngagedForSession,
} from './motorTestCapability';
import { mspSessionCoordinator } from './MspSessionCoordinator';
import type {
  MspIdentificationState,
  MspSessionOwnershipState,
  SetupUiSessionKey,
} from './MspSessionCoordinator';
import { setupAppStateTelemetryOwner } from './setupAppStateTelemetryOwner';
import type { SetupAppStatePhase } from './setupAppStateTelemetryOwner';
import {
  acquireMotorConfigurationInterlock,
  MotorConfigurationTransactionInProgressError,
} from './motorConfigurationInterlock';
import {
  MutationLedger,
  MutationStoppedError,
} from './configurationSaveLedger';

const EMPTY_PAYLOAD = new Uint8Array(0);

const COMMAND_FOR_GROUP: Readonly<
  Record<MotorConfigurationWriteGroup, number>
> = Object.freeze({
  FEATURE: MSP_SET_FEATURE_CONFIG,
  MIXER: MSP_SET_MIXER_CONFIG,
  MOTOR: MSP_SET_MOTOR_CONFIG,
  MOTOR_3D: MSP_SET_MOTOR_3D_CONFIG,
  ADVANCED: MSP_SET_ADVANCED_CONFIG,
});

const CONFIRMED_NOT_SENT_CODES: readonly string[] = Object.freeze([
  'MSP_ENCODE_FAILED',
  'MSP_QUEUE_FULL',
  'MSP_TRANSPORT_QUEUE_FULL',
  'MSP_RECOVERY_REQUIRED',
  'MSP_RECOVERING',
]);

export type MotorConfigurationBlockReason =
  | 'SESSION_CHANGED'
  | 'DISCONNECTED'
  | 'IDENTIFYING'
  | 'INCOMPATIBLE_FIRMWARE'
  | 'APP_BACKGROUNDED'
  | 'LINK_RECOVERING'
  | 'FC_ARMED'
  | 'ARMED_STATE_UNKNOWN'
  | 'MOTOR_TEST_ACTIVE'
  | 'INVALID_DRAFT'
  | 'STALE_BASE'
  | 'CONFIGURATION_BUSY'
  | 'ESC_DIRECTION_UNSUPPORTED'
  /**
   * The board CAN be read, and this app will not write to it.
   *
   * Distinct from INCOMPATIBLE_FIRMWARE on purpose: that one means "this
   * screen is not for this board", and telling an operator that in front of
   * a Motors page that is visibly showing them their own live settings is
   * simply a false statement. This one means the settings on screen are
   * real and the save button is the part that is unavailable, because the
   * firmware is NEWER than any revision whose setter payloads this build
   * has been able to check. See motorFirmwareCompatibility.ts.
   */
  | 'CONFIGURATION_WRITE_UNVERIFIED';

export type MotorConfigurationLoadOutcome =
  | { readonly kind: 'LOADED'; readonly snapshot: MotorConfigurationSnapshot }
  | {
      readonly kind: 'REJECTED';
      readonly reason: MotorConfigurationBlockReason;
    }
  | { readonly kind: 'FAILED'; readonly error: unknown }
  | { readonly kind: 'SESSION_ENDED' };

export type MotorConfigurationSaveOutcome =
  | {
      readonly kind: 'NO_CHANGES';
      readonly snapshot: MotorConfigurationSnapshot;
    }
  | {
      readonly kind: 'SAVED_VERIFIED';
      readonly snapshot: MotorConfigurationSnapshot;
      readonly rebootRequired: true;
      readonly changedGroups: readonly MotorConfigurationWriteGroup[];
    }
  | {
      readonly kind: 'SAVED_UNVERIFIED';
      readonly rebootRequired: true;
      readonly changedGroups: readonly MotorConfigurationWriteGroup[];
      readonly error: unknown;
    }
  | {
      readonly kind: 'REJECTED';
      readonly reason: MotorConfigurationBlockReason;
      readonly issues?: readonly MotorConfigurationValidationIssue[];
    }
  | {
      readonly kind: 'FAILED';
      readonly error: unknown;
      readonly acknowledgedGroups: readonly MotorConfigurationWriteGroup[];
      readonly persisted: false;
    }
  | {
      readonly kind: 'UNCONFIRMED';
      readonly stage: MotorConfigurationWriteGroup | 'EEPROM' | 'UNKNOWN';
      readonly acknowledgedGroups: readonly MotorConfigurationWriteGroup[];
    }
  /**
   * THE AIRCRAFT'S RAM MOVED AND ITS FLASH DID NOT.
   *
   * U-R1. A Motors save sends up to five SET frames before the EEPROM
   * commit, and the flight controller applies each one the instant it
   * acknowledges it. If the sequence then stops - the board restarted,
   * the app was backgrounded, the link changed hands, or a frame was
   * refused outright - the acknowledged groups are LIVE and unpersisted.
   *
   * Neither `FAILED` nor `SAVED_*` can say that. `FAILED` means nothing
   * happened, which is false and is exactly the shape of U-X2-001; a
   * `SAVED_*` claim is worse. `acknowledgedGroups` names what the board
   * accepted, so the operator can be told which half of their edit the
   * aircraft is flying until the next power cycle.
   *
   * `definitelyNotSent` distinguishes a frame this app never handed to
   * the transport (it stopped first, or the queue refused it) from one
   * whose fate is unknown. It is never used to upgrade an ambiguous
   * result.
   */
  | {
      readonly kind: 'PARTIAL_UNPERSISTED';
      readonly acknowledgedGroups: readonly MotorConfigurationWriteGroup[];
      readonly failedStage: MotorConfigurationWriteGroup | 'EEPROM';
      readonly definitelyNotSent: boolean;
    }
  | { readonly kind: 'SESSION_ENDED' };

export type MotorOutputOrderLoadOutcome =
  | { readonly kind: 'LOADED'; readonly values: readonly number[] }
  | {
      readonly kind: 'REJECTED';
      readonly reason: MotorConfigurationBlockReason;
    }
  | { readonly kind: 'FAILED'; readonly error: unknown }
  | { readonly kind: 'SESSION_ENDED' };

export type MotorOutputOrderSaveOutcome =
  | { readonly kind: 'NO_CHANGES'; readonly values: readonly number[] }
  | { readonly kind: 'SAVED_VERIFIED'; readonly values: readonly number[] }
  | { readonly kind: 'SAVED_UNVERIFIED'; readonly error: unknown }
  | {
      readonly kind: 'REJECTED';
      readonly reason: MotorConfigurationBlockReason;
    }
  | { readonly kind: 'FAILED'; readonly error: unknown }
  | { readonly kind: 'UNCONFIRMED'; readonly stage: 'OUTPUT_ORDER' | 'EEPROM' }
  /**
   * The reorder map reached the flight controller's RAM and the EEPROM
   * commit did not. U-R1: same defect shape as the main save, on a
   * two-stage sequence - see MotorConfigurationSaveOutcome.
   */
  | {
      readonly kind: 'PARTIAL_UNPERSISTED';
      readonly failedStage: 'EEPROM';
      readonly definitelyNotSent: boolean;
    }
  | { readonly kind: 'SESSION_ENDED' };

/**
 * The explicit reboot step of the M-F3 §36 save lifecycle. A saved mixer
 * or props flag governs only after mixerInit() runs at boot, so the strip
 * offers this as its own verified action AFTER a verified save - never
 * silently inside one.
 *
 * REBOOT_REQUESTED.acknowledged distinguishes "the FC answered the
 * MSP_REBOOT frame before restarting" from "the link dropped around the
 * request" - which is the expected shape of a reboot actually happening,
 * and therefore not a failure. Neither value claims the FC came back:
 * that is only established by the reconnect reading the new configuration.
 */
export type MotorRebootOutcome =
  | { readonly kind: 'REBOOT_REQUESTED'; readonly acknowledged: boolean }
  | { readonly kind: 'UNCONFIRMED' }
  | {
      readonly kind: 'REJECTED';
      readonly reason: MotorConfigurationBlockReason;
    }
  | { readonly kind: 'FAILED'; readonly error: unknown }
  | { readonly kind: 'SESSION_ENDED' };

export type EscDirectionOutcome =
  | {
      readonly kind: 'ACKNOWLEDGED';
      readonly motorNumber: number;
      readonly direction: DshotEscDirection;
      readonly physicallyVerified: false;
    }
  | {
      readonly kind: 'REJECTED';
      readonly reason: MotorConfigurationBlockReason;
    }
  | { readonly kind: 'FAILED'; readonly error: unknown }
  | { readonly kind: 'UNCONFIRMED' }
  | { readonly kind: 'SESSION_ENDED' };

interface MotorConfigurationClient extends MspRequester {
  getEpoch(): number;
}

export interface MotorConfigurationSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): MotorConfigurationClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

export interface MotorConfigurationAppStateOwner {
  getPhase(): SetupAppStatePhase;
}

export interface MotorConfigurationControllerOptions {
  readonly coordinator?: MotorConfigurationSessionCoordinator;
  readonly appStateOwner?: MotorConfigurationAppStateOwner;
  /**
   * Test seam only. Production uses the official capability store.
   *
   * Named for what it now asks: could a motor be TURNING? It used to be
   * bound to isMotorTestSessionActive - "does a session exist?" - which
   * refused configuration whenever a Motors session was open even with every
   * motor at rest, and so forced the operator to close the session, leave
   * Motors and come back to change something that concerns motors. Session
   * existence was never the dangerous condition.
   */
  readonly isMotorOutputEngaged?: (sessionId: string) => boolean;
}

class MotorConfigurationPreflightError extends Error {
  constructor(public readonly reason: MotorConfigurationBlockReason) {
    super(`Motor configuration preflight rejected: ${reason}`);
    this.name = 'MotorConfigurationPreflightError';
  }
}

class MotorConfigurationDefiniteWriteError extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly acknowledgedGroups: readonly MotorConfigurationWriteGroup[],
  ) {
    super('Motor configuration write failed before EEPROM persistence.');
    this.name = 'MotorConfigurationDefiniteWriteError';
  }
}

interface MotorConfigurationAmbiguousWriteCause {
  readonly kind: 'MOTOR_CONFIGURATION_AMBIGUOUS_WRITE';
  readonly originalError: unknown;
  readonly stage:
    | MotorConfigurationWriteGroup
    | 'OUTPUT_ORDER'
    | 'ESC_DIRECTION'
    | 'EEPROM';
  readonly acknowledgedGroups: readonly MotorConfigurationWriteGroup[];
  /**
   * The save left the aircraft holding SOME of the requested change in
   * RAM with nothing in flash. U-R1: a decision made where the sequence
   * stopped, not re-derived from `acknowledgedGroups.length` - by the
   * time the EEPROM frame runs every RAM write is already confirmed, so
   * an ambiguous EEPROM is not a partial configuration and stays
   * UNCONFIRMED(EEPROM).
   */
  readonly partial: boolean;
  /** The frame provably never reached the flight controller. */
  readonly definitelyNotSent: boolean;
}

class MotorConfigurationAmbiguousWriteError extends MspOperationOutcomeUnknownError {
  constructor(
    cause: unknown,
    stage:
      | MotorConfigurationWriteGroup
      | 'OUTPUT_ORDER'
      | 'ESC_DIRECTION'
      | 'EEPROM',
    acknowledgedGroups: readonly MotorConfigurationWriteGroup[],
    partial = false,
    definitelyNotSent = false,
  ) {
    super(
      Object.freeze({
        kind: 'MOTOR_CONFIGURATION_AMBIGUOUS_WRITE',
        originalError: cause,
        stage,
        acknowledgedGroups,
        partial,
        definitelyNotSent,
      } satisfies MotorConfigurationAmbiguousWriteCause),
    );
    this.name = 'MotorConfigurationAmbiguousWriteError';
  }
}

function isAmbiguousWriteCause(
  value: unknown,
): value is MotorConfigurationAmbiguousWriteCause {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'MOTOR_CONFIGURATION_AMBIGUOUS_WRITE'
  );
}

interface SaveExecutionResult {
  readonly originalWhenSaved: MotorConfigurationSnapshot;
  readonly changedGroups: readonly MotorConfigurationWriteGroup[];
  readonly readback?: MotorConfigurationSnapshot;
  readonly readbackError?: unknown;
}

function errorCodeOf(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function isDefiniteNotApplied(error: unknown): boolean {
  const code = errorCodeOf(error);
  return (
    code === 'MSP_REMOTE_ERROR' ||
    (code !== undefined && CONFIRMED_NOT_SENT_CODES.includes(code))
  );
}

/** The ONE shared liveness predicate - see
 * motorTestCapability.ts's own isMotorTestSessionActive() for why a
 * per-controller copy that read `mayHaveReachedFc` as liveness blocked
 * every configuration screen until the cable was replugged. */
const defaultMotorOutputEngaged = isMotorOutputEngagedForSession;

export class MotorConfigurationController {
  private readonly coordinator: MotorConfigurationSessionCoordinator;
  private readonly appStateOwner: MotorConfigurationAppStateOwner;
  private readonly isMotorOutputEngaged: (sessionId: string) => boolean;
  private readonly boxIds = new Map<
    string,
    {
      readonly client: MotorConfigurationClient;
      readonly acquisition: BoxIdsAcquisition;
    }
  >();

  constructor(options: MotorConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.isMotorOutputEngaged =
      options.isMotorOutputEngaged ?? defaultMotorOutputEngaged;
  }

  /**
   * U-R3: takes a `SetupUiSessionKey`, not a bare sessionId.
   *
   * This controller was the ONE of the nine whose caller could not
   * express a stale generation - the native layer is allowed to reuse a
   * sessionId string, so `sessionId` alone cannot distinguish one
   * activation from the next. Every other configuration controller had
   * been taking the composite key since Pass 7.1; this closes the gap
   * rather than reproducing the missing half inside the controller,
   * which would have meant inventing a generation the caller never
   * proved.
   */
  async load(sessionKey: SetupUiSessionKey): Promise<MotorConfigurationLoadOutcome> {
    const sessionId = sessionKey.sessionId;
    const preflight = this.captureSession(sessionId, 'MOTOR_CONFIGURATION_READ');
    if ('reason' in preflight) {
      return { kind: 'REJECTED', reason: preflight.reason };
    }
    const { client, scheduler, generation, epoch } = preflight;
    /* The half a bare sessionId could never carry. */
    if (generation !== sessionKey.generation) {
      return { kind: 'REJECTED', reason: 'DISCONNECTED' };
    }
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? { kind: 'REJECTED', reason: 'CONFIGURATION_BUSY' }
        : { kind: 'FAILED', error };
    }
    try {
      const operations = this.operations(sessionId, client, scheduler);
      const result = await operations.execute<MotorConfigurationSnapshot>({
        id: `motor-config:load:${sessionId}:${generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new MotorConfigurationPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLivePreflight(sessionId, client, generation, epoch);
          return rememberConfigurationSession(
            await this.readSnapshot(requester),
            sessionKey,
          );
        },
      });

      switch (result.status) {
        case 'SUCCEEDED':
          return { kind: 'LOADED', snapshot: result.result };
        case 'SESSION_ENDED':
        case 'OUTCOME_UNKNOWN':
          return { kind: 'SESSION_ENDED' };
        default:
          return result.error instanceof MotorConfigurationPreflightError
            ? { kind: 'REJECTED', reason: result.error.reason }
            : { kind: 'FAILED', error: result.error };
      }
    } finally {
      interlock.release();
    }
  }

  /**
   * THE AIRFRAME ALONE - M-F3F §15, and it costs the link almost nothing.
   *
   * =====================================================================
   * WHY THIS IS NOT `load()`
   * =====================================================================
   *
   * A screen that only DRAWS the aircraft needs two numbers: the mixer
   * mode and the runtime motor count. `load()` gives it those and four
   * other groups, and - far more expensively - it runs the full FC-tool
   * operation: an exclusive configuration interlock, a fresh capability
   * scope (which re-reads the box-id mapping), and a telemetry pause.
   *
   * That is exactly right for the settings editor, which is about to
   * WRITE. It is wrong for Setup, and measurably so: adding a `load()` at
   * connect time cost Setup a third box-id acquisition and starved its
   * attitude poll long enough that three of its own integration
   * assertions failed. A screen asking "which aircraft is this?" must not
   * degrade the screen it is asking on.
   *
   * So this is TWO READ-ONLY REQUESTS on the session's existing client.
   * No interlock - nothing is being written and nothing needs excluding.
   * No scope acquisition - no capability is being exercised. No telemetry
   * pause - the scheduler keeps running. It cannot change the board, and
   * it cannot make another operation fail: at worst it returns undefined.
   *
   * `undefined` means "not answered", never a guessed airframe.
   */
  async readObservedAirframe(sessionId: string): Promise<
    | {readonly mixerModeRaw: number; readonly motorCount: number | undefined}
    | undefined
  > {
    const preflight = this.captureSession(sessionId, 'MOTOR_CONFIGURATION_READ');
    if ('reason' in preflight) {
      return undefined;
    }
    const {client, generation, epoch} = preflight;
    try {
      this.assertLivePreflight(sessionId, client, generation, epoch);
      const [mixer, motor] = await Promise.all([
        this.read(client, MSP_MIXER_CONFIG, decodeMixerConfig),
        this.read(client, MSP_MOTOR_CONFIG, decodeMotorConfig),
      ]);
      /* Re-checked AFTER the reads: a session that ended underneath them
         would make these bytes describe a board that is no longer there. */
      this.assertLivePreflight(sessionId, client, generation, epoch);
      return Object.freeze({
        mixerModeRaw: mixer.mixerModeRaw,
        motorCount: motor.motorCount,
      });
    } catch {
      return undefined;
    }
  }

  async loadOutputOrder(
    sessionId: string,
  ): Promise<MotorOutputOrderLoadOutcome> {
    const preflight = this.captureSession(sessionId, 'MOTOR_CONFIGURATION_READ');
    if ('reason' in preflight) {
      return { kind: 'REJECTED', reason: preflight.reason };
    }
    const { client, scheduler, generation, epoch } = preflight;
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? { kind: 'REJECTED', reason: 'CONFIGURATION_BUSY' }
        : { kind: 'FAILED', error };
    }
    try {
      const result = await this.operations(
        sessionId,
        client,
        scheduler,
      ).execute<readonly number[]>({
        id: `motor-output-order:load:${sessionId}:${generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new MotorConfigurationPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLivePreflight(sessionId, client, generation, epoch);
          return this.readOutputOrder(requester);
        },
      });
      switch (result.status) {
        case 'SUCCEEDED':
          return { kind: 'LOADED', values: result.result };
        case 'SESSION_ENDED':
        case 'OUTCOME_UNKNOWN':
          return { kind: 'SESSION_ENDED' };
        default:
          return result.error instanceof MotorConfigurationPreflightError
            ? { kind: 'REJECTED', reason: result.error.reason }
            : { kind: 'FAILED', error: result.error };
      }
    } finally {
      interlock.release();
    }
  }

  async saveOutputOrder(
    sessionId: string,
    original: readonly number[],
    desired: readonly number[],
  ): Promise<MotorOutputOrderSaveOutcome> {
    let payload: Uint8Array;
    try {
      payload = encodeMotorOutputOrder(desired);
      encodeMotorOutputOrder(original);
    } catch (error) {
      return { kind: 'FAILED', error };
    }
    if (
      original.length === desired.length &&
      original.every((value, index) => value === desired[index])
    ) {
      return { kind: 'NO_CHANGES', values: Object.freeze([...original]) };
    }

    const preflight = this.captureSession(
      sessionId,
      'MOTOR_CONFIGURATION_WRITE',
    );
    if ('reason' in preflight) {
      return { kind: 'REJECTED', reason: preflight.reason };
    }
    const { client, scheduler, generation, epoch } = preflight;
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? { kind: 'REJECTED', reason: 'CONFIGURATION_BUSY' }
        : { kind: 'FAILED', error };
    }
    try {
      const acquisition = this.boxIdsFor(sessionId, client);
      const identity: BoxIdsOwnerIdentity = {
        physicalGeneration: generation,
        mspEpoch: epoch,
      };
      const result = await this.operations(
        sessionId,
        client,
        scheduler,
      ).execute<
        | { readonly kind: 'VERIFIED'; readonly values: readonly number[] }
        | { readonly kind: 'UNVERIFIED'; readonly error: unknown }
      >({
        id: `motor-output-order:save:${sessionId}:${generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new MotorConfigurationPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLivePreflight(sessionId, client, generation, epoch);
          const current = await this.readOutputOrder(requester);
          if (
            current.length !== original.length ||
            !current.every((value, index) => value === original[index])
          ) {
            throw new MotorConfigurationPreflightError('STALE_BASE');
          }

          await this.assertDisarmed(
            sessionId,
            client,
            generation,
            epoch,
            requester,
            acquisition,
            identity,
          );

          /* U-R1. Two mutating stages, so the same rule as the main save:
             re-ask liveness in the frame's own synchronous turn, and once
             the reorder map has been acknowledged never let the EEPROM
             commit reach a board that has meanwhile restarted. A reorder
             persisted across a restart maps the operator's motor numbers
             onto outputs they never saw. */
          let reordered = false;
          const stopIfNotLive = (stage: 'OUTPUT_ORDER' | 'EEPROM'): void => {
            try {
              this.assertLivePreflight(sessionId, client, generation, epoch);
            } catch (error) {
              if (!reordered) {
                throw error;
              }
              throw new MotorConfigurationAmbiguousWriteError(
                new MutationStoppedError(stage, ['OUTPUT_ORDER'], error),
                stage,
                [],
                true,
                true,
              );
            }
          };

          stopIfNotLive('OUTPUT_ORDER');
          try {
            await requester.request(MSP2_SET_MOTOR_OUTPUT_REORDERING, payload, {
              wireFormat: 'v2',
            });
          } catch (error) {
            if (isDefiniteNotApplied(error)) {
              throw new MotorConfigurationDefiniteWriteError(error, []);
            }
            throw new MotorConfigurationAmbiguousWriteError(
              error,
              'OUTPUT_ORDER',
              [],
            );
          }
          reordered = true;

          stopIfNotLive('EEPROM');
          try {
            await requester.request(MSP_EEPROM_WRITE, EMPTY_PAYLOAD, {
              wireFormat: 'v1',
            });
          } catch (error) {
            if (isDefiniteNotApplied(error)) {
              /* The map is live in RAM and the commit was refused
                 outright - not a failed save, an unpersisted one. */
              throw new MotorConfigurationAmbiguousWriteError(
                error,
                'EEPROM',
                [],
                true,
                true,
              );
            }
            throw new MotorConfigurationAmbiguousWriteError(
              error,
              'EEPROM',
              [],
            );
          }

          try {
            const readback = await this.readOutputOrder(requester);
            return { kind: 'VERIFIED' as const, values: readback };
          } catch (error) {
            return { kind: 'UNVERIFIED' as const, error };
          }
        },
      });

      switch (result.status) {
        case 'SUCCEEDED':
          if (result.result.kind === 'UNVERIFIED') {
            return { kind: 'SAVED_UNVERIFIED', error: result.result.error };
          }
          return result.result.values.length === desired.length &&
            result.result.values.every(
              (value, index) => value === desired[index],
            )
            ? { kind: 'SAVED_VERIFIED', values: result.result.values }
            : {
                kind: 'SAVED_UNVERIFIED',
                error: new Error(
                  'Motor output order readback did not match the requested map.',
                ),
              };
        case 'OUTCOME_UNKNOWN': {
          const reason = result.reason;
          if (
            !isAmbiguousWriteCause(reason) ||
            (reason.stage !== 'OUTPUT_ORDER' && reason.stage !== 'EEPROM')
          ) {
            return { kind: 'UNCONFIRMED', stage: 'OUTPUT_ORDER' };
          }
          /* U-R1. The map is in RAM and provably not in flash. */
          return reason.partial
            ? {
                kind: 'PARTIAL_UNPERSISTED',
                failedStage: 'EEPROM',
                definitelyNotSent: reason.definitelyNotSent,
              }
            : { kind: 'UNCONFIRMED', stage: reason.stage };
        }
        case 'SESSION_ENDED':
          return { kind: 'SESSION_ENDED' };
        default:
          if (result.error instanceof MotorConfigurationPreflightError) {
            return { kind: 'REJECTED', reason: result.error.reason };
          }
          if (result.error instanceof MotorConfigurationDefiniteWriteError) {
            return { kind: 'FAILED', error: result.error.cause };
          }
          return { kind: 'FAILED', error: result.error };
      }
    } finally {
      interlock.release();
    }
  }

  async setEscDirection(
    sessionId: string,
    motorNumber: number,
    direction: DshotEscDirection,
  ): Promise<EscDirectionOutcome> {
    let payload: Uint8Array;
    try {
      payload = encodeDshotEscDirection(motorNumber - 1, direction);
    } catch (error) {
      return { kind: 'FAILED', error };
    }

    const preflight = this.captureSession(sessionId, 'ESC_DIRECTION_WRITE');
    if ('reason' in preflight) {
      return { kind: 'REJECTED', reason: preflight.reason };
    }
    const { client, scheduler, generation, epoch } = preflight;
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? { kind: 'REJECTED', reason: 'CONFIGURATION_BUSY' }
        : { kind: 'FAILED', error };
    }
    try {
      const acquisition = this.boxIdsFor(sessionId, client);
      const identity: BoxIdsOwnerIdentity = {
        physicalGeneration: generation,
        mspEpoch: epoch,
      };
      const result = await this.operations(
        sessionId,
        client,
        scheduler,
      ).execute<void>({
        id: `esc-direction:${sessionId}:${generation}:${motorNumber}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new MotorConfigurationPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLivePreflight(sessionId, client, generation, epoch);
          // Direction needs only these three stable motor facts. Do not
          // couple the API-1.46/1.48 direction adapter to the wider
          // API-1.47 configuration transaction (mixer and 3D-range reads),
          // whose payloads are deliberately not granted write parity.
          const configuration = await this.readEscDirectionScope(requester);
          const protocol = configuration.motorProtocolRaw;
          if (
            motorNumber < 1 ||
            motorNumber > configuration.motorCount ||
            protocol < 5 ||
            protocol > 8 ||
            configuration.feature3dEnabled
          ) {
            throw new MotorConfigurationPreflightError(
              'ESC_DIRECTION_UNSUPPORTED',
            );
          }

          await this.assertDisarmed(
            sessionId,
            client,
            generation,
            epoch,
            requester,
            acquisition,
            identity,
          );

          try {
            await requester.request(MSP2_SEND_DSHOT_COMMAND, payload, {
              wireFormat: 'v2',
            });
          } catch (error) {
            if (isDefiniteNotApplied(error)) {
              throw new MotorConfigurationDefiniteWriteError(error, []);
            }
            throw new MotorConfigurationAmbiguousWriteError(
              error,
              'ESC_DIRECTION',
              [],
            );
          }
        },
      });

      switch (result.status) {
        case 'SUCCEEDED':
          return {
            kind: 'ACKNOWLEDGED',
            motorNumber,
            direction,
            physicallyVerified: false,
          };
        case 'OUTCOME_UNKNOWN':
          return { kind: 'UNCONFIRMED' };
        case 'SESSION_ENDED':
          return { kind: 'SESSION_ENDED' };
        default:
          if (result.error instanceof MotorConfigurationPreflightError) {
            return { kind: 'REJECTED', reason: result.error.reason };
          }
          if (result.error instanceof MotorConfigurationDefiniteWriteError) {
            return { kind: 'FAILED', error: result.error.cause };
          }
          return { kind: 'FAILED', error: result.error };
      }
    } finally {
      interlock.release();
    }
  }

  async save(
    sessionKey: SetupUiSessionKey,
    original: MotorConfigurationSnapshot,
    draft: MotorConfigurationDraft,
  ): Promise<MotorConfigurationSaveOutcome> {
    const sessionId = sessionKey.sessionId;
    /* SESSION-BOUND DRAFT OWNERSHIP.
       FIRST, before validation, before captureSession(), before any wire
       access at all: a baseline produced under a DIFFERENT session may
       not be written under this one. Two byte-identical boards defeat
       every other guard here - stale-base compares configuration, and
       assertLivePreflight compares liveness; neither asks which aircraft
       the operator was editing.
       See core/state/configurationSessionOwnership. */
    if (!isOwnedByConfigurationSession(original, sessionKey)) {
      return { kind: 'REJECTED', reason: 'SESSION_CHANGED' };
    }
    const validation = validateMotorConfigurationDraft(draft);
    if (!validation.valid) {
      return {
        kind: 'REJECTED',
        reason: 'INVALID_DRAFT',
        issues: validation.issues,
      };
    }
    // Is there anything at all to do? Answered against the snapshot the
    // editor is holding, because it must be answered WITHOUT touching the
    // link - an unchanged save costs nothing and takes no lease.
    //
    // The payloads themselves are NOT taken from here. See the re-encode
    // inside the transaction below for why that distinction matters.
    if (encodeChangedMotorConfiguration(original, draft).length === 0) {
      return { kind: 'NO_CHANGES', snapshot: original };
    }

    const preflight = this.captureSession(
      sessionId,
      'MOTOR_CONFIGURATION_WRITE',
    );
    if ('reason' in preflight) {
      return { kind: 'REJECTED', reason: preflight.reason };
    }
    const { client, scheduler, generation, epoch } = preflight;
    /* The half a bare sessionId could never carry. */
    if (generation !== sessionKey.generation) {
      return { kind: 'REJECTED', reason: 'DISCONNECTED' };
    }
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? { kind: 'REJECTED', reason: 'CONFIGURATION_BUSY' }
        : {
            kind: 'FAILED',
            error,
            acknowledgedGroups: [],
            persisted: false,
          };
    }
    try {
      const acquisition = this.boxIdsFor(sessionId, client);
      const identity: BoxIdsOwnerIdentity = {
        physicalGeneration: generation,
        mspEpoch: epoch,
      };
      const operations = this.operations(sessionId, client, scheduler);
      const result = await operations.execute<SaveExecutionResult>({
        id: `motor-config:save:${sessionId}:${generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new MotorConfigurationPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLivePreflight(sessionId, client, generation, epoch);

          // Re-read the owned groups under the exclusive lease. A second
          // configurator changing the FC after the UI loaded cannot be silently
          // overwritten by an old draft.
          const current = await this.readSnapshot(requester);
          if (
            !motorConfigurationDraftsEqual(
              createMotorConfigurationDraft(current),
              createMotorConfigurationDraft(original),
            )
          ) {
            throw new MotorConfigurationPreflightError('STALE_BASE');
          }

          /*
           * THE PAYLOADS ARE BUILT FROM `current`, NOT FROM `original`.
           *
           * Three of the five commands this transaction sends carry fields
           * the Motors page does not own and cannot show:
           *
           *   MSP_SET_FEATURE_CONFIG    ONE 32-bit mask for the whole
           *                             aircraft. Motors owns 3 bits of it;
           *                             GPS, Ports, Receiver and General
           *                             own others.
           *   MSP_SET_ADVANCED_CONFIG   carries pid_process_denom, the gyro
           *                             calibration fields, gyro_offset_yaw
           *                             and debug_mode.
           *   MSP_SET_MIXER_CONFIG      carries the mixer mode.
           *
           * MSP has no way to set one bit of a shared value: the whole
           * thing goes on the wire every time. So whichever snapshot these
           * unowned fields are mirrored from is the version of them the
           * aircraft ends up with.
           *
           * Mirroring them from `original` - the snapshot the editor loaded,
           * possibly minutes and several screens ago - meant a Motors save
           * quietly reverted anything another screen had changed since. The
           * stale-base check above cannot catch it: it compares the DRAFT,
           * which projects 3 bits of a 32-bit mask, so a GPS feature enabled
           * in between compares equal and is then overwritten. Every signal
           * says success - the write is acknowledged, the EEPROM commit
           * lands, the readback of the owned fields matches exactly - and
           * the aircraft has silently lost its GPS feature.
           *
           * `current` was read a few lines above under this transaction's
           * own exclusive lease, and the owned fields in it have just been
           * proven equal to the base the operator edited. So it is the same
           * base for everything Motors owns, and the LIVE value for
           * everything it does not.
           *
           * The set of groups is unchanged by this: for each shared payload
           * the unowned fields appear on both sides of the changed-or-not
           * comparison and cancel, so a group is emitted on exactly the
           * same condition as before.
           */
          const writes = encodeChangedMotorConfiguration(current, draft);

          const stillOwned = (): boolean =>
            this.isStillOwned(sessionId, client, generation, epoch);
          const mapping = await acquisition.acquire(identity, stillOwned);
          this.assertLivePreflight(sessionId, client, generation, epoch);
          if (mapping.kind !== 'READY') {
            throw new MotorConfigurationPreflightError('ARMED_STATE_UNKNOWN');
          }

          // The final awaited preflight read. From its resolution to the first
          // write, all checks are synchronous.
          const statusFrame = await requester.request(
            MSP_STATUS_EX,
            EMPTY_PAYLOAD,
            { wireFormat: 'v1' },
          );
          const status = decodeStatusExDiagnostics(statusFrame.payload);
          const armed = deriveArmedState(
            status.flightModeFlagsLow32,
            status.readiness.extraFlightModeFlagBytes,
            mapping.permanentIds,
          );
          if (armed === 'ARMED') {
            throw new MotorConfigurationPreflightError('FC_ARMED');
          }
          if (armed !== 'DISARMED' || status.readiness.malformedTail) {
            throw new MotorConfigurationPreflightError('ARMED_STATE_UNKNOWN');
          }
          this.assertLivePreflight(sessionId, client, generation, epoch);

          /*
           * U-R1 - LIVENESS IS RE-ASKED BEFORE EVERY MUTATING FRAME.
           *
           * The preflight above establishes that the board is ours, is
           * disarmed, and is answering. It establishes it ONCE. Between
           * this point and the EEPROM commit there are up to six awaited
           * round trips, and a flight controller can restart inside any
           * of them - a brownout, a bench knock on the USB plug, a
           * watchdog. When it does, the frames after the restart land on
           * a board that has come back with its stored RAM, and the
           * EEPROM write at the end then persists that mixture. One
           * operator intent, split durably across two FC lifetimes,
           * reported as a successful save.
           *
           * So each frame re-asks immediately before it goes out, and
           * the check and the request sit in the SAME synchronous turn -
           * no `await` between them - because a check separated from its
           * write by a suspension point is a check of the past.
           *
           * After the first acknowledgement the answer to "is it still
           * live" stops being a refusal and becomes a report: the
           * aircraft's RAM has already moved, and the ledger says by how
           * much.
           */
          const ledger = new MutationLedger<MotorConfigurationWriteGroup>();
          for (const write of writes) {
            this.stopIfNotLive(
              sessionId,
              client,
              generation,
              epoch,
              write.group,
              ledger,
            );
            try {
              await requester.request(
                COMMAND_FOR_GROUP[write.group],
                write.payload,
                { wireFormat: 'v1' },
              );
            } catch (error) {
              throw this.writeFailure(error, write.group, ledger);
            }
            ledger.acknowledge(write.group);
          }

          this.stopIfNotLive(
            sessionId,
            client,
            generation,
            epoch,
            'EEPROM',
            ledger,
          );
          try {
            await requester.request(MSP_EEPROM_WRITE, EMPTY_PAYLOAD, {
              wireFormat: 'v1',
            });
          } catch (error) {
            throw this.writeFailure(error, 'EEPROM', ledger);
          }
          ledger.markPersisted();

          // Persistence is already acknowledged. A readback failure cannot
          // truthfully downgrade it to a failed save.
          try {
            const readback = await this.readSnapshot(requester);
            return {
              originalWhenSaved: original,
              changedGroups: Object.freeze(writes.map(write => write.group)),
              readback,
            };
          } catch (readbackError) {
            return {
              originalWhenSaved: original,
              changedGroups: Object.freeze(writes.map(write => write.group)),
              readbackError,
            };
          }
        },
      });

      switch (result.status) {
        case 'SUCCEEDED': {
          const execution = result.result;
          if (execution.readback === undefined) {
            return {
              kind: 'SAVED_UNVERIFIED',
              rebootRequired: true,
              changedGroups: execution.changedGroups,
              error: execution.readbackError,
            };
          }
          if (
            !motorConfigurationDraftsEqual(
              createMotorConfigurationDraft(execution.readback),
              draft,
            )
          ) {
            return {
              kind: 'SAVED_UNVERIFIED',
              rebootRequired: true,
              changedGroups: execution.changedGroups,
              error: new Error(
                'Motor configuration readback did not match the saved draft.',
              ),
            };
          }
          return {
            kind: 'SAVED_VERIFIED',
            snapshot: rememberConfigurationSession(
              execution.readback,
              sessionKey,
            ),
            rebootRequired: true,
            changedGroups: execution.changedGroups,
          };
        }
        case 'OUTCOME_UNKNOWN': {
          const reason = result.reason;
          if (
            !isAmbiguousWriteCause(reason) ||
            reason.stage === 'OUTPUT_ORDER' ||
            reason.stage === 'ESC_DIRECTION'
          ) {
            return {
              kind: 'UNCONFIRMED',
              stage: 'UNKNOWN',
              acknowledgedGroups: [],
            };
          }
          /* U-R1. Groups acknowledged, nothing persisted: the aircraft is
             running a mixture until its next power cycle, which is a
             different statement from "the result is unknown" and has to
             be made separately. */
          return reason.partial
            ? {
                kind: 'PARTIAL_UNPERSISTED',
                acknowledgedGroups: reason.acknowledgedGroups,
                failedStage: reason.stage,
                definitelyNotSent: reason.definitelyNotSent,
              }
            : {
                kind: 'UNCONFIRMED',
                stage: reason.stage,
                acknowledgedGroups: reason.acknowledgedGroups,
              };
        }
        case 'SESSION_ENDED':
          return { kind: 'SESSION_ENDED' };
        default: {
          const error = result.error;
          if (error instanceof MotorConfigurationPreflightError) {
            return { kind: 'REJECTED', reason: error.reason };
          }
          if (error instanceof MotorConfigurationDefiniteWriteError) {
            return {
              kind: 'FAILED',
              error: error.cause,
              acknowledgedGroups: error.acknowledgedGroups,
              persisted: false,
            };
          }
          return {
            kind: 'FAILED',
            error,
            acknowledgedGroups: [],
            persisted: false,
          };
        }
      }
    } finally {
      interlock.release();
    }
  }

  /**
   * Send MSP_REBOOT so a persisted mixer/props save can take effect - the
   * same frame and the same guard order the General controller's
   * save-and-reboot uses, but as a standalone, explicitly requested step:
   * DISARMED is re-verified immediately before the frame, because
   * restarting an armed flight controller is the one thing this must
   * never do, and the link dropping right after the request is reported
   * as the reboot proceeding, not as an error.
   */
  async requestReboot(sessionId: string): Promise<MotorRebootOutcome> {
    const preflight = this.captureSession(
      sessionId,
      'MOTOR_CONFIGURATION_WRITE',
    );
    if ('reason' in preflight) {
      return { kind: 'REJECTED', reason: preflight.reason };
    }
    const { client, scheduler, generation, epoch } = preflight;
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? { kind: 'REJECTED', reason: 'CONFIGURATION_BUSY' }
        : { kind: 'FAILED', error };
    }
    try {
      const acquisition = this.boxIdsFor(sessionId, client);
      const identity: BoxIdsOwnerIdentity = {
        physicalGeneration: generation,
        mspEpoch: epoch,
      };
      const result = await this.operations(sessionId, client, scheduler).execute<{
        readonly acknowledged: boolean;
      }>({
        id: `motor-config:reboot:${sessionId}:${generation}`,
        sessionEffect: 'EXPECT_REBOOT',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new MotorConfigurationPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLivePreflight(sessionId, client, generation, epoch);
          await this.assertDisarmed(
            sessionId,
            client,
            generation,
            epoch,
            requester,
            acquisition,
            identity,
          );
          try {
            await requester.request(MSP_REBOOT, EMPTY_PAYLOAD, {
              wireFormat: 'v1',
            });
            return { acknowledged: true };
          } catch (error) {
            if (isDefiniteNotApplied(error)) {
              throw new MotorConfigurationDefiniteWriteError(error, []);
            }
            // The restarting FC tears the link down; an unanswered
            // MSP_REBOOT is the expected shape of the reboot happening.
            return { acknowledged: false };
          }
        },
      });
      switch (result.status) {
        case 'SUCCEEDED':
          return {
            kind: 'REBOOT_REQUESTED',
            acknowledged: result.result.acknowledged,
          };
        case 'OUTCOME_UNKNOWN':
          // The link died before the reboot frame was dispatched - during
          // the disarmed preflight, for example. Whether the FC is
          // restarting is genuinely unknown; do not claim it is.
          return { kind: 'UNCONFIRMED' };
        case 'SESSION_ENDED':
          return { kind: 'SESSION_ENDED' };
        default:
          if (result.error instanceof MotorConfigurationPreflightError) {
            return { kind: 'REJECTED', reason: result.error.reason };
          }
          if (result.error instanceof MotorConfigurationDefiniteWriteError) {
            return { kind: 'FAILED', error: result.error.cause };
          }
          return { kind: 'FAILED', error: result.error };
      }
    } finally {
      interlock.release();
    }
  }

  private async assertDisarmed(
    sessionId: string,
    client: MotorConfigurationClient,
    generation: number,
    epoch: number,
    requester: MspRequester,
    acquisition: BoxIdsAcquisition,
    identity: BoxIdsOwnerIdentity,
  ): Promise<void> {
    const stillOwned = (): boolean =>
      this.isStillOwned(sessionId, client, generation, epoch);
    const mapping = await acquisition.acquire(identity, stillOwned);
    this.assertLivePreflight(sessionId, client, generation, epoch);
    if (mapping.kind !== 'READY') {
      throw new MotorConfigurationPreflightError('ARMED_STATE_UNKNOWN');
    }

    const statusFrame = await requester.request(MSP_STATUS_EX, EMPTY_PAYLOAD, {
      wireFormat: 'v1',
    });
    const status = decodeStatusExDiagnostics(statusFrame.payload);
    const armed = deriveArmedState(
      status.flightModeFlagsLow32,
      status.readiness.extraFlightModeFlagBytes,
      mapping.permanentIds,
    );
    if (armed === 'ARMED') {
      throw new MotorConfigurationPreflightError('FC_ARMED');
    }
    if (armed !== 'DISARMED' || status.readiness.malformedTail) {
      throw new MotorConfigurationPreflightError('ARMED_STATE_UNKNOWN');
    }
    this.assertLivePreflight(sessionId, client, generation, epoch);
  }

  /**
   * The admission check every operation runs before touching the link.
   *
   * `requiredCapability` HAS NO DEFAULT, and that is the fix rather than an
   * accident of style. It used to default to MOTOR_CONFIGURATION_WRITE, so
   * every caller that forgot to pass one - including `load`, which only
   * ever reads - demanded permission to WRITE. On a board whose writes were
   * withheld but whose reads were fine, opening the Motors page returned
   * INCOMPATIBLE_FIRMWARE and the operator was shown nothing at all. Asking
   * for the capability you actually exercise is now compulsory.
   */
  private captureSession(
    sessionId: string,
    requiredCapability: MotorFirmwareCapability,
  ):
    | {
        readonly client: MotorConfigurationClient;
        readonly scheduler: MspTelemetryScheduler;
        readonly generation: number;
        readonly epoch: number;
      }
    | { readonly reason: MotorConfigurationBlockReason } {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') {
      return { reason: 'APP_BACKGROUNDED' };
    }
    // Motors may be TURNING - not merely "a session is open". A session
    // sitting at rest is exactly as safe as no session, and blocking it was
    // the whole of the close-leave-return loop.
    if (this.isMotorOutputEngaged(sessionId)) {
      return { reason: 'MOTOR_TEST_ACTIVE' };
    }
    const compatibility = this.compatibilityOf(
      sessionId,
      requiredCapability,
    );
    if (compatibility !== undefined) {
      return { reason: compatibility };
    }
    const key = this.coordinator.getSessionKey(sessionId);
    const client = this.coordinator.getActiveMspClient(sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(sessionId);
    if (
      this.coordinator.getOwnershipState(sessionId) !== 'ACTIVE' ||
      key === undefined ||
      client === undefined ||
      scheduler === undefined
    ) {
      return { reason: 'DISCONNECTED' };
    }
    if (this.coordinator.getMspRecoveryState(sessionId) !== 'READY') {
      return { reason: 'LINK_RECOVERING' };
    }
    return {
      client,
      scheduler,
      generation: key.generation,
      epoch: client.getEpoch(),
    };
  }

  /**
   * Turns "this firmware lacks the capability" into the RIGHT refusal.
   *
   * Two different things were being reported identically. A board this app
   * cannot read at all and a board it can read but will not write to are
   * not the same situation, and collapsing them meant the second one was
   * described to the operator with a sentence about the screen being
   * unsupported - in front of a screen that had just loaded their settings.
   *
   * So the read capability is asked about SEPARATELY: if it is there and
   * the requested write is not, the refusal is about the write.
   */
  private compatibilityOf(
    sessionId: string,
    requiredCapability: MotorFirmwareCapability,
  ): MotorConfigurationBlockReason | undefined {
    const state = this.coordinator.getIdentificationState(sessionId);
    if (state.status === 'IDLE' || state.status === 'RUNNING') {
      return 'IDENTIFYING';
    }
    if (state.status === 'FAILED') {
      return 'INCOMPATIBLE_FIRMWARE';
    }
    const compatibility = resolveMotorFirmwareCompatibility(state.identity);
    if (motorFirmwareSupports(compatibility, requiredCapability)) {
      return undefined;
    }
    return requiredCapability !== 'MOTOR_CONFIGURATION_READ' &&
      motorFirmwareSupports(compatibility, 'MOTOR_CONFIGURATION_READ')
      ? 'CONFIGURATION_WRITE_UNVERIFIED'
      : 'INCOMPATIBLE_FIRMWARE';
  }

  private assertLivePreflight(
    sessionId: string,
    client: MotorConfigurationClient,
    generation: number,
    epoch: number,
  ): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') {
      throw new MotorConfigurationPreflightError('APP_BACKGROUNDED');
    }
    // Re-checked at write time, not just at admission: the operator may have
    // started a motor between opening the editor and pressing save.
    if (this.isMotorOutputEngaged(sessionId)) {
      throw new MotorConfigurationPreflightError('MOTOR_TEST_ACTIVE');
    }
    if (!this.isStillOwned(sessionId, client, generation, epoch)) {
      throw new MotorConfigurationPreflightError('DISCONNECTED');
    }
    if (this.coordinator.getMspRecoveryState(sessionId) !== 'READY') {
      throw new MotorConfigurationPreflightError('LINK_RECOVERING');
    }
  }

  /**
   * The liveness check a MUTATING frame asks immediately before going out.
   *
   * Before anything has been acknowledged this is exactly
   * `assertLivePreflight` - the aircraft is untouched, so a lost session
   * is an ordinary refusal and the operator is told the save did not
   * happen, which is true.
   *
   * After the first acknowledgement it can no longer say that. The RAM
   * has moved. The sequence still stops - continuing would write to
   * whatever is on the other end of the link now, which is the defect
   * this closes - but it stops with the ledger attached so the outcome
   * can name the groups the board accepted.
   *
   * THE INVARIANT THIS EXISTS FOR: when liveness is lost after any SET,
   * the EEPROM write count is zero. Nothing half-applied is ever made
   * permanent.
   */
  private stopIfNotLive(
    sessionId: string,
    client: MotorConfigurationClient,
    generation: number,
    epoch: number,
    stage: MotorConfigurationWriteGroup | 'EEPROM',
    ledger: MutationLedger<MotorConfigurationWriteGroup>,
  ): void {
    try {
      this.assertLivePreflight(sessionId, client, generation, epoch);
    } catch (error) {
      if (!ledger.hasMutated) {
        throw error;
      }
      throw new MotorConfigurationAmbiguousWriteError(
        new MutationStoppedError(stage, ledger.acknowledgedStages, error),
        stage,
        ledger.acknowledgedStages,
        true,
        // This app stopped before handing the frame to the transport, so
        // it provably never reached the flight controller.
        true,
      );
    }
  }

  /**
   * What a refused or unanswered mutating frame means, given what the
   * board has already accepted.
   *
   * A refusal with an EMPTY ledger is an ordinary failure and keeps the
   * existing `FAILED` answer: nothing was written, and saying so is
   * accurate.
   *
   * A refusal AFTER an acknowledgement is not. The refused frame is
   * provably not applied, and the acknowledged ones provably are - the
   * aircraft is running a mixture, unpersisted. Reporting that as
   * `FAILED` is the second confirmed defect this phase closes.
   *
   * An UNANSWERED frame stays ambiguous in both cases and is never
   * upgraded to either certainty.
   */
  private writeFailure(
    error: unknown,
    stage: MotorConfigurationWriteGroup | 'EEPROM',
    ledger: MutationLedger<MotorConfigurationWriteGroup>,
  ): unknown {
    if (isDefiniteNotApplied(error)) {
      return ledger.hasMutated
        ? new MotorConfigurationAmbiguousWriteError(
            error,
            stage,
            ledger.acknowledgedStages,
            true,
            true,
          )
        : new MotorConfigurationDefiniteWriteError(
            error,
            ledger.acknowledgedStages,
          );
    }
    return new MotorConfigurationAmbiguousWriteError(
      error,
      stage,
      ledger.acknowledgedStages,
      false,
      false,
    );
  }

  private isStillOwned(
    sessionId: string,
    client: MotorConfigurationClient,
    generation: number,
    epoch: number,
  ): boolean {
    return (
      this.coordinator.getOwnershipState(sessionId) === 'ACTIVE' &&
      this.coordinator.getSessionKey(sessionId)?.generation === generation &&
      this.coordinator.getActiveMspClient(sessionId) === client &&
      client.getEpoch() === epoch
    );
  }

  private operations(
    sessionId: string,
    client: MotorConfigurationClient,
    scheduler: MspTelemetryScheduler,
  ) {
    return createMspOperationCoordinator(
      client,
      scheduler,
      { captureCurrent: () => this.coordinator.getSessionKey(sessionId) },
      {
        getContext: () => ({
          clientState:
            this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED',
          isArmed: false,
        }),
      },
    );
  }

  private boxIdsFor(
    sessionId: string,
    client: MotorConfigurationClient,
  ): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId);
    if (existing !== undefined && existing.client === client) {
      return existing.acquisition;
    }
    const acquisition = new BoxIdsAcquisition(client);
    this.boxIds.set(sessionId, { client, acquisition });
    return acquisition;
  }

  private async readSnapshot(
    requester: MspRequester,
  ): Promise<MotorConfigurationSnapshot> {
    const [feature, mixer, motor, motor3d, advanced] = await Promise.all([
      this.read(requester, MSP_FEATURE_CONFIG, decodeFeatureConfig),
      this.read(requester, MSP_MIXER_CONFIG, decodeMixerConfig),
      this.read(requester, MSP_MOTOR_CONFIG, decodeMotorConfig),
      this.read(requester, MSP_MOTOR_3D_CONFIG, decodeMotor3dConfig),
      this.read(requester, MSP_ADVANCED_CONFIG, decodeAdvancedConfig),
    ]);
    return Object.freeze({ feature, mixer, motor, motor3d, advanced });
  }

  /**
   * Minimal read model for a persistent DShot direction command.
   *
   * The direction adapters for API 1.46 and 1.48 were admitted only after
   * these exact motor-relevant fields were reviewed. Keeping this separate
   * from readSnapshot() prevents an unrelated API-1.47 settings payload from
   * becoming an accidental prerequisite for the direction operation.
   */
  private async readEscDirectionScope(
    requester: MspRequester,
  ): Promise<{
    readonly motorCount: number;
    readonly motorProtocolRaw: number;
    readonly feature3dEnabled: boolean;
  }> {
    const [feature, motor, advanced] = await Promise.all([
      this.read(requester, MSP_FEATURE_CONFIG, decodeFeatureConfig),
      this.read(requester, MSP_MOTOR_CONFIG, decodeMotorConfig),
      this.read(requester, MSP_ADVANCED_CONFIG, decodeAdvancedConfig),
    ]);
    return Object.freeze({
      motorCount: motor.motorCount,
      motorProtocolRaw: advanced.motorProtocolRaw,
      feature3dEnabled: feature.feature3dEnabled,
    });
  }

  private async readOutputOrder(
    requester: MspRequester,
  ): Promise<readonly number[]> {
    const frame = await requester.request(
      MSP2_MOTOR_OUTPUT_REORDERING,
      EMPTY_PAYLOAD,
      { wireFormat: 'v2' },
    );
    return decodeMotorOutputOrder(frame.payload).values;
  }

  private async read<T>(
    requester: MspRequester,
    command: number,
    decode: (payload: Uint8Array) => T,
  ): Promise<T> {
    const frame = await requester.request(command, EMPTY_PAYLOAD, {
      wireFormat: 'v1',
    });
    return decode(frame.payload);
  }
}

export const motorConfigurationController = new MotorConfigurationController();
