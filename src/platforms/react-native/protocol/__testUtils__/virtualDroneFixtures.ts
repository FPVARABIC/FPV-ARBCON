/* eslint-disable no-bitwise -- building the documented MSP bit fields and feature masks. */
/**
 * FIVE VIRTUAL DRONES, and the boards they are built on.
 *
 * These are not one fixture with five names. Each spec describes a
 * different airframe with different hardware, and the differences are the
 * point: a harness whose five drones share a UART map, a cell count and a
 * motor protocol cannot tell you whether the app can configure five kinds
 * of aircraft - it tells you it can configure one, five times.
 *
 * WHERE THE NUMBERS COME FROM. Ranges, enums and defaults are the
 * firmware's, cited at each field. Where a value is a BUILD CHOICE rather
 * than a firmware constant - "a 7-inch long-range quad runs DShot300" -
 * it is a choice, and it is written as one, because the acceptance
 * question is whether the app can carry a plausible build to the board
 * intact, not whether this file guessed the fashionable tune.
 *
 * TWO STATES PER DRONE:
 *
 *   FACTORY   what the board looks like fresh from a firmware flash -
 *             no GPS, no receiver protocol, default rates, PWM motors.
 *             Every scenario starts here, so nothing can pass by having
 *             been pre-configured in the fixture.
 *   TARGET    what the operator is trying to reach.
 *
 * The scenario's job is to get from the first to the second using only
 * the application, and to prove the board actually holds the result.
 */

import {
  encodeSerialPorts,
  type MspSerialPortRecord,
} from '../../../../core/protocol/msp/decoding/decodeSerialPorts';
import {recordKey} from './virtualFlightController';
import {
  MSP2_COMMON_SERIAL_CONFIG,
  MSP2_GET_TEXT,
  MSP_ADVANCED_CONFIG,
  MSP_ARMING_CONFIG,
  MSP_BATTERY_CONFIG,
  MSP_BEEPER_CONFIG,
  MSP_BOARD_ALIGNMENT_CONFIG,
  MSP_BOXNAMES,
  MSP_BUILD_INFO,
  MSP_CURRENT_METER_CONFIG,
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
  MSP_RSSI_CONFIG,
  MSP_RXFAIL_CONFIG,
  MSP_RX_CONFIG,
  MSP_RX_MAP,
  MSP_VOLTAGE_METER_CONFIG,
  MSP_VTXTABLE_BAND,
  MSP_VTXTABLE_POWERLEVEL,
  MSP_VTX_CONFIG,
} from '../../../../core/protocol/msp/commands/mspCommands';

/* ------------------------------------------------------------------ *
 * FIRMWARE CONSTANTS - named so a fixture cannot quietly invent one.
 * ------------------------------------------------------------------ */

/** motorProtocolTypes_e, pinned by the app at API 1.47:
 *  0 PWM · 1 ONESHOT125 · 2 ONESHOT42 · 3 MULTISHOT · 4 BRUSHED ·
 *  5 DSHOT150 · 6 DSHOT300 · 7 DSHOT600 · 8 PROSHOT1000 · 9 DISABLED
 *  (src/core/state/motorConfigurationModel.ts pins MIN 0 / MAX 9 and the
 *  DShot family as 5..8.) */
export const MOTOR_PWM = 0;
export const MOTOR_DSHOT300 = 6;
export const MOTOR_DSHOT600 = 7;

/** features_e bits. GPS is bit 7 (gpsConfigurationModel.GPS_FEATURE_BIT),
 *  3D is bit 12 (decodeFeatureConfig.FEATURE_3D_BIT), MOTOR_STOP bit 4 and
 *  ESC_SENSOR bit 27 (motorConfigurationModel). */
export const FEATURE_MOTOR_STOP = 2 ** 4;
export const FEATURE_GPS = 2 ** 7;
export const FEATURE_TELEMETRY = 2 ** 10;
export const FEATURE_OSD = 2 ** 21;

/** serialPortFunction_e bits, as decodeSerialPorts reads them. */
export const FUNCTION_MSP = 1 << 0;
export const FUNCTION_GPS = 1 << 1;
export const FUNCTION_TELEMETRY_SMARTPORT = 1 << 4;
export const FUNCTION_RX_SERIAL = 1 << 6;
export const FUNCTION_VTX_MSP = 1 << 20;

/** failsafe_procedure_e: 0 AUTO-LAND, 1 DROP, 2 GPS RESCUE
 *  (fc/failsafe.h). */
export const FAILSAFE_LAND = 0;
export const FAILSAFE_DROP = 1;
export const FAILSAFE_GPS_RESCUE = 2;

/* ------------------------------------------------------------------ *
 * FRAME BUILDERS - one per MSP read command, each following the layout
 * its firmware handler emits.
 * ------------------------------------------------------------------ */

function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function withView(size: number, fill: (view: DataView, bytes: Uint8Array) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  fill(new DataView(bytes.buffer), bytes);
  return bytes;
}

/**
 * MSP_BUILD_INFO - and it carries more than a version string.
 *
 * After 26 header bytes the frame lists the option ids the firmware was
 * COMPILED with, terminated by a zero (decodeBuildOptions). Two separate
 * app decisions read that list, so a fixture that omits it is not a
 * neutral simplification - it describes a board that cannot do things a
 * real one can:
 *
 *   GPS (16412)          decodeFailsafe reads it as supportsGpsRescue,
 *                        so without it GPS Rescue is not offerable
 *   SERIALRX_CRSF (4097) resolveProviderAvailability reads it, so
 *                        without it the app REFUSES to select CRSF -
 *                        correctly, because an uncompiled driver would
 *                        leave the aircraft with no receiver at all
 */
export const BUILD_OPTION_GPS = 16412;
export const BUILD_OPTION_SERIALRX_CRSF = 4097;

function buildInfo(optionIds: readonly number[]): Uint8Array {
  return withView(26 + optionIds.length * 2 + 2, view => {
    let offset = 26;
    for (const id of optionIds) {
      view.setUint16(offset, id, true);
      offset += 2;
    }
    view.setUint16(offset, 0, true); // terminator
  });
}

