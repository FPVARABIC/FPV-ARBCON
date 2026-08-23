/**
 * A FLIGHT CONTROLLER THAT ACTUALLY HAS PROFILES.
 *
 * The shared VirtualFlightController models one parameter store keyed by
 * command, which is exactly right for the screens that own global settings
 * and useless for this one: nearly everything the PID page writes lives in
 * one of four PID profiles or one of four rate profiles, and the whole point
 * of P-C is that writing into the wrong one is the defect to prevent.
 *
 * So this board keeps four of each, and it models the firmware BEHAVIOURS
 * that P-A and P-B traced, because a board that merely echoes what it was
 * sent cannot prove a controller handles normalisation:
 *
 *   MSP_SELECT_SETTING   bit 7 rate, bit 6 battery from 1.48, else PID;
 *                        a PID switch is refused while armed, silently;
 *                        an out-of-range index becomes 0, silently
 *   MSP_SET_PID_ADVANCED tpa_rate clamped to 100
 *   MSP_SET_RC_TUNING    pitch follows roll when the two were equal
 *   MSP_SET_FILTER_CONFIG  the gyro-config validation: ceiling resets, a
 *                        notch disabled by its cutoff, a dynamic minimum
 *                        above its maximum, and the cross-subsystem
 *                        changes to pid_process_denom and the motor
 *                        protocol
 *   MSP_SET_SIMPLIFIED_TUNING  stores the inputs and then REGENERATES the
 *                        PID gains, D Max, feedforward and filter Hz
 *   MSP_COPY_PROFILE     a whole-struct copy with no re-initialisation
 *   MSP_SET_RESET_CURR_PID  the current PID profile back to defaults
 *
 * It is deliberately a separate file. Motors and Sensors scenarios keep the
 * board they already have; nothing here touches them.
 */

import type {MspFrame} from '../../../../core/protocol/mspTypes';
import type {MspRequestOptions} from '../../../../core/protocol/mspClient';
import {
  MSP2_GET_TEXT,
  MSP2_SET_TEXT,
  MSP_ADVANCED_CONFIG,
  MSP_BOXIDS,
  MSP_EEPROM_WRITE,
  MSP_FILTER_CONFIG,
  MSP_PID,
  MSP_PID_ADVANCED,
  MSP_RC_TUNING,
  MSP_SELECT_SETTING,
  MSP_SET_FILTER_CONFIG,
  MSP_SET_PID,
  MSP_SET_PID_ADVANCED,
  MSP_SET_RC_TUNING,
  MSP_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../../../../core/protocol/msp/commands/mspCommands';
import {
  MSP_CALCULATE_SIMPLIFIED_PID,
  MSP_COPY_PROFILE,
  MSP_SET_RESET_CURR_PID,
  MSP_SET_SIMPLIFIED_TUNING,
  MSP_SIMPLIFIED_TUNING,
  MSP_VALIDATE_SIMPLIFIED_TUNING,
} from '../../../../core/protocol/msp/commands/pidProfileCommands';
import {
  MAX_PROFILE_NAME_LENGTH,
  MSP2TEXT_PID_PROFILE_NAME,
  MSP2TEXT_RATE_PROFILE_NAME,
} from '../../../../core/protocol/msp/encoding/encodeProfileCommands';
import {FILTER_CONFIG_OFFSETS} from '../../../../core/protocol/msp/decoding/decodeFilterConfigFull';
import {PID_ADVANCED_OFFSETS, TPA_RATE_MAX} from '../../../../core/protocol/msp/decoding/decodePidAdvancedFull';
import {RC_TUNING_OFFSETS, RC_TUNING_RETIRED_OFFSETS} from '../../../../core/protocol/msp/decoding/decodeRcTuningFull';
import {
  SIMPLIFIED_FILTER_BLOCK_BYTES,
  SIMPLIFIED_PID_BLOCK_BYTES,
} from '../../../../core/protocol/msp/decoding/decodeSimplifiedTuning';
import {
  MAX_PID_PROCESS_DENOM,
  PID_DENOM_FORCE_SAMPLE_RATE_HZ,
  motorUpdateRestrictionSeconds,
} from '../../../../core/state/filterSideEffectProjection';
import {
  MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_PROSHOT1000_AT_2025_12_2,
} from '../../../../core/protocol/msp/decoding/decodeAdvancedConfig';
import {
  generateSimplifiedDtermFilters,
  generateSimplifiedGyroFilters,
  generateSimplifiedPids,
  simplifiedDefaultsFor,
} from '../../../../core/state/simplifiedTuningGenerator';

export const PID_PROFILE_SLOTS = 4;
export const RATE_PROFILE_SLOTS = 4;

const MSP_ERROR = 'MSP_REMOTE_ERROR';

class VirtualPidError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VirtualPidError';
    this.code = code;
  }
}

/** Offsets inside MSP_FILTER_CONFIG that belong to the PID PROFILE. */
const PROFILE_FILTER_U16: readonly number[] = [
  FILTER_CONFIG_OFFSETS.dtermLpf1StaticHz,
  FILTER_CONFIG_OFFSETS.yawLowpassHz,
  FILTER_CONFIG_OFFSETS.dtermNotchHz,
  FILTER_CONFIG_OFFSETS.dtermNotchCutoff,
  FILTER_CONFIG_OFFSETS.dtermLpf2StaticHz,
  FILTER_CONFIG_OFFSETS.dtermLpf1DynMinHz,
  FILTER_CONFIG_OFFSETS.dtermLpf1DynMaxHz,
];
const PROFILE_FILTER_U8: readonly number[] = [
  FILTER_CONFIG_OFFSETS.dtermLpf1Type,
  FILTER_CONFIG_OFFSETS.dtermLpf2Type,
  FILTER_CONFIG_OFFSETS.dtermLpf1DynExpo,
];

export interface VirtualPidProfile {
  pid: Uint8Array;
  advanced: Uint8Array;
  /** Only the PID-profile offsets of this array are meaningful. */
  filterProfile: Uint8Array;
  /** The 17-byte simplified PID block plus the 18-byte D-term block. */
  simplifiedPids: Uint8Array;
  simplifiedDterm: Uint8Array;
  name: string;
}

