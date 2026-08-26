/**
 * THE ONE OWNER OF LED STRIP CONFIGURATION ON A LIVE BOARD.
 *
 * Reads through the real MspClient, over the real session coordinator, under
 * the same exclusive-operation lock every other configuration screen uses.
 * It creates no transport, no connection manager, no reboot driver and no
 * timer of its own.
 *
 * FOUR THINGS THIS CONTROLLER REFUSES TO DO, each because the reference
 * configurator does it and each was traced to source before being called a
 * defect:
 *
 *  1. IT NEVER WRITES ON LOAD. Opening the reference's LED tab pushes the
 *     brightness and rainbow values straight back at the board, because
 *     three watchers fire the moment the loaded values differ from the
 *     screen's own defaults. Reading a screen is not consent to write.
 *
 *  2. IT NEVER SENDS THE WHOLE ARRAY. The reference writes every index from
 *     0 to the array length on every save. The firmware re-counts the strip
 *     after each accepted write, so those writes are not merely redundant -
 *     their ORDER decides what the aircraft looks like in between.
 *
 *  3. IT NEVER RESTATES A VALUE IT DID NOT READ THIS SECOND. The palette and
 *     the MSP2 values are whole-frame writes, so every save necessarily
 *     restates fields nobody touched. Those come from a read taken inside
 *     the save, never from the snapshot the screen was holding.
 *
 *  4. IT NEVER CALLS AN ACK A SAVE. A write's acknowledgement proves the
 *     frame was parsed. Applied is a readback; persisted is an EEPROM write
 *     followed by another readback; and the three are separate fields of the
 *     result for exactly that reason.
 *
 * NO REBOOT, ANYWHERE. The firmware re-evaluates the strip inside the write
 * handler itself, so LED configuration takes effect the moment it is
 * accepted. There is no restart in this file and no reboot lifecycle import.
 *
 * ARMED STATE. This controller adds no armed gate. No pinned firmware source
 * conditions any of the eight LED commands on the arming state, and this
 * product has no blanket "disarmed to write configuration" rule - each
 * operation's own `validate` owns that question, and Motors owns the one
 * that matters. Inventing an LED-specific rule here would be a safety claim
 * with nothing behind it.
 */

import {
  createMspOperationCoordinator,
  MSP_EEPROM_WRITE,
  MspOperationOutcomeUnknownError,
  type MspClient,
  type MspClientState,
  type MspRequester,
  type MspTelemetryScheduler,
} from '../../../core';
import {
  MSP2_GET_LED_STRIP_CONFIG_VALUES,
  MSP2_SET_LED_STRIP_CONFIG_VALUES,
  MSP_LED_COLORS,
  MSP_LED_STRIP_CONFIG,
  MSP_LED_STRIP_MODECOLOR,
  MSP_SET_LED_COLORS,
  MSP_SET_LED_STRIP_CONFIG,
  MSP_SET_LED_STRIP_MODECOLOR,
} from '../../../core/protocol/msp/commands/ledStripCommands';
import {
  decodeLedStripColors,
  decodeLedStripConfig,
  decodeLedStripConfigValues,
  decodeLedStripModeColors,
  type LedModeColorTuple,
  type LedPaletteColor,
  type LedStripRuntimeConfigValues,
} from '../../../core/protocol/msp/decoding/decodeLedStrip';
import {
  ledStripWriteAuthority,
  resolveLedStripApi,
  type LedEntry,
  type LedStripApiContract,
} from '../../../core/protocol/msp/decoding/ledStripWireContract';
import {
  encodeLedStripColors,
  encodeLedStripConfigEntry,
  encodeLedStripConfigValues,
  encodeLedStripModeColor,
} from '../../../core/protocol/msp/encoding/encodeLedStrip';
import {
  classifyLedStripBuildCapability,
  type LedStripBuildCapability,
} from '../../../core/state/ledStripModel';
import {
  ledEntryArrayIsCanonical,
  ledPaletteColorsEqual,
  ledRuntimeValuesEqual,
  mergeLedPalette,
  mergeLedRuntimeValues,
  planLedEntryWrites,
  planLedModeColorWrites,
  LED_SAVE_GROUP_ORDER,
  type LedEntryPlanRefusal,
  type LedEntryWrite,
  type LedModeColorWrite,
  type LedPaletteEntry,
  type LedRuntimeValueField,
  type LedRuntimeValues,
  type LedSaveGroup,
} from '../../../core/state/ledStripSaveModel';
import {deriveLedStripTruth, type LedStripTruth} from '../../../core/state/ledStripTruth';
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
const V2 = {wireFormat: 'v2'} as const;

/* ================================================================== *
 * PORTS
 * ================================================================== */

export interface LedStripSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): MspClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

export interface LedStripAppStateOwner {
  getPhase(): SetupAppStatePhase;
}