/** MSP_FEATURE_CONFIG: the whole feature mask as one u32. */
function featureMask(mask: number): Uint8Array {
  return withView(4, view => view.setUint32(0, mask >>> 0, true));
}

/** MSP_GPS_CONFIG (msp.c): provider, sbasMode, autoConfig, autoBaud,
 *  setHomePointOnce, useGalileo. */
function gpsConfig(o: {
  provider: number;
  sbas: number;
  autoConfig: boolean;
  autoBaud: boolean;
  homeOnce: boolean;
  galileo: boolean;
}): Uint8Array {
  return u8(
    o.provider,
    o.sbas,
    o.autoConfig ? 1 : 0,
    o.autoBaud ? 1 : 0,
    o.homeOnce ? 1 : 0,
    o.galileo ? 1 : 0,
  );
}

/** MSP_GPS_RESCUE, full API-1.47 length (26 bytes) as the app's own
 *  GPS_RESCUE_FULL_BYTES pins it. */
function gpsRescue(o: {
  angle: number;
  returnAltitudeM: number;
  descentDistanceM: number;
  groundSpeedCmS: number;
  minSatellites: number;
  minStartDistM: number;
}): Uint8Array {
  return withView(26, view => {
    view.setUint16(0, o.angle, true);
    view.setUint16(2, o.returnAltitudeM, true);
    view.setUint16(4, o.descentDistanceM, true);
    view.setUint16(6, o.groundSpeedCmS, true);
    view.setUint16(8, 1600, true); // throttleMin
    view.setUint16(10, 1900, true); // throttleMax
    view.setUint16(12, 1500, true); // throttleHover
    view.setUint8(14, 0); // sanityChecks
    view.setUint8(15, o.minSatellites);
    view.setUint16(16, 150, true); // ascendRate
    view.setUint16(18, 150, true); // descendRate
    view.setUint8(20, 0); // allowArmingWithoutFix - a boolean, not a value
    view.setUint8(21, 0); // altitudeMode
    view.setUint16(22, o.minStartDistM, true);
    view.setUint8(24, 0);
    view.setUint8(25, 0);
  });
}

/** MSP_FAILSAFE_CONFIG (msp.c): delay, landingTime, throttle u16,
 *  switchMode, throttleLowDelay u16, procedure. */
function failsafeConfig(o: {
  delayDeciseconds: number;
  landingTimeSeconds: number;
  throttle: number;
  switchMode: number;
  throttleLowDelay: number;
  procedure: number;
}): Uint8Array {
  return withView(8, view => {
    view.setUint8(0, o.delayDeciseconds);
    view.setUint8(1, o.landingTimeSeconds);
    view.setUint16(2, o.throttle, true);
    view.setUint8(4, o.switchMode);
    view.setUint16(5, o.throttleLowDelay, true);
    view.setUint8(7, o.procedure);
  });
}

/** MSP_RXFAIL_CONFIG: mode u8 + value u16 per channel. */
function rxFail(channels: number): Uint8Array {
  return withView(channels * 3, view => {
    for (let channel = 0; channel < channels; channel += 1) {
      // AUTO for the four sticks, HOLD for the switches - the firmware's
      // own reset behaviour.
      view.setUint8(channel * 3, channel < 4 ? 0 : 1);
      // 875 and 1500 both sit on the RX_FAILSAFE_MIN + 25k grid the
      // firmware encodes; an off-grid value is not representable.
      view.setUint16(channel * 3 + 1, channel === 3 ? 875 : 1500, true);
    }
  });
}

/** MSP_RX_CONFIG at the app's pinned API-1.47 length of 39 bytes. */
function rxConfig(o: {
  serialRxProvider: number;
  midRc: number;
  minCheck: number;
  maxCheck: number;
  fpvCamAngleDegrees: number;
}): Uint8Array {
  return withView(39, view => {
    view.setUint8(0, o.serialRxProvider);
    view.setUint16(1, o.maxCheck, true);
    view.setUint16(3, o.midRc, true);
    view.setUint16(5, o.minCheck, true);
    view.setUint8(7, 0); // spektrum_sat_bind
    view.setUint16(8, 885, true); // rx_min_usec
    view.setUint16(10, 2115, true); // rx_max_usec
    view.setUint8(12, 0);
    view.setUint8(13, 0);
    view.setUint16(14, 1350, true); // airModeActivateThreshold, encoded
    view.setUint8(16, 0); // rx_spi_protocol
    view.setUint32(17, 0, true); // rx_spi_id
    view.setUint8(21, 0); // rx_spi_rf_channel_count
    view.setUint8(22, o.fpvCamAngleDegrees);
    view.setUint8(23, 0);
    view.setUint8(24, 0);
    view.setUint8(25, 15); // rc_smoothing_setpoint_cutoff
    view.setUint8(26, 15); // rc_smoothing_throttle_cutoff
    view.setUint8(27, 0);
    view.setUint8(28, 0);
    view.setUint8(29, 0);
    view.setUint8(30, 0);
    view.setUint8(31, 0);
    view.setUint8(32, 0);
    view.setUint8(33, 0);
    view.setUint8(34, 0);
    view.setUint8(35, 0);
    view.setUint8(36, 0);
    view.setUint8(37, 0);
    view.setUint8(38, 0);
  });
}

/** MSP_BATTERY_CONFIG (msp.c): the decivolt trio, capacity, the two
 *  meter sources, then the same three voltages as centivolts. */