export interface VirtualRateProfile {
  rcTuning: Uint8Array;
  name: string;
}

export interface VirtualPidGlobals {
  /** Only the GLOBAL offsets of this array are meaningful. */
  filterGlobal: Uint8Array;
  simplifiedGyro: Uint8Array;
  advancedConfig: Uint8Array;
}

interface Snapshot {
  pidProfiles: VirtualPidProfile[];
  rateProfiles: VirtualRateProfile[];
  globals: VirtualPidGlobals;
  activePid: number;
  activeRate: number;
}

export type VirtualPidFault =
  | {readonly kind: 'TIMEOUT'}
  | {readonly kind: 'REMOTE_ERROR'}
  | {readonly kind: 'DETACH'};

export interface VirtualPidFaultPlan {
  readonly command: number;
  readonly occurrence?: number;
  readonly fault: VirtualPidFault;
}

/**
 * BOARDS THAT DO NOT BEHAVE.
 *
 * Every quirk below models a way a real flight controller can acknowledge a
 * command and then not do what was asked. They exist so a scenario can prove
 * the controller CATCHES it rather than proving only that a well-behaved
 * board round-trips - which any implementation would pass.
 *
 * None of them is a claim that a specific board does this. They are the
 * failure shapes the verification steps exist for.
 */
export interface VirtualPidBoardQuirks {
  /** PID profile indices the board acknowledges a switch to and ignores. */
  readonly silentlyIgnoredPidSelects?: readonly number[];
  /** What the commit does to RAM besides committing. */
  readonly onEepromWrite?: 'NOTHING' | 'REVERT_ACTIVE_PID' | 'MOVE_ACTIVE_PROFILE';
  /** A copy that stops short of a whole-struct copy. */
  readonly copyProfile?: 'FULL' | 'PARTIAL';
  /** A generator whose output differs from our reimplementation. */
  readonly simplifiedGenerator?: 'FIRMWARE' | 'DRIFTED';
  /**
   * A reset that does not produce the firmware defaults. WRONG_LEVEL_ITEM
   * misses one of the two PID items this screen never edits, which is the
   * case a three-axis check would sail straight past.
   */
  readonly resetProduces?: 'FIRMWARE_DEFAULTS' | 'SOMETHING_ELSE' | 'WRONG_LEVEL_ITEM';
  /** A rates-type write that also rescales a number it had no business touching. */
  readonly ratesTypeWrite?: 'FAITHFUL' | 'ALSO_RESCALES';
  /** A name buffer shorter than MAX_PROFILE_NAME_LENGTH. */
  readonly profileNameCapacity?: number;
  /** A GET_TEXT reply that echoes a selector nobody asked for. */
  readonly textSelectorEcho?: 'REQUESTED' | 'WRONG';
  /** A board whose CALCULATE RPC disagrees with our own generator. */
  readonly calculateOracle?: 'AGREES' | 'DISAGREES';
}

export interface VirtualPidBoardOptions {
  readonly apiMinor: number;
  readonly quirks?: VirtualPidBoardQuirks;
  readonly filterBytes: number;
  readonly pidProfiles?: readonly Partial<VirtualPidProfile>[];
  readonly rateProfiles?: readonly Partial<VirtualRateProfile>[];
  readonly globals?: Partial<VirtualPidGlobals>;
  readonly armed?: boolean;
  readonly boxIds?: readonly number[];
  /** `gyro.sampleRateHz`. Drives the whole gyro-validation block. */
  readonly gyroSampleRateHz?: number;
  /** `motorConfig()->dev.useDshotTelemetry`, answered on MSP_MOTOR_CONFIG. */
  readonly useDshotTelemetry?: boolean;
  /**
   * Whether this TARGET compiles in `USE_PID_DENOM_CHECK` and passes the
   * `cpu_overclock` test. No client can observe either, which is the whole
   * reason the controller must refuse to predict what this flag controls.
   */
  readonly targetHasPidDenomCheck?: boolean;
  /** A board that also does something no documented rule explains. */
  readonly unpredictedExtraSideEffect?: boolean;
  /** Commands the board does not implement at all - a build without them. */
  readonly unsupportedCommands?: readonly number[];
}

const DSHOT_PROTOCOL_RAWS: ReadonlySet<number> = new Set([
  MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_PROSHOT1000_AT_2025_12_2,
]);

const clone = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes);

/**
 * `resetPidProfile()`'s template, for the fields this app can observe.
 *
 * `RESET_CONFIG` memcpys a static const over the whole struct, so every value
 * here is the firmware's own default and every field not listed is zero.
 * Read from `src/main/flight/pid.c:129-250` at the pinned commit.
 */
