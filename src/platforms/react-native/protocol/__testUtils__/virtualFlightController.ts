/**
 * A VIRTUAL FLIGHT CONTROLLER - a parameter store with a lifecycle, not a
 * firmware emulator.
 *
 * ===================================================================
 * WHY THE EXISTING HARNESSES ARE NOT ENOUGH
 * ===================================================================
 *
 * `scriptedMotorFc` is a LOOKUP TABLE: command in, fixed reply out. It
 * makes a session lifecycle reachable, and its own header is right that
 * anything richer risks becoming "a second implementation of the firmware
 * for tests to disagree with".
 *
 * But a lookup table cannot answer the question this harness exists for:
 * *if the app writes a value, does the board then hold that value?* A
 * table answers the readback with whatever the fixture pre-baked, so a
 * controller that wrote complete garbage - or wrote nothing at all -
 * still reads back the "expected" bytes and the test goes green. Every
 * readback assertion built on a lookup table is therefore vacuous.
 *
 * This store answers reads from state that WRITES ACTUALLY MUTATED. That
 * is the whole difference, and it is what makes a five-drone end-to-end
 * acceptance test mean something.
 *
 * ===================================================================
 * WHERE THE LINE IS DRAWN, so this does not become a second firmware
 * ===================================================================
 *
 * MODELLED (because the app makes claims about them that must be tested):
 *   - a RAM copy and an EEPROM copy, and the difference between them
 *   - MSP_EEPROM_WRITE promoting RAM to EEPROM
 *   - MSP_REBOOT discarding unsaved RAM, reloading EEPROM, and bumping
 *     the epoch - which is how "the value did not survive the restart"
 *     becomes observable
 *   - ARMED / DISARMED, surfaced through MSP_STATUS_EX exactly as the
 *     firmware does
 *   - per-command fault injection: error frames, timeouts, silence
 *
 * NOT MODELLED (deliberately - the app makes no claims about these, and
 * inventing them would create a firmware to disagree with):
 *   - flight dynamics, PID behaviour, sensor fusion, arming *logic*
 *   - validateAndFixConfig()'s clamping and cross-field repair
 *   - any semantic meaning of a value beyond its bytes
 *
 * ===================================================================
 * HOW A WRITE BECOMES A READ, AND WHY THAT IS THE HARD PART
 * ===================================================================
 *
 * The store holds GET-frame bytes per command. A SET command has to be
 * folded into the GET buffer, and Betaflight's SET and GET layouts are
 * NOT always the same shape. Getting this wrong in the harness is the
 * single easiest way to build a test that lies, so every rule below
 * names the firmware handler it was read from.
 *
 *   OVERLAY - the SET payload is a byte-for-byte prefix of the GET
 *   payload, so writing it at offset 0 is exactly what the firmware
 *   does. Verified pair by pair against msp.c; see SYMMETRIC_PAIRS.
 *
 *   SPLICE - the GET carries a field the SET does not. MSP_MOTOR_CONFIG
 *   is the real example and it matters: GET emits
 *     u16 minthrottle | u16 maxthrottle | u16 mincommand |
 *     u8 MOTOR COUNT  | u8 poleCount    | u8 dshotTelemetry | u8 escSensor
 *   while SET reads
 *     u16 (discarded) | u16 maxthrottle | u16 mincommand |
 *     u8 poleCount    | u8 dshotTelemetry
 *   (msp.c MSP_MOTOR_CONFIG and MSP_SET_MOTOR_CONFIG). A naive overlay
 *   would drop poleCount into the motor-count slot and shift everything
 *   after it - and the readback would then "prove" a value the board
 *   never held.
 *
 *   INDEXED - the SET addresses one element by id and the GET returns
 *   the whole collection: MSP_SET_RXFAIL_CONFIG (channel), MSP_SET_
 *   MODE_RANGE (slot), MSP_SET_VTXTABLE_BAND / _POWERLEVEL (row),
 *   MSP_SET_VOLTAGE_METER_CONFIG / _CURRENT_METER_CONFIG (sensor id).
 *
 * ===================================================================
 * FAIL CLOSED, INCLUDING THE HARNESS ITSELF
 * ===================================================================
 *
 * A SET command with no rule here is REFUSED with an MSP error rather
 * than quietly accepted. An unmodelled write must surface as a failing
 * scenario that a human then resolves, never as a silent pass - the same
 * standard this project holds the application to.
 */

