/* eslint-disable no-bitwise -- this harness assembles and parses the same
 * packed words the firmware does. */
/**
 * A FLIGHT CONTROLLER'S LED BEHAVIOUR, MODELLED FROM THE FIRMWARE.
 *
 * This board answers the eight LED commands the way `src/main/msp/msp.c` and
 * `src/main/io/ledstrip.c` answer them at the pinned commits - NOT the way
 * this app's controller would find convenient.
 *
 * THE ONE BEHAVIOUR THAT MATTERS MOST is that the strip is re-counted after
 * EVERY accepted entry write, exactly as `reevaluateLedConfig()` runs at the
 * end of the firmware's own `MSP_SET_LED_STRIP_CONFIG` case. Deferring that
 * to the end of a save would make a write order that truncates the strip
 * mid-transaction look identical to one that never does, and proving the
 * difference is the entire reason this file exists. Every intermediate state
 * is recorded in `trace` so a test can assert on it rather than on the final
 * result alone.
 *
 * Response bytes are assembled here with a plain DataView. Nothing in this
 * file imports the app's encoders: a harness built out of the code under
 * test can only ever confirm that the code agrees with itself.
 *
 * Test-only.
 */

import type {MspRequestOptions} from '../../../../core/protocol/mspClient';
import type {MspFrame} from '../../../../core/protocol/mspTypes';

const MSP_LED_COLORS = 46;
const MSP_SET_LED_COLORS = 47;
const MSP_LED_STRIP_CONFIG = 48;
const MSP_SET_LED_STRIP_CONFIG = 49;
const MSP_EEPROM_WRITE = 250;
const MSP_REBOOT = 68;
const MSP_LED_STRIP_MODECOLOR = 127;
const MSP_SET_LED_STRIP_MODECOLOR = 221;
const MSP2_GET_LED_STRIP_CONFIG_VALUES = 0x3008;
const MSP2_SET_LED_STRIP_CONFIG_VALUES = 0x3009;

/** The client's own code for a genuine MSP error frame. */
const REMOTE_ERROR = 'MSP_REMOTE_ERROR';

export class VirtualLedMspError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VirtualLedMspError';
    this.code = code;
  }
}

export interface VirtualLedColor {
  readonly hue: number;
  readonly whiteness: number;
  readonly value: number;
}

export interface VirtualLedTuple {
  readonly mode: number;
  readonly slot: number;
  readonly value: number;
}

export type VirtualLedFaultKind =
  /** The board answers with an error frame - "I refuse" or "I do not know". */
  | {readonly kind: 'REMOTE_ERROR'}
  /** Nobody answers. The link, not the board. */
  | {readonly kind: 'TIMEOUT'}
  /** The link is gone for good. */
  | {readonly kind: 'SESSION_CLOSED'};

export interface VirtualLedFault {
  readonly command: number;
  readonly fault: VirtualLedFaultKind;
  /** 1-based. Omit to fault every occurrence. */
  readonly occurrence?: number;
  /** For entry writes: only fault the write aimed at this index. */
  readonly entryIndex?: number;
}

export interface VirtualLedBoardOptions {
  /** How many slots the board's array has. 32 and 64 are the firmware's own
   *  two branches; a target header may define any other value first, so this
   *  is free. */
  readonly maxLength: number;
  /** The trailing capability byte: 1 for a status-mode build, 0 for a strip
   *  the firmware can drive but not configure per LED. */
  readonly advancedRaw: number;
  readonly profile?: number;
  /** Raw words, wire order. Shorter arrays are zero-filled to maxLength. */
  readonly entries?: readonly number[];
  readonly palette?: readonly VirtualLedColor[];
  readonly modeColors?: readonly VirtualLedTuple[];
  readonly brightness?: number;
  readonly rainbowDelta?: number;
  readonly rainbowFreq?: number;
  /** Simulates a board built without `USE_LED_STRIP` at all. */
  readonly ledStripAbsent?: boolean;
}