export interface LedStripConfigurationControllerOptions {
  readonly coordinator?: LedStripSessionCoordinator;
  readonly appStateOwner?: LedStripAppStateOwner;
}

/* ================================================================== *
 * RESULTS
 * ================================================================== */

export type LedStripBlockReason =
  | 'DISCONNECTED'
  | 'IDENTIFYING'
  | 'UNSUPPORTED_FIRMWARE'
  | 'APP_BACKGROUNDED'
  | 'LINK_RECOVERING'
  | 'OPERATION_IN_PROGRESS'
  /** Newer than any firmware whose LED source this build has read. */
  | 'UNVERIFIED_FUTURE_API'
  /** This board answers no LED command at all. */
  | 'LED_STRIP_UNSUPPORTED_BY_BUILD';

/** Which resource a capability contradiction was found on. */
export type LedStripResource = 'ENTRIES' | 'PALETTE' | 'MODE_COLORS' | 'RUNTIME_VALUES';

export interface LedStripSnapshot {
  /** The session this state was read from. A draft built on it is only
   *  valid against the same session and generation. */
  readonly sessionId: string;
  readonly generation: number;
  readonly apiContract: LedStripApiContract;
  /** From the payload length, never assumed. */
  readonly maxLength: number;
  readonly entries: readonly LedEntry[];
  /** The trailing capability byte exactly as sent. */
  readonly advancedRaw: number;
  readonly capability: LedStripBuildCapability;
  /** Read-only. The firmware's own setter cannot reach the profile byte. */
  readonly profile: number;
  readonly truth: LedStripTruth;
  /** Absent on a board without the status-mode build. Never fabricated. */
  readonly palette: readonly LedPaletteColor[] | undefined;
  readonly modeColors: readonly LedModeColorTuple[] | undefined;
  readonly runtimeValues: LedStripRuntimeConfigValues;
}

export type LedStripLoadOutcome =
  | {readonly kind: 'LOADED'; readonly snapshot: LedStripSnapshot}
  | {readonly kind: 'REJECTED'; readonly reason: LedStripBlockReason}
  /**
   * The board said it has the advanced status-mode build and then refused a
   * command that build defines. Degrading quietly to "basic" would hide a
   * real disagreement, so it is reported - with whatever basic state was
   * safely readable, because that part is still true.
   */
  | {
      readonly kind: 'CAPABILITY_CONTRADICTION';
      readonly resource: LedStripResource;
      readonly partial: LedStripSnapshot | undefined;
    }
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/** What the operator is asking to change. Absent means "not mine". */
export interface LedStripSaveRequest {
  /** The snapshot the draft was built from. */
  readonly observed: LedStripSnapshot;
  readonly entries?: {
    /** The complete target array, one word per board slot. */
    readonly target: readonly number[];
    /** How many LEDs the caller believes that array describes. Supplying it
     *  is what catches an edited LED that serialised to all-zeros and
     *  silently became the end of the strip. */
    readonly declaredEffectiveCount?: number;
  };
  /** Only the palette slots the operator edited. */
  readonly palette?: ReadonlyMap<number, LedPaletteEntry>;
  /** Only the mode/special/aux tuples the operator edited. */
  readonly modeColors?: readonly LedModeColorWrite[];
  /** Only the runtime fields the operator edited. */
  readonly runtimeValues?: Partial<LedRuntimeValues>;
}

/** Per group, how far it actually got. */
export type LedGroupState = 'PENDING' | 'APPLIED_ACK' | 'READBACK_VERIFIED';

export type LedGroupStates = Readonly<Partial<Record<LedSaveGroup, LedGroupState>>>;

/** What a save refused BEFORE writing anything. */
export type LedSaveRefusal =
  | {readonly kind: 'STALE_SESSION'}
  | {readonly kind: 'ADVANCED_LED_STATUS_UNAVAILABLE'; readonly groups: readonly LedSaveGroup[]}
  | {readonly kind: 'ENTRY_PLAN_REFUSED'; readonly refusal: LedEntryPlanRefusal}
  | {readonly kind: 'STALE_PALETTE_SLOT'; readonly slot: number}
  | {readonly kind: 'STALE_MODE_COLOR'; readonly mode: number; readonly slot: number}
  | {readonly kind: 'MODE_COLOR_TUPLE_ABSENT'; readonly mode: number; readonly slot: number}
  | {readonly kind: 'STALE_RUNTIME_VALUE'; readonly field: LedRuntimeValueField}
  | {readonly kind: 'INVALID_DRAFT'; readonly detail: string};

