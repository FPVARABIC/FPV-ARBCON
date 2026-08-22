/**
 * BLACKBOX / ONBOARD LOGGING - ORCHESTRATION ONLY.
 *
 * Wire truth lives in the B-1 codecs, storage truth in B-2's
 * blackboxStorageSemantics, and neither is re-derived here. This module
 * sequences MSP operations and decides when a result may be called done.
 *
 * THREE THINGS IT REFUSES TO DO, each because the firmware makes the naive
 * version wrong:
 *
 *   AN ACK IS NOT AN APPLY. msp.c wraps MSP_SET_BLACKBOX_CONFIG in
 *   `if (blackboxMayEditConfig())`. When that is false the frame is
 *   consumed, nothing is written, and an ordinary success reply goes back.
 *   Every save therefore reads the configuration back BEFORE persisting,
 *   and a mismatch stops the sequence with no EEPROM write and no reboot.
 *
 *   A PERSIST IS NOT A REBOOT SURVIVAL. MSP_EEPROM_WRITE acknowledging says
 *   the request was accepted, not that the value is there after the board
 *   restarts. `save()` therefore CANNOT return success: it ends at
 *   AWAITING_REBOOT_VERIFICATION and hands back a token. Only
 *   `verifyPersistence()`, called against a genuinely NEW session, can
 *   return SUCCEEDED.
 *
 *   AN ERASE ACK IS NOT AN ERASED CHIP. blackboxEraseAll() starts an
 *   asynchronous sector erase and returns; completion is observable only by
 *   polling MSP_DATAFLASH_SUMMARY until the volume reports READY with zero
 *   used bytes. The poll is bounded by an absolute deadline, and every exit
 *   is terminal.
 *
 * WHY SAVE IS SPLIT IN TWO, AND WHY THAT IS NOT A WEAKER CONTRACT.
 * Reconnecting after a deliberate reboot is owned end to end by the app's
 * existing lifecycle: a controller calls fcRebootRecovery.expectReboot() and
 * the session layer (useRebootReconnect) drives the rescan, the reopen and
 * the new verified session. There is no headless path to await, and building
 * one here would mean a second reconnect driver - the exact duplication this
 * work is meant to avoid. Splitting instead keeps the guarantee intact where
 * it matters: SUCCEEDED is unreachable until a post-reboot readback on a NEW
 * session matched, and the token below refuses the old session by identity.
 */

import {
  createMspOperationCoordinator,
  decodeAdvancedConfig,
  decodeBlackboxConfig,
  decodeDataflashSummary,
  decodeSdcardSummary,
  encodeAdvancedConfigDebugMode,
  encodeBlackboxConfig,
  MSP_ADVANCED_CONFIG,
  MSP_BLACKBOX_CONFIG,
  MSP_DATAFLASH_SUMMARY,
  MSP_EEPROM_WRITE,
  MSP_SDCARD_SUMMARY,
  MSP_SET_ADVANCED_CONFIG,
  MSP_SET_BLACKBOX_CONFIG,
  MspOperationOutcomeUnknownError,
  type MspBlackboxConfig,
  type MspClient,
  type MspClientState,
  type MspRequester,
  type MspTelemetryScheduler,
} from '../../../core';
import {
  classifyBlackboxConfig,
  classifyBlackboxDevice,
  classifyBlackboxSampleRate,
  classifyDataflash,
  classifySdcard,
  type BlackboxConfiguration,
  type DataflashStorage,
  type SdcardStorage,
} from '../../../core/state/blackboxStorageSemantics';
import {fcRebootRecovery} from './fcRebootRecovery';
import {isSupportedConfigurationApi} from './betaflightApiSupport';
import {
  mspSessionCoordinator,
  type MspIdentificationState,
  type MspSessionOwnershipState,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';
import {
  setupAppStateTelemetryOwner,
  type SetupAppStatePhase,
} from './setupAppStateTelemetryOwner';

const EMPTY = new Uint8Array(0);
const V1 = {wireFormat: 'v1'} as const;

/** MSP_DATAFLASH_ERASE (72). Declared here, beside the only lifecycle that
 * is allowed to send it, rather than in the shared command table where any
 * consumer could reach a destructive operation without ownership. */
const MSP_DATAFLASH_ERASE = 72;

/** How often the erase is re-observed. */
export const BLACKBOX_ERASE_POLL_INTERVAL_MS = 500;
/**
 * The whole erase, not one request. The reference client polls forever; the
 * only published estimate is its own "about 20 seconds", and this is six
 * times that so a slow chip is not cut short while a dead one still ends.
 */
export const BLACKBOX_ERASE_ABSOLUTE_DEADLINE_MS = 120_000;

/* ================================================================== *
 * PORTS
 * ================================================================== */

export interface BlackboxSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): MspClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