import {
  MSP2_COMMON_SERIAL_CONFIG,
  MSP2_COMMON_SET_SERIAL_CONFIG,
  MSP2_GET_TEXT,
  MSP2_SET_TEXT,
  MSP_ADVANCED_CONFIG,
  MSP_ARMING_CONFIG,
  MSP_BATTERY_CONFIG,
  MSP_BEEPER_CONFIG,
  MSP_BOARD_ALIGNMENT_CONFIG,
  MSP_BOXIDS,
  MSP_BOXNAMES,
  MSP_BUILD_INFO,
  MSP_CURRENT_METER_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_FAILSAFE_CONFIG,
  MSP_FEATURE_CONFIG,
  MSP_FILTER_CONFIG,
  MSP_GPS_CONFIG,
  MSP_GPS_RESCUE,
  MSP_MIXER_CONFIG,
  MSP_MODE_RANGES,
  MSP_MODE_RANGES_EXTRA,
  MSP_MOTOR_3D_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_OSD_CANVAS,
  MSP_OSD_CONFIG,
  MSP_PID,
  MSP_PID_ADVANCED,
  MSP_RC_DEADBAND,
  MSP_RC_TUNING,
  MSP_REBOOT,
  MSP_RSSI_CONFIG,
  MSP_RXFAIL_CONFIG,
  MSP_RX_CONFIG,
  MSP_RX_MAP,
  MSP_SELECT_SETTING,
  MSP_SET_ADVANCED_CONFIG,
  MSP_SET_ARMING_CONFIG,
  MSP_SET_BATTERY_CONFIG,
  MSP_SET_BEEPER_CONFIG,
  MSP_SET_BOARD_ALIGNMENT_CONFIG,
  MSP_SET_CURRENT_METER_CONFIG,
  MSP_SET_FAILSAFE_CONFIG,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_FILTER_CONFIG,
  MSP_SET_GPS_CONFIG,
  MSP_SET_GPS_RESCUE,
  MSP_SET_MIXER_CONFIG,
  MSP_SET_MODE_RANGE,
  MSP_SET_MOTOR_3D_CONFIG,
  MSP_SET_MOTOR_CONFIG,
  MSP_SET_OSD_CONFIG,
  MSP_SET_PID,
  MSP_SET_PID_ADVANCED,
  MSP_SET_RC_DEADBAND,
  MSP_SET_RC_TUNING,
  MSP_SET_RSSI_CONFIG,
  MSP_SET_RXFAIL_CONFIG,
  MSP_SET_RX_CONFIG,
  MSP_SET_RX_MAP,
  MSP_SET_VOLTAGE_METER_CONFIG,
  MSP_SET_VTXTABLE_BAND,
  MSP_SET_VTXTABLE_POWERLEVEL,
  MSP_SET_VTX_CONFIG,
  MSP_STATUS_EX,
  MSP_VOLTAGE_METER_CONFIG,
  MSP_VTXTABLE_BAND,
  MSP_VTXTABLE_POWERLEVEL,
  MSP_VTX_CONFIG,
} from '../../../../core/protocol/msp/commands/mspCommands';
import type {MspRequestOptions} from '../../../../core/protocol/mspClient';
import type {MspFrame} from '../../../../core/protocol/mspTypes';

/** A named MSP failure the app's own error taxonomy recognises. */
export type VirtualFault =
  | {readonly kind: 'ERROR_FRAME'}
  | {readonly kind: 'TIMEOUT'}
  | {readonly kind: 'REMOTE_ERROR'}
  | {readonly kind: 'TRUNCATE'; readonly bytes: number};

export interface VirtualFaultPlan {
  /** Command to disturb. */
  readonly command: number;
  readonly fault: VirtualFault;
  /** Disturb only the Nth matching request (1-based); every one if unset. */
  readonly occurrence?: number;
}

export interface VirtualFlightControllerOptions {
  /** GET-frame bytes per read command. This IS the board's parameter
   *  store; anything absent is a command this board does not answer. */
  readonly parameters: ReadonlyMap<number, Uint8Array>;
  readonly armed?: boolean;
  /** Permanent box ids, as MSP_BOXIDS would report them. */
  readonly boxIds?: readonly number[];
}

