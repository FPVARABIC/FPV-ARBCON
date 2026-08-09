import type {MspModesConfiguration} from '../decoding/decodeModes';
import {createModesConfigurationDraft} from '../../../state/modesConfigurationModel';
import {encodeModeRangeWrites} from './encodeModes';

const snapshot: MspModesConfiguration = {
  definitions: [
    {name: 'ARM', permanentId: 0, flagIndex: 0},
    {name: 'ANGLE', permanentId: 1, flagIndex: 1},
    {name: 'BEEPER', permanentId: 13, flagIndex: 2},
  ],
  capacity: 20,
  slots: Array.from({length: 20}, () => ({permanentId: 0, auxChannelIndex: 0, start: 900, end: 900, logic: 0 as const, linkedTo: 0})),
};

describe('encodeModeRangeWrites', () => {
  it('returns no writes for an unchanged draft', () => {
    expect(encodeModeRangeWrites(snapshot, createModesConfigurationDraft(snapshot))).toEqual([]);
  });

  it('rewrites every FC slot so removed conditions cannot survive', () => {
    const writes = encodeModeRangeWrites(snapshot, {conditions: [
      {kind: 'RANGE', permanentId: 1, auxChannelIndex: 2, start: 1200, end: 1600, logic: 1},
      {kind: 'LINK', permanentId: 13, linkedTo: 1, logic: 0},
    ]});
    expect(writes).toHaveLength(20);
    expect([...writes[0].payload]).toEqual([0, 1, 2, 12, 28, 1, 0]);
    expect([...writes[1].payload]).toEqual([1, 13, 0, 0, 0, 0, 1]);
    expect([...writes[19].payload]).toEqual([19, 0, 0, 0, 0, 0, 0]);
  });
});
