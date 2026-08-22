/**
 * A VIRTUAL FLIGHT CONTROLLER THAT ANSWERS THE SENSOR COMMANDS.
 *
 * Shared by the two Sensors production-path suites so the save tests and
 * the calibration tests drive the SAME board, rather than two boards that
 * could drift apart and quietly stop testing the same thing.
 *
 * It speaks real MSP over the real MspSessionCoordinator: only the USB
 * device is fake. Both wire formats are parsed, because the two MSP2
 * sensor commands genuinely travel as v2 and a harness that only understood
 * v1 would silently never see them.
 *
 * Every frame it emits was written by hand from the API-1.47 serializers,
 * never by running our own encoders.
 */

import {buildMspFrameBytes} from '../../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from '../base64';
import type {UsbSerialDataEvent, UsbSerialTransportClient} from '../../transport';

export const MSP_API_VERSION = 1;
export const MSP_FC_VARIANT = 2;
export const MSP_BOARD_INFO = 4;
export const MSP_BOXIDS = 119;
export const MSP_SENSOR_CONFIG = 96;
export const MSP_SET_SENSOR_CONFIG = 97;
export const MSP_SENSOR_ALIGNMENT = 126;
export const MSP_SET_SENSOR_ALIGNMENT = 220;
export const MSP_COMPASS_CONFIG = 133;
export const MSP_SET_COMPASS_CONFIG = 224;
export const MSP_SET_ACC_TRIM = 239;
export const MSP_ACC_TRIM = 240;
export const MSP_STATUS_EX = 150;
export const MSP_EEPROM_WRITE = 250;
export const MSP_ACC_CALIBRATION = 205;
export const MSP_MAG_CALIBRATION = 206;
export const MSP2_SENSOR_CONFIG_ACTIVE = 0x300a;
export const MSP2_GYRO_SENSOR_ACTIVE = 0x300d;
/** Never answered, never expected - the negative proof that Sensors does
 *  not reach for the board's mounting angles. */
export const MSP_BOARD_ALIGNMENT_CONFIG = 38;
export const MSP_SET_BOARD_ALIGNMENT_CONFIG = 39;

export const CALIBRATING_BIT = 12;
export const ACC_CALIBRATION_BIT = 23;

const b = (...values: number[]): Uint8Array => Uint8Array.from(values);

/* ------------------------------------------------------------------ *
 * HAND-WRITTEN FRAMES
 * ------------------------------------------------------------------ */

/**
 * MSP_STATUS_EX, with the full API-1.47 tail.
 *
 *   u16 cycle · u16 i2c · u16 sensorMask · u32 flightModeFlags ·
 *   u8 pidProfile · u16 cpuLoad · u8 pidProfileCount ·
 *   u8 rateProfileIndex · u8 extBytes(0) · u8 blockerCount ·
 *   u32 armingDisableFlags · u8 configState · u16 cpuTemp ·
 *   u8 rateProfileCount
 */
export function statusExFrame(options: {
  sensorMask: number;
  armingDisableFlags: number;
  flightModeFlagsLow32?: number;
}): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1000, true); // cycle time
  view.setUint16(2, 0, true); // i2c errors
  view.setUint16(4, options.sensorMask, true);
  view.setUint32(6, options.flightModeFlagsLow32 ?? 0, true);
  view.setUint8(10, 0); // pid profile index
  view.setUint16(11, 10, true); // cpu load
  view.setUint8(13, 3); // pid profile count
  view.setUint8(14, 0); // control rate profile index
  view.setUint8(15, 0); // no flight-mode extension bytes
  view.setUint8(16, 29); // ARMING_DISABLE_FLAGS_COUNT
  view.setUint32(17, options.armingDisableFlags, true);
  view.setUint8(21, 0); // config state: no reboot required
  view.setUint16(22, 250, true); // core temp, deci-celsius
  return bytes.slice(0, 24);
}

/** MSP_SENSOR_ALIGNMENT (126), eleven bytes. */
export function alignmentFrame(options: {
  gyroAlign: number;
  accAlign?: number;
  magAlign: number;
  detectedFlags: number;
  enabledMask: number;
  roll: number;
  pitch: number;
  yaw: number;
}): Uint8Array {
  const bytes = new Uint8Array(11);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, options.gyroAlign);
  view.setUint8(1, options.accAlign ?? options.gyroAlign);
  view.setUint8(2, options.magAlign);
  view.setUint8(3, options.detectedFlags);
  view.setUint8(4, options.enabledMask);
  view.setInt16(5, options.roll, true);
  view.setInt16(7, options.pitch, true);
  view.setInt16(9, options.yaw, true);
  return bytes;
}