function batteryConfig(o: {
  minCellCentivolts: number;
  maxCellCentivolts: number;
  warningCellCentivolts: number;
  capacityMah: number;
  voltageMeterSource: number;
  currentMeterSource: number;
}): Uint8Array {
  return withView(13, (view, bytes) => {
    bytes[0] = Math.round(o.minCellCentivolts / 10);
    bytes[1] = Math.round(o.maxCellCentivolts / 10);
    bytes[2] = Math.round(o.warningCellCentivolts / 10);
    view.setUint16(3, o.capacityMah, true);
    bytes[5] = o.voltageMeterSource;
    bytes[6] = o.currentMeterSource;
    view.setUint16(7, o.minCellCentivolts, true);
    view.setUint16(9, o.maxCellCentivolts, true);
    view.setUint16(11, o.warningCellCentivolts, true);
  });
}

/** MSP_VOLTAGE_METER_CONFIG: count, then a 5-byte subframe per sensor. */
function voltageMeters(scale: number): Uint8Array {
  return u8(1, 5, 10, 0, scale, 10, 1);
}

/** MSP_CURRENT_METER_CONFIG: count, then a 6-byte subframe per sensor. */
function currentMeters(scale: number, offset: number): Uint8Array {
  return withView(8, (view, bytes) => {
    bytes[0] = 1;
    bytes[1] = 6;
    bytes[2] = 10;
    bytes[3] = 1;
    view.setUint16(4, scale, true);
    view.setUint16(6, offset, true);
  });
}

/**
 * MSP_MOTOR_CONFIG. The MOTOR COUNT byte at offset 6 is the one the SET
 * frame does not carry (see the virtual controller's splice rule).
 */
function motorConfig(o: {
  maxThrottle: number;
  minCommand: number;
  motorCount: number;
  poleCount: number;
  dshotTelemetry: boolean;
}): Uint8Array {
  return withView(11, (view, bytes) => {
    view.setUint16(0, 0, true); // minthrottle, deprecated after 4.5
    view.setUint16(2, o.maxThrottle, true);
    view.setUint16(4, o.minCommand, true);
    bytes[6] = o.motorCount;
    bytes[7] = o.poleCount;
    bytes[8] = o.dshotTelemetry ? 1 : 0;
    bytes[9] = 0; // esc sensor available
    bytes[10] = 0;
  });
}

/** MSP_MOTOR_3D_CONFIG: deadband low, high, neutral. */
function motor3d(): Uint8Array {
  return withView(6, view => {
    view.setUint16(0, 1406, true);
    view.setUint16(2, 1514, true);
    view.setUint16(4, 1460, true);
  });
}

/** MSP_ADVANCED_CONFIG (msp.c), 22 bytes through debug_mode + count. */
function advancedConfig(o: {
  pidProcessDenom: number;
  motorProtocol: number;
  motorPwmRate: number;
  motorIdlePercent: number;
}): Uint8Array {
  return withView(22, (view, bytes) => {
    bytes[0] = 1; // was gyro_sync_denom
    bytes[1] = o.pidProcessDenom;
    bytes[2] = 0; // useContinuousUpdate
    bytes[3] = o.motorProtocol;
    view.setUint16(4, o.motorPwmRate, true);
    view.setUint16(6, o.motorIdlePercent, true);
    bytes[8] = 0; // deprecated 32kHz
    bytes[9] = 0; // motorInversion
    bytes[10] = 0; // deprecated gyro_to_use
    bytes[11] = 0; // gyro_high_fsr
    bytes[12] = 32; // gyroMovementCalibrationThreshold
    view.setUint16(13, 125, true); // gyroCalibrationDuration
    view.setUint16(15, 0, true); // gyro_offset_yaw
    bytes[17] = 0; // checkOverflow
    bytes[18] = 0; // debug_mode
    bytes[19] = 60; // DEBUG_COUNT
    bytes[20] = 0;
    bytes[21] = 0;
  });
}

/** MSP_ARMING_CONFIG: autoDisarmDelay, reserved, smallAngle, gyroCal. */
function armingConfig(smallAngle: number): Uint8Array {
  return u8(5, 0, smallAngle, 0);
}

/** MSP_BEEPER_CONFIG: offFlags u32, dshotBeaconTone, offFlags u32. */
function beeperConfig(): Uint8Array {
  return withView(9, (view, bytes) => {
    view.setUint32(0, 0, true);
    bytes[4] = 1;
    view.setUint32(5, 0, true);
  });
}

/** MSP_BOARD_ALIGNMENT_CONFIG: three signed 16-bit degrees. */
function boardAlignment(roll: number, pitch: number, yaw: number): Uint8Array {
  return withView(6, view => {
    view.setInt16(0, roll, true);
    view.setInt16(2, pitch, true);
    view.setInt16(4, yaw, true);
  });
}

/** MSP_PID: three terms for each of five axes/items. */
function pid(o: {
  rollP: number;
  rollI: number;
  rollD: number;
  pitchP: number;
  pitchI: number;
  pitchD: number;
  yawP: number;
  yawI: number;
  yawD: number;
}): Uint8Array {
  return u8(
    o.rollP, o.rollI, o.rollD,
    o.pitchP, o.pitchI, o.pitchD,
    o.yawP, o.yawI, o.yawD,
    0, 50, 50, 75, 40, 0,
  );
}

/** MSP_PID_ADVANCED at the app's pinned minimum of 61 bytes; the
 *  feed-forward trio sits at offsets 32/34/36. */
function pidAdvanced(rollF: number, pitchF: number, yawF: number): Uint8Array {
  return withView(61, view => {
    view.setUint16(32, rollF, true);
    view.setUint16(34, pitchF, true);
    view.setUint16(36, yawF, true);
  });
}