export interface BlackboxAppStateOwner {
  getPhase(): SetupAppStatePhase;
}

/** The reboot lifecycle seam - the app's existing one, never a new driver. */
export interface BlackboxRebootLifecycle {
  expectReboot(sessionId: string, reason: 'CLI_SAVE'): void;
}

/** Timing seam so an absolute deadline can be proven without waiting it out. */
export interface BlackboxClock {
  now(): number;
  sleep(ms: number, signal: {readonly cancelled: boolean}): Promise<void>;
}

const REAL_CLOCK: BlackboxClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>(resolve => {
      const handle = setTimeout(resolve, ms);
      if (signal.cancelled) {
        clearTimeout(handle);
        resolve();
      }
    }),
};

export interface BlackboxConfigurationControllerOptions {
  readonly coordinator?: BlackboxSessionCoordinator;
  readonly appStateOwner?: BlackboxAppStateOwner;
  readonly rebootLifecycle?: BlackboxRebootLifecycle;
  readonly clock?: BlackboxClock;
}

/* ================================================================== *
 * RESULTS
 * ================================================================== */

export type BlackboxBlockReason =
  | 'DISCONNECTED'
  | 'IDENTIFYING'
  | 'UNSUPPORTED_FIRMWARE'
  | 'APP_BACKGROUNDED'
  | 'LINK_RECOVERING'
  | 'OPERATION_IN_PROGRESS'
  /** The firmware build has no Blackbox at all - a capability, not a fault. */
  | 'BLACKBOX_UNSUPPORTED'
  /** A required read never landed, so there is nothing safe to edit from. */
  | 'NOT_READY_TO_EDIT'
  /** The draft names a device or rate this build does not model. */
  | 'UNSUPPORTED_VALUE';

/** Everything the screen will need, with storage truth already resolved. */
export interface BlackboxSnapshot {
  /** Raw wire config - the source for unowned-field preservation. */
  readonly config: MspBlackboxConfig;
  /** The same config, read through B-2. */
  readonly configuration: BlackboxConfiguration;
  readonly dataflash: DataflashStorage;
  readonly sdcard: SdcardStorage;
  /**
   * THERE IS NO `blackboxFeatureEnabled` HERE, AND THAT IS THE FIX.
   *
   * An earlier version of this snapshot read MSP_FEATURE_CONFIG and
   * reported bit 19 as FEATURE_BLACKBOX. No such feature exists:
   * `features_e` (src/main/config/feature.h) runs
   * ... FEATURE_OSD = 1 << 18, FEATURE_CHANNEL_FORWARDING = 1 << 20 ...
   * at BOTH pinned revisions, bit 19 is an unused gap, and no member of
   * that enum mentions blackbox. blackbox.c consults exactly one feature,
   * FEATURE_GPS, and that is for the GPS field.
   *
   * The firmware gates logging on the CONFIGURED DEVICE alone - NONE
   * means nothing is written, anything else means it is - so that is the
   * only question worth asking, and `configuration.device` already
   * answers it. Reading a meaningless bit produced a confident, false
   * "logging is switched off" on every real board.
   */
  readonly debugMode: number;
  readonly debugModeCount: number;
  /** Needed later to label logging rates; carried, never interpreted here. */
  readonly pidProcessDenom: number;
}

