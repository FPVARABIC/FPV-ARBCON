import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

export interface MspBatteryConfiguration {readonly minCellCentivolts: number; readonly maxCellCentivolts: number; readonly warningCellCentivolts: number; readonly capacityMah: number; readonly voltageMeterSource: number; readonly currentMeterSource: number}
export interface MspVoltageMeterConfiguration {readonly id: number; readonly sensorType: number; readonly scale: number; readonly divider: number; readonly multiplier: number}
export interface MspCurrentMeterConfiguration {readonly id: number; readonly sensorType: number; readonly scale: number; readonly offset: number}
export interface MspPowerConfigurationSnapshot {readonly battery: MspBatteryConfiguration; readonly voltageMeters: readonly MspVoltageMeterConfiguration[]; readonly currentMeters: readonly MspCurrentMeterConfiguration[]}

export function decodeBatteryConfiguration(payload: Uint8Array): MspBatteryConfiguration {
  if (payload.length !== 13) throw new MspPayloadReadError(`MSP_BATTERY_CONFIG API 1.47 must be exactly 13 bytes; received ${payload.length}.`);
  const reader = new MspPayloadReader(payload);
  reader.readU8(); reader.readU8(); reader.readU8();
  const capacityMah = reader.readU16LE(); const voltageMeterSource = reader.readU8(); const currentMeterSource = reader.readU8();
  const minCellCentivolts = reader.readU16LE(); const maxCellCentivolts = reader.readU16LE(); const warningCellCentivolts = reader.readU16LE();
  return Object.freeze({minCellCentivolts, maxCellCentivolts, warningCellCentivolts, capacityMah, voltageMeterSource, currentMeterSource});
}

export function decodeVoltageMeterConfiguration(payload: Uint8Array): readonly MspVoltageMeterConfiguration[] {
  const reader = new MspPayloadReader(payload); const count = reader.readU8(); const meters: MspVoltageMeterConfiguration[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = reader.readU8(); const bytes = reader.readBytes(length); if (length !== 5) continue;
    meters.push(Object.freeze({id: bytes[0], sensorType: bytes[1], scale: bytes[2], divider: bytes[3], multiplier: bytes[4]}));
  }
  if (reader.remaining() !== 0) throw new MspPayloadReadError('MSP_VOLTAGE_METER_CONFIG has trailing bytes outside declared subframes.');
  return Object.freeze(meters);
}

export function decodeCurrentMeterConfiguration(payload: Uint8Array): readonly MspCurrentMeterConfiguration[] {
  const reader = new MspPayloadReader(payload); const count = reader.readU8(); const meters: MspCurrentMeterConfiguration[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = reader.readU8(); const bytes = reader.readBytes(length); if (length !== 6) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    meters.push(Object.freeze({id: bytes[0], sensorType: bytes[1], scale: view.getInt16(2, true), offset: view.getInt16(4, true)}));
  }
  if (reader.remaining() !== 0) throw new MspPayloadReadError('MSP_CURRENT_METER_CONFIG has trailing bytes outside declared subframes.');
  return Object.freeze(meters);
}