/** MSP_RC_TUNING at the app's pinned 24 bytes. */
function rcTuning(o: {
  rcRate: number;
  superRate: number;
  expo: number;
  throttleMid: number;
  throttleExpo: number;
  tpaRate: number;
}): Uint8Array {
  return withView(24, (view, bytes) => {
    bytes[0] = o.rcRate; // roll rc rate
    bytes[1] = o.expo; // roll expo
    bytes[2] = o.superRate; // roll super rate
    bytes[3] = o.superRate; // pitch super rate
    bytes[4] = o.superRate; // yaw super rate
    bytes[5] = o.tpaRate;
    bytes[6] = o.throttleMid;
    bytes[7] = o.throttleExpo;
    view.setUint16(8, 1350, true); // tpa breakpoint
    bytes[10] = o.expo; // yaw expo
    bytes[11] = o.rcRate; // yaw rc rate
    bytes[12] = o.rcRate; // pitch rc rate
    bytes[13] = o.expo; // pitch expo
    bytes[14] = 0; // throttle limit type
    bytes[15] = 100; // throttle limit percent
    view.setUint16(16, 1998, true); // roll rate limit
    view.setUint16(18, 1998, true); // pitch rate limit
    view.setUint16(20, 1998, true); // yaw rate limit
    bytes[22] = 0; // rates type
    bytes[23] = 50;
  });
}

/**
 * MSP_FILTER_CONFIG at the app's pinned 49 bytes.
 *
 * The offsets are decodeFilterConfiguration's own, not a guess: that
 * decoder reads the frame POSITIONALLY (deliberately, so a firmware that
 * appends a field still opens the PID tab), which means a fixture that
 * puts a value one slot out does not fail loudly - it silently becomes a
 * different setting. Writing a dynamic-LPF ceiling into the notch
 * minimum, for instance, produces a number that is legal for one field
 * and out of range for the other.
 */
function filterConfig(o: {
  gyroLowpassHz: number;
  dtermLowpassHz: number;
  dynLpfMinHz: number;
  dynLpfMaxHz: number;
}): Uint8Array {
  return withView(49, (view, bytes) => {
    view.setUint16(1, o.dtermLowpassHz, true); // dtermLpf1StaticHz
    view.setUint16(20, o.gyroLowpassHz, true); // gyroLpf1StaticHz
    view.setUint16(29, o.dynLpfMinHz, true); // gyroLpf1DynamicMinHz
    view.setUint16(31, o.dynLpfMaxHz, true); // gyroLpf1DynamicMaxHz
    view.setUint16(33, 0, true); // dtermLpf1DynamicMinHz
    view.setUint16(35, 0, true); // dtermLpf1DynamicMaxHz
    view.setUint16(39, 300, true); // dynamicNotchQ
    view.setUint16(41, 100, true); // dynamicNotchMinHz
    view.setUint16(45, 600, true); // dynamicNotchMaxHz
    bytes[48] = 3; // dynamicNotchCount
  });
}

/** MSP_MODE_RANGES: four bytes per slot, twenty slots. */
function modeRanges(
  ranges: ReadonlyArray<{box: number; aux: number; start: number; end: number}>,
): Uint8Array {
  return withView(80, (_view, bytes) => {
    ranges.forEach((range, index) => {
      const offset = index * 4;
      bytes[offset] = range.box;
      bytes[offset + 1] = range.aux;
      bytes[offset + 2] = (range.start - 900) / 25;
      bytes[offset + 3] = (range.end - 900) / 25;
    });
  });
}

/** MSP_OSD_CONFIG, self-describing exactly as decodeOsdConfiguration
 *  reads it: flags, video, units, alarms, then the three declared
 *  tables, then the warning and profile tail. */
function osdConfig(o: {
  videoSystem: number;
  units: number;
  rssiAlarmPercent: number;
  capacityAlarmMah: number;
  altitudeAlarmM: number;
  elements: readonly number[];
  statistics: readonly boolean[];
  timers: readonly number[];
  enabledWarnings: number;
  linkQualityAlarmPercent: number;
  rssiDbmAlarm: number;
}): Uint8Array {
  const size =
    10 +
    o.elements.length * 2 +
    1 +
    o.statistics.length +
    1 +
    o.timers.length * 2 +
    2 +
    1 +
    4 +
    1 +
    4 +
    2 +
    2;
  return withView(size, (view, bytes) => {
    bytes[0] = 1; // osdFlags: driver present
    bytes[1] = o.videoSystem;
    bytes[2] = o.units;
    bytes[3] = o.rssiAlarmPercent;
    view.setUint16(4, o.capacityAlarmMah, true);
    bytes[6] = 0;
    bytes[7] = o.elements.length;
    view.setUint16(8, o.altitudeAlarmM, true);
    let offset = 10;
    for (const position of o.elements) {
      view.setUint16(offset, position, true);
      offset += 2;
    }
    bytes[offset] = o.statistics.length;
    offset += 1;
    for (const enabled of o.statistics) {
      bytes[offset] = enabled ? 1 : 0;
      offset += 1;
    }
    bytes[offset] = o.timers.length;
    offset += 1;
    for (const timer of o.timers) {
      view.setUint16(offset, timer, true);
      offset += 2;
    }
    view.setUint16(offset, o.enabledWarnings & 0xffff, true);
    offset += 2;
    bytes[offset] = 32; // warningCount
    offset += 1;
    view.setUint32(offset, o.enabledWarnings >>> 0, true);
    offset += 4;
    bytes[offset] = 3; // profileCount
    offset += 1;
    bytes[offset] = 1; // selectedProfile
    bytes[offset + 1] = 0; // overlayRadioMode
    bytes[offset + 2] = 24; // cameraFrameWidth
    bytes[offset + 3] = 11; // cameraFrameHeight
    offset += 4;
    view.setUint16(offset, o.linkQualityAlarmPercent, true);
    view.setInt16(offset + 2, o.rssiDbmAlarm, true);
  });
}

/** MSP_VTX_CONFIG, in the 15-byte shape the app's decoder accepts. */
function vtxConfig(o: {
  band: number;
  channel: number;
  power: number;
  pitMode: boolean;
  frequency: number;
}): Uint8Array {
  return withView(15, (view, bytes) => {
    bytes[0] = 3; // device type: SmartAudio
    bytes[1] = o.band;
    bytes[2] = o.channel;
    bytes[3] = o.power;
    bytes[4] = o.pitMode ? 1 : 0;
    view.setUint16(5, o.frequency, true);
    bytes[7] = 1; // deviceIsReady
    bytes[8] = 0; // lowPowerDisarm
    view.setUint16(9, 0, true); // pitModeFreq
    bytes[11] = 1; // vtxTableAvailable
    bytes[12] = 5; // bands
    bytes[13] = 8; // channels
    bytes[14] = 3; // power levels
  });
}

