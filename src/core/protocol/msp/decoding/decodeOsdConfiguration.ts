import {MspPayloadReader} from './MspPayloadReader';

export interface MspOsdConfiguration {
  readonly flags: number;
  readonly videoSystem: number;
  readonly units: number;
  readonly rssiAlarmPercent: number;
  readonly capacityAlarmMah: number;
  readonly altitudeAlarm: number;
  readonly elementPositions: readonly number[];
  readonly statistics: readonly boolean[];
  readonly timers: readonly number[];
  readonly warningCount: number;
  readonly enabledWarnings: number;
  readonly profileCount: number;
  readonly selectedProfile: number;
  readonly overlayRadioMode: number;
  readonly cameraFrameWidth: number;
  readonly cameraFrameHeight: number;
  readonly linkQualityAlarmPercent: number;
  readonly rssiDbmAlarm: number;
}

export interface MspOsdCanvas {readonly columns: number; readonly rows: number}
export interface MspOsdSnapshot {readonly config: MspOsdConfiguration; readonly canvas: MspOsdCanvas}

export function decodeOsdConfiguration(payload: Uint8Array): MspOsdConfiguration {
  // Betaflight reads MSP_OSD_CONFIG positionally over a reader that returns
  // null past the end (src/js/injected_methods.js) and validates neither the
  // total length nor any trailing byte (src/js/msp/MSPHelper.js). Every count
  // in this payload - elements, statistics, timers - is declared by the
  // firmware itself and grows between releases, so a build that demanded an
  // exact length would refuse to open the OSD screen against the very next
  // firmware that adds one element.
  const reader = new MspPayloadReader(payload, {lenient: true});
  const flags = reader.readU8();
  const videoSystem = reader.readU8();
  const units = reader.readU8();
  const rssiAlarmPercent = reader.readU8();
  const capacityAlarmMah = reader.readU16LE();
  reader.readU8();
  const elementCount = reader.readU8();
  const altitudeAlarm = reader.readU16LE();
  const elementPositions: number[] = [];
  for (let index = 0; index < elementCount; index += 1) elementPositions.push(reader.readU16LE());
  const statisticCount = reader.readU8();
  const statistics: boolean[] = [];
  for (let index = 0; index < statisticCount; index += 1) statistics.push(reader.readU8() !== 0);
  const timerCount = reader.readU8();
  const timers: number[] = [];
  for (let index = 0; index < timerCount; index += 1) timers.push(reader.readU16LE());
  reader.readU16LE(); // obsolete warning low word, retained only for old API compatibility
  const warningCount = reader.readU8();
  const enabledWarnings = reader.readU32LE();
  const profileCount = reader.readU8();
  const selectedProfile = reader.readU8();
  const overlayRadioMode = reader.readU8();
  const cameraFrameWidth = reader.readU8();
  const cameraFrameHeight = reader.readU8();
  const linkQualityAlarmPercent = reader.readU16LE();
  const rssiDbmAlarm = reader.readS16LE();
  return Object.freeze({
    flags, videoSystem, units, rssiAlarmPercent, capacityAlarmMah, altitudeAlarm,
    elementPositions: Object.freeze(elementPositions), statistics: Object.freeze(statistics),
    timers: Object.freeze(timers), warningCount, enabledWarnings, profileCount,
    selectedProfile, overlayRadioMode, cameraFrameWidth, cameraFrameHeight,
    linkQualityAlarmPercent, rssiDbmAlarm,
  });
}

/**
 * The HD grid Betaflight itself starts from, before any board answers
 * (src/js/tabs/osd.js: VIDEO_COLS.HD = 53, VIDEO_ROWS.HD = 20).
 *
 * MSP_OSD_CANVAS is display geometry only - it sizes the preview and is
 * never written back to the flight controller - so an absent or nonsensical
 * answer has no safety meaning and must not close the screen. Falling back
 * to the standard HD grid is exactly what Betaflight shows in that case.
 */
export const OSD_DEFAULT_HD_CANVAS: MspOsdCanvas = Object.freeze({columns: 53, rows: 20});

export function decodeOsdCanvas(payload: Uint8Array): MspOsdCanvas {
  // Betaflight reads two bytes positionally with no length guard at all
  // (src/js/msp/MSPHelper.js case MSP_OSD_CANVAS).
  const reader = new MspPayloadReader(payload, {lenient: true});
  const columns = reader.readU8();
  const rows = reader.readU8();
  if (columns < 1 || columns > 64 || rows < 1 || rows > 32) return OSD_DEFAULT_HD_CANVAS;
  return Object.freeze({columns, rows});
}