export interface LedPartialApplyDetail {
  readonly groups: LedGroupStates;
  /** Entry indexes whose write was acknowledged, in the order sent. */
  readonly appliedEntryIndexes: readonly number[];
  readonly failedEntryIndex: number | undefined;
  /** The phase of the strip transition the failure landed in, if any. */
  readonly failedEntryPhase: LedEntryWrite['phase'] | undefined;
  readonly appliedModeColors: readonly LedModeColorWrite[];
  readonly failedModeColor: LedModeColorWrite | undefined;
  /** What the board reports NOW, when the link allowed a re-read. */
  readonly observed: LedStripSnapshot | undefined;
  /** Always NOT_ATTEMPTED for a partial apply. Persisting a half-applied
   *  strip is how a bad state survives a power cycle. */
  readonly persistence: 'NOT_ATTEMPTED';
}

export type LedStripSaveOutcome =
  /** Everything applied, every group read back, one EEPROM write, and a
   *  final read that still agrees. */
  | {readonly kind: 'SAVE_VERIFIED'; readonly snapshot: LedStripSnapshot}
  /** The fresh read already matched the draft. Nothing written, no EEPROM
   *  cycle spent. */
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: LedStripSnapshot}
  | {readonly kind: 'REJECTED'; readonly reason: LedStripBlockReason}
  | {readonly kind: 'REFUSED'; readonly refusal: LedSaveRefusal}
  | {
      readonly kind: 'READBACK_MISMATCH';
      readonly group: LedSaveGroup;
      readonly detail: LedPartialApplyDetail;
    }
  | {readonly kind: 'PARTIAL_APPLY'; readonly detail: LedPartialApplyDetail}
  /** RAM holds the change and the readbacks agree; the persist did not. */
  | {
      readonly kind: 'APPLIED_NOT_PERSISTED';
      readonly groups: LedGroupStates;
      readonly snapshot: LedStripSnapshot | undefined;
    }
  | {readonly kind: 'SESSION_LOST_DURING_SAVE'; readonly detail: LedPartialApplyDetail}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/* ================================================================== *
 * INTERNAL
 * ================================================================== */

class LedPreflightError extends Error {
  constructor(readonly reason: LedStripBlockReason) {
    super(`LED strip operation blocked: ${reason}`);
    this.name = 'LedPreflightError';
  }
}

/** A write whose outcome the link could not confirm. Carried so the caller
 *  is never told "nothing happened" about a frame that may have landed. */
class LedAmbiguousWriteError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, readonly group: LedSaveGroup) {
    super(Object.freeze({kind: 'LED_AMBIGUOUS_WRITE', group, error}));
  }
}

/**
 * Whether the BOARD refused, as opposed to the link failing.
 *
 * `MSP_REMOTE_ERROR` is the client's code for an actual MSP error frame -
 * the firmware answering "I do not know this command" or "that payload is
 * wrong". Everything else, a timeout above all, means nobody answered, and
 * turning silence into "this feature does not exist" is how a flaky cable
 * gets reported as a missing capability.
 */
function isBoardRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {readonly code?: unknown}).code === 'MSP_REMOTE_ERROR'
  );
}

/** A private error used only to unwind out of a write loop with context. */
class LedWriteFailure extends Error {
  constructor(
    readonly group: LedSaveGroup,
    readonly cause: unknown,
    readonly entryIndex?: number,
    readonly entryPhase?: LedEntryWrite['phase'],
    readonly modeColor?: LedModeColorWrite,
  ) {
    super('LED write failed');
    this.name = 'LedWriteFailure';
  }
}

function paletteEntriesOf(colors: readonly LedPaletteColor[]): LedPaletteEntry[] {
  return colors.map(color =>
    Object.freeze({hue: color.hue, whiteness: color.whiteness, value: color.value}),
  );
}

function tupleWritesOf(tuples: readonly LedModeColorTuple[]): LedModeColorWrite[] {
  return tuples.map(tuple =>
    Object.freeze({mode: tuple.mode, slot: tuple.slot, value: tuple.value}),
  );
}

function runtimeValuesOf(values: LedStripRuntimeConfigValues): LedRuntimeValues {
  return Object.freeze({
    brightness: values.brightness,
    rainbowDelta: values.rainbowDelta,
    rainbowFreq: values.rainbowFreq,
  });
}

function palettesEqual(
  a: readonly LedPaletteEntry[],
  b: readonly LedPaletteEntry[],
): boolean {
  return a.length === b.length && a.every((color, i) => ledPaletteColorsEqual(color, b[i]));
}

function rawsOf(entries: readonly LedEntry[]): number[] {
  return entries.map(entry => entry.raw);
}

/* ================================================================== *
 * THE CONTROLLER
 * ================================================================== */

export class LedStripConfigurationController {
  private readonly coordinator: LedStripSessionCoordinator;
  private readonly appStateOwner: LedStripAppStateOwner;
  /** One in-flight exclusive LED operation per session, at most. A second
   *  save while one runs is refused, never interleaved. */
  private readonly busy = new Set<string>();

  constructor(options: LedStripConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
  }