/** MSP_ACC_TRIM (240): pitch first, roll second, both signed. */
export function accTrimFrame(pitch: number, roll: number): Uint8Array {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, pitch, true);
  view.setInt16(2, roll, true);
  return bytes;
}

/** MSP_COMPASS_CONFIG (133): one signed value, tenths of a degree. */
export function compassFrame(decidegrees: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setInt16(0, decidegrees, true);
  return bytes;
}

/* ------------------------------------------------------------------ *
 * THE BOARD
 * ------------------------------------------------------------------ */

export interface SensorsFcBehaviour {
  /** How many bytes MSP_SENSOR_CONFIG answers with: 3, 4 or 5. */
  readonly sensorConfigWidth?: 3 | 4 | 5;
  readonly acc?: number;
  readonly baro?: number;
  readonly mag?: number;
  readonly rangefinder?: number;
  readonly opticalflow?: number;
  /** Consume MSP_SET_SENSOR_CONFIG and change nothing, replying normally. */
  readonly silentlyRejectSensorConfigWrite?: boolean;
  /** Consume MSP_SET_SENSOR_ALIGNMENT and change nothing. */
  readonly silentlyRejectAlignmentWrite?: boolean;
  /** Forget everything again the moment EEPROM is written. */
  readonly loseValueOnEepromWrite?: boolean;

  readonly gyroAlign?: number;
  readonly magAlign?: number;
  readonly detectedFlags?: number;
  readonly enabledMask?: number;
  readonly customRoll?: number;
  readonly customPitch?: number;
  readonly customYaw?: number;

  readonly accTrimPitch?: number;
  readonly accTrimRoll?: number;
  readonly declinationDecidegrees?: number;

  /** Answer MSP2_SENSOR_CONFIG_ACTIVE / MSP2_GYRO_SENSOR_ACTIVE with an
   *  MSP error, the way a build without them does. */
  readonly noMsp2SensorCommands?: boolean;
  /** Likewise for MSP_ACC_TRIM and MSP_COMPASS_CONFIG on a build compiled
   *  without an accelerometer or magnetometer. */
  readonly noAccTrimCommand?: boolean;
  readonly noCompassCommand?: boolean;

  readonly sensorMask?: number;
  readonly detectedGyro?: number;
  readonly detectedAcc?: number;
  readonly detectedBaro?: number;
  readonly detectedMag?: number;
  readonly detectedRangefinder?: number;
  readonly detectedOpticalflow?: number;
  readonly gyroSlots?: readonly number[];

  /** Starting arming-disable mask. */
  readonly armingDisableFlags?: number;
  /** Packed flight-mode bits; with a BOXIDS reply of [0], bit 0 is ARM. */
  readonly flightModeFlagsLow32?: number;
  /** Answer MSP_BOXIDS with an error, so the armed state cannot resolve. */
  readonly noBoxIds?: boolean;
}

export class VirtualSensorsFc {
  readonly requested: number[] = [];
  readonly writes: {command: number; payload: number[]}[] = [];
  private readonly listeners = new Set<(e: UsbSerialDataEvent) => void>();

  private acc: number;
  private baro: number;
  private mag: number;
  private rangefinder: number;
  private opticalflow: number;
  private readonly width: 3 | 4 | 5;

  private gyroAlign: number;
  private magAlign: number;
  private detectedFlags: number;
  private enabledMask: number;
  private customRoll: number;
  private customPitch: number;
  private customYaw: number;

  private accTrimPitch: number;
  private accTrimRoll: number;
  private declination: number;

  private armingDisableFlags: number;

  /** Set to make every later request behave as a dead link. */
  silent = false;
  /** Replaces the arming mask on each STATUS_EX, one entry per request. */
  readonly scriptedArmingFlags: number[] = [];

  constructor(
    readonly sessionId: string,
    private readonly behaviour: SensorsFcBehaviour = {},
  ) {
    this.width = behaviour.sensorConfigWidth ?? 5;
    this.acc = behaviour.acc ?? 0;
    this.baro = behaviour.baro ?? 0;
    this.mag = behaviour.mag ?? 1;
    this.rangefinder = behaviour.rangefinder ?? 0;
    this.opticalflow = behaviour.opticalflow ?? 0;
    this.gyroAlign = behaviour.gyroAlign ?? 2;
    this.magAlign = behaviour.magAlign ?? 1;
    this.detectedFlags = behaviour.detectedFlags ?? 0b01;
    this.enabledMask = behaviour.enabledMask ?? 0b01;
    this.customRoll = behaviour.customRoll ?? 0;
    this.customPitch = behaviour.customPitch ?? 0;
    this.customYaw = behaviour.customYaw ?? 0;
    this.accTrimPitch = behaviour.accTrimPitch ?? 0;
    this.accTrimRoll = behaviour.accTrimRoll ?? 0;
    this.declination = behaviour.declinationDecidegrees ?? 0;
    this.armingDisableFlags = behaviour.armingDisableFlags ?? 0;
  }