/** One MSP_VTXTABLE_BAND row: number, name, letter, factory flag, then
 *  the channel frequencies (decodeVtxBand). */
function vtxBand(
  number: number,
  name: string,
  letter: string,
  frequencies: readonly number[],
): Uint8Array {
  const label = textBytes(name);
  return withView(4 + label.length + 1 + frequencies.length * 2, (view, bytes) => {
    bytes[0] = number;
    bytes[1] = label.length;
    bytes.set(label, 2);
    let offset = 2 + label.length;
    bytes[offset] = letter.charCodeAt(0);
    bytes[offset + 1] = 1; // factory band
    bytes[offset + 2] = frequencies.length;
    offset += 3;
    for (const frequency of frequencies) {
      view.setUint16(offset, frequency, true);
      offset += 2;
    }
  });
}

/** One MSP_VTXTABLE_POWERLEVEL row: number, value u16, label
 *  (decodeVtxPowerLevel). */
function vtxPowerLevel(number: number, value: number, label: string): Uint8Array {
  const text = textBytes(label);
  return withView(4 + text.length, (view, bytes) => {
    bytes[0] = number;
    view.setUint16(1, value, true);
    bytes[3] = text.length;
    bytes.set(text, 4);
  });
}

/** An MSP2_GET_TEXT reply: type, length, bytes (decodeMspText). */
function mspText(type: number, value: string): Uint8Array {
  const text = textBytes(value);
  const bytes = new Uint8Array(2 + text.length);
  bytes[0] = type;
  bytes[1] = text.length;
  bytes.set(text, 2);
  return bytes;
}

/* ------------------------------------------------------------------ *
 * THE SPEC, AND THE FIVE DRONES
 * ------------------------------------------------------------------ */

export type DroneKey =
  | 'LONG_RANGE'
  | 'RACING'
  | 'FREESTYLE'
  | 'CINEWHOOP'
  | 'TINY_WHOOP';

export interface DroneHardware {
  /** Board identifier the FC reports, purely descriptive here. */
  readonly board: string;
  readonly apiMinor: number;
  readonly motorCount: number;
  readonly motorPoleCount: number;
  readonly cells: number;
  readonly hasGps: boolean;
  readonly hasCurrentSensor: boolean;
  readonly hasVtx: boolean;
  readonly channels: number;
  readonly serialPorts: readonly MspSerialPortRecord[];
}

export interface DroneTarget {
  readonly featureMask: number;
  readonly motorProtocol: number;
  readonly motorIdlePercent: number;
  readonly battery: Parameters<typeof batteryConfig>[0];
  readonly failsafe: Parameters<typeof failsafeConfig>[0];
  readonly pid: Parameters<typeof pid>[0];
  readonly rates: Parameters<typeof rcTuning>[0];
  readonly filters: Parameters<typeof filterConfig>[0];
  readonly boardAlignment: readonly [number, number, number];
  readonly gps?: Parameters<typeof gpsConfig>[0];
  readonly gpsRescue?: Parameters<typeof gpsRescue>[0];
  readonly vtx?: Parameters<typeof vtxConfig>[0];
  readonly osdAltitudeAlarmM: number;
  readonly osdCapacityAlarmMah: number;
  readonly rxSerialProvider: number;
  readonly fpvCamAngleDegrees: number;
}

export interface DroneSpec {
  readonly key: DroneKey;
  readonly name: string;
  /** Why this build exists, in one line, for the acceptance report. */
  readonly rationale: string;
  readonly hardware: DroneHardware;
  readonly target: DroneTarget;
}

function port(
  identifier: number,
  functionMask: number,
  overrides: Partial<MspSerialPortRecord> = {},
): MspSerialPortRecord {
  return {
    identifier,
    functionMask,
    mspBaudIndex: 5,
    gpsBaudIndex: 2,
    telemetryBaudIndex: 0,
    blackboxBaudIndex: 0,
    extensionBytes: new Uint8Array(0),
    ...overrides,
  };
}

/** USB VCP is identifier 20 in Betaflight's serial port map. */
const USB_VCP = 20;