export type BlackboxLoadOutcome =
  | {readonly kind: 'LOADED'; readonly snapshot: BlackboxSnapshot}
  | {readonly kind: 'REJECTED'; readonly reason: BlackboxBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/** ONLY the fields Blackbox owns. Everything else is re-read, never passed. */
export interface BlackboxOwnedDraft {
  readonly deviceRaw: number;
  readonly sampleRateRaw: number;
  /** A SET BIT DISABLES its field - the polarity is in the name. */
  readonly disabledFieldsMask: number;
  readonly debugMode: number;
}

/**
 * WHERE A SAVE HAS ACTUALLY GOT TO, published as it happens.
 *
 * The screen has to name the current step, and it must name the REAL one.
 * Without this it could only show a single spinner for the whole sequence,
 * or - far worse - animate through four invented captions on a timer while
 * the board was still on the first. Only the controller knows, so only the
 * controller says.
 *
 * This is an observation seam and nothing else: no step can be skipped,
 * reordered or refused through it, and a caller that passes no observer
 * changes the sequence not at all.
 */
export type BlackboxSaveProgress =
  /** The SET frame is on the wire. */
  | 'SENDING'
  /** Reading the configuration back, before anything is persisted. */
  | 'VERIFYING_APPLY'
  /** The readback matched; EEPROM write and reboot request. */
  | 'PERSISTING';

/** Likewise for the erase, whose two phases look identical from outside. */
export type BlackboxEraseProgress =
  /** The destructive command is out; nothing is known about it yet. */
  | 'REQUESTED'
  /** It was acknowledged and the volume is being watched. */
  | 'OBSERVING';

/** The stage a save stopped at, for a message that names the real step. */
export type BlackboxSaveStage =
  | 'BLACKBOX_WRITE'
  | 'BLACKBOX_READBACK'
  | 'ADVANCED_WRITE'
  | 'ADVANCED_READBACK'
  | 'EEPROM';

/**
 * Proof that a save reached the reboot, and the identity of the session it
 * must NOT be verified against.
 */
export interface BlackboxPendingPersistence {
  readonly sessionId: string;
  /** The generation the write happened on. A new session must differ. */
  readonly writtenOnGeneration: number;
  readonly expected: BlackboxOwnedDraft;
  readonly debugModeChanged: boolean;
}

export type BlackboxSaveOutcome =
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: BlackboxSnapshot}
  | {
      readonly kind: 'AWAITING_REBOOT_VERIFICATION';
      readonly pending: BlackboxPendingPersistence;
    }
  /**
   * The write was acknowledged and the value did not change. The known
   * firmware cause is a rejection while logging is active, but this result
   * says only what was measured - naming the cause would be a guess.
   */
  | {
      readonly kind: 'READBACK_MISMATCH';
      readonly stage: 'BLACKBOX' | 'ADVANCED';
      readonly expected: BlackboxOwnedDraft;
      readonly observed: BlackboxOwnedDraft;
    }
  | {readonly kind: 'REJECTED'; readonly reason: BlackboxBlockReason}
  | {readonly kind: 'UNCONFIRMED'; readonly stage: BlackboxSaveStage}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

export type BlackboxPersistenceOutcome =
  | {readonly kind: 'SUCCEEDED'; readonly snapshot: BlackboxSnapshot}
  | {
      readonly kind: 'PERSISTENCE_MISMATCH';
      readonly expected: BlackboxOwnedDraft;
      readonly observed: BlackboxOwnedDraft;
    }
  /** Handed the session the write happened on - that proves nothing. */
  | {readonly kind: 'STALE_SESSION'}
  | {readonly kind: 'REJECTED'; readonly reason: BlackboxBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

export type BlackboxEraseRefusal =
  | 'BLACKBOX_UNSUPPORTED'
  /** The PERSISTED device is not FLASH, so the firmware would erase nothing. */
  | 'DEVICE_NOT_FLASH'
  | 'DATAFLASH_UNSUPPORTED'
  | 'DATAFLASH_NOT_READY'
  | 'ALREADY_EMPTY';

export type BlackboxEraseOutcome =
  | {readonly kind: 'SUCCEEDED'; readonly dataflash: DataflashStorage}
  | {readonly kind: 'REFUSED'; readonly reason: BlackboxEraseRefusal}
  | {readonly kind: 'TIMED_OUT'; readonly elapsedMs: number}
  | {readonly kind: 'LINK_LOST'}
  /**
   * Local observation stopped. The board was never told to stop, because
   * the firmware has no way to be told - it may still be erasing.
   */
  | {
      readonly kind: 'OBSERVATION_CANCELLED';
      readonly boardMayStillBeErasing: true;
    }
  | {readonly kind: 'REJECTED'; readonly reason: BlackboxBlockReason}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/** Handle returned by an erase so a caller can stop watching it. */
export interface BlackboxEraseObservation {
  readonly result: Promise<BlackboxEraseOutcome>;
  /** Stops local polling only. Never claims the board stopped. */
  cancel(): void;
}

/* ================================================================== *
 * INTERNALS
 * ================================================================== */

class BlackboxPreflightError extends Error {
  constructor(readonly reason: BlackboxBlockReason) {
    super(`Blackbox operation refused: ${reason}`);
    this.name = 'BlackboxPreflightError';
  }
}

class BlackboxStageUnknownError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, readonly stage: BlackboxSaveStage) {
    super(Object.freeze({kind: 'BLACKBOX_AMBIGUOUS_WRITE', stage, error}));
  }
}

