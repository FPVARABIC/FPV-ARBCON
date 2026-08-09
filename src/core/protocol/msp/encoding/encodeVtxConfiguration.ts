/* eslint-disable no-bitwise -- VTX payloads are byte-oriented wire values. */
import type { MspVtxSnapshot } from '../decoding/decodeVtxConfiguration';
import {
  createVtxConfigurationDraft,
  validateVtxDraft,
  vtxDraftsEqual,
  type VtxConfigurationDraft,
} from '../../../state/vtxConfigurationModel';
export type VtxWriteGroup = 'CONFIG' | 'BAND' | 'POWER_LEVEL';
export interface EncodedVtxWrite {
  readonly group: VtxWriteGroup;
  readonly index?: number;
  readonly payload: Uint8Array;
}
function bytes(text: string): number[] {
  return Array.from(text, character => character.charCodeAt(0) & 0xff);
}
export function encodeChangedVtxConfiguration(
  snapshot: MspVtxSnapshot,
  draft: VtxConfigurationDraft,
): readonly EncodedVtxWrite[] {
  if (validateVtxDraft(draft, snapshot).length > 0)
    throw new RangeError('Invalid VTX configuration draft.');
  const original = createVtxConfigurationDraft(snapshot);
  if (vtxDraftsEqual(original, draft)) return Object.freeze([]);
  const writes: EncodedVtxWrite[] = [];
  const configChanged = [
    'band',
    'channel',
    'power',
    'pitMode',
    'frequencyMhz',
    'lowPowerDisarm',
    'pitModeFrequencyMhz',
  ].some(
    key =>
      original[key as keyof VtxConfigurationDraft] !==
      draft[key as keyof VtxConfigurationDraft],
  );
  if (configChanged) {
    const payload = new Uint8Array(15);
    const view = new DataView(payload.buffer);
    view.setUint16(0, draft.frequencyMhz, true);
    payload[2] = draft.power;
    payload[3] = draft.pitMode ? 1 : 0;
    payload[4] = draft.lowPowerDisarm;
    view.setUint16(5, draft.pitModeFrequencyMhz, true);
    payload[7] = draft.band;
    payload[8] = draft.channel;
    view.setUint16(9, draft.frequencyMhz, true);
    payload[11] = draft.bands.length;
    payload[12] = snapshot.config.channelCount;
    payload[13] = draft.powerLevels.length;
    payload[14] = 0;
    writes.push(Object.freeze({ group: 'CONFIG', payload }));
  }
  draft.bands.forEach((band, index) => {
    if (JSON.stringify(band) === JSON.stringify(original.bands[index])) return;
    const name = bytes(band.name);
    const payload = new Uint8Array(
      1 + 1 + name.length + 1 + 1 + 1 + band.frequenciesMhz.length * 2,
    );
    const view = new DataView(payload.buffer);
    let o = 0;
    payload[o++] = band.number;
    payload[o++] = name.length;
    payload.set(name, o);
    o += name.length;
    payload[o++] = band.letter.charCodeAt(0) & 0xff;
    payload[o++] = band.factory ? 1 : 0;
    payload[o++] = band.frequenciesMhz.length;
    band.frequenciesMhz.forEach(frequency => {
      view.setUint16(o, frequency, true);
      o += 2;
    });
    writes.push(Object.freeze({ group: 'BAND', index: band.number, payload }));
  });
  draft.powerLevels.forEach((level, index) => {
    if (JSON.stringify(level) === JSON.stringify(original.powerLevels[index]))
      return;
    const label = bytes(level.label);
    const payload = new Uint8Array(4 + label.length);
    const view = new DataView(payload.buffer);
    payload[0] = level.number;
    view.setUint16(1, level.value, true);
    payload[3] = label.length;
    payload.set(label, 4);
    writes.push(
      Object.freeze({ group: 'POWER_LEVEL', index: level.number, payload }),
    );
  });
  return Object.freeze(writes);
}