/** What the board looked like immediately after one accepted entry write. */
export interface VirtualLedTraceStep {
  readonly index: number;
  readonly raw: number;
  readonly effectiveCount: number;
  readonly firstTerminator: number | undefined;
  readonly gapDetected: boolean;
}

function defaultPalette(): VirtualLedColor[] {
  /* Sixteen distinguishable slots. Deliberately NOT Betaflight's named
     defaults: those changed between 1.47 and 1.48, and a harness that
     hard-coded them would be asserting a firmware version rather than a
     protocol. */
  return Array.from({length: 16}, (_unused, slot) => ({
    hue: (slot * 21 + 3) % 360,
    whiteness: (slot * 11 + 7) & 0xff,
    value: (slot * 9 + 120) & 0xff,
  }));
}

function defaultModeColors(): VirtualLedTuple[] {
  const tuples: VirtualLedTuple[] = [];
  let n = 0;
  const next = (): number => (n++ * 3 + 2) % 16;
  for (let mode = 0; mode < 6; mode++) {
    for (let slot = 0; slot < 6; slot++) tuples.push({mode, slot, value: next()});
  }
  for (let slot = 0; slot < 11; slot++) tuples.push({mode: 6, slot, value: next()});
  tuples.push({mode: 7, slot: 0, value: 3});
  return tuples;
}

export class VirtualLedBoard {
  private ramEntries: number[];
  private eepromEntries: number[];
  private ramPalette: VirtualLedColor[];
  private eepromPalette: VirtualLedColor[];
  private ramTuples: VirtualLedTuple[];
  private eepromTuples: VirtualLedTuple[];
  private ramValues: {brightness: number; rainbowDelta: number; rainbowFreq: number};
  private eepromValues: {brightness: number; rainbowDelta: number; rainbowFreq: number};
  private epoch = 1;
  private reachable = true;
  private readonly faults: VirtualLedFault[] = [];
  private readonly seen = new Map<number, number>();

  readonly maxLength: number;
  readonly advancedRaw: number;
  readonly profile: number;
  readonly ledStripAbsent: boolean;

  /** Every command the board was asked, in order. */
  readonly requests: {command: number; payload: Uint8Array; epoch: number}[] = [];
  /** One entry per accepted LED write, with the state it produced. */
  readonly trace: VirtualLedTraceStep[] = [];
  readonly counts = {
    reads: 0,
    stripWrites: 0,
    paletteWrites: 0,
    modeColorWrites: 0,
    runtimeValueWrites: 0,
    eepromWrites: 0,
    reboots: 0,
  };

  constructor(options: VirtualLedBoardOptions) {
    this.maxLength = options.maxLength;
    this.advancedRaw = options.advancedRaw;
    this.profile = options.profile ?? 0;
    this.ledStripAbsent = options.ledStripAbsent ?? false;
    this.ramEntries = Array.from(
      {length: options.maxLength},
      (_unused, i) => options.entries?.[i] ?? 0,
    );
    this.ramPalette = [...(options.palette ?? defaultPalette())];
    this.ramTuples = [...(options.modeColors ?? defaultModeColors())];
    this.ramValues = {
      brightness: options.brightness ?? 50,
      rainbowDelta: options.rainbowDelta ?? 0,
      rainbowFreq: options.rainbowFreq ?? 120,
    };
    this.eepromEntries = [...this.ramEntries];
    this.eepromPalette = [...this.ramPalette];
    this.eepromTuples = [...this.ramTuples];
    this.eepromValues = {...this.ramValues};
  }

  /* ---------------- inspection, for assertions ---------------- */

  getEpoch(): number {
    return this.epoch;
  }

  readEntries(): readonly number[] {
    return [...this.ramEntries];
  }

  readPersistedEntries(): readonly number[] {
    return [...this.eepromEntries];
  }

  readPalette(): readonly VirtualLedColor[] {
    return this.ramPalette.map(color => ({...color}));
  }

  readTuples(): readonly VirtualLedTuple[] {
    return this.ramTuples.map(tuple => ({...tuple}));
  }

  readValues(): {brightness: number; rainbowDelta: number; rainbowFreq: number} {
    return {...this.ramValues};
  }

