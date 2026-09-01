import {MspPayloadReader} from './MspPayloadReader';

export interface MspBatteryConfiguration {readonly minCellCentivolts: number; readonly maxCellCentivolts: number; readonly warningCellCentivolts: number; readonly capacityMah: number; readonly voltageMeterSource: number; readonly currentMeterSource: number}
export interface MspVoltageMeterConfiguration {readonly id: number; readonly sensorType: number; readonly scale: number; readonly divider: number; readonly multiplier: number}
export interface MspCurrentMeterConfiguration {readonly id: number; readonly sensorType: number; readonly scale: number; readonly offset: number}
export interface MspPowerConfigurationSnapshot {readonly battery: MspBatteryConfiguration; readonly voltageMeters: readonly MspVoltageMeterConfiguration[]; readonly currentMeters: readonly MspCurrentMeterConfiguration[]}

/**
 * READS THE BATTERY CONFIGURATION AS SENT.
 *
 * This demanded exactly 13 bytes. Betaflight reads the nine fields
 * positionally with no length check at all (src/js/msp/MSPHelper.js,
 * `case MSPCodes.MSP_BATTERY_CONFIG`), so a firmware one byte longer or
 * shorter still opens its Power tab. Ours refused to open at all - on the
 * screen that carries cell-count and low-voltage warning settings.
 *
 * Betaflight's own handler reads the legacy u8 decivolt fields first and
 * then OVERWRITES them with the u16 centivolt fields that follow; the
 * three skipped reads below are those same legacy bytes, and the u16
 * fields are what this app keeps.
 */
export function decodeBatteryConfiguration(payload: Uint8Array): MspBatteryConfiguration {
  const reader = new MspPayloadReader(payload, {lenient: true});
  reader.readU8(); reader.readU8(); reader.readU8();
  const capacityMah = reader.readU16LE(); const voltageMeterSource = reader.readU8(); const currentMeterSource = reader.readU8();
  const minCellCentivolts = reader.readU16LE(); const maxCellCentivolts = reader.readU16LE(); const warningCellCentivolts = reader.readU16LE();
  return Object.freeze({minCellCentivolts, maxCellCentivolts, warningCellCentivolts, capacityMah, voltageMeterSource, currentMeterSource});
}

export function decodeVoltageMeterConfiguration(payload: Uint8Array): readonly MspVoltageMeterConfiguration[] {
  const reader = new MspPayloadReader(payload, {lenient: true}); const count = reader.readU8(); const meters: MspVoltageMeterConfiguration[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = reader.readU8(); const bytes = reader.readBytes(length); if (length !== 5) continue;
    meters.push(Object.freeze({id: bytes[0], sensorType: bytes[1], scale: bytes[2], divider: bytes[3], multiplier: bytes[4]}));
  }
  // Trailing bytes beyond the declared subframes belong to a firmware
  // newer than this build; Betaflight ignores them, so do we.
  return Object.freeze(meters);
}

export function decodeCurrentMeterConfiguration(payload: Uint8Array): readonly MspCurrentMeterConfiguration[] {
  const reader = new MspPayloadReader(payload, {lenient: true}); const count = reader.readU8(); const meters: MspCurrentMeterConfiguration[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = reader.readU8(); const bytes = reader.readBytes(length); if (length !== 6) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    meters.push(Object.freeze({id: bytes[0], sensorType: bytes[1], scale: view.getInt16(2, true), offset: view.getInt16(4, true)}));
  }
  // As above: extra trailing bytes are ignored, never fatal.
  return Object.freeze(meters);
}