  /* ---------------------------------------------------------------- *
   * LOAD - reads only, always
   * ---------------------------------------------------------------- */

  async load(key: SetupUiSessionKey): Promise<LedStripLoadOutcome> {
    const captured = this.capture(key);
    if ('reason' in captured) {
      return {kind: 'REJECTED', reason: captured.reason};
    }
    if (this.busy.has(key.sessionId)) {
      return {kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'};
    }
    const {client, scheduler, epoch, contract} = captured;
    this.busy.add(key.sessionId);
    try {
      const result = await this.operations(key.sessionId, client, scheduler).execute<
        LedStripLoadOutcome
      >({
        id: `ledStrip:load:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {allowed: false, error: new LedPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          return this.readSnapshot(requester, key, contract);
        },
      });
      if (result.status === 'SUCCEEDED') return result.result;
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') {
        return {kind: 'SESSION_ENDED'};
      }
      return result.error instanceof LedPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      this.busy.delete(key.sessionId);
    }
  }

  /**
   * CAPABILITY FIRST, THEN ONLY WHAT THE CAPABILITY COVERS.
   *
   * The strip GET is the one command a board with any LED support answers,
   * and its trailing byte is the board stating which build it is. Asking a
   * basic build for its palette would earn an error frame and teach the
   * screen nothing it could not already read off that byte - so it is not
   * asked. Nothing in here writes.
   */
  private async readSnapshot(
    requester: MspRequester,
    key: SetupUiSessionKey,
    apiContract: LedStripApiContract,
  ): Promise<LedStripLoadOutcome> {
    let stripFrame;
    try {
      stripFrame = await requester.request(MSP_LED_STRIP_CONFIG, EMPTY, V1);
    } catch (error) {
      if (isBoardRefusal(error)) {
        return {kind: 'REJECTED', reason: 'LED_STRIP_UNSUPPORTED_BY_BUILD'};
      }
      throw error;
    }
    const strip = decodeLedStripConfig(stripFrame.payload);
    const capability = classifyLedStripBuildCapability(strip.advancedRaw);

    let runtimeValues: LedStripRuntimeConfigValues;
    try {
      const frame = await requester.request(MSP2_GET_LED_STRIP_CONFIG_VALUES, EMPTY, V2);
      runtimeValues = decodeLedStripConfigValues(frame.payload);
    } catch (error) {
      if (isBoardRefusal(error)) {
        /* The strip command answered, so `USE_LED_STRIP` is compiled in and
           this command is compiled in with it. A refusal here is a real
           disagreement, not a build variant we know about. */
        return {kind: 'CAPABILITY_CONTRADICTION', resource: 'RUNTIME_VALUES', partial: undefined};
      }
      throw error;
    }

    const base = (
      palette: readonly LedPaletteColor[] | undefined,
      modeColors: readonly LedModeColorTuple[] | undefined,
    ): LedStripSnapshot =>
      Object.freeze({
        sessionId: key.sessionId,
        generation: key.generation,
        apiContract,
        maxLength: strip.maxLength,
        entries: strip.entries,
        advancedRaw: strip.advancedRaw,
        capability,
        profile: strip.profile,
        truth: deriveLedStripTruth(strip.entries, strip.maxLength),
        palette,
        modeColors,
        runtimeValues,
      });

    if (capability !== 'ADVANCED_STATUS_MODE') {
      /* A basic build genuinely has no palette and no mode colours. Leaving
         them undefined says that; inventing sixteen black slots would let a
         screen offer edits the board cannot accept. */
      return {kind: 'LOADED', snapshot: base(undefined, undefined)};
    }

    let palette: readonly LedPaletteColor[];
    try {
      const frame = await requester.request(MSP_LED_COLORS, EMPTY, V1);
      palette = decodeLedStripColors(frame.payload);
    } catch (error) {
      if (isBoardRefusal(error)) {
        return {
          kind: 'CAPABILITY_CONTRADICTION',
          resource: 'PALETTE',
          partial: base(undefined, undefined),
        };
      }
      throw error;
    }

    let modeColors: readonly LedModeColorTuple[];
    try {
      const frame = await requester.request(MSP_LED_STRIP_MODECOLOR, EMPTY, V1);
      modeColors = decodeLedStripModeColors(frame.payload);
    } catch (error) {
      if (isBoardRefusal(error)) {
        return {
          kind: 'CAPABILITY_CONTRADICTION',
          resource: 'MODE_COLORS',
          partial: base(palette, undefined),
        };
      }
      throw error;
    }

    return {kind: 'LOADED', snapshot: base(palette, modeColors)};
  }

  /* ---------------------------------------------------------------- *
   * SAVE
   * ---------------------------------------------------------------- */

  /**
   * PLAN EVERYTHING, THEN WRITE.
   *
   * Phase one re-reads every resource a dirty group touches and resolves
   * every conflict and every validation against those fresh bytes. If any of
   * it refuses, the board has not been written to at all - which is the only
   * reason a refusal can be reported as cleanly as it is.
   *
   * Phase two writes group by group in one fixed order, reading each group
   * back before starting the next so a divergence is found while only one
   * group has moved. The single persist happens after all of that, once.
   *
   * There is no rollback. MSP has no transaction, and a rollback would be
   * more writes that can also fail - it would turn one honest partial state
   * into an unknown one. What replaces it is the preflight above and an
   * explicit report of exactly how far the writes got.
   */
  async save(
    key: SetupUiSessionKey,
    request: LedStripSaveRequest,
  ): Promise<LedStripSaveOutcome> {
    const captured = this.capture(key);
    if ('reason' in captured) {
      return {kind: 'REJECTED', reason: captured.reason};
    }
    if (this.busy.has(key.sessionId)) {
      return {kind: 'REJECTED', reason: 'OPERATION_IN_PROGRESS'};
    }
    const {client, scheduler, epoch, contract, authority} = captured;
    if (authority.kind !== 'ALLOWED') {
      /* Fail-closed above the newest firmware whose LED source was read.
         Not one SET, not one EEPROM cycle. */
      return {
        kind: 'REJECTED',
        reason:
          authority.reason === 'UNVERIFIED_FUTURE_API'
            ? 'UNVERIFIED_FUTURE_API'
            : 'UNSUPPORTED_FIRMWARE',
      };
    }
    const {observed} = request;
    if (observed.sessionId !== key.sessionId || observed.generation !== key.generation) {
      return {kind: 'REFUSED', refusal: {kind: 'STALE_SESSION'}};
    }

    this.busy.add(key.sessionId);
    try {
      const result = await this.operations(key.sessionId, client, scheduler).execute<
        LedStripSaveOutcome
      >({
        id: `ledStrip:save:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {allowed: false, error: new LedPreflightError('LINK_RECOVERING')},
        execute: requester => this.runSave(requester, key, client, epoch, contract, request),
      });
      if (result.status === 'SUCCEEDED') return result.result;
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') {
        return {kind: 'SESSION_ENDED'};
      }
      return result.error instanceof LedPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      this.busy.delete(key.sessionId);
    }
  }