/** Every request the board saw, in order. The scenario assertions read
 *  this to prove ordering (armed proof before write, EEPROM after). */
export interface VirtualRequestRecord {
  readonly command: number;
  readonly payload: Uint8Array;
  readonly epoch: number;
}

const MSP_ERROR = 'MSP_REMOTE_ERROR';

function clone(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function cloneStore(
  store: ReadonlyMap<number, Uint8Array>,
): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  for (const [command, bytes] of store) out.set(command, clone(bytes));
  return out;
}

class VirtualMspError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VirtualMspError';
    this.code = code;
  }
}

/**
 * SET payloads that are a byte-for-byte prefix of their GET payload.
 *
 * Each entry was read from BOTH handlers in msp.c and the field order
 * compared term by term. They are listed rather than assumed because the
 * three exceptions below prove the assumption is not safe in general.
 */
const SYMMETRIC_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [MSP_SET_GPS_CONFIG, MSP_GPS_CONFIG], //          provider..useGalileo, 6B
  [MSP_SET_FAILSAFE_CONFIG, MSP_FAILSAFE_CONFIG], //delay..procedure, 8B
  [MSP_SET_ARMING_CONFIG, MSP_ARMING_CONFIG], //    autoDisarm,rsv,angle,cal
  [MSP_SET_BEEPER_CONFIG, MSP_BEEPER_CONFIG], //    offFlags u32, tone, u32
  [MSP_SET_MIXER_CONFIG, MSP_MIXER_CONFIG], //      mixerMode, yawReversed
  [MSP_SET_RSSI_CONFIG, MSP_RSSI_CONFIG], //        rssi_channel
  [MSP_SET_RC_DEADBAND, MSP_RC_DEADBAND], //        dz,yawDz,posDz,3dThr
  [MSP_SET_MOTOR_3D_CONFIG, MSP_MOTOR_3D_CONFIG], //low, high, neutral
  [MSP_SET_BATTERY_CONFIG, MSP_BATTERY_CONFIG], //  13B, same order
  [MSP_SET_FEATURE_CONFIG, MSP_FEATURE_CONFIG], //  mask u32
  [MSP_SET_ADVANCED_CONFIG, MSP_ADVANCED_CONFIG], //GET has a DEBUG_COUNT tail
  [MSP_SET_BOARD_ALIGNMENT_CONFIG, MSP_BOARD_ALIGNMENT_CONFIG], // 3x s16
  [MSP_SET_PID, MSP_PID],
  [MSP_SET_PID_ADVANCED, MSP_PID_ADVANCED],
  [MSP_SET_RC_TUNING, MSP_RC_TUNING],
  [MSP_SET_FILTER_CONFIG, MSP_FILTER_CONFIG],
  [MSP_SET_GPS_RESCUE, MSP_GPS_RESCUE],
  [MSP_SET_RX_MAP, MSP_RX_MAP],
  [MSP_SET_RX_CONFIG, MSP_RX_CONFIG],
  [MSP_SET_VTX_CONFIG, MSP_VTX_CONFIG],
  [MSP2_COMMON_SET_SERIAL_CONFIG, MSP2_COMMON_SERIAL_CONFIG],
];

export class VirtualFlightController {
  /** What the board is running on right now. */
  private ram: Map<number, Uint8Array>;
  /** What survives a restart. */
  private eeprom: Map<number, Uint8Array>;
  private epoch = 1;
  private armedState: boolean;
  private readonly boxIds: readonly number[];
  private readonly faults: VirtualFaultPlan[] = [];
  private readonly seen = new Map<number, number>();
  private reachable = true;
  readonly requests: VirtualRequestRecord[] = [];
  /** Counters the acceptance report quotes rather than estimates. */
  readonly counts = {reads: 0, writes: 0, eepromWrites: 0, reboots: 0};

  constructor(options: VirtualFlightControllerOptions) {
    this.ram = cloneStore(options.parameters);
    this.eeprom = cloneStore(options.parameters);
    this.armedState = options.armed === true;
    this.boxIds = options.boxIds ?? [0];
  }