  /* --- state the tests drive or inspect --- */

  setArmingDisableFlags(mask: number): void {
    this.armingDisableFlags = mask;
  }
  getArmingDisableFlags(): number {
    return this.armingDisableFlags;
  }
  setEnabledMask(mask: number): void {
    this.enabledMask = mask;
  }
  setDetectedFlags(mask: number): void {
    this.detectedFlags = mask;
  }
  setCustomAngles(roll: number, pitch: number, yaw: number): void {
    this.customRoll = roll;
    this.customPitch = pitch;
    this.customYaw = yaw;
  }
  setBaro(raw: number): void {
    this.baro = raw;
  }
  configuredHardware(): {
    acc: number;
    baro: number;
    mag: number;
    rangefinder: number;
    opticalflow: number;
  } {
    return {
      acc: this.acc,
      baro: this.baro,
      mag: this.mag,
      rangefinder: this.rangefinder,
      opticalflow: this.opticalflow,
    };
  }
  alignmentState(): {
    magAlign: number;
    enabledMask: number;
    roll: number;
    pitch: number;
    yaw: number;
  } {
    return {
      magAlign: this.magAlign,
      enabledMask: this.enabledMask,
      roll: this.customRoll,
      pitch: this.customPitch,
      yaw: this.customYaw,
    };
  }
  accTrimState(): {pitch: number; roll: number} {
    return {pitch: this.accTrimPitch, roll: this.accTrimRoll};
  }
  declinationState(): number {
    return this.declination;
  }
  payloadsFor(command: number): number[][] {
    return this.writes
      .filter(entry => entry.command === command)
      .map(entry => entry.payload);
  }

  /* --- the wire --- */

  private sensorConfigPayload(): Uint8Array {
    const all = [this.acc, this.baro, this.mag, this.rangefinder, this.opticalflow];
    return Uint8Array.from(all.slice(0, this.width));
  }

  private reply(
    command: number,
    payload: Uint8Array,
    wireFormat: 'v1' | 'v2',
    direction: 'response' | 'error' = 'response',
  ): void {
    const frame = buildMspFrameBytes(command, payload, {wireFormat, direction});
    Promise.resolve().then(() => {
      for (const listener of Array.from(this.listeners)) {
        listener({sessionId: this.sessionId, dataBase64: bytesToBase64(frame)});
      }
    });
  }