  private async runSave(
    requester: MspRequester,
    key: SetupUiSessionKey,
    client: MspClient,
    epoch: number,
    contract: LedStripApiContract,
    request: LedStripSaveRequest,
  ): Promise<LedStripSaveOutcome> {
    this.assertLive(key, client, epoch);
    const {observed} = request;

    /* ---- ADVANCED GATE, before any read of a command that would fail --- */
    const advancedGroups: LedSaveGroup[] = [];
    if (request.palette !== undefined && request.palette.size > 0) advancedGroups.push('PALETTE');
    if (request.modeColors !== undefined && request.modeColors.length > 0) {
      advancedGroups.push('MODE_COLORS');
    }
    if (advancedGroups.length > 0 && observed.capability !== 'ADVANCED_STATUS_MODE') {
      return {
        kind: 'REFUSED',
        refusal: {kind: 'ADVANCED_LED_STATUS_UNAVAILABLE', groups: Object.freeze(advancedGroups)},
      };
    }

    /* ================= PHASE ONE: fresh reads and planning ============= */

    let entryWrites: readonly LedEntryWrite[] = [];
    let entryTarget: readonly number[] | undefined;
    if (request.entries !== undefined) {
      this.assertLive(key, client, epoch);
      const fresh = await this.readEntries(requester);
      const plan = planLedEntryWrites({
        fresh: fresh.entries,
        baseline: rawsOf(observed.entries),
        target: request.entries.target,
        declaredEffectiveCount: request.entries.declaredEffectiveCount,
      });
      if (plan.kind === 'REFUSED') {
        return {kind: 'REFUSED', refusal: {kind: 'ENTRY_PLAN_REFUSED', refusal: plan.refusal}};
      }
      entryWrites = plan.writes;
      entryTarget = request.entries.target;
    }

    let paletteFrame: readonly LedPaletteEntry[] | undefined;
    if (request.palette !== undefined && request.palette.size > 0) {
      if (observed.palette === undefined) {
        return {
          kind: 'REFUSED',
          refusal: {kind: 'INVALID_DRAFT', detail: 'palette draft without an observed palette'},
        };
      }
      this.assertLive(key, client, epoch);
      const fresh = paletteEntriesOf(
        decodeLedStripColors(
          (await requester.request(MSP_LED_COLORS, EMPTY, V1)).payload,
        ),
      );
      const merged = mergeLedPalette({
        fresh,
        baseline: paletteEntriesOf(observed.palette),
        owned: request.palette,
      });
      if (merged.kind === 'STALE_PALETTE_SLOT') {
        return {kind: 'REFUSED', refusal: {kind: 'STALE_PALETTE_SLOT', slot: merged.slot}};
      }
      if (merged.changed) paletteFrame = merged.colors;
    }

    let modeColorWrites: readonly LedModeColorWrite[] = [];
    if (request.modeColors !== undefined && request.modeColors.length > 0) {
      if (observed.modeColors === undefined) {
        return {
          kind: 'REFUSED',
          refusal: {kind: 'INVALID_DRAFT', detail: 'mode-colour draft without observed tuples'},
        };
      }
      this.assertLive(key, client, epoch);
      const fresh = tupleWritesOf(
        decodeLedStripModeColors(
          (await requester.request(MSP_LED_STRIP_MODECOLOR, EMPTY, V1)).payload,
        ),
      );
      const plan = planLedModeColorWrites({
        fresh,
        baseline: tupleWritesOf(observed.modeColors),
        owned: request.modeColors,
      });
      if (plan.kind === 'STALE_MODE_COLOR') {
        return {
          kind: 'REFUSED',
          refusal: {kind: 'STALE_MODE_COLOR', mode: plan.mode, slot: plan.slot},
        };
      }
      if (plan.kind === 'TUPLE_ABSENT') {
        return {
          kind: 'REFUSED',
          refusal: {kind: 'MODE_COLOR_TUPLE_ABSENT', mode: plan.mode, slot: plan.slot},
        };
      }
      modeColorWrites = plan.writes;
    }

    let runtimeFrame: LedRuntimeValues | undefined;
    if (request.runtimeValues !== undefined && Object.keys(request.runtimeValues).length > 0) {
      this.assertLive(key, client, epoch);
      const fresh = runtimeValuesOf(
        decodeLedStripConfigValues(
          (await requester.request(MSP2_GET_LED_STRIP_CONFIG_VALUES, EMPTY, V2)).payload,
        ),
      );
      const merged = mergeLedRuntimeValues({
        fresh,
        baseline: runtimeValuesOf(observed.runtimeValues),
        owned: request.runtimeValues,
      });
      if (merged.kind === 'STALE_RUNTIME_VALUE') {
        return {kind: 'REFUSED', refusal: {kind: 'STALE_RUNTIME_VALUE', field: merged.field}};
      }
      if (merged.changed) runtimeFrame = merged.values;
    }

    const nothingToDo =
      entryWrites.length === 0 &&
      paletteFrame === undefined &&
      modeColorWrites.length === 0 &&
      runtimeFrame === undefined;
    if (nothingToDo) {
      const snapshot = await this.readSnapshotOrUndefined(requester, key, contract);
      return snapshot === undefined
        ? {kind: 'SESSION_ENDED'}
        : {kind: 'NO_CHANGES', snapshot};
    }

    /* ================= PHASE TWO: write, verify per group ============= */

    const groups: Partial<Record<LedSaveGroup, LedGroupState>> = {};
    for (const group of LED_SAVE_GROUP_ORDER) groups[group] = 'PENDING';
    const appliedEntryIndexes: number[] = [];
    const appliedModeColors: LedModeColorWrite[] = [];

    const partial = async (
      failure: LedWriteFailure | undefined,
    ): Promise<LedPartialApplyDetail> => ({
      groups: Object.freeze({...groups}),
      appliedEntryIndexes: Object.freeze([...appliedEntryIndexes]),
      failedEntryIndex: failure?.entryIndex,
      failedEntryPhase: failure?.entryPhase,
      appliedModeColors: Object.freeze([...appliedModeColors]),
      failedModeColor: failure?.modeColor,
      observed: await this.readSnapshotOrUndefined(requester, key, contract),
      persistence: 'NOT_ATTEMPTED',
    });

    try {
      /* ---- ENTRIES ---- */
      if (entryWrites.length > 0 && entryTarget !== undefined) {
        for (const write of entryWrites) {
          this.assertLive(key, client, epoch);
          try {
            await requester.request(
              MSP_SET_LED_STRIP_CONFIG,
              encodeLedStripConfigEntry({
                index: write.index,
                raw: write.raw,
                maxLength: observed.maxLength,
              }),
              V1,
            );
          } catch (error) {
            throw new LedWriteFailure('ENTRIES', error, write.index, write.phase);
          }
          appliedEntryIndexes.push(write.index);
        }
        groups.ENTRIES = 'APPLIED_ACK';
        this.assertLive(key, client, epoch);
        const after = await this.readEntries(requester);
        const afterRaw = rawsOf(after.entries);
        /* The WHOLE array, not the indexes we touched. Entry meaning is
           globally coupled - a word that moved somewhere we did not write
           changes the count, the ordinal animations or the quadrant
           boundaries, and none of that would show in a per-index check. */
        const matches =
          after.maxLength === observed.maxLength &&
          after.advancedRaw === observed.advancedRaw &&
          after.profile === observed.profile &&
          afterRaw.length === entryTarget.length &&
          afterRaw.every((word, i) => word === entryTarget?.[i]) &&
          ledEntryArrayIsCanonical(afterRaw);
        if (!matches) {
          return {kind: 'READBACK_MISMATCH', group: 'ENTRIES', detail: await partial(undefined)};
        }
        groups.ENTRIES = 'READBACK_VERIFIED';
      }

      /* ---- PALETTE ---- */
      if (paletteFrame !== undefined) {
        this.assertLive(key, client, epoch);
        try {
          await requester.request(MSP_SET_LED_COLORS, encodeLedStripColors(paletteFrame), V1);
        } catch (error) {
          throw new LedWriteFailure('PALETTE', error);
        }
        groups.PALETTE = 'APPLIED_ACK';
        this.assertLive(key, client, epoch);
        const after = paletteEntriesOf(
          decodeLedStripColors((await requester.request(MSP_LED_COLORS, EMPTY, V1)).payload),
        );
        if (!palettesEqual(after, paletteFrame)) {
          return {kind: 'READBACK_MISMATCH', group: 'PALETTE', detail: await partial(undefined)};
        }
        groups.PALETTE = 'READBACK_VERIFIED';
      }

      /* ---- MODE COLOURS ---- */
      if (modeColorWrites.length > 0) {
        for (const tuple of modeColorWrites) {
          this.assertLive(key, client, epoch);
          try {
            await requester.request(
              MSP_SET_LED_STRIP_MODECOLOR,
              encodeLedStripModeColor(tuple),
              V1,
            );
          } catch (error) {
            throw new LedWriteFailure('MODE_COLORS', error, undefined, undefined, tuple);
          }
          appliedModeColors.push(tuple);
        }
        groups.MODE_COLORS = 'APPLIED_ACK';
        this.assertLive(key, client, epoch);
        const after = tupleWritesOf(
          decodeLedStripModeColors(
            (await requester.request(MSP_LED_STRIP_MODECOLOR, EMPTY, V1)).payload,
          ),
        );
        const wanted = new Map(modeColorWrites.map(t => [`${t.mode}:${t.slot}`, t.value]));
        const baseline = tupleWritesOf(observed.modeColors ?? []);
        const baselineByKey = new Map(baseline.map(t => [`${t.mode}:${t.slot}`, t.value]));
        /* Every requested tuple moved, and every tuple nobody owned is still
           what it was - including the three unnamed special slots and the
           runtime-inert mode, which are preserved precisely by never being
           written. */
        const ok = after.every(tuple => {
          const key2 = `${tuple.mode}:${tuple.slot}`;
          const requested = wanted.get(key2);
          if (requested !== undefined) return tuple.value === requested;
          const was = baselineByKey.get(key2);
          return was === undefined || tuple.value === was;
        });
        if (!ok) {
          return {
            kind: 'READBACK_MISMATCH',
            group: 'MODE_COLORS',
            detail: await partial(undefined),
          };
        }
        groups.MODE_COLORS = 'READBACK_VERIFIED';
      }

      /* ---- RUNTIME VALUES ---- */
      if (runtimeFrame !== undefined) {
        this.assertLive(key, client, epoch);
        try {
          await requester.request(
            MSP2_SET_LED_STRIP_CONFIG_VALUES,
            encodeLedStripConfigValues(runtimeFrame),
            V2,
          );
        } catch (error) {
          throw new LedWriteFailure('RUNTIME_VALUES', error);
        }
        groups.RUNTIME_VALUES = 'APPLIED_ACK';
        this.assertLive(key, client, epoch);
        const after = runtimeValuesOf(
          decodeLedStripConfigValues(
            (await requester.request(MSP2_GET_LED_STRIP_CONFIG_VALUES, EMPTY, V2)).payload,
          ),
        );
        if (!ledRuntimeValuesEqual(after, runtimeFrame)) {
          return {
            kind: 'READBACK_MISMATCH',
            group: 'RUNTIME_VALUES',
            detail: await partial(undefined),
          };
        }
        groups.RUNTIME_VALUES = 'READBACK_VERIFIED';
      }
    } catch (error) {
      if (error instanceof LedWriteFailure) {
        const detail = await partial(error);
        return isSessionLoss(error.cause)
          ? {kind: 'SESSION_LOST_DURING_SAVE', detail}
          : {kind: 'PARTIAL_APPLY', detail};
      }
      if (error instanceof LedPreflightError) {
        /* The link or the session went while we were writing. Nothing more
           is sent onto whatever is there now, and no persist is attempted. */
        return {kind: 'SESSION_LOST_DURING_SAVE', detail: await partial(undefined)};
      }
      throw error;
    }

    /* ================= PERSIST: exactly once, at the end =============== */

    this.assertLive(key, client, epoch);
    try {
      await requester.request(MSP_EEPROM_WRITE, EMPTY, V1);
    } catch (error) {
      if (error instanceof LedPreflightError) throw error;
      /* Every group is applied and verified in RAM. Saying "saved" would be
         a lie about a power cycle; saying "failed" would be a lie about the
         board's current behaviour. */
      return {
        kind: 'APPLIED_NOT_PERSISTED',
        groups: Object.freeze({...groups}),
        snapshot: await this.readSnapshotOrUndefined(requester, key, contract),
      };
    }

    this.assertLive(key, client, epoch);
    const finalSnapshot = await this.readSnapshotOrUndefined(requester, key, contract);
    if (finalSnapshot === undefined) return {kind: 'SESSION_ENDED'};
    return {kind: 'SAVE_VERIFIED', snapshot: finalSnapshot};
  }

