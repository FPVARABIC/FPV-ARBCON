import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

export interface MspVtxConfiguration {readonly deviceType: number; readonly band: number; readonly channel: number; readonly power: number; readonly pitMode: boolean; readonly frequencyMhz: number; readonly deviceReady: boolean; readonly lowPowerDisarm: number; readonly pitModeFrequencyMhz: number; readonly tableAvailable: boolean; readonly bandCount: number; readonly channelCount: number; readonly powerLevelCount: number}
export interface MspVtxBand {readonly number: number; readonly name: string; readonly letter: string; readonly factory: boolean; readonly frequenciesMhz: readonly number[]}
export interface MspVtxPowerLevel {readonly number: number; readonly value: number; readonly label: string}
export interface MspVtxSnapshot {readonly config: MspVtxConfiguration; readonly bands: readonly MspVtxBand[]; readonly powerLevels: readonly MspVtxPowerLevel[]}

function ascii(bytes: Uint8Array): string {return Array.from(bytes, value => String.fromCharCode(value)).join('').replace(/\0+$/u, '').trimEnd();}
/**
 * Betaflight reads these fifteen fields positionally with no length check
 * (src/js/msp/MSPHelper.js, `case MSPCodes.MSP_VTX_CONFIG`), and its own
 * source marks the tail "Introduced in API version 1.42" - meaning older
 * firmware genuinely sends fewer bytes and its VTX tab still opens.
 * Demanding exactly 15 made ours refuse to open instead.
 */
export function decodeVtxConfiguration(payload: Uint8Array): MspVtxConfiguration {const r = new MspPayloadReader(payload, {lenient: true}); return Object.freeze({deviceType: r.readU8(), band: r.readU8(), channel: r.readU8(), power: r.readU8(), pitMode: r.readU8() !== 0, frequencyMhz: r.readU16LE(), deviceReady: r.readU8() !== 0, lowPowerDisarm: r.readU8(), pitModeFrequencyMhz: r.readU16LE(), tableAvailable: r.readU8() !== 0, bandCount: r.readU8(), channelCount: r.readU8(), powerLevelCount: r.readU8()});}
export function decodeVtxBand(payload: Uint8Array): MspVtxBand {const r = new MspPayloadReader(payload); const number = r.readU8(); const name = ascii(r.readBytes(r.readU8())); const letter = String.fromCharCode(r.readU8()); const factory = r.readU8() !== 0; const count = r.readU8(); const frequenciesMhz: number[] = []; for (let i = 0; i < count; i += 1) frequenciesMhz.push(r.readU16LE()); if (r.remaining() !== 0) throw new MspPayloadReadError('MSP_VTXTABLE_BAND has trailing bytes.'); return Object.freeze({number, name, letter, factory, frequenciesMhz: Object.freeze(frequenciesMhz)});}
export function decodeVtxPowerLevel(payload: Uint8Array): MspVtxPowerLevel {const r = new MspPayloadReader(payload); const number = r.readU8(); const value = r.readU16LE(); const label = ascii(r.readBytes(r.readU8())); if (r.remaining() !== 0) throw new MspPayloadReadError('MSP_VTXTABLE_POWERLEVEL has trailing bytes.'); return Object.freeze({number, value, label});}