  private handle(
    command: number,
    payload: Uint8Array,
  ): {payload: Uint8Array; error?: true} | undefined {
    const ok = (p: Uint8Array) => ({payload: p});
    const unknown = () => ({payload: new Uint8Array(0), error: true as const});
    switch (command) {
      case MSP_API_VERSION:
        return ok(b(0, 1, 47));
      case MSP_FC_VARIANT:
        return ok(b(66, 84, 70, 76));
      case MSP_BOARD_INFO:
        return ok(
          b(
            83, 80, 66, 69, 0, 0, 0, 0,
            4, 83, 52, 48, 53,
            4, 83, 52, 48, 53,
            4, 83, 80, 66, 69,
            ...new Array(32).fill(0), 0,
          ),
        );
      case MSP_BOXIDS:
        // BOXARM's permanent id is 0, so index 0 is the ARM bit.
        return this.behaviour.noBoxIds === true ? unknown() : ok(b(0, 1, 2));
      case MSP_SENSOR_CONFIG:
        return ok(this.sensorConfigPayload());
      case MSP_SET_SENSOR_CONFIG: {
        if (this.behaviour.silentlyRejectSensorConfigWrite !== true) {
          // Exactly the firmware's own guarded reads: three unconditional,
          // then one more per byte that actually arrived.
          this.acc = payload[0];
          this.baro = payload[1];
          this.mag = payload[2];
          if (payload.length >= 4) this.rangefinder = payload[3];
          if (payload.length >= 5) this.opticalflow = payload[4];
        }
        return ok(new Uint8Array(0));
      }
      case MSP_SENSOR_ALIGNMENT:
        return ok(
          alignmentFrame({
            gyroAlign: this.gyroAlign,
            magAlign: this.magAlign,
            detectedFlags: this.detectedFlags,
            enabledMask: this.enabledMask,
            roll: this.customRoll,
            pitch: this.customPitch,
            yaw: this.customYaw,
          }),
        );
      case MSP_SET_SENSOR_ALIGNMENT: {
        if (this.behaviour.silentlyRejectAlignmentWrite !== true) {
          // Bytes 0 and 1 are read and discarded, exactly as msp.c does.
          this.magAlign = payload[2];
          this.enabledMask = payload[3];
          if (payload.length >= 10) {
            const view = new DataView(
              payload.buffer,
              payload.byteOffset,
              payload.byteLength,
            );
            this.customRoll = view.getInt16(4, true);
            this.customPitch = view.getInt16(6, true);
            this.customYaw = view.getInt16(8, true);
          }
        }
        return ok(new Uint8Array(0));
      }
      case MSP_ACC_TRIM:
        return this.behaviour.noAccTrimCommand === true
          ? unknown()
          : ok(accTrimFrame(this.accTrimPitch, this.accTrimRoll));
      case MSP_SET_ACC_TRIM: {
        const view = new DataView(
          payload.buffer,
          payload.byteOffset,
          payload.byteLength,
        );
        this.accTrimPitch = view.getInt16(0, true);
        this.accTrimRoll = view.getInt16(2, true);
        return ok(new Uint8Array(0));
      }
      case MSP_COMPASS_CONFIG:
        return this.behaviour.noCompassCommand === true
          ? unknown()
          : ok(compassFrame(this.declination));
      case MSP_SET_COMPASS_CONFIG: {
        const view = new DataView(
          payload.buffer,
          payload.byteOffset,
          payload.byteLength,
        );
        this.declination = view.getInt16(0, true);
        return ok(new Uint8Array(0));
      }
      case MSP2_SENSOR_CONFIG_ACTIVE:
        return this.behaviour.noMsp2SensorCommands === true
          ? unknown()
          : ok(
              b(
                this.behaviour.detectedGyro ?? 13,
                this.behaviour.detectedAcc ?? 12,
                this.behaviour.detectedBaro ?? 8,
                this.behaviour.detectedMag ?? 1,
                this.behaviour.detectedRangefinder ?? 0,
                this.behaviour.detectedOpticalflow ?? 0,
              ),
            );
      case MSP2_GYRO_SENSOR_ACTIVE: {
        if (this.behaviour.noMsp2SensorCommands === true) return unknown();
        const slots = this.behaviour.gyroSlots ?? [13];
        return ok(b(slots.length, ...slots));
      }
      case MSP_STATUS_EX: {
        const scripted = this.scriptedArmingFlags.shift();
        if (scripted !== undefined) this.armingDisableFlags = scripted;
        return ok(
          statusExFrame({
            sensorMask: this.behaviour.sensorMask ?? 0b0100011,
            armingDisableFlags: this.armingDisableFlags,
            flightModeFlagsLow32: this.behaviour.flightModeFlagsLow32 ?? 0,
          }),
        );
      }
      case MSP_ACC_CALIBRATION:
      case MSP_MAG_CALIBRATION:
        return ok(new Uint8Array(0));
      case MSP_EEPROM_WRITE:
        if (this.behaviour.loseValueOnEepromWrite === true) {
          this.accTrimPitch = 0;
          this.accTrimRoll = 0;
          this.declination = 0;
          this.magAlign = 0;
        }
        return ok(new Uint8Array(0));
      default:
        return ok(new Uint8Array(0));
    }
  }

  readonly client: UsbSerialTransportClient = {
    writeBytes: (_sessionId: string, dataBase64: string) => {
      if (this.silent) return Promise.resolve(undefined);
      const frame = base64ToBytes(dataBase64);
      const isV2 = frame[1] === 0x58;
      const command = isV2 ? frame[4] | (frame[5] << 8) : frame[4];
      const size = isV2 ? frame[6] | (frame[7] << 8) : frame[3];
      const start = isV2 ? 8 : 5;
      const payload = frame.slice(start, start + size);
      this.requested.push(command);
      if (payload.length > 0) {
        this.writes.push({command, payload: Array.from(payload)});
      } else {
        // A zero-length write still has to be visible: EEPROM and the two
        // calibration commands carry no payload at all.
        this.writes.push({command, payload: []});
      }
      const reply = this.handle(command, payload);
      if (reply !== undefined) {
        this.reply(
          command,
          reply.payload,
          isV2 ? 'v2' : 'v1',
          reply.error === true ? 'error' : 'response',
        );
      }
      return Promise.resolve(undefined);
    },
    onDataReceived: (listener: (e: UsbSerialDataEvent) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    onSessionDetached: () => () => undefined,
    onDeviceDetached: () => () => undefined,
    onError: () => () => undefined,
    startReading: () => Promise.resolve(undefined),
    stopReading: () => Promise.resolve(undefined),
    closeSession: () => Promise.resolve(undefined),
  } as unknown as UsbSerialTransportClient;
}