function unknownStage(reason: unknown): BlackboxSaveStage | undefined {
  const cause = (reason as {readonly cause?: unknown} | undefined)?.cause as
    | {readonly kind?: string; readonly stage?: BlackboxSaveStage}
    | undefined;
  return cause?.kind === 'BLACKBOX_AMBIGUOUS_WRITE' ? cause.stage : undefined;
}

/** Owned values only. Legacy and derived fields are deliberately absent. */
function ownedOf(
  config: MspBlackboxConfig,
  debugMode: number,
): BlackboxOwnedDraft {
  return Object.freeze({
    deviceRaw: config.deviceRaw,
    sampleRateRaw: config.sampleRateRaw,
    disabledFieldsMask: config.disabledFieldsMask,
    debugMode,
  });
}

function blackboxFieldsEqual(
  a: BlackboxOwnedDraft,
  b: BlackboxOwnedDraft,
): boolean {
  return (
    a.deviceRaw === b.deviceRaw &&
    a.sampleRateRaw === b.sampleRateRaw &&
    a.disabledFieldsMask === b.disabledFieldsMask
  );
}

/* ================================================================== *
 * THE CONTROLLER
 * ================================================================== */

export class BlackboxConfigurationController {
  private readonly coordinator: BlackboxSessionCoordinator;
  private readonly appStateOwner: BlackboxAppStateOwner;
  private readonly rebootLifecycle: BlackboxRebootLifecycle;
  private readonly clock: BlackboxClock;
  /** One in-flight exclusive Blackbox operation per session, at most. */
  private readonly busy = new Set<string>();

  constructor(options: BlackboxConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.rebootLifecycle = options.rebootLifecycle ?? fcRebootRecovery;
    this.clock = options.clock ?? REAL_CLOCK;
  }

  /* ---------------------------------------------------------------- *
   * LOAD
   * ---------------------------------------------------------------- */