export const DRONE_SPECS: readonly DroneSpec[] = Object.freeze([
  {
    key: 'LONG_RANGE',
    name: '7" Long Range — ELRS 868/915, GPS, 6S',
    rationale:
      'The richest configuration surface: a GPS UART, GPS Rescue as the ' +
      'failsafe procedure, a low-rate ELRS link, big-battery power limits ' +
      'and OSD elements that only matter when the aircraft is out of sight.',
    hardware: {
      board: 'S405',
      apiMinor: 47,
      motorCount: 4,
      motorPoleCount: 14,
      cells: 6,
      hasGps: true,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 16,
      serialPorts: [
        port(USB_VCP, FUNCTION_MSP),
        port(0, FUNCTION_RX_SERIAL),
        port(1, FUNCTION_GPS, {gpsBaudIndex: 2}),
        port(2, FUNCTION_VTX_MSP),
      ],
    },
    target: {
      featureMask: FEATURE_GPS | FEATURE_TELEMETRY | FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT300,
      motorIdlePercent: 550,
      battery: {
        minCellCentivolts: 320,
        maxCellCentivolts: 430,
        warningCellCentivolts: 350,
        capacityMah: 5000,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 15,
        landingTimeSeconds: 60,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_GPS_RESCUE,
      },
      pid: {
        rollP: 42, rollI: 85, rollD: 30,
        pitchP: 46, pitchI: 90, pitchD: 32,
        yawP: 45, yawI: 90, yawD: 0,
      },
      rates: {
        rcRate: 90, superRate: 60, expo: 15,
        throttleMid: 50, throttleExpo: 0, tpaRate: 65,
      },
      filters: {
        gyroLowpassHz: 250,
        dtermLowpassHz: 120,
        dynLpfMinHz: 300,
        dynLpfMaxHz: 700,
      },
      boardAlignment: [0, 0, 0],
      gps: {
        provider: 1, // UBLOX
        sbas: 0, // AUTO
        autoConfig: true,
        autoBaud: false,
        homeOnce: true,
        galileo: true,
      },
      gpsRescue: {
        angle: 40,
        returnAltitudeM: 60,
        descentDistanceM: 200,
        groundSpeedCmS: 750,
        minSatellites: 8,
        minStartDistM: 30,
      },
      vtx: {band: 5, channel: 1, power: 2, pitMode: false, frequency: 5658},
      osdAltitudeAlarmM: 120,
      osdCapacityAlarmMah: 4200,
      rxSerialProvider: 9, // CRSF
      fpvCamAngleDegrees: 20,
    },
  },
  {
    key: 'RACING',
    name: '5" Race — ELRS 2.4, DShot600, 6S, no GPS',
    rationale:
      'The opposite pressure to long range: no GPS at all, a DROP failsafe ' +
      'because a race quad must not fly itself back through a track, the ' +
      'fastest motor protocol, and rates built for a pilot who is looking ' +
      'at the aircraft.',
    hardware: {
      board: 'HX40',
      apiMinor: 48,
      motorCount: 4,
      motorPoleCount: 14,
      cells: 6,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 12,
      serialPorts: [port(USB_VCP, FUNCTION_MSP), port(0, FUNCTION_RX_SERIAL), port(1, FUNCTION_VTX_MSP)],
    },
    target: {
      featureMask: FEATURE_TELEMETRY | FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT600,
      motorIdlePercent: 450,
      battery: {
        minCellCentivolts: 330,
        maxCellCentivolts: 430,
        warningCellCentivolts: 350,
        capacityMah: 1300,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 4,
        landingTimeSeconds: 10,
        throttle: 1000,
        switchMode: 1,
        throttleLowDelay: 100,
        procedure: FAILSAFE_DROP,
      },
      pid: {
        rollP: 47, rollI: 84, rollD: 40,
        pitchP: 50, pitchI: 88, pitchD: 42,
        yawP: 47, yawI: 84, yawD: 0,
      },
      rates: {
        rcRate: 120, superRate: 78, expo: 0,
        throttleMid: 50, throttleExpo: 0, tpaRate: 75,
      },
      filters: {
        gyroLowpassHz: 0,
        dtermLowpassHz: 150,
        dynLpfMinHz: 400,
        dynLpfMaxHz: 1000,
      },
      boardAlignment: [0, 0, 0],
      vtx: {band: 5, channel: 4, power: 4, pitMode: false, frequency: 5769},
      osdAltitudeAlarmM: 0,
      osdCapacityAlarmMah: 1100,
      rxSerialProvider: 9, // CRSF
      fpvCamAngleDegrees: 40,
    },
  },
  {
    key: 'FREESTYLE',
    name: '5" Freestyle — ELRS 2.4, DShot600, 6S',
    rationale:
      'The tuning-heavy case: same airframe class as the racer but a ' +
      'different point in the trade-off, so the PID, filter and rate ' +
      'groups all have to carry distinct values without one screen ' +
      'overwriting another.',
    hardware: {
      board: 'HX40',
      apiMinor: 49,
      motorCount: 4,
      motorPoleCount: 14,
      cells: 6,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 12,
      serialPorts: [port(USB_VCP, FUNCTION_MSP), port(0, FUNCTION_RX_SERIAL), port(1, FUNCTION_VTX_MSP)],
    },
    target: {
      featureMask: FEATURE_TELEMETRY | FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT600,
      motorIdlePercent: 500,
      battery: {
        minCellCentivolts: 330,
        maxCellCentivolts: 430,
        warningCellCentivolts: 360,
        capacityMah: 1300,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 10,
        landingTimeSeconds: 20,
        throttle: 1000,
        switchMode: 1,
        throttleLowDelay: 100,
        procedure: FAILSAFE_DROP,
      },
      pid: {
        rollP: 45, rollI: 80, rollD: 38,
        pitchP: 48, pitchI: 85, pitchD: 40,
        yawP: 45, yawI: 80, yawD: 0,
      },
      rates: {
        rcRate: 105, superRate: 70, expo: 10,
        throttleMid: 50, throttleExpo: 20, tpaRate: 65,
      },
      filters: {
        gyroLowpassHz: 0,
        dtermLowpassHz: 135,
        dynLpfMinHz: 350,
        dynLpfMaxHz: 850,
      },
      boardAlignment: [0, 0, 0],
      vtx: {band: 5, channel: 2, power: 3, pitMode: false, frequency: 5695},
      osdAltitudeAlarmM: 0,
      osdCapacityAlarmMah: 1100,
      rxSerialProvider: 9,
      fpvCamAngleDegrees: 35,
    },
  },
  {
    key: 'CINEWHOOP',
    name: '3" Cinewhoop — ducted, 4S, DShot300, stack rotated 90°',
    rationale:
      'The board-alignment case, and it is a real one: a ducted frame has ' +
      'no room to mount the stack facing forward, so the FC sits a quarter ' +
      'turn out and the firmware has to be told. Also the softest tune of ' +
      'the five - a camera platform, not a sport aircraft.',
    hardware: {
      board: 'AIOF4',
      apiMinor: 47,
      motorCount: 4,
      motorPoleCount: 12,
      cells: 4,
      hasGps: false,
      hasCurrentSensor: true,
      hasVtx: true,
      channels: 10,
      serialPorts: [port(USB_VCP, FUNCTION_MSP), port(0, FUNCTION_RX_SERIAL), port(1, FUNCTION_TELEMETRY_SMARTPORT)],
    },
    target: {
      featureMask: FEATURE_TELEMETRY | FEATURE_OSD,
      motorProtocol: MOTOR_DSHOT300,
      motorIdlePercent: 800,
      battery: {
        minCellCentivolts: 330,
        maxCellCentivolts: 430,
        warningCellCentivolts: 355,
        capacityMah: 850,
        voltageMeterSource: 1,
        currentMeterSource: 1,
      },
      failsafe: {
        delayDeciseconds: 10,
        landingTimeSeconds: 30,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_LAND,
      },
      pid: {
        rollP: 60, rollI: 100, rollD: 45,
        pitchP: 64, pitchI: 105, pitchD: 48,
        yawP: 55, yawI: 95, yawD: 0,
      },
      rates: {
        rcRate: 70, superRate: 45, expo: 25,
        throttleMid: 55, throttleExpo: 30, tpaRate: 50,
      },
      filters: {
        gyroLowpassHz: 180,
        dtermLowpassHz: 90,
        dynLpfMinHz: 250,
        dynLpfMaxHz: 600,
      },
      // The stack is fitted a quarter turn clockwise inside the duct.
      boardAlignment: [0, 0, 90],
      vtx: {band: 5, channel: 6, power: 1, pitMode: false, frequency: 5843},
      osdAltitudeAlarmM: 0,
      osdCapacityAlarmMah: 700,
      rxSerialProvider: 9,
      fpvCamAngleDegrees: 10,
    },
  },
  {
    key: 'TINY_WHOOP',
    name: '65mm Tiny Whoop — 1S, DShot300, 25 mW',
    rationale:
      'The constrained case. One cell means voltage limits nothing else ' +
      'uses, a tiny pack means a low capacity alarm, and a 25 mW VTX with ' +
      'the smallest legal power level - the opposite end of every range ' +
      'from the long-range build, which is exactly why it is here.',
    hardware: {
      board: 'AIO1S',
      apiMinor: 47,
      motorCount: 4,
      motorPoleCount: 12,
      cells: 1,
      hasGps: false,
      hasCurrentSensor: false,
      hasVtx: true,
      channels: 8,
      serialPorts: [port(USB_VCP, FUNCTION_MSP), port(0, FUNCTION_RX_SERIAL)],
    },
    target: {
      featureMask: FEATURE_OSD | FEATURE_MOTOR_STOP,
      motorProtocol: MOTOR_DSHOT300,
      motorIdlePercent: 700,
      battery: {
        minCellCentivolts: 330,
        maxCellCentivolts: 435,
        warningCellCentivolts: 350,
        capacityMah: 300,
        voltageMeterSource: 1,
        currentMeterSource: 0, // no current sensor on this board
      },
      failsafe: {
        delayDeciseconds: 10,
        landingTimeSeconds: 10,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_DROP,
      },
      pid: {
        rollP: 75, rollI: 120, rollD: 55,
        pitchP: 80, pitchI: 125, pitchD: 58,
        yawP: 70, yawI: 110, yawD: 0,
      },
      rates: {
        rcRate: 100, superRate: 72, expo: 20,
        throttleMid: 50, throttleExpo: 15, tpaRate: 60,
      },
      filters: {
        gyroLowpassHz: 150,
        dtermLowpassHz: 100,
        dynLpfMinHz: 200,
        dynLpfMaxHz: 500,
      },
      boardAlignment: [0, 0, 0],
      vtx: {band: 5, channel: 8, power: 1, pitMode: false, frequency: 5917},
      osdAltitudeAlarmM: 0,
      osdCapacityAlarmMah: 260,
      rxSerialProvider: 9,
      fpvCamAngleDegrees: 25,
    },
  },
]);

