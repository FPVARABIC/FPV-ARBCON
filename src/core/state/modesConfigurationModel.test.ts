import type {MspModesConfiguration} from '../protocol/msp/decoding/decodeModes';
import {conditionsForMode, createModesConfigurationDraft, modeArabicName, modeIsActive, validateModesDraft} from './modesConfigurationModel';

function snapshot(): MspModesConfiguration {
  return {
    definitions: [
      {name: 'ARM', permanentId: 0, flagIndex: 0},
      {name: 'ANGLE', permanentId: 1, flagIndex: 1},
      {name: 'BEEPER', permanentId: 13, flagIndex: 40},
    ],
    capacity: 3,
    slots: [
      {permanentId: 1, auxChannelIndex: 2, start: 1200, end: 1600, logic: 0, linkedTo: 0},
      {permanentId: 13, auxChannelIndex: 0, start: 900, end: 900, logic: 1, linkedTo: 1},
      {permanentId: 0, auxChannelIndex: 0, start: 900, end: 900, logic: 0, linkedTo: 0},
    ],
  };
}

describe('Modes configuration model', () => {
  it('removes empty FC slots while preserving range and linked conditions', () => {
    const draft = createModesConfigurationDraft(snapshot());
    expect(draft.conditions).toEqual([
      {kind: 'RANGE', permanentId: 1, auxChannelIndex: 2, start: 1200, end: 1600, logic: 0},
      {kind: 'LINK', permanentId: 13, linkedTo: 1, logic: 1},
    ]);
    expect(conditionsForMode(draft, 13)).toHaveLength(1);
  });

  it('rejects invalid AUX, non-grid ranges, unsafe links and overflow', () => {
    const base = createModesConfigurationDraft(snapshot());
    expect(validateModesDraft(base, snapshot())).toEqual([]);
    expect(validateModesDraft({conditions: [{kind: 'RANGE', permanentId: 1, auxChannelIndex: 14, start: 1200, end: 1600, logic: 0}]}, snapshot())).toContain('AUX_CHANNEL_INVALID');
    expect(validateModesDraft({conditions: [{kind: 'RANGE', permanentId: 1, auxChannelIndex: 0, start: 1210, end: 1600, logic: 0}]}, snapshot())).toContain('RANGE_INVALID');
    expect(validateModesDraft({conditions: [{kind: 'LINK', permanentId: 0, linkedTo: 1, logic: 0}]}, snapshot())).toContain('ARM_LINK_FORBIDDEN');
    expect(validateModesDraft({conditions: [{kind: 'LINK', permanentId: 1, linkedTo: 1, logic: 0}]}, snapshot())).toContain('LINK_INVALID');
    expect(validateModesDraft({conditions: [...base.conditions, ...base.conditions]}, snapshot())).toContain('TOO_MANY_CONDITIONS');
  });

  it('reads packed flags beyond bit 31 and localizes known names', () => {
    expect(modeIsActive(snapshot().definitions[0], 1, undefined)).toBe(true);
    expect(modeIsActive(snapshot().definitions[1], 1, undefined)).toBe(false);
    expect(modeIsActive(snapshot().definitions[2], 0, [0, 1])).toBe(true);
    expect(modeArabicName('ANGLE')).toBe('تثبيت الزاوية');
    expect(modeArabicName('CUSTOM MODE')).toBe('CUSTOM MODE');
  });
});