function firmwareResetPidProfile(filterBytes: number): VirtualPidProfile {
  const advanced = new Uint8Array(61);
  const view = new DataView(advanced.buffer);
  // The `F` element of PID_ROLL/PITCH/YAW_DEFAULT.
  view.setUint16(PID_ADVANCED_OFFSETS.feedforwardRoll, 120, true);
  view.setUint16(PID_ADVANCED_OFFSETS.feedforwardPitch, 125, true);
  view.setUint16(PID_ADVANCED_OFFSETS.feedforwardYaw, 120, true);
  advanced[PID_ADVANCED_OFFSETS.dMaxRoll] = 40;      // D_MAX_DEFAULT
  advanced[PID_ADVANCED_OFFSETS.dMaxPitch] = 46;
  advanced[PID_ADVANCED_OFFSETS.dMaxYaw] = 0;
  advanced[PID_ADVANCED_OFFSETS.dMaxGain] = 37;      // .d_max_gain
  advanced[PID_ADVANCED_OFFSETS.tpaRate] = 65;       // .tpa_rate
  view.setUint16(PID_ADVANCED_OFFSETS.tpaBreakpoint, 1350, true);
  advanced[PID_ADVANCED_OFFSETS.tpaMode] = 0;        // TPA_MODE_D
  view.setUint16(PID_ADVANCED_OFFSETS.dynIdleMinRpm, 0, true);
  advanced[PID_ADVANCED_OFFSETS.feedforwardAveraging] = 1;  // 2_POINT
  advanced[PID_ADVANCED_OFFSETS.feedforwardBoost] = 15;
  advanced[PID_ADVANCED_OFFSETS.feedforwardJitterFactor] = 7;

  const filterProfile = new Uint8Array(filterBytes);
  const fp = new DataView(filterProfile.buffer);
  fp.setUint16(FILTER_CONFIG_OFFSETS.dtermLpf1StaticHz, 75, true);
  fp.setUint16(FILTER_CONFIG_OFFSETS.dtermLpf2StaticHz, 150, true);
  fp.setUint16(FILTER_CONFIG_OFFSETS.dtermLpf1DynMinHz, 75, true);
  fp.setUint16(FILTER_CONFIG_OFFSETS.dtermLpf1DynMaxHz, 150, true);
  fp.setUint16(FILTER_CONFIG_OFFSETS.yawLowpassHz, 100, true);

  // `.simplified_pids_mode = PID_SIMPLIFIED_TUNING_RPY` - a reset turns the
  // generator back ON, which is itself a behaviour worth reproducing.
  const simplifiedPids = Uint8Array.from([
    2, 100, 100, 100, 100, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const simplifiedDterm = new Uint8Array(SIMPLIFIED_FILTER_BLOCK_BYTES);
  simplifiedDterm[1] = 100;
  const sd = new DataView(simplifiedDterm.buffer);
  sd.setUint16(2, 75, true);
  sd.setUint16(4, 150, true);
  sd.setUint16(6, 75, true);
  sd.setUint16(8, 150, true);
  return {
    // ROLL/PITCH/YAW defaults, then PID_LEVEL {50,75,75} and PID_MAG {40,0,0}.
    pid: Uint8Array.from([45, 80, 30, 47, 84, 34, 45, 80, 0, 50, 75, 75, 40, 0, 0]),
    advanced,
    filterProfile,
    simplifiedPids,
    simplifiedDterm,
    name: '',
  };
}

/**
 * The profile a freshly-constructed board starts from.
 *
 * Identical to the firmware reset template EXCEPT that the simplified
 * generator is OFF. A factory-reset Betaflight profile really does have
 * `simplified_pids_mode = RPY`, but a board somebody has actually tuned by
 * hand has turned it off - and that is the state most scenarios here are
 * about. The reset command still produces the true template, which is how
 * the difference stays visible.
 */
function defaultPidProfile(filterBytes: number): VirtualPidProfile {
  const profile = firmwareResetPidProfile(filterBytes);
  profile.simplifiedPids[0] = 0;
  return profile;
}

function defaultRateProfile(): VirtualRateProfile {
  const rcTuning = new Uint8Array(24);
  rcTuning[RC_TUNING_OFFSETS.rcRateRoll] = 100;
  rcTuning[RC_TUNING_OFFSETS.rcRatePitch] = 100;
  rcTuning[RC_TUNING_OFFSETS.rcRateYaw] = 100;
  rcTuning[RC_TUNING_OFFSETS.superRateRoll] = 70;
  rcTuning[RC_TUNING_OFFSETS.superRatePitch] = 70;
  rcTuning[RC_TUNING_OFFSETS.superRateYaw] = 70;
  rcTuning[RC_TUNING_OFFSETS.throttleMid] = 50;
  rcTuning[RC_TUNING_OFFSETS.throttleExpo] = 0;
  rcTuning[RC_TUNING_OFFSETS.throttleLimitType] = 0;
  rcTuning[RC_TUNING_OFFSETS.throttleLimitPercent] = 100;
  rcTuning[RC_TUNING_OFFSETS.throttleHover] = 50;
  const view = new DataView(rcTuning.buffer);
  view.setUint16(RC_TUNING_OFFSETS.rateLimitRoll, 1998, true);
  view.setUint16(RC_TUNING_OFFSETS.rateLimitPitch, 1998, true);
  view.setUint16(RC_TUNING_OFFSETS.rateLimitYaw, 1998, true);
  return {rcTuning, name: ''};
}

function defaultGlobals(filterBytes: number): VirtualPidGlobals {
  const filterGlobal = new Uint8Array(filterBytes);
  const view = new DataView(filterGlobal.buffer);
  view.setUint16(FILTER_CONFIG_OFFSETS.gyroLpf1StaticHz, 250, true);
  filterGlobal[FILTER_CONFIG_OFFSETS.gyroLpf1StaticHzLegacyU8] = 250;
  view.setUint16(FILTER_CONFIG_OFFSETS.gyroLpf2StaticHz, 500, true);
  view.setUint16(FILTER_CONFIG_OFFSETS.gyroLpf1DynMinHz, 250, true);
  view.setUint16(FILTER_CONFIG_OFFSETS.gyroLpf1DynMaxHz, 500, true);
  view.setUint16(FILTER_CONFIG_OFFSETS.dynNotchQ, 300, true);
  view.setUint16(FILTER_CONFIG_OFFSETS.dynNotchMinHz, 100, true);
  view.setUint16(FILTER_CONFIG_OFFSETS.dynNotchMaxHz, 600, true);
  filterGlobal[FILTER_CONFIG_OFFSETS.dynNotchCount] = 3;
  const simplifiedGyro = new Uint8Array(SIMPLIFIED_FILTER_BLOCK_BYTES);
  simplifiedGyro[1] = 100;
  const sg = new DataView(simplifiedGyro.buffer);
  sg.setUint16(2, 250, true);
  sg.setUint16(4, 500, true);
  sg.setUint16(6, 250, true);
  sg.setUint16(8, 500, true);
  // MSP_ADVANCED_CONFIG: [gyro_sync_denom, pid_process_denom,
  // useContinuousUpdate, motorProtocol, motorPwmRate u16, ...]
  const advancedConfig = new Uint8Array(20);
  advancedConfig[0] = 1;
  advancedConfig[1] = 1;
  advancedConfig[2] = 0;
  advancedConfig[3] = 6; // DSHOT600
  new DataView(advancedConfig.buffer).setUint16(4, 480, true);
  return {filterGlobal, simplifiedGyro, advancedConfig};
}

function cloneProfile(profile: VirtualPidProfile): VirtualPidProfile {
  return {
    pid: clone(profile.pid),
    advanced: clone(profile.advanced),
    filterProfile: clone(profile.filterProfile),
    simplifiedPids: clone(profile.simplifiedPids),
    simplifiedDterm: clone(profile.simplifiedDterm),
    name: profile.name,
  };
}

function cloneRate(profile: VirtualRateProfile): VirtualRateProfile {
  return {rcTuning: clone(profile.rcTuning), name: profile.name};
}

function cloneGlobals(globals: VirtualPidGlobals): VirtualPidGlobals {
  return {
    filterGlobal: clone(globals.filterGlobal),
    simplifiedGyro: clone(globals.simplifiedGyro),
    advancedConfig: clone(globals.advancedConfig),
  };
}

export class VirtualPidBoard {
  private state: Snapshot;
  private persisted: Snapshot;
  private epoch = 1;
  private armedState: boolean;
  private reachable = true;
  private readonly boxIds: readonly number[];
  private readonly faults: VirtualPidFaultPlan[] = [];
  private readonly seen = new Map<number, number>();
  private readonly apiMinor: number;
  private readonly filterBytes: number;
  private readonly gyroSampleRateHz: number;
  private readonly useDshotTelemetry: boolean;
  private readonly targetHasPidDenomCheck: boolean;
  private readonly unpredictedExtraSideEffect: boolean;
  private readonly unsupported: ReadonlySet<number>;
  private readonly quirks: VirtualPidBoardQuirks;
  readonly requests: Array<{command: number; payload: Uint8Array}> = [];
  readonly counts = {eepromWrites: 0};

  constructor(options: VirtualPidBoardOptions) {
    this.apiMinor = options.apiMinor;
    this.filterBytes = options.filterBytes;
    this.armedState = options.armed === true;
    this.boxIds = options.boxIds ?? [0];
    this.gyroSampleRateHz = options.gyroSampleRateHz ?? 8000;
    this.useDshotTelemetry = options.useDshotTelemetry === true;
    this.targetHasPidDenomCheck = options.targetHasPidDenomCheck === true;
    this.unpredictedExtraSideEffect = options.unpredictedExtraSideEffect === true;
    this.unsupported = new Set(options.unsupportedCommands ?? []);
    this.quirks = options.quirks ?? {};
    const pidProfiles = Array.from({length: PID_PROFILE_SLOTS}, (_unused, index) => ({
      ...defaultPidProfile(options.filterBytes),
      ...(options.pidProfiles?.[index] ?? {}),
    })) as VirtualPidProfile[];
    const rateProfiles = Array.from({length: RATE_PROFILE_SLOTS}, (_unused, index) => ({
      ...defaultRateProfile(),
      ...(options.rateProfiles?.[index] ?? {}),
    })) as VirtualRateProfile[];
    this.state = {
      pidProfiles,
      rateProfiles,
      globals: {...defaultGlobals(options.filterBytes), ...(options.globals ?? {})},
      activePid: 0,
      activeRate: 0,
    };
    this.persisted = this.snapshot();
  }

  private snapshot(): Snapshot {
    return {
      pidProfiles: this.state.pidProfiles.map(cloneProfile),
      rateProfiles: this.state.rateProfiles.map(cloneRate),
      globals: cloneGlobals(this.state.globals),
      activePid: this.state.activePid,
      activeRate: this.state.activeRate,
    };
  }

  getEpoch(): number { return this.epoch; }
  setArmed(armed: boolean): void { this.armedState = armed; }
  detach(): void { this.reachable = false; }
  reattach(): void { this.reachable = true; }
  injectFault(plan: VirtualPidFaultPlan): void { this.faults.push(plan); }
  activePidProfile(): number { return this.state.activePid; }
  activeRateProfile(): number { return this.state.activeRate; }
  pidProfile(index: number): VirtualPidProfile { return this.state.pidProfiles[index]; }
  rateProfile(index: number): VirtualRateProfile { return this.state.rateProfiles[index]; }
  globals(): VirtualPidGlobals { return this.state.globals; }
  persistedActivePidProfile(): number { return this.persisted.activePid; }
  persistedPidProfile(index: number): VirtualPidProfile { return this.persisted.pidProfiles[index]; }
  persistedRateProfile(index: number): VirtualRateProfile { return this.persisted.rateProfiles[index]; }
  commandCount(command: number): number {
    return this.requests.filter(entry => entry.command === command).length;
  }

  /** The composed MSP_FILTER_CONFIG the board would answer with. */
  composedFilterConfig(): Uint8Array {
    const bytes = clone(this.state.globals.filterGlobal);
    const profile = this.state.pidProfiles[this.state.activePid].filterProfile;
    const out = new DataView(bytes.buffer);
    const src = new DataView(profile.buffer);
    for (const offset of PROFILE_FILTER_U16) out.setUint16(offset, src.getUint16(offset, true), true);
    for (const offset of PROFILE_FILTER_U8) bytes[offset] = profile[offset];
    return bytes;
  }

  private composedSimplified(): Uint8Array {
    const profile = this.state.pidProfiles[this.state.activePid];
    const out = new Uint8Array(53);
    out.set(profile.simplifiedPids.subarray(0, SIMPLIFIED_PID_BLOCK_BYTES), 0);
    out.set(profile.simplifiedDterm, SIMPLIFIED_PID_BLOCK_BYTES);
    out.set(this.state.globals.simplifiedGyro, SIMPLIFIED_PID_BLOCK_BYTES + SIMPLIFIED_FILTER_BLOCK_BYTES);
    return out;
  }

  /**
   * `sbufWriteU8(dst, 0)` and `sbufWriteU16(dst, 0)` where tpa_rate and
   * tpa_breakpoint used to be, so those three bytes read as zero no matter
   * what a client wrote into them.
   */
  private rcTuningResponse(): Uint8Array {
    const bytes = clone(this.state.rateProfiles[this.state.activeRate].rcTuning);
    for (const offset of RC_TUNING_RETIRED_OFFSETS) bytes[offset] = 0;
    return bytes;
  }

  /**
   * MSP_MOTOR_CONFIG. Only offset 8 matters to the PID page: it is the
   * `useDshotTelemetry` flag that decides whether the unobservable branch of
   * the gyro validation can fire.
   */
  private motorConfig(): Uint8Array {
    const bytes = new Uint8Array(10);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0, true);      // was minthrottle
    view.setUint16(2, 2000, true);   // maxthrottle
    view.setUint16(4, 1000, true);   // mincommand
    bytes[6] = 4;                    // motor count
    bytes[7] = 14;                   // motor pole count
    bytes[8] = this.useDshotTelemetry ? 1 : 0;
    bytes[9] = 0;                    // ESC sensor feature
    return bytes;
  }

  private statusEx(): Uint8Array {
    const bytes = new Uint8Array(24);
    bytes[6] = this.armedState ? 1 : 0;
    bytes[10] = this.state.activePid;
    bytes[13] = PID_PROFILE_SLOTS;
    bytes[14] = this.state.activeRate;
    bytes[15] = 0;
    bytes[16] = 29;
    // armingDisableFlags u32 at 17..20, configState at 21
    bytes[21] = 0;
    return bytes;
  }

  private frame(command: number, payload: Uint8Array, options: MspRequestOptions): MspFrame {
    return {
      protocolVersion: options.wireFormat === 'v1' ? 'v1' : 'v2',
      wireFormat: options.wireFormat,
      direction: 'response',
      command,
      flags: 0,
      payload,
    };
  }

  async request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
    if (!this.reachable) throw new VirtualPidError('MSP_TIMEOUT', 'link detached');
    this.requests.push({command, payload: clone(payload)});
    const seen = (this.seen.get(command) ?? 0) + 1;
    this.seen.set(command, seen);
    const fault = this.faults.find(
      plan => plan.command === command && (plan.occurrence === undefined || plan.occurrence === seen),
    );
    if (fault !== undefined) {
      if (fault.fault.kind === 'TIMEOUT') { this.epoch += 1; throw new VirtualPidError('MSP_TIMEOUT', 'timeout'); }
      if (fault.fault.kind === 'DETACH') { this.reachable = false; throw new VirtualPidError('MSP_TIMEOUT', 'detached'); }
      throw new VirtualPidError(MSP_ERROR, 'board refused');
    }
    if (this.unsupported.has(command)) throw new VirtualPidError(MSP_ERROR, `unsupported ${command}`);
    return this.frame(command, this.dispatch(command, payload), options);
  }

  private dispatch(command: number, payload: Uint8Array): Uint8Array {
    const empty = new Uint8Array(0);
    const active = this.state.pidProfiles[this.state.activePid];
    switch (command) {
      case MSP_STATUS_EX: return this.statusEx();
      case MSP_BOXIDS: return Uint8Array.from(this.boxIds);
      case MSP_PID: return clone(active.pid);
      case MSP_PID_ADVANCED: return clone(active.advanced);
      case MSP_RC_TUNING: return this.rcTuningResponse();
      case MSP_FILTER_CONFIG: return this.composedFilterConfig();
      case MSP_ADVANCED_CONFIG: return clone(this.state.globals.advancedConfig);
      case MSP_MOTOR_CONFIG: return this.motorConfig();
      case MSP_SIMPLIFIED_TUNING: return this.composedSimplified();
      case MSP_VALIDATE_SIMPLIFIED_TUNING: return this.validateSimplified();
      case MSP_CALCULATE_SIMPLIFIED_PID: return this.calculateSimplifiedPid(payload);
      case MSP2_GET_TEXT: return this.getText(payload);
      case MSP2_SET_TEXT: this.setText(payload); return empty;
      case MSP_EEPROM_WRITE: this.commit(); return empty;
      case MSP_SELECT_SETTING: this.selectSetting(payload[0]); return empty;
      case MSP_SET_PID: active.pid.set(payload.subarray(0, 15)); return empty;
      case MSP_SET_PID_ADVANCED: this.setPidAdvanced(payload); return empty;
      case MSP_SET_RC_TUNING: this.setRcTuning(payload); return empty;
      case MSP_SET_FILTER_CONFIG: this.setFilterConfig(payload); return empty;
      case MSP_SET_SIMPLIFIED_TUNING: this.setSimplified(payload); return empty;
      case MSP_COPY_PROFILE: this.copyProfile(payload); return empty;
      case MSP_SET_RESET_CURR_PID: this.resetCurrentPidProfile(); return empty;
      default: throw new VirtualPidError(MSP_ERROR, `unsupported command ${command}`);
    }
  }

  /**
   * The commit, plus whatever this board also does while committing.
   *
   * A commit that quietly disturbs RAM is exactly why an EEPROM
   * acknowledgement is not accepted as proof of anything.
   */
  private commit(): void {
    this.counts.eepromWrites += 1;
    if (this.quirks.onEepromWrite === 'REVERT_ACTIVE_PID') {
      this.state.pidProfiles[this.state.activePid].pid[0] = 45;
    }
    if (this.quirks.onEepromWrite === 'MOVE_ACTIVE_PROFILE') {
      this.state.activePid = (this.state.activePid + 1) % PID_PROFILE_SLOTS;
    }
    this.persisted = this.snapshot();
  }

  /** bit 6 battery (1.48+, tested first), bit 7 rate, else PID. */
  private selectSetting(raw: number): void {
    if (this.apiMinor >= 48 && raw >= 0x40 && raw < 0x80) return; // battery profile, ignored here
    if (raw >= 0x80) {
      const index = raw - 0x80;
      this.state.activeRate = index < RATE_PROFILE_SLOTS ? index : 0;
      return;
    }
    // The firmware refuses a PID-profile switch while armed - and ACKs anyway.
    if (this.armedState) return;
    if (this.quirks.silentlyIgnoredPidSelects?.includes(raw) === true) return;
    this.state.activePid = raw < PID_PROFILE_SLOTS ? raw : 0;
  }

  private setPidAdvanced(payload: Uint8Array): void {
    const active = this.state.pidProfiles[this.state.activePid];
    active.advanced.set(payload.subarray(0, 61));
    active.advanced[PID_ADVANCED_OFFSETS.tpaRate] =
      Math.min(active.advanced[PID_ADVANCED_OFFSETS.tpaRate], TPA_RATE_MAX);
  }

  /**
   * MSP_SET_RC_TUNING, IN THE FIRMWARE'S OWN READ ORDER.
   *
   * The order is the whole point, and it is easy to get backwards. The
   * legacy pitch-follows-roll linkage fires on the FIRST byte, against the
   * values the board is holding at that moment - but the payload also
   * carries an EXPLICIT pitch rcRate at offset 12 and an explicit pitch expo
   * at offset 13, and those are read LAST and assigned unconditionally. So
   * on a full-length write the linkage is invisible: whatever it set is
   * immediately overwritten. It can only be observed by a client that sends
   * a payload short enough to stop before offset 12.
   *
   * Three bytes are read and thrown away - `tpa_rate` at 5 and
   * `tpa_breakpoint` at 8..9 moved to the PID profile - and the responder
   * writes literal zeros in their place, so they can never round-trip.
   */
  private setRcTuning(payload: Uint8Array): void {
    const rate = this.state.rateProfiles[this.state.activeRate];
    const stored = rate.rcTuning;
    const o = RC_TUNING_OFFSETS;
    if (stored[o.rcRatePitch] === stored[o.rcRateRoll]) stored[o.rcRatePitch] = payload[o.rcRateRoll];
    stored[o.rcRateRoll] = payload[o.rcRateRoll];
    if (stored[o.expoPitch] === stored[o.expoRoll]) stored[o.expoPitch] = payload[o.expoRoll];
    stored[o.expoRoll] = payload[o.expoRoll];
    stored[o.superRateRoll] = payload[o.superRateRoll];
    stored[o.superRatePitch] = payload[o.superRatePitch];
    stored[o.superRateYaw] = payload[o.superRateYaw];
    stored[o.throttleMid] = payload[o.throttleMid];
    stored[o.throttleExpo] = payload[o.throttleExpo];
    if (payload.length <= o.expoYaw) return;
    stored[o.expoYaw] = payload[o.expoYaw];
    if (payload.length <= o.rcRateYaw) return;
    stored[o.rcRateYaw] = payload[o.rcRateYaw];
    if (payload.length <= o.rcRatePitch) return;
    stored[o.rcRatePitch] = payload[o.rcRatePitch];
    if (payload.length <= o.expoPitch) return;
    stored[o.expoPitch] = payload[o.expoPitch];
    if (payload.length < o.rateLimitRoll) return;
    stored[o.throttleLimitType] = payload[o.throttleLimitType];
    stored[o.throttleLimitPercent] = payload[o.throttleLimitPercent];
    if (payload.length < o.ratesType) return;
    const out = new DataView(stored.buffer);
    const src = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    out.setUint16(o.rateLimitRoll, src.getUint16(o.rateLimitRoll, true), true);
    out.setUint16(o.rateLimitPitch, src.getUint16(o.rateLimitPitch, true), true);
    out.setUint16(o.rateLimitYaw, src.getUint16(o.rateLimitYaw, true), true);
    if (payload.length <= o.ratesType) return;
    const ratesTypeChanged = stored[o.ratesType] !== payload[o.ratesType];
    stored[o.ratesType] = payload[o.ratesType];
    if (payload.length <= o.throttleHover) return;
    stored[o.throttleHover] = payload[o.throttleHover];
    if (this.quirks.ratesTypeWrite === 'ALSO_RESCALES' && ratesTypeChanged) {
      // A board that "helpfully" rescales a rate when the formula changes.
      stored[o.rcRateRoll] = (stored[o.rcRateRoll] + 7) % 251;
    }
  }

  private setFilterConfig(payload: Uint8Array): void {
    const global = this.state.globals.filterGlobal;
    const profile = this.state.pidProfiles[this.state.activePid].filterProfile;
    global.set(payload.subarray(0, this.filterBytes));
    profile.set(payload.subarray(0, this.filterBytes));
    const view = new DataView(global.buffer);
    const o = FILTER_CONFIG_OFFSETS;
    // The firmware's ceiling fix is a RESET, and the reset value differs:
    // a centre becomes the ceiling, a cutoff becomes zero.
    const limit = (offset: number, resetValue: number): void => {
      if (view.getUint16(offset, true) > 1000) view.setUint16(offset, resetValue, true);
    };
    limit(o.gyroLpf1StaticHz, 1000);
    limit(o.gyroLpf2StaticHz, 1000);
    limit(o.gyroSoftNotchHz1, 1000);
    limit(o.gyroSoftNotchCutoff1, 0);
    limit(o.gyroSoftNotchHz2, 1000);
    limit(o.gyroSoftNotchCutoff2, 0);
    if (view.getUint16(o.gyroSoftNotchCutoff1, true) >= view.getUint16(o.gyroSoftNotchHz1, true)) {
      view.setUint16(o.gyroSoftNotchHz1, 0, true);
    }
    if (view.getUint16(o.gyroSoftNotchCutoff2, true) >= view.getUint16(o.gyroSoftNotchHz2, true)) {
      view.setUint16(o.gyroSoftNotchHz2, 0, true);
    }
    if (view.getUint16(o.gyroLpf1DynMinHz, true) > view.getUint16(o.gyroLpf1DynMaxHz, true)) {
      view.setUint16(o.gyroLpf1DynMinHz, 0, true);
    }
    this.validateAndFixGyroConfigTail();
  }

  /**
   * The rest of `validateAndFixGyroConfig` (config.c:579-649), reproduced in
   * the firmware's own order and with its own arithmetic.
   *
   * The earlier version of this board applied a crude "denom goes up, DShot
   * goes down" caricature that did not match any real rule - and the
   * classifier it was paired with accepted any change in those directions.
   * Both are now exact.
   */
  private validateAndFixGyroConfigTail(): void {
    const advanced = this.state.globals.advancedConfig;
    const view = new DataView(advanced.buffer);
    const rate = this.gyroSampleRateHz;
    if (rate <= 0) return;

    // The target-gated branch. `targetHasPidDenomCheck` stands in for
    // USE_PID_DENOM_CHECK plus the cpu_overclock test - a build fact no
    // client can observe, which is exactly why the app must not predict it.
    if (this.targetHasPidDenomCheck && this.useDshotTelemetry) {
      if (advanced[3] === MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2) {
        advanced[3] = MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2;
      }
      if (rate > PID_DENOM_FORCE_SAMPLE_RATE_HZ) advanced[1] = Math.max(2, advanced[1]);
    }

    const samplingTime = 1 / rate;
    let restriction = motorUpdateRestrictionSeconds(advanced[3]);

    if (advanced[2] !== 0) {
      const isDshot = DSHOT_PROTOCOL_RAWS.has(advanced[3]);
      if (!isDshot && advanced[3] !== 0) {
        const maxEscRate = Math.round(1 / restriction);
        view.setUint16(4, Math.min(view.getUint16(4, true), maxEscRate), true);
      }
    } else {
      if (this.useDshotTelemetry) restriction *= 2;
      const pidLooptime = samplingTime * advanced[1];
      if (pidLooptime < restriction) {
        const ratio = restriction / samplingTime;
        let minimum = Math.trunc(ratio) % 256;
        if (ratio > minimum) minimum += 1;
        minimum = Math.min(Math.max(minimum, 1), MAX_PID_PROCESS_DENOM);
        advanced[1] = Math.max(advanced[1], minimum);
      }
    }

    if (this.unpredictedExtraSideEffect) {
      // A board doing something no documented rule explains at all.
      view.setUint16(4, view.getUint16(4, true) + 1, true);
    }
  }

  private setSimplified(payload: Uint8Array): void {
    const active = this.state.pidProfiles[this.state.activePid];
    active.simplifiedPids.set(payload.subarray(0, SIMPLIFIED_PID_BLOCK_BYTES));
    active.simplifiedDterm.set(
      payload.subarray(SIMPLIFIED_PID_BLOCK_BYTES, SIMPLIFIED_PID_BLOCK_BYTES + SIMPLIFIED_FILTER_BLOCK_BYTES),
    );
    this.state.globals.simplifiedGyro.set(payload.subarray(SIMPLIFIED_PID_BLOCK_BYTES + SIMPLIFIED_FILTER_BLOCK_BYTES));
    this.applySimplified();
  }

  /** The firmware's applySimplifiedTuning(), on the active profile. */
  private applySimplified(): void {
    const defaults = simplifiedDefaultsFor('API_1_47');
    const active = this.state.pidProfiles[this.state.activePid];
    const inputs = active.simplifiedPids;
    const mode = inputs[0];
    if (mode === 1 || mode === 2) {
      const generated = generateSimplifiedPids({
        mode,
        masterMultiplier: inputs[1],
        rollPitchRatio: inputs[2],
        iGain: inputs[3],
        dGain: inputs[4],
        piGain: inputs[5],
        dMaxGain: inputs[6],
        feedforwardGain: inputs[7],
        pitchPiGain: inputs[8],
      }, defaults);
      const adv = new DataView(active.advanced.buffer);
      generated.axes.forEach((axis, index) => {
        active.pid[index * 3] = axis.p;
        active.pid[index * 3 + 1] = axis.i;
        active.pid[index * 3 + 2] = axis.d;
        adv.setUint16(PID_ADVANCED_OFFSETS.feedforwardRoll + index * 2, axis.f, true);
        active.advanced[PID_ADVANCED_OFFSETS.dMaxRoll + index] = axis.dMax;
      });
      if (this.quirks.simplifiedGenerator === 'DRIFTED') {
        // A board whose generator does not agree with our reimplementation.
        // The sliders still echo perfectly - which is the whole reason an
        // echo cannot be the verification.
        active.pid[0] = (active.pid[0] + 1) % 251;
      }
    }
    const dterm = active.simplifiedDterm;
    if (dterm[0] !== 0) {
      const view = new DataView(dterm.buffer);
      const generated = generateSimplifiedDtermFilters(true, dterm[1], {
        lpf1StaticHz: view.getUint16(2, true),
        lpf2StaticHz: view.getUint16(4, true),
        lpf1DynMinHz: view.getUint16(6, true),
        lpf1DynMaxHz: view.getUint16(8, true),
      }, defaults);
      view.setUint16(2, generated.lpf1StaticHz, true);
      view.setUint16(4, generated.lpf2StaticHz, true);
      view.setUint16(6, generated.lpf1DynMinHz, true);
      view.setUint16(8, generated.lpf1DynMaxHz, true);
      const fp = new DataView(active.filterProfile.buffer);
      fp.setUint16(FILTER_CONFIG_OFFSETS.dtermLpf1StaticHz, generated.lpf1StaticHz, true);
      fp.setUint16(FILTER_CONFIG_OFFSETS.dtermLpf2StaticHz, generated.lpf2StaticHz, true);
      fp.setUint16(FILTER_CONFIG_OFFSETS.dtermLpf1DynMinHz, generated.lpf1DynMinHz, true);
      fp.setUint16(FILTER_CONFIG_OFFSETS.dtermLpf1DynMaxHz, generated.lpf1DynMaxHz, true);
    }
    const gyro = this.state.globals.simplifiedGyro;
    if (gyro[0] !== 0) {
      const view = new DataView(gyro.buffer);
      const generated = generateSimplifiedGyroFilters(true, gyro[1], {
        lpf1StaticHz: view.getUint16(2, true),
        lpf2StaticHz: view.getUint16(4, true),
        lpf1DynMinHz: view.getUint16(6, true),
        lpf1DynMaxHz: view.getUint16(8, true),
      }, defaults);
      view.setUint16(2, generated.lpf1StaticHz, true);
      view.setUint16(4, generated.lpf2StaticHz, true);
      view.setUint16(6, generated.lpf1DynMinHz, true);
      view.setUint16(8, generated.lpf1DynMaxHz, true);
      const fg = new DataView(this.state.globals.filterGlobal.buffer);
      fg.setUint16(FILTER_CONFIG_OFFSETS.gyroLpf1StaticHz, generated.lpf1StaticHz, true);
      this.state.globals.filterGlobal[FILTER_CONFIG_OFFSETS.gyroLpf1StaticHzLegacyU8] =
        generated.lpf1StaticHz % 256;
      fg.setUint16(FILTER_CONFIG_OFFSETS.gyroLpf2StaticHz, generated.lpf2StaticHz, true);
      fg.setUint16(FILTER_CONFIG_OFFSETS.gyroLpf1DynMinHz, generated.lpf1DynMinHz, true);
      fg.setUint16(FILTER_CONFIG_OFFSETS.gyroLpf1DynMaxHz, generated.lpf1DynMaxHz, true);
    }
  }

  /**
   * MSP_CALCULATE_SIMPLIFIED_PID: the generator run against a TEMPORARY copy
   * of the profile, serialised as three axes of
   * `{u8 P, u8 I, u8 D, u8 dMax, u16 F}`. Nothing is stored - which is
   * exactly why a client must not treat this as applied state.
   */
  private calculateSimplifiedPid(payload: Uint8Array): Uint8Array {
    // `pidProfile_t tempPidProfile = *currentPidProfile;` then
    // `readSimplifiedPids(&tempPidProfile, src)` - the sliders come from the
    // REQUEST, not from what the board is storing.
    const inputs = payload.length >= SIMPLIFIED_PID_BLOCK_BYTES
      ? payload
      : this.state.pidProfiles[this.state.activePid].simplifiedPids;
    const mode = inputs[0] === 1 || inputs[0] === 2 ? (inputs[0] as 1 | 2) : 0;
    const generated = generateSimplifiedPids({
      mode,
      masterMultiplier: inputs[1],
      rollPitchRatio: inputs[2],
      iGain: inputs[3],
      dGain: inputs[4],
      piGain: inputs[5],
      dMaxGain: inputs[6],
      feedforwardGain: inputs[7],
      pitchPiGain: inputs[8],
    }, simplifiedDefaultsFor('API_1_47'));
    const bytes = new Uint8Array(18);
    const view = new DataView(bytes.buffer);
    generated.axes.forEach((axis, index) => {
      const base = index * 6;
      bytes[base] = axis.p;
      bytes[base + 1] = axis.i;
      bytes[base + 2] = axis.d;
      bytes[base + 3] = axis.dMax;
      view.setUint16(base + 4, axis.f, true);
      if (this.quirks.calculateOracle === 'DISAGREES') bytes[base] = (axis.p + 1) % 251;
    });
    return bytes;
  }

  /** The firmware's own opinion: PIDs, then GYRO, then DTERM. */
  private validateSimplified(): Uint8Array {
    const active = this.state.pidProfiles[this.state.activePid];
    const mode = active.simplifiedPids[0];
    const pidsValid = mode === 0 ? 1 : 1;
    return Uint8Array.from([
      pidsValid,
      this.state.globals.simplifiedGyro[0] === 0 ? 0 : 1,
      active.simplifiedDterm[0] === 0 ? 0 : 1,
    ]);
  }

  private copyProfile(payload: Uint8Array): void {
    const [type, destination, source] = [payload[0], payload[1], payload[2]];
    const slots = type === 1 ? RATE_PROFILE_SLOTS : PID_PROFILE_SLOTS;
    if (destination >= slots || source >= slots || destination === source) return;
    if (type === 1) {
      this.state.rateProfiles[destination] = cloneRate(this.state.rateProfiles[source]);
    } else {
      this.state.pidProfiles[destination] = cloneProfile(this.state.pidProfiles[source]);
      if (this.quirks.copyProfile === 'PARTIAL') {
        // A copy that acknowledged and left one field behind.
        this.state.pidProfiles[destination].advanced[PID_ADVANCED_OFFSETS.dMaxRoll] = 0;
      }
    }
    // No re-initialisation follows the memcpy in the firmware.
  }

  /**
   * `resetPidProfile(currentPidProfile)` is `RESET_CONFIG`, which memcpys a
   * static const template over the WHOLE struct - so the name and the
   * simplified sliders go back to their defaults too, not just the gains.
   */
  private resetCurrentPidProfile(): void {
    const fresh = firmwareResetPidProfile(this.filterBytes);
    if (this.quirks.resetProduces === 'SOMETHING_ELSE') fresh.pid[0] = 44;
    if (this.quirks.resetProduces === 'WRONG_LEVEL_ITEM') fresh.pid[9] = 33;
    this.state.pidProfiles[this.state.activePid] = fresh;
  }

  /**
   * `sbufWriteU8(dst, textType)` then `sbufWritePString(dst, textVar)`, so
   * the reply is TYPE, LENGTH, characters - the type byte is echoed back and
   * a reader that skips it would take the length for the type.
   */
  private getText(payload: Uint8Array): Uint8Array {
    const selector = payload[0];
    if (selector !== MSP2TEXT_PID_PROFILE_NAME && selector !== MSP2TEXT_RATE_PROFILE_NAME) {
      throw new VirtualPidError(MSP_ERROR, `unsupported text selector ${selector}`);
    }
    const name = selector === MSP2TEXT_RATE_PROFILE_NAME
      ? this.state.rateProfiles[this.state.activeRate].name
      : this.state.pidProfiles[this.state.activePid].name;
    const bytes = Array.from(name, character => character.charCodeAt(0));
    const echoed = this.quirks.textSelectorEcho === 'WRONG' ? selector + 1 : selector;
    return Uint8Array.from([echoed, bytes.length, ...bytes]);
  }

  /**
   * `textLength = MIN(textSpace, sbufReadU8(src))` - the firmware TRUNCATES
   * a name longer than eight characters and acknowledges it, so a client
   * that sent nine would be told everything was fine. Reproduced here so a
   * test can prove our encoder refuses before the wire rather than relying
   * on the board to notice.
   */
  private setText(payload: Uint8Array): void {
    const selector = payload[0];
    if (selector !== MSP2TEXT_PID_PROFILE_NAME && selector !== MSP2TEXT_RATE_PROFILE_NAME) {
      throw new VirtualPidError(MSP_ERROR, `unsupported text selector ${selector}`);
    }
    const capacity = this.quirks.profileNameCapacity ?? MAX_PROFILE_NAME_LENGTH;
    const length = Math.min(capacity, payload[1]);
    const name = String.fromCharCode(...Array.from(payload.subarray(2, 2 + length)));
    if (selector === MSP2TEXT_RATE_PROFILE_NAME) this.state.rateProfiles[this.state.activeRate].name = name;
    else this.state.pidProfiles[this.state.activePid].name = name;
  }
}