/** The five standard analogue video bands, as Betaflight's own default
 *  VTX table declares them. */
const BAND_A = [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725];
const BAND_B = [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866];
const BAND_E = [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945];
const BAND_F = [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880];
const BAND_R = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];

/** decodeMspText's own type constants. */
const MSP_TEXT_PILOT_NAME = 1;
const MSP_TEXT_CRAFT_NAME = 2;

/** Ten common OSD element slots. Positions are the firmware's packed
 *  row/column word; the values themselves are what the app moves. */
const FACTORY_OSD_ELEMENTS = Object.freeze([
  0x0805, 0x0a21, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000,
]);

/**
 * A FRESHLY FLASHED BOARD. No receiver protocol, no GPS, PWM motors,
 * factory rates and a default battery profile. Every scenario starts
 * here, so no test can pass because the fixture had already done the
 * configuring.
 */
export function buildFactoryBoard(spec: DroneSpec): Map<number, Uint8Array> {
  const hardware = spec.hardware;
  return new Map<number, Uint8Array>([
    [
      MSP_BUILD_INFO,
      buildInfo([
        // Every one of these boards ships a CRSF build - they all fly
        // ELRS - and only the long-range board has GPS compiled in.
        BUILD_OPTION_SERIALRX_CRSF,
        ...(hardware.hasGps ? [BUILD_OPTION_GPS] : []),
      ]),
    ],
    [MSP_FEATURE_CONFIG, featureMask(0)],
    [
      MSP_GPS_CONFIG,
      gpsConfig({
        provider: 0,
        sbas: 0,
        autoConfig: false,
        autoBaud: false,
        homeOnce: false,
        galileo: false,
      }),
    ],
    [
      MSP_GPS_RESCUE,
      gpsRescue({
        angle: 32,
        returnAltitudeM: 30,
        descentDistanceM: 200,
        groundSpeedCmS: 500,
        minSatellites: 8,
        minStartDistM: 30,
      }),
    ],
    [
      MSP_FAILSAFE_CONFIG,
      failsafeConfig({
        delayDeciseconds: 4,
        landingTimeSeconds: 10,
        throttle: 1000,
        switchMode: 0,
        throttleLowDelay: 100,
        procedure: FAILSAFE_DROP,
      }),
    ],
    [MSP_RXFAIL_CONFIG, rxFail(hardware.channels)],
    [
      MSP_RX_CONFIG,
      rxConfig({
        serialRxProvider: 0,
        midRc: 1500,
        minCheck: 1050,
        maxCheck: 1900,
        fpvCamAngleDegrees: 0,
      }),
    ],
    [MSP_RX_MAP, u8(0, 1, 3, 2, 4, 5, 6, 7)],
    [MSP_RSSI_CONFIG, u8(0)],
    [MSP_RC_DEADBAND, u8(0, 0, 0, 0, 0)],
    [
      MSP_BATTERY_CONFIG,
      batteryConfig({
        minCellCentivolts: 330,
        maxCellCentivolts: 430,
        warningCellCentivolts: 350,
        capacityMah: 0,
        voltageMeterSource: 1,
        currentMeterSource: hardware.hasCurrentSensor ? 1 : 0,
      }),
    ],
    [MSP_VOLTAGE_METER_CONFIG, voltageMeters(110)],
    [MSP_CURRENT_METER_CONFIG, currentMeters(400, 0)],
    [
      MSP_MOTOR_CONFIG,
      motorConfig({
        maxThrottle: 2000,
        minCommand: 1000,
        motorCount: hardware.motorCount,
        poleCount: hardware.motorPoleCount,
        dshotTelemetry: false,
      }),
    ],
    [MSP_MOTOR_3D_CONFIG, motor3d()],
    [MSP_MIXER_CONFIG, u8(3, 0)], // QUADX, yaw not reversed
    [
      MSP_ADVANCED_CONFIG,
      advancedConfig({
        pidProcessDenom: 1,
        motorProtocol: MOTOR_PWM,
        motorPwmRate: 480,
        motorIdlePercent: 550,
      }),
    ],
    [MSP_ARMING_CONFIG, armingConfig(25)],
    [MSP_BEEPER_CONFIG, beeperConfig()],
    [MSP_BOARD_ALIGNMENT_CONFIG, boardAlignment(0, 0, 0)],
    [
      MSP_PID,
      pid({
        rollP: 45, rollI: 80, rollD: 40,
        pitchP: 47, pitchI: 84, pitchD: 46,
        yawP: 45, yawI: 80, yawD: 0,
      }),
    ],
    [MSP_PID_ADVANCED, pidAdvanced(120, 125, 0)],
    [
      MSP_RC_TUNING,
      rcTuning({
        rcRate: 100, superRate: 70, expo: 0,
        throttleMid: 50, throttleExpo: 0, tpaRate: 65,
      }),
    ],
    [
      MSP_FILTER_CONFIG,
      filterConfig({
        gyroLowpassHz: 0,
        dtermLowpassHz: 150,
        dynLpfMinHz: 300,
        dynLpfMaxHz: 750,
      }),
    ],
    [MSP_MODE_RANGES, modeRanges([])],
    [MSP_MODE_RANGES_EXTRA, new Uint8Array(60)],
    [MSP_BOXNAMES, textBytes('ARM;ANGLE;HORIZON;BEEPER;GPS RESCUE;')],
    [
      MSP_OSD_CONFIG,
      osdConfig({
        videoSystem: 1,
        units: 1,
        rssiAlarmPercent: 20,
        capacityAlarmMah: 0,
        altitudeAlarmM: 0,
        elements: FACTORY_OSD_ELEMENTS,
        statistics: [false, false, false, false, false, false],
        timers: [0x0a21, 0x0000],
        enabledWarnings: 0,
        linkQualityAlarmPercent: 0,
        rssiDbmAlarm: 0,
      }),
    ],
    [MSP_OSD_CANVAS, u8(30, 16)],
    [
      MSP_VTX_CONFIG,
      vtxConfig({band: 5, channel: 1, power: 1, pitMode: false, frequency: 5658}),
    ],
    [
      MSP2_COMMON_SERIAL_CONFIG,
      encodeSerialPorts([port(USB_VCP, FUNCTION_MSP), ...hardware.serialPorts.slice(1).map(p => port(p.identifier, 0))]),
    ],
    // Records addressed by index in the request, not returned as a table.
    [recordKey(MSP_VTXTABLE_BAND, 1), vtxBand(1, 'BOSCAM A', 'A', BAND_A)],
    [recordKey(MSP_VTXTABLE_BAND, 2), vtxBand(2, 'BOSCAM B', 'B', BAND_B)],
    [recordKey(MSP_VTXTABLE_BAND, 3), vtxBand(3, 'BOSCAM E', 'E', BAND_E)],
    [recordKey(MSP_VTXTABLE_BAND, 4), vtxBand(4, 'FATSHARK', 'F', BAND_F)],
    [recordKey(MSP_VTXTABLE_BAND, 5), vtxBand(5, 'RACEBAND', 'R', BAND_R)],
    [recordKey(MSP_VTXTABLE_POWERLEVEL, 1), vtxPowerLevel(1, 25, '25')],
    [recordKey(MSP_VTXTABLE_POWERLEVEL, 2), vtxPowerLevel(2, 200, '200')],
    [recordKey(MSP_VTXTABLE_POWERLEVEL, 3), vtxPowerLevel(3, 500, '500')],
    [recordKey(MSP_VTXTABLE_POWERLEVEL, 4), vtxPowerLevel(4, 800, '800')],
    [recordKey(MSP2_GET_TEXT, MSP_TEXT_PILOT_NAME), mspText(MSP_TEXT_PILOT_NAME, '')],
    [recordKey(MSP2_GET_TEXT, MSP_TEXT_CRAFT_NAME), mspText(MSP_TEXT_CRAFT_NAME, '')],
  ]);
}

function textBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

export const FRAME_BUILDERS = {
  buildInfo,
  featureMask,
  gpsConfig,
  gpsRescue,
  failsafeConfig,
  rxFail,
  rxConfig,
  batteryConfig,
  voltageMeters,
  currentMeters,
  motorConfig,
  motor3d,
  advancedConfig,
  armingConfig,
  beeperConfig,
  boardAlignment,
  pid,
  pidAdvanced,
  rcTuning,
  filterConfig,
  modeRanges,
  osdConfig,
  vtxConfig,
  port,
  USB_VCP,
};