  getEpoch(): number {
    return this.epoch;
  }

  setArmed(armed: boolean): void {
    this.armedState = armed;
  }

  /** Simulates the link going away without a reboot. */
  detach(): void {
    this.reachable = false;
  }

  reattach(): void {
    this.reachable = true;
  }

  injectFault(plan: VirtualFaultPlan): void {
    this.faults.push(plan);
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  /** The bytes the board would answer MSP <command> with right now. */
  readParameter(command: number): Uint8Array | undefined {
    const value = this.ram.get(command);
    return value === undefined ? undefined : clone(value);
  }

  /** The bytes that would survive a restart. */
  readPersisted(command: number): Uint8Array | undefined {
    const value = this.eeprom.get(command);
    return value === undefined ? undefined : clone(value);
  }

  /** True when every RAM value has been promoted to EEPROM. */
  hasUnsavedChanges(): boolean {
    for (const [command, bytes] of this.ram) {
      const saved = this.eeprom.get(command);
      if (saved === undefined || !bytesEqual(saved, bytes)) return true;
    }
    return false;
  }

  /**
   * A power cycle. Unsaved RAM is LOST - which is the only way a test can
   * tell "the app wrote it" apart from "the app persisted it" - and the
   * epoch moves, so any reply still in flight belongs to the old board.
   */
  powerCycle(): void {
    this.ram = cloneStore(this.eeprom);
    this.epoch += 1;
    this.counts.reboots += 1;
  }

  /**
   * A SECOND CONFIGURATOR changing this board while the app holds a
   * snapshot of it - a laptop on the same USB port, a Lua script, the CLI.
   *
   * Deliberately not routed through `request`, because the point is that it
   * happened WITHOUT this app's knowledge: the RAM moves and nothing in the
   * request log records it, which is exactly the situation the stale-base
   * re-read exists to catch.
   */
  overwriteParameter(command: number, bytes: Uint8Array): void {
    this.ram.set(command, clone(bytes));
  }

  /** Wipes the board back to a supplied defaults set, as a firmware flash
   *  followed by a factory reset would. */
  factoryReset(defaults: ReadonlyMap<number, Uint8Array>): void {
    this.eeprom = cloneStore(defaults);
    this.ram = cloneStore(defaults);
    this.epoch += 1;
  }

  async request(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    this.requests.push({command, payload: clone(payload), epoch: this.epoch});
    if (!this.reachable) {
      this.epoch += 1;
      throw new VirtualMspError('MSP_TIMEOUT', 'link detached');
    }

    const seen = (this.seen.get(command) ?? 0) + 1;
    this.seen.set(command, seen);
    const fault = this.faults.find(
      plan =>
        plan.command === command &&
        (plan.occurrence === undefined || plan.occurrence === seen),
    );
    if (fault !== undefined) {
      switch (fault.fault.kind) {
        case 'TIMEOUT':
          // A timeout is a link event: the real client bumps its epoch
          // when it recovers, so the guards must survive that here too.
          this.epoch += 1;
          throw new VirtualMspError('MSP_TIMEOUT', `timeout on ${command}`);
        case 'REMOTE_ERROR':
        case 'ERROR_FRAME':
          throw new VirtualMspError(MSP_ERROR, `board refused ${command}`);
        case 'TRUNCATE': {
          const full = this.ram.get(command) ?? new Uint8Array(0);
          return this.frame(command, full.slice(0, fault.fault.bytes), options);
        }
      }
    }

    if (command === MSP_EEPROM_WRITE) {
      this.eeprom = cloneStore(this.ram);
      this.counts.eepromWrites += 1;
      return this.frame(command, new Uint8Array(0), options);
    }
    if (command === MSP_REBOOT) {
      this.powerCycle();
      return this.frame(command, new Uint8Array(0), options);
    }
    if (command === MSP_SELECT_SETTING) {
      return this.frame(command, new Uint8Array(0), options);
    }
    if (command === MSP_STATUS_EX) {
      return this.frame(command, this.statusEx(), options);
    }
    if (command === MSP_BOXIDS) {
      return this.frame(command, Uint8Array.from(this.boxIds), options);
    }
    // Three reads name the record they want in the REQUEST payload rather
    // than returning a whole table, so the store is keyed per record.
    if (
      command === MSP_VTXTABLE_BAND ||
      command === MSP_VTXTABLE_POWERLEVEL ||
      command === MSP2_GET_TEXT
    ) {
      const row = this.ram.get(recordKey(command, payload[0]));
      if (row === undefined) {
        throw new VirtualMspError(
          MSP_ERROR,
          `no record ${payload[0]} for command ${command}`,
        );
      }
      this.counts.reads += 1;
      return this.frame(command, clone(row), options);
    }

    if (this.isWrite(command)) {
      this.counts.writes += 1;
      this.applyWrite(command, payload);
      return this.frame(command, new Uint8Array(0), options);
    }

    const stored = this.ram.get(command);
    if (stored === undefined) {
      // This board does not implement the command. Refusing is the
      // firmware's own behaviour and keeps the harness fail-closed.
      throw new VirtualMspError(MSP_ERROR, `unsupported command ${command}`);
    }
    this.counts.reads += 1;
    return this.frame(command, clone(stored), options);
  }

  private frame(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): MspFrame {
    return {
      protocolVersion: options.wireFormat === 'v1' ? 'v1' : 'v2',
      wireFormat: options.wireFormat,
      direction: 'response',
      command,
      flags: 0,
      payload,
    };
  }

  /** MSP_STATUS_EX, in the shape decodeStatusExDiagnostics reads: the
   *  arming flag lives in the flight-mode bitfield at offset 6.
   *
   *  THE LAST THREE BYTES ARE NOT DECORATION. Betaflight appends
   *  `cpuTemp` (u16, API 1.46) and `numberOfRateProfiles` (u8, API 1.47)
   *  to the end of this frame, and this decoder reads by LENGTH: a frame
   *  that stops early reports those fields as absent, which is correct
   *  for old firmware and wrong for the 1.47 board this fixture claims
   *  to be. Without them the rate-profile selector had no count, drew a
   *  dash, and rendered no options at all - so six real controls existed
   *  on no fixture anywhere. 6 is CONTROL_RATE_PROFILE_COUNT. */
  private statusEx(): Uint8Array {
    const bytes = Uint8Array.from([
      0, 0, 0, 0, 0, 0, this.armedState ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 29,
      0, 0, 0, 0, 0,
      /* cpuTemp: 32.5 C, little endian. */
      0x45, 0x01,
      /* numberOfRateProfiles. */
      6,
    ]);
    return bytes;
  }

  private isWrite(command: number): boolean {
    return WRITE_COMMANDS.has(command);
  }

  private applyWrite(command: number, payload: Uint8Array): void {
    const symmetric = SYMMETRIC_PAIRS.find(([set]) => set === command);
    if (symmetric !== undefined) {
      this.overlay(symmetric[1], payload);
      return;
    }
    switch (command) {
      case MSP_SET_MOTOR_CONFIG:
        this.spliceMotorConfig(payload);
        return;
      case MSP_SET_RXFAIL_CONFIG:
        this.applyIndexed(MSP_RXFAIL_CONFIG, payload, 1, 3);
        return;
      case MSP_SET_MODE_RANGE:
        this.applyModeRange(payload);
        return;
      case MSP_SET_VTXTABLE_BAND:
        this.applyRow(MSP_VTXTABLE_BAND, payload);
        return;
      case MSP_SET_VTXTABLE_POWERLEVEL:
        this.applyRow(MSP_VTXTABLE_POWERLEVEL, payload);
        return;
      case MSP_SET_VOLTAGE_METER_CONFIG:
        this.applyVoltageMeter(payload);
        return;
      case MSP_SET_CURRENT_METER_CONFIG:
        this.applyCurrentMeter(payload);
        return;
      case MSP_SET_OSD_CONFIG:
        this.applyOsd(payload);
        return;
      case MSP2_SET_TEXT:
        this.applyText(payload);
        return;
      default:
        throw new VirtualMspError(
          MSP_ERROR,
          `virtual FC has no verified write rule for command ${command}; ` +
            'refusing rather than pretending the board accepted it',
        );
    }
  }

  private overlay(readCommand: number, payload: Uint8Array): void {
    const current = this.ram.get(readCommand);
    if (current === undefined) {
      this.ram.set(readCommand, clone(payload));
      return;
    }
    if (payload.length >= current.length) {
      this.ram.set(readCommand, clone(payload));
      return;
    }
    const next = clone(current);
    next.set(payload, 0);
    this.ram.set(readCommand, next);
  }

  /**
   * MSP_MOTOR_CONFIG. GET carries a motor COUNT byte at offset 6 that the
   * SET payload does not, so the two tails do not line up.
   * (msp.c: MSP_MOTOR_CONFIG vs MSP_SET_MOTOR_CONFIG.)
   */
  private spliceMotorConfig(payload: Uint8Array): void {
    const current = this.ram.get(MSP_MOTOR_CONFIG);
    if (current === undefined || current.length < 9) {
      throw new VirtualMspError(MSP_ERROR, 'motor config not present');
    }
    const next = clone(current);
    next.set(payload.slice(0, 6), 0); // minthrottle, maxthrottle, mincommand
    if (payload.length >= 7) next[7] = payload[6]; // poleCount, past count
    if (payload.length >= 8) next[8] = payload[7]; // dshot telemetry
    this.ram.set(MSP_MOTOR_CONFIG, next);
  }

  /**
   * An indexed SET whose GET is the concatenation of fixed-size records.
   * The first payload byte is the record index; `recordBytes` of payload
   * follow it and replace that record in place. MSP_SET_RXFAIL_CONFIG is
   * the case this was written for (msp.c reads `i` then mode+step).
   */
  private applyIndexed(
    readCommand: number,
    payload: Uint8Array,
    indexBytes: number,
    recordBytes: number,
  ): void {
    const current = this.ram.get(readCommand);
    if (current === undefined) {
      throw new VirtualMspError(MSP_ERROR, `no record set for ${readCommand}`);
    }
    const index = payload[0];
    const offset = index * recordBytes;
    if (offset + recordBytes > current.length) {
      throw new VirtualMspError(MSP_ERROR, `record ${index} out of range`);
    }
    const next = clone(current);
    next.set(payload.slice(indexBytes, indexBytes + recordBytes), offset);
    this.ram.set(readCommand, next);
  }

  /** MSP_SET_MODE_RANGE: index, then boxId, auxChannel, start, end. The
   *  GET returns 4 bytes per slot with no index. */
  private applyModeRange(payload: Uint8Array): void {
    this.applyIndexed(MSP_MODE_RANGES, payload, 1, 4);
    // MODE_RANGES_EXTRA carries the linked-mode fields for the same slot
    // and is left alone: the app does not write it, so a harness that
    // invented a value here would be inventing a capability.
  }

  /** A VTX table row: first byte is the 1-based row number. The SET frame
   *  IS the GET frame for these, so the row is stored verbatim. */
  private applyRow(readCommand: number, payload: Uint8Array): void {
    this.ram.set(recordKey(readCommand, payload[0]), clone(payload));
  }

  /** MSP_SET_VOLTAGE_METER_CONFIG: sensor id, then scale/divider/mult.
   *  GET is [count, (subframeLen, id, type, scale, div, mult) x count]. */
  private applyVoltageMeter(payload: Uint8Array): void {
    const current = this.ram.get(MSP_VOLTAGE_METER_CONFIG);
    if (current === undefined) {
      throw new VirtualMspError(MSP_ERROR, 'no voltage meter config');
    }
    const next = clone(current);
    const id = payload[0];
    let offset = 1;
    while (offset + 6 <= next.length) {
      if (next[offset + 1] === id) {
        next[offset + 3] = payload[1];
        next[offset + 4] = payload[2];
        next[offset + 5] = payload[3];
        this.ram.set(MSP_VOLTAGE_METER_CONFIG, next);
        return;
      }
      offset += 1 + next[offset];
    }
    throw new VirtualMspError(MSP_ERROR, `unknown voltage sensor ${id}`);
  }

  /** MSP_SET_CURRENT_METER_CONFIG: sensor id, scale u16, offset u16. */
  private applyCurrentMeter(payload: Uint8Array): void {
    const current = this.ram.get(MSP_CURRENT_METER_CONFIG);
    if (current === undefined) {
      throw new VirtualMspError(MSP_ERROR, 'no current meter config');
    }
    const next = clone(current);
    const id = payload[0];
    let offset = 1;
    while (offset + 6 <= next.length) {
      if (next[offset + 1] === id) {
        next.set(payload.slice(1, 5), offset + 3);
        this.ram.set(MSP_CURRENT_METER_CONFIG, next);
        return;
      }
      offset += 1 + next[offset];
    }
    throw new VirtualMspError(MSP_ERROR, `unknown current sensor ${id}`);
  }

  /**
   * MSP_SET_OSD_CONFIG, with the firmware's own four-way discriminator
   * (msp.c MSP_SET_OSD_CONFIG):
   *
   *   addr 0xFF  the general settings block
   *   addr 0xFE  index u8 + value u16, a timer
   *   otherwise  value u16, then a SCREEN byte - 0 selects the statistic
   *              with that index, anything else (the app sends 1) selects
   *              the element position with that index
   *
   * The element/statistic pair matters: both frames are four bytes and
   * both start with the index, so the ONLY thing separating "move the
   * altitude readout" from "turn off a post-flight stat" is that fourth
   * byte. A harness that ignored it would accept either write as the
   * other and never notice the app confusing them.
   */
  private applyOsd(payload: Uint8Array): void {
    const current = this.ram.get(MSP_OSD_CONFIG);
    if (current === undefined) {
      throw new VirtualMspError(MSP_ERROR, 'no OSD config');
    }
    const layout = readOsdLayout(current);
    const next = clone(current);
    const view = new DataView(next.buffer);
    const addr = payload[0];

    if (addr === 0xff) {
      // The general fields are NOT contiguous in the GET frame - the
      // element, statistic and timer tables sit between them - so each
      // one is placed at its own offset rather than blitted as a block.
      const set = new DataView(payload.buffer, payload.byteOffset);
      next[1] = payload[1]; // videoSystem
      next[2] = payload[2]; // units
      next[3] = payload[3]; // rssiAlarmPercent
      view.setUint16(4, set.getUint16(4, true), true); // capacityAlarmMah
      view.setUint16(8, set.getUint16(8, true), true); // altitudeAlarm
      view.setUint16(layout.obsoleteWarning, set.getUint16(10, true), true);
      view.setUint32(layout.enabledWarnings, set.getUint32(12, true), true);
      next[layout.selectedProfile] = payload[16];
      next[layout.selectedProfile + 1] = payload[17]; // overlayRadioMode
      next[layout.selectedProfile + 2] = payload[18]; // cameraFrameWidth
      next[layout.selectedProfile + 3] = payload[19]; // cameraFrameHeight
      view.setUint16(layout.linkQuality, set.getUint16(20, true), true);
      view.setInt16(layout.rssiDbm, set.getInt16(22, true), true);
      this.ram.set(MSP_OSD_CONFIG, next);
      return;
    }

    if (addr === 0xfe) {
      const index = payload[1];
      if (index >= layout.timerCount) {
        throw new VirtualMspError(MSP_ERROR, `OSD timer ${index} absent`);
      }
      const set = new DataView(payload.buffer, payload.byteOffset);
      view.setUint16(layout.timers + index * 2, set.getUint16(2, true), true);
      this.ram.set(MSP_OSD_CONFIG, next);
      return;
    }

    const set = new DataView(payload.buffer, payload.byteOffset);
    const value = set.getUint16(1, true);
    const screen = payload.length >= 4 ? payload[3] : 1;
    if (screen === 0) {
      if (addr >= layout.statisticCount) {
        throw new VirtualMspError(MSP_ERROR, `OSD statistic ${addr} absent`);
      }
      next[layout.statistics + addr] = value !== 0 ? 1 : 0;
    } else {
      if (addr >= layout.elementCount) {
        throw new VirtualMspError(MSP_ERROR, `OSD element ${addr} absent`);
      }
      view.setUint16(layout.elements + addr * 2, value, true);
    }
    this.ram.set(MSP_OSD_CONFIG, next);
  }

  /** MSP2_SET_TEXT: type, length, bytes - the same shape MSP2_GET_TEXT
   *  answers with, so it is stored as the reply for that type. */
  private applyText(payload: Uint8Array): void {
    this.ram.set(recordKey(MSP2_GET_TEXT, payload[0]), clone(payload));
  }
}

/**
 * A synthetic store key for a command whose records are addressed by an
 * index in the REQUEST rather than returned as one table. Kept far above
 * any real MSP command number so it can never collide with one.
 */
export function recordKey(command: number, index: number): number {
  return 1_000_000 + command * 1000 + index;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Where each field sits inside a MSP_OSD_CONFIG GET frame.
 *
 * The frame is self-describing: the element, statistic and timer tables
 * each declare their own length, so every field after them moves with
 * the board's build. The offsets are therefore READ from the frame, in
 * the same order decodeOsdConfiguration reads them, rather than hardcoded
 * for one firmware.
 */
interface OsdLayout {
  readonly elementCount: number;
  readonly elements: number;
  readonly statisticCount: number;
  readonly statistics: number;
  readonly timerCount: number;
  readonly timers: number;
  readonly obsoleteWarning: number;
  readonly enabledWarnings: number;
  readonly selectedProfile: number;
  readonly linkQuality: number;
  readonly rssiDbm: number;
}

function readOsdLayout(frame: Uint8Array): OsdLayout {
  const elementCount = frame[7];
  const elements = 10;
  let offset = elements + elementCount * 2;
  const statisticCount = frame[offset];
  const statistics = offset + 1;
  offset = statistics + statisticCount;
  const timerCount = frame[offset];
  const timers = offset + 1;
  offset = timers + timerCount * 2;
  const obsoleteWarning = offset;
  offset += 2;
  offset += 1; // warningCount
  const enabledWarnings = offset;
  offset += 4;
  offset += 1; // profileCount
  const selectedProfile = offset;
  offset += 4; // selectedProfile, overlayRadioMode, cameraFrameWidth/Height
  const linkQuality = offset;
  const rssiDbm = offset + 2;
  return {
    elementCount,
    elements,
    statisticCount,
    statistics,
    timerCount,
    timers,
    obsoleteWarning,
    enabledWarnings,
    selectedProfile,
    linkQuality,
    rssiDbm,
  };
}

const WRITE_COMMANDS: ReadonlySet<number> = new Set([
  ...SYMMETRIC_PAIRS.map(([set]) => set),
  MSP_SET_MOTOR_CONFIG,
  MSP_SET_RXFAIL_CONFIG,
  MSP_SET_MODE_RANGE,
  MSP_SET_VTXTABLE_BAND,
  MSP_SET_VTXTABLE_POWERLEVEL,
  MSP_SET_VOLTAGE_METER_CONFIG,
  MSP_SET_CURRENT_METER_CONFIG,
  MSP_SET_OSD_CONFIG,
  MSP2_SET_TEXT,
]);

/** Read commands a scenario may seed. Exported so a fixture cannot
 *  silently misname one. */
export const VIRTUAL_READ_COMMANDS = {
  MSP_BUILD_INFO,
  MSP_FEATURE_CONFIG,
  MSP_GPS_CONFIG,
  MSP_GPS_RESCUE,
  MSP_FAILSAFE_CONFIG,
  MSP_RXFAIL_CONFIG,
  MSP_RX_CONFIG,
  MSP_RX_MAP,
  MSP_RSSI_CONFIG,
  MSP_RC_DEADBAND,
  MSP_BATTERY_CONFIG,
  MSP_VOLTAGE_METER_CONFIG,
  MSP_CURRENT_METER_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_MOTOR_3D_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_ADVANCED_CONFIG,
  MSP_ARMING_CONFIG,
  MSP_BEEPER_CONFIG,
  MSP_BOARD_ALIGNMENT_CONFIG,
  MSP_PID,
  MSP_PID_ADVANCED,
  MSP_RC_TUNING,
  MSP_FILTER_CONFIG,
  MSP_MODE_RANGES,
  MSP_MODE_RANGES_EXTRA,
  MSP_BOXNAMES,
  MSP_OSD_CONFIG,
  MSP_OSD_CANVAS,
  MSP_VTX_CONFIG,
  MSP_VTXTABLE_BAND,
  MSP_VTXTABLE_POWERLEVEL,
  MSP2_COMMON_SERIAL_CONFIG,
} as const;