  /** How many LEDs the firmware would render right now. */
  effectiveCount(): number {
    let count = 0;
    for (const word of this.ramEntries) {
      if (word === 0) break;
      count += 1;
    }
    return count;
  }

  /** Every command id the board was asked, with how many times. */
  commandCounts(): ReadonlyMap<number, number> {
    const counts = new Map<number, number>();
    for (const record of this.requests) {
      counts.set(record.command, (counts.get(record.command) ?? 0) + 1);
    }
    return counts;
  }

  countOf(command: number): number {
    return this.commandCounts().get(command) ?? 0;
  }

  /* ---------------- scenario control ---------------- */

  injectFault(fault: VirtualLedFault): void {
    this.faults.push(fault);
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  detach(): void {
    this.reachable = false;
  }

  powerCycle(): void {
    this.ramEntries = [...this.eepromEntries];
    this.ramPalette = [...this.eepromPalette];
    this.ramTuples = [...this.eepromTuples];
    this.ramValues = {...this.eepromValues};
    this.epoch += 1;
    this.counts.reboots += 1;
  }

  /** An external actor changing the board underneath the app. */
  externallySetEntry(index: number, raw: number): void {
    this.ramEntries[index] = raw >>> 0;
  }

  externallySetPaletteSlot(slot: number, color: VirtualLedColor): void {
    this.ramPalette[slot] = {...color};
  }

  externallySetTuple(mode: number, slot: number, value: number): void {
    const found = this.ramTuples.findIndex(t => t.mode === mode && t.slot === slot);
    if (found >= 0) this.ramTuples[found] = {mode, slot, value};
  }

  externallySetValues(
    patch: Partial<{brightness: number; rainbowDelta: number; rainbowFreq: number}>,
  ): void {
    this.ramValues = {...this.ramValues, ...patch};
  }

  /* ---------------- the MSP surface ---------------- */

  async request(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    this.requests.push({command, payload: Uint8Array.from(payload), epoch: this.epoch});
    if (!this.reachable) {
      this.epoch += 1;
      throw new VirtualLedMspError('MSP_TIMEOUT', 'link detached');
    }

    const seen = (this.seen.get(command) ?? 0) + 1;
    this.seen.set(command, seen);
    const fault = this.faults.find(
      plan =>
        plan.command === command &&
        (plan.occurrence === undefined || plan.occurrence === seen) &&
        (plan.entryIndex === undefined || plan.entryIndex === payload[0]),
    );
    if (fault !== undefined) {
      switch (fault.fault.kind) {
        case 'REMOTE_ERROR':
          throw new VirtualLedMspError(REMOTE_ERROR, `board refused ${command}`);
        case 'TIMEOUT':
          this.epoch += 1;
          throw new VirtualLedMspError('MSP_TIMEOUT', `timeout on ${command}`);
        case 'SESSION_CLOSED':
          this.reachable = false;
          throw new VirtualLedMspError('MSP_SESSION_CLOSED', `session closed on ${command}`);
      }
    }

    if (this.ledStripAbsent && command !== MSP_EEPROM_WRITE && command !== MSP_REBOOT) {
      throw new VirtualLedMspError(REMOTE_ERROR, `no LED support for ${command}`);
    }

    switch (command) {
      case MSP_LED_STRIP_CONFIG:
        this.counts.reads += 1;
        return this.frame(command, this.stripPayload(), options);

      case MSP_SET_LED_STRIP_CONFIG:
        return this.applyEntryWrite(command, payload, options);

      case MSP_LED_COLORS:
        this.requireAdvanced(command);
        this.counts.reads += 1;
        return this.frame(command, this.palettePayload(), options);

      case MSP_SET_LED_COLORS:
        this.requireAdvanced(command);
        return this.applyPaletteWrite(command, payload, options);

      case MSP_LED_STRIP_MODECOLOR:
        this.requireAdvanced(command);
        this.counts.reads += 1;
        return this.frame(command, this.modeColorPayload(), options);

      case MSP_SET_LED_STRIP_MODECOLOR:
        this.requireAdvanced(command);
        return this.applyModeColorWrite(command, payload, options);

      case MSP2_GET_LED_STRIP_CONFIG_VALUES:
        this.counts.reads += 1;
        return this.frame(command, this.valuesPayload(), options);

      case MSP2_SET_LED_STRIP_CONFIG_VALUES:
        return this.applyValuesWrite(command, payload, options);

      case MSP_EEPROM_WRITE:
        this.eepromEntries = [...this.ramEntries];
        this.eepromPalette = [...this.ramPalette];
        this.eepromTuples = [...this.ramTuples];
        this.eepromValues = {...this.ramValues};
        this.counts.eepromWrites += 1;
        return this.frame(command, new Uint8Array(0), options);

      case MSP_REBOOT:
        this.powerCycle();
        return this.frame(command, new Uint8Array(0), options);

      default:
        throw new VirtualLedMspError(REMOTE_ERROR, `unsupported command ${command}`);
    }
  }

  /**
   * The palette and mode-colour commands live behind
   * `USE_LED_STRIP_STATUS_MODE`. On a board without it they are not empty -
   * they are not compiled, and the firmware answers an unknown command.
   */
  private requireAdvanced(command: number): void {
    if (this.advancedRaw !== 1) {
      throw new VirtualLedMspError(REMOTE_ERROR, `status mode absent for ${command}`);
    }
  }

  /**
   * `MSP_SET_LED_STRIP_CONFIG`, including the two guards the firmware
   * applies before it touches anything: the index must be inside the array
   * and the payload must be EXACTLY five bytes. The firmware's own
   * `dataSize != (1 + 4)` check is what makes its trailing profile branch
   * unreachable, so a six-byte frame is refused here too.
   */
  private applyEntryWrite(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): MspFrame {
    if (payload.length !== 5) {
      throw new VirtualLedMspError(REMOTE_ERROR, `bad SET_LED_STRIP_CONFIG length ${payload.length}`);
    }
    const index = payload[0];
    if (index >= this.maxLength) {
      throw new VirtualLedMspError(REMOTE_ERROR, `index ${index} beyond ${this.maxLength}`);
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const raw = view.getUint32(1, true);
    this.ramEntries[index] = raw >>> 0;
    this.counts.stripWrites += 1;
    /* reevaluateLedConfig(), immediately, exactly as the firmware does. */
    this.recordTrace(index, raw >>> 0);
    return this.frame(command, new Uint8Array(0), options);
  }

  private recordTrace(index: number, raw: number): void {
    let firstTerminator: number | undefined;
    for (let i = 0; i < this.ramEntries.length; i++) {
      if (this.ramEntries[i] === 0) {
        firstTerminator = i;
        break;
      }
    }
    const effectiveCount = firstTerminator ?? this.ramEntries.length;
    let gapDetected = false;
    for (let i = effectiveCount; i < this.ramEntries.length; i++) {
      if (this.ramEntries[i] !== 0) {
        gapDetected = true;
        break;
      }
    }
    this.trace.push(
      Object.freeze({index, raw, effectiveCount, firstTerminator, gapDetected}),
    );
  }

  private applyPaletteWrite(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): MspFrame {
    if (payload.length !== 64) {
      throw new VirtualLedMspError(REMOTE_ERROR, `bad SET_LED_COLORS length ${payload.length}`);
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const next: VirtualLedColor[] = [];
    for (let slot = 0; slot < 16; slot++) {
      const offset = slot * 4;
      next.push({
        hue: view.getUint16(offset, true),
        whiteness: payload[offset + 2],
        value: payload[offset + 3],
      });
    }
    this.ramPalette = next;
    this.counts.paletteWrites += 1;
    return this.frame(command, new Uint8Array(0), options);
  }

  /**
   * `setModeColor()`, including its per-tuple validation. The colour guard
   * sits ABOVE the mode branch in the firmware, so it applies to the aux
   * tuple too - a fact easy to get wrong in either direction.
   */
  private applyModeColorWrite(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): MspFrame {
    if (payload.length !== 3) {
      throw new VirtualLedMspError(REMOTE_ERROR, `bad SET_MODECOLOR length ${payload.length}`);
    }
    const [mode, slot, value] = payload;
    if (value >= 16) throw new VirtualLedMspError(REMOTE_ERROR, `colour ${value} out of range`);
    const valid =
      (mode < 6 && slot < 6) || (mode === 6 && slot < 11) || (mode === 7 && slot === 0);
    if (!valid) throw new VirtualLedMspError(REMOTE_ERROR, `bad tuple ${mode}/${slot}`);
    const found = this.ramTuples.findIndex(t => t.mode === mode && t.slot === slot);
    if (found < 0) throw new VirtualLedMspError(REMOTE_ERROR, `no tuple ${mode}/${slot}`);
    this.ramTuples[found] = {mode, slot, value};
    this.counts.modeColorWrites += 1;
    return this.frame(command, new Uint8Array(0), options);
  }

  /** The firmware assigns all three straight out of the buffer with no
   *  length guard at all; the length check here is the harness refusing to
   *  read past the frame, which the real thing would happily do. */
  private applyValuesWrite(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): MspFrame {
    if (payload.length !== 5) {
      throw new VirtualLedMspError(REMOTE_ERROR, `bad SET_VALUES length ${payload.length}`);
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    this.ramValues = {
      brightness: payload[0],
      rainbowDelta: view.getUint16(1, true),
      rainbowFreq: view.getUint16(3, true),
    };
    this.counts.runtimeValueWrites += 1;
    return this.frame(command, new Uint8Array(0), options);
  }

  /* ---------------- payload assembly ---------------- */

  private stripPayload(): Uint8Array {
    const bytes = new Uint8Array(this.maxLength * 4 + 2);
    const view = new DataView(bytes.buffer);
    this.ramEntries.forEach((word, i) => view.setUint32(i * 4, word >>> 0, true));
    bytes[this.maxLength * 4] = this.advancedRaw;
    bytes[this.maxLength * 4 + 1] = this.profile;
    return bytes;
  }

  private palettePayload(): Uint8Array {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    this.ramPalette.forEach((color, slot) => {
      const offset = slot * 4;
      view.setUint16(offset, color.hue, true);
      bytes[offset + 2] = color.whiteness;
      bytes[offset + 3] = color.value;
    });
    return bytes;
  }

  private modeColorPayload(): Uint8Array {
    const bytes = new Uint8Array(this.ramTuples.length * 3);
    this.ramTuples.forEach((tuple, i) => {
      bytes[i * 3] = tuple.mode;
      bytes[i * 3 + 1] = tuple.slot;
      bytes[i * 3 + 2] = tuple.value;
    });
    return bytes;
  }

  private valuesPayload(): Uint8Array {
    const bytes = new Uint8Array(5);
    const view = new DataView(bytes.buffer);
    bytes[0] = this.ramValues.brightness;
    view.setUint16(1, this.ramValues.rainbowDelta, true);
    view.setUint16(3, this.ramValues.rainbowFreq, true);
    return bytes;
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
}

/** Command ids re-declared for assertions, so a test can count them without
 *  importing the production module it is checking. */
export const LED_CMD = Object.freeze({
  STRIP_CONFIG: MSP_LED_STRIP_CONFIG,
  SET_STRIP_CONFIG: MSP_SET_LED_STRIP_CONFIG,
  COLORS: MSP_LED_COLORS,
  SET_COLORS: MSP_SET_LED_COLORS,
  MODECOLOR: MSP_LED_STRIP_MODECOLOR,
  SET_MODECOLOR: MSP_SET_LED_STRIP_MODECOLOR,
  GET_VALUES: MSP2_GET_LED_STRIP_CONFIG_VALUES,
  SET_VALUES: MSP2_SET_LED_STRIP_CONFIG_VALUES,
  EEPROM: MSP_EEPROM_WRITE,
  REBOOT: MSP_REBOOT,
});