  /* ---------------------------------------------------------------- *
   * SHARED
   * ---------------------------------------------------------------- */

  private async readEntries(requester: MspRequester) {
    const frame = await requester.request(MSP_LED_STRIP_CONFIG, EMPTY, V1);
    return decodeLedStripConfig(frame.payload);
  }

  /** A best-effort re-read for a result that has to say what the board holds
   *  now. Returns `undefined` rather than throwing, because a save that
   *  already has a verdict must not lose it to a failing extra read. */
  private async readSnapshotOrUndefined(
    requester: MspRequester,
    key: SetupUiSessionKey,
    contract: LedStripApiContract,
  ): Promise<LedStripSnapshot | undefined> {
    try {
      const outcome = await this.readSnapshot(requester, key, contract);
      return outcome.kind === 'LOADED' ? outcome.snapshot : outcome.kind === 'CAPABILITY_CONTRADICTION'
        ? outcome.partial
        : undefined;
    } catch {
      return undefined;
    }
  }

  private capture(
    key: SetupUiSessionKey,
  ):
    | {
        client: MspClient;
        scheduler: MspTelemetryScheduler;
        epoch: number;
        contract: LedStripApiContract;
        authority: ReturnType<typeof ledStripWriteAuthority>;
      }
    | {reason: LedStripBlockReason} {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') {
      return {reason: 'APP_BACKGROUNDED'};
    }
    const identification = this.coordinator.getIdentificationState(key.sessionId);
    if (identification.status === 'IDLE' || identification.status === 'RUNNING') {
      return {reason: 'IDENTIFYING'};
    }
    if (!isSupportedConfigurationApi(identification)) {
      return {reason: 'UNSUPPORTED_FIRMWARE'};
    }
    const {apiVersion} = identification.identity;
    const resolution = resolveLedStripApi({
      major: apiVersion.apiVersionMajor,
      minor: apiVersion.apiVersionMinor,
    });
    const authority = ledStripWriteAuthority(resolution);
    /* A future board may still be READ, using the newest layout this build
       has actually verified - named here rather than hidden in a fallback. */
    const contract: LedStripApiContract =
      resolution.kind === 'SOURCE_VERIFIED'
        ? resolution.contract
        : resolution.kind === 'UNVERIFIED_FUTURE_API'
          ? resolution.newestVerified
          : 'API_1_47';
    if (resolution.kind === 'BELOW_SUPPORTED_FLOOR' || resolution.kind === 'NOT_A_BETAFLIGHT_API') {
      return {reason: 'UNSUPPORTED_FIRMWARE'};
    }
    const client = this.coordinator.getActiveMspClient(key.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation ||
      client === undefined ||
      scheduler === undefined
    ) {
      return {reason: 'DISCONNECTED'};
    }
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') {
      return {reason: 'LINK_RECOVERING'};
    }
    return {client, scheduler, epoch: client.getEpoch(), contract, authority};
  }

  private assertLive(key: SetupUiSessionKey, client: MspClient, epoch: number): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') {
      throw new LedPreflightError('APP_BACKGROUNDED');
    }
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation ||
      this.coordinator.getActiveMspClient(key.sessionId) !== client ||
      client.getEpoch() !== epoch
    ) {
      throw new LedPreflightError('DISCONNECTED');
    }
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') {
      throw new LedPreflightError('LINK_RECOVERING');
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
          clientState: this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED',
          isArmed: false,
        }),
      },
    );
  }
}

/** A link that went away, as opposed to a board that said no. */
function isSessionLoss(error: unknown): boolean {
  const code = (error as {readonly code?: unknown} | undefined)?.code;
  return (
    code === 'MSP_SESSION_CLOSED' ||
    code === 'MSP_DEVICE_DETACHED' ||
    code === 'MSP_RECOVERY_REQUIRED'
  );
}

/** Referenced so the ambiguous-write type stays part of the compiled
 *  surface for the coordinator to classify against. */
export type {LedAmbiguousWriteError};

export const ledStripConfigurationController = new LedStripConfigurationController();
