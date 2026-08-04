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
  MSP_SET_ADVANCED_CONFIG,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_MIXER_CONFIG,
  MSP_SET_MOTOR_3D_CONFIG,
  MSP_SET_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import { decodeAdvancedConfig } from '../../../core/protocol/msp/decoding/decodeAdvancedConfig';
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
  isMotorTestSessionActive,
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
  | 'ESC_DIRECTION_UNSUPPORTED';

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
  /** Test seam only. Production uses the official capability store. */
  readonly isMotorTestActive?: (sessionId: string) => boolean;
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
  ) {
    super(
      Object.freeze({
        kind: 'MOTOR_CONFIGURATION_AMBIGUOUS_WRITE',
        originalError: cause,
        stage,
        acknowledgedGroups,
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
const defaultMotorTestActive = isMotorTestSessionActive;

export class MotorConfigurationController {
  private readonly coordinator: MotorConfigurationSessionCoordinator;
  private readonly appStateOwner: MotorConfigurationAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
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
    this.isMotorTestActive =
      options.isMotorTestActive ?? defaultMotorTestActive;
  }

  async load(sessionId: string): Promise<MotorConfigurationLoadOutcome> {
    const preflight = this.captureSession(sessionId);
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
          return this.readSnapshot(requester);
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

  async loadOutputOrder(
    sessionId: string,
  ): Promise<MotorOutputOrderLoadOutcome> {
    const preflight = this.captureSession(sessionId);
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

    const preflight = this.captureSession(sessionId);
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

          try {
            await requester.request(MSP_EEPROM_WRITE, EMPTY_PAYLOAD, {
              wireFormat: 'v1',
            });
          } catch (error) {
            if (isDefiniteNotApplied(error)) {
              throw new MotorConfigurationDefiniteWriteError(error, []);
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
          return isAmbiguousWriteCause(reason) &&
            (reason.stage === 'OUTPUT_ORDER' || reason.stage === 'EEPROM')
            ? { kind: 'UNCONFIRMED', stage: reason.stage }
            : { kind: 'UNCONFIRMED', stage: 'OUTPUT_ORDER' };
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
    sessionId: string,
    original: MotorConfigurationSnapshot,
    draft: MotorConfigurationDraft,
  ): Promise<MotorConfigurationSaveOutcome> {
    const validation = validateMotorConfigurationDraft(draft);
    if (!validation.valid) {
      return {
        kind: 'REJECTED',
        reason: 'INVALID_DRAFT',
        issues: validation.issues,
      };
    }
    const writes = encodeChangedMotorConfiguration(original, draft);
    if (writes.length === 0) {
      return { kind: 'NO_CHANGES', snapshot: original };
    }

    const preflight = this.captureSession(sessionId);
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

          const acknowledged: MotorConfigurationWriteGroup[] = [];
          for (const write of writes) {
            try {
              await requester.request(
                COMMAND_FOR_GROUP[write.group],
                write.payload,
                { wireFormat: 'v1' },
              );
              acknowledged.push(write.group);
            } catch (error) {
              if (isDefiniteNotApplied(error)) {
                throw new MotorConfigurationDefiniteWriteError(
                  error,
                  Object.freeze([...acknowledged]),
                );
              }
              throw new MotorConfigurationAmbiguousWriteError(
                error,
                write.group,
                Object.freeze([...acknowledged]),
              );
            }
          }

          try {
            await requester.request(MSP_EEPROM_WRITE, EMPTY_PAYLOAD, {
              wireFormat: 'v1',
            });
          } catch (error) {
            if (isDefiniteNotApplied(error)) {
              throw new MotorConfigurationDefiniteWriteError(
                error,
                Object.freeze([...acknowledged]),
              );
            }
            throw new MotorConfigurationAmbiguousWriteError(
              error,
              'EEPROM',
              Object.freeze([...acknowledged]),
            );
          }

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
            snapshot: execution.readback,
            rebootRequired: true,
            changedGroups: execution.changedGroups,
          };
        }
        case 'OUTCOME_UNKNOWN': {
          const reason = result.reason;
          return isAmbiguousWriteCause(reason) &&
            reason.stage !== 'OUTPUT_ORDER' &&
            reason.stage !== 'ESC_DIRECTION'
            ? {
                kind: 'UNCONFIRMED',
                stage: reason.stage,
                acknowledgedGroups: reason.acknowledgedGroups,
              }
            : {
                kind: 'UNCONFIRMED',
                stage: 'UNKNOWN',
                acknowledgedGroups: [],
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

  private captureSession(
    sessionId: string,
    requiredCapability: MotorFirmwareCapability =
      'MOTOR_CONFIGURATION_WRITE',
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
    if (this.isMotorTestActive(sessionId)) {
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
    return motorFirmwareSupports(
      compatibility,
      requiredCapability,
    )
      ? undefined
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
    if (this.isMotorTestActive(sessionId)) {
      throw new MotorConfigurationPreflightError('MOTOR_TEST_ACTIVE');
    }
    if (!this.isStillOwned(sessionId, client, generation, epoch)) {
      throw new MotorConfigurationPreflightError('DISCONNECTED');
    }
    if (this.coordinator.getMspRecoveryState(sessionId) !== 'READY') {
      throw new MotorConfigurationPreflightError('LINK_RECOVERING');
    }
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