  async load(key: SetupUiSessionKey): Promise<BlackboxLoadOutcome> {
    const captured = this.capture(key);
    if ('reason' in captured) {
      return {kind: 'REJECTED', reason: captured.reason};
    }
    if (this.busy.has(key.sessionId)) {
      return {kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'};
    }
    const {client, scheduler, epoch} = captured;
    this.busy.add(key.sessionId);
    try {
      const result = await this.operations(
        key.sessionId,
        client,
        scheduler,
      ).execute<BlackboxSnapshot>({
        id: `blackbox:load:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {
                allowed: false,
                error: new BlackboxPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(key, client, epoch);
          return this.readSnapshot(requester);
        },
      });
      if (result.status === 'SUCCEEDED') {
        return {kind: 'LOADED', snapshot: result.result};
      }
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') {
        return {kind: 'SESSION_ENDED'};
      }
      return result.error instanceof BlackboxPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      this.busy.delete(key.sessionId);
    }
  }

  /* ---------------------------------------------------------------- *
   * SAVE - up to and including the reboot request, never past it
   * ---------------------------------------------------------------- */

  async save(
    key: SetupUiSessionKey,
    observed: BlackboxSnapshot,
    draft: BlackboxOwnedDraft,
    onProgress?: (progress: BlackboxSaveProgress) => void,
  ): Promise<BlackboxSaveOutcome> {
    if (!observed.config.supported) {
      return {kind: 'REJECTED', reason: 'BLACKBOX_UNSUPPORTED'};
    }
    // A draft may keep an unmodelled value the board already had, but it may
    // never introduce one: writing a device this build cannot name would be
    // asking the firmware to do something we cannot describe.
    if (
      !classifyBlackboxDevice(draft.deviceRaw).modelled &&
      draft.deviceRaw !== observed.config.deviceRaw
    ) {
      return {kind: 'REJECTED', reason: 'UNSUPPORTED_VALUE'};
    }
    if (
      !classifyBlackboxSampleRate(draft.sampleRateRaw).modelled &&
      draft.sampleRateRaw !== observed.config.sampleRateRaw
    ) {
      return {kind: 'REJECTED', reason: 'UNSUPPORTED_VALUE'};
    }

    const current = ownedOf(observed.config, observed.debugMode);
    const debugModeChanged = draft.debugMode !== observed.debugMode;
    if (blackboxFieldsEqual(current, draft) && !debugModeChanged) {
      return {kind: 'NO_CHANGES', snapshot: observed};
    }

    const captured = this.capture(key);
    if ('reason' in captured) {
      return {kind: 'REJECTED', reason: captured.reason};
    }
    if (this.busy.has(key.sessionId)) {
      return {kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'};
    }
    const {client, scheduler, epoch} = captured;
    this.busy.add(key.sessionId);
    try {
      const result = await this.operations(
        key.sessionId,
        client,
        scheduler,
      ).execute<BlackboxSaveOutcome>({
        id: `blackbox:save:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {
                allowed: false,
                error: new BlackboxPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(key, client, epoch);

          // (1) FRESH READ. The legacy rate fields and pRatio are the
          //     firmware's, and they are echoed from THIS read - never from
          //     a snapshot that may be minutes old.
          const liveConfig = decodeBlackboxConfig(
            (await requester.request(MSP_BLACKBOX_CONFIG, EMPTY, V1)).payload,
          );

          // (2) WRITE, carrying the unowned fields back unchanged.
          onProgress?.('SENDING');
          await this.writeOnce(
            requester,
            MSP_SET_BLACKBOX_CONFIG,
            encodeBlackboxConfig({
              deviceRaw: draft.deviceRaw,
              legacyRateNumerator: liveConfig.legacyRateNumerator,
              legacyRateDenominator: liveConfig.legacyRateDenominator,
              pRatio: liveConfig.pRatio,
              sampleRateRaw: draft.sampleRateRaw,
              disabledFieldsMask: draft.disabledFieldsMask,
            }),
            'BLACKBOX_WRITE',
          );

          // (3) MANDATORY READBACK. This is the only thing that separates
          //     "the frame was accepted" from "the value changed".
          onProgress?.('VERIFYING_APPLY');
          this.assertLive(key, client, epoch);
          const afterWrite = decodeBlackboxConfig(
            (await requester.request(MSP_BLACKBOX_CONFIG, EMPTY, V1)).payload,
          );
          const observedOwned = ownedOf(afterWrite, observed.debugMode);
          if (!blackboxFieldsEqual(observedOwned, draft)) {
            return {
              kind: 'READBACK_MISMATCH' as const,
              stage: 'BLACKBOX' as const,
              expected: draft,
              observed: observedOwned,
            };
          }

          // (4) The one Advanced Config field Blackbox owns, if it moved.
          if (debugModeChanged) {
            this.assertLive(key, client, epoch);
            const liveAdvanced = decodeAdvancedConfig(
              (await requester.request(MSP_ADVANCED_CONFIG, EMPTY, V1)).payload,
            );
            await this.writeOnce(
              requester,
              MSP_SET_ADVANCED_CONFIG,
              encodeAdvancedConfigDebugMode(liveAdvanced, draft.debugMode),
              'ADVANCED_WRITE',
            );
            this.assertLive(key, client, epoch);
            const afterAdvanced = decodeAdvancedConfig(
              (await requester.request(MSP_ADVANCED_CONFIG, EMPTY, V1)).payload,
            );
            if (afterAdvanced.debugMode !== draft.debugMode) {
              return {
                kind: 'READBACK_MISMATCH' as const,
                stage: 'ADVANCED' as const,
                expected: draft,
                observed: ownedOf(afterWrite, afterAdvanced.debugMode),
              };
            }
          }

          // (5) Only now may anything be persisted.
          onProgress?.('PERSISTING');
          this.assertLive(key, client, epoch);
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM');

          // (6) Hand the reboot to the app's existing lifecycle and stop.
          //     No success is returned here and none can be.
          this.rebootLifecycle.expectReboot(key.sessionId, 'CLI_SAVE');
          return {
            kind: 'AWAITING_REBOOT_VERIFICATION' as const,
            pending: Object.freeze({
              sessionId: key.sessionId,
              writtenOnGeneration: key.generation,
              expected: draft,
              debugModeChanged,
            }),
          };
        },
      });
      if (result.status === 'SUCCEEDED') return result.result;
      if (result.status === 'OUTCOME_UNKNOWN') {
        const stage = unknownStage(result.reason);
        return stage !== undefined
          ? {kind: 'UNCONFIRMED', stage}
          : {kind: 'SESSION_ENDED'};
      }
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof BlackboxPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      this.busy.delete(key.sessionId);
    }
  }

  /* ---------------------------------------------------------------- *
   * PERSISTENCE VERIFICATION - the only path to SUCCEEDED
   * ---------------------------------------------------------------- */

  async verifyPersistence(
    key: SetupUiSessionKey,
    pending: BlackboxPendingPersistence,
  ): Promise<BlackboxPersistenceOutcome> {
    /**
     * THE SESSION MUST BE A DIFFERENT ONE. A generation that still matches
     * the write means the board never went away, so a matching readback
     * would only be reading the RAM the write already changed - it would
     * prove nothing about EEPROM. This is refused by identity rather than
     * by timing.
     */
    if (key.generation === pending.writtenOnGeneration) {
      return {kind: 'STALE_SESSION'};
    }
    const loaded = await this.load(key);
    if (loaded.kind !== 'LOADED') {
      return loaded.kind === 'REJECTED'
        ? {kind: 'REJECTED', reason: loaded.reason}
        : loaded.kind === 'SESSION_ENDED'
          ? {kind: 'SESSION_ENDED'}
          : {kind: 'FAILED', error: loaded.error};
    }
    const observed = ownedOf(loaded.snapshot.config, loaded.snapshot.debugMode);
    const fieldsMatch = blackboxFieldsEqual(observed, pending.expected);
    const debugMatches =
      !pending.debugModeChanged ||
      loaded.snapshot.debugMode === pending.expected.debugMode;
    if (!fieldsMatch || !debugMatches) {
      return {
        kind: 'PERSISTENCE_MISMATCH',
        expected: pending.expected,
        observed,
      };
    }
    return {kind: 'SUCCEEDED', snapshot: loaded.snapshot};
  }

  /* ---------------------------------------------------------------- *
   * ERASE
   * ---------------------------------------------------------------- */

  /**
   * Starts an erase and returns a handle. The promise always settles on a
   * terminal outcome; `cancel()` stops the local watch and nothing else.
   */
  eraseDataflash(
    key: SetupUiSessionKey,
    observed: BlackboxSnapshot,
    onProgress?: (progress: BlackboxEraseProgress) => void,
  ): BlackboxEraseObservation {
    const signal = {cancelled: false};
    const result = this.runErase(key, observed, signal, onProgress);
    return {
      result,
      cancel: () => {
        signal.cancelled = true;
      },
    };
  }

  private async runErase(
    key: SetupUiSessionKey,
    observed: BlackboxSnapshot,
    signal: {cancelled: boolean},
    onProgress?: (progress: BlackboxEraseProgress) => void,
  ): Promise<BlackboxEraseOutcome> {
    /**
     * PRECONDITIONS ARE CHECKED AGAINST THE PERSISTED CONFIGURATION, never
     * a draft. blackboxEraseAll() switches on blackboxConfig()->device and
     * does nothing for any other value, so a screen where the operator has
     * selected FLASH but not yet saved must not be able to send a
     * destructive command that would silently erase nothing.
     */
    if (!observed.config.supported) {
      return {kind: 'REFUSED', reason: 'BLACKBOX_UNSUPPORTED'};
    }
    if (observed.configuration.device.device !== 'FLASH') {
      return {kind: 'REFUSED', reason: 'DEVICE_NOT_FLASH'};
    }
    const flash = observed.dataflash;
    if (flash.state === 'UNSUPPORTED') {
      return {kind: 'REFUSED', reason: 'DATAFLASH_UNSUPPORTED'};
    }
    if (flash.state === 'READY_EMPTY') {
      return {kind: 'REFUSED', reason: 'ALREADY_EMPTY'};
    }
    if (flash.state !== 'READY_WITH_DATA' && flash.state !== 'READY_FULL') {
      return {kind: 'REFUSED', reason: 'DATAFLASH_NOT_READY'};
    }

    const captured = this.capture(key);
    if ('reason' in captured) {
      return {kind: 'REJECTED', reason: captured.reason};
    }
    if (this.busy.has(key.sessionId)) {
      return {kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'};
    }
    const {client, scheduler, epoch} = captured;
    this.busy.add(key.sessionId);
    const startedAt = this.clock.now();
    try {
      const outcome = await this.operations(
        key.sessionId,
        client,
        scheduler,
      ).execute<BlackboxEraseOutcome>({
        id: `blackbox:erase:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {
                allowed: false,
                error: new BlackboxPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(key, client, epoch);
          // The command starts an asynchronous sector erase and returns.
          // Its acknowledgement is not a result.
          onProgress?.('REQUESTED');
          await requester.request(MSP_DATAFLASH_ERASE, EMPTY, V1);
          // Acknowledged. From here the only thing that can end this is an
          // observation of the volume itself.
          onProgress?.('OBSERVING');
          return this.pollUntilErased(key, client, epoch, requester, {
            signal,
            startedAt,
          });
        },
      });
      if (outcome.status === 'SUCCEEDED') return outcome.result;
      /**
       * WHO STOPPED THIS - us, or the link? The two answers get different
       * sentences on screen ("we stopped watching, the board may still be
       * erasing" versus "the connection was lost, we cannot confirm
       * anything"), so they must not be decided by which internal error
       * happened to surface.
       *
       * Cancellation is the one fact held LOCALLY and with certainty: the
       * caller either set the signal or did not, and no transport failure
       * can change that. So it decides, and the link is what is left.
       *
       * PRECEDENCE, stated rather than left to a race: an explicit
       * cancellation wins even if the link also died in the same turn.
       * That direction is deliberate - "the app stopped watching, the
       * board may still be erasing" stays true whatever the link did,
       * while "the connection was lost" would be a claim about hardware
       * we did not observe. The reverse precedence can assert something
       * false; this one cannot.
       */
      if (
        outcome.status === 'SESSION_ENDED' ||
        outcome.status === 'OUTCOME_UNKNOWN'
      ) {
        return signal.cancelled
          ? {kind: 'OBSERVATION_CANCELLED', boardMayStillBeErasing: true}
          : {kind: 'LINK_LOST'};
      }
      return outcome.error instanceof BlackboxPreflightError
        ? {kind: 'REJECTED', reason: outcome.error.reason}
        : {kind: 'FAILED', error: outcome.error};
    } finally {
      this.busy.delete(key.sessionId);
    }
  }

  private async pollUntilErased(
    key: SetupUiSessionKey,
    client: MspClient,
    epoch: number,
    requester: MspRequester,
    watch: {
      readonly signal: {readonly cancelled: boolean};
      readonly startedAt: number;
    },
  ): Promise<BlackboxEraseOutcome> {
    const deadline = watch.startedAt + BLACKBOX_ERASE_ABSOLUTE_DEADLINE_MS;
    for (;;) {
      if (watch.signal.cancelled) {
        return {kind: 'OBSERVATION_CANCELLED', boardMayStillBeErasing: true};
      }
      if (this.clock.now() >= deadline) {
        // The board may well still be erasing. This says only that we
        // stopped waiting.
        return {kind: 'TIMED_OUT', elapsedMs: this.clock.now() - watch.startedAt};
      }
      await this.clock.sleep(BLACKBOX_ERASE_POLL_INTERVAL_MS, watch.signal);
      if (watch.signal.cancelled) {
        return {kind: 'OBSERVATION_CANCELLED', boardMayStillBeErasing: true};
      }
      try {
        this.assertLive(key, client, epoch);
      } catch (error) {
        /**
         * THE SAME QUESTION AGAIN: did WE stop, or did the LINK?
         *
         * APP_BACKGROUNDED is the app losing the ability to watch while
         * the cable, the port and the board may all be perfectly fine.
         * Reporting that as a lost connection would state something about
         * the hardware that was never observed, so it takes the sentence
         * that is actually true - we stopped, the board may still be
         * erasing. DISCONNECTED and LINK_RECOVERING both mean the board
         * is out of sight, which is what LINK_LOST says.
         */
        return error instanceof BlackboxPreflightError &&
          error.reason === 'APP_BACKGROUNDED'
          ? {kind: 'OBSERVATION_CANCELLED', boardMayStillBeErasing: true}
          : {kind: 'LINK_LOST'};
      }
      let flash: DataflashStorage;
      try {
        flash = classifyDataflash(
          decodeDataflashSummary(
            (await requester.request(MSP_DATAFLASH_SUMMARY, EMPTY, V1)).payload,
          ),
        );
      } catch {
        /**
         * A flash chip can stop answering MSP mid-erase. A single missed
         * summary is not a verdict - the absolute deadline above is what
         * makes this bounded, so keep observing until it fires.
         */
        continue;
      }
      /**
       * SUCCESS IS THE SEMANTIC STATE, NOT A FLAG. `ready` alone would go
       * true the moment the volume is idle again; only READY_EMPTY proves
       * supported AND ready AND nothing stored.
       */
      if (flash.state === 'READY_EMPTY') {
        return {kind: 'SUCCEEDED', dataflash: flash};
      }
      // BUSY_OR_NOT_READY during an erase is expected progress, and
      // READY_WITH_DATA simply means it has not finished. Neither ends it.
    }
  }

  /* ---------------------------------------------------------------- *
   * SHARED
   * ---------------------------------------------------------------- */

  private async readSnapshot(
    requester: MspRequester,
  ): Promise<BlackboxSnapshot> {
    const config = decodeBlackboxConfig(
      (await requester.request(MSP_BLACKBOX_CONFIG, EMPTY, V1)).payload,
    );
    const dataflash = decodeDataflashSummary(
      (await requester.request(MSP_DATAFLASH_SUMMARY, EMPTY, V1)).payload,
    );
    const sdcard = decodeSdcardSummary(
      (await requester.request(MSP_SDCARD_SUMMARY, EMPTY, V1)).payload,
    );
    const advanced = decodeAdvancedConfig(
      (await requester.request(MSP_ADVANCED_CONFIG, EMPTY, V1)).payload,
    );
    return Object.freeze({
      config,
      configuration: classifyBlackboxConfig(config),
      dataflash: classifyDataflash(dataflash),
      sdcard: classifySdcard(sdcard),
      debugMode: advanced.debugMode,
      debugModeCount: advanced.debugModeCount,
      pidProcessDenom: advanced.pidProcessDenom,
    });
  }

  private async writeOnce(
    requester: MspRequester,
    command: number,
    payload: Uint8Array,
    stage: BlackboxSaveStage,
  ): Promise<void> {
    try {
      await requester.request(command, payload, V1);
    } catch (error) {
      // A write whose outcome cannot be known must not be reported as a
      // clean failure - the board may have applied it.
      throw new BlackboxStageUnknownError(error, stage);
    }
  }

  private capture(
    key: SetupUiSessionKey,
  ):
    | {client: MspClient; scheduler: MspTelemetryScheduler; epoch: number}
    | {reason: BlackboxBlockReason} {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') {
      return {reason: 'APP_BACKGROUNDED'};
    }
    const identification = this.coordinator.getIdentificationState(
      key.sessionId,
    );
    if (identification.status === 'IDLE' || identification.status === 'RUNNING') {
      return {reason: 'IDENTIFYING'};
    }
    if (!isSupportedConfigurationApi(identification)) {
      return {reason: 'UNSUPPORTED_FIRMWARE'};
    }
    const client = this.coordinator.getActiveMspClient(key.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !==
        key.generation ||
      client === undefined ||
      scheduler === undefined
    ) {
      return {reason: 'DISCONNECTED'};
    }
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') {
      return {reason: 'LINK_RECOVERING'};
    }
    return {client, scheduler, epoch: client.getEpoch()};
  }

  private assertLive(
    key: SetupUiSessionKey,
    client: MspClient,
    epoch: number,
  ): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') {
      throw new BlackboxPreflightError('APP_BACKGROUNDED');
    }
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !==
        key.generation ||
      this.coordinator.getActiveMspClient(key.sessionId) !== client ||
      client.getEpoch() !== epoch
    ) {
      throw new BlackboxPreflightError('DISCONNECTED');
    }
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') {
      throw new BlackboxPreflightError('LINK_RECOVERING');
    }
  }

  private operations(
    sessionId: string,
    client: MspClient,
    scheduler: MspTelemetryScheduler,
  ) {
    return createMspOperationCoordinator(
      client,
      scheduler,
      {captureCurrent: () => this.coordinator.getSessionKey(sessionId)},
      {
        getContext: () => ({
          clientState:
            this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED',
          isArmed: false,
        }),
      },
    );
  }
}

export const blackboxConfigurationController =
  new BlackboxConfigurationController();
