import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

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
  const reader = new MspPayloadReader(payload);
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
  if (reader.remaining() !== 0) throw new MspPayloadReadError('MSP_OSD_CONFIG has unexpected trailing bytes for API 1.47.');
  return Object.freeze({
    flags, videoSystem, units, rssiAlarmPercent, capacityAlarmMah, altitudeAlarm,
    elementPositions: Object.freeze(elementPositions), statistics: Object.freeze(statistics),
    timers: Object.freeze(timers), warningCount, enabledWarnings, profileCount,
    selectedProfile, overlayRadioMode, cameraFrameWidth, cameraFrameHeight,
    linkQualityAlarmPercent, rssiDbmAlarm,
  });
}

export function decodeOsdCanvas(payload: Uint8Array): MspOsdCanvas {
  if (payload.length !== 2) throw new MspPayloadReadError(`MSP_OSD_CANVAS must be exactly 2 bytes; received ${payload.length}.`);
  const columns = payload[0];
  const rows = payload[1];
  if (columns < 1 || columns > 64 || rows < 1 || rows > 32) throw new MspPayloadReadError(`Invalid OSD canvas ${columns}x${rows}.`);
  return Object.freeze({columns, rows});
}
