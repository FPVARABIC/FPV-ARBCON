/**
 * M-F3 §17/§18 - the direction workflow's per-motor status machine,
 * pinned row by row.
 *
 * The hard rule under mutation: NO event whose only evidence is a flight
 * controller acknowledgement may land on a CONFIRMED_* status. The
 * reverse command is write-only (no readback exists on the audited MSP
 * surface), so "confirmed" can only ever follow the operator's own
 * answer.
 */

import {
  motorDirectionWorkflowStatusKey,
  nextMotorDirectionWorkflowStatus,
  type MotorDirectionWorkflowStatus,
} from './motorDirectionWorkflow';

const ALL: readonly MotorDirectionWorkflowStatus[] = [
  'UNCHECKED',
  'CONFIRMED_CORRECT',
  'NEEDS_REVERSE',
  'REVERSED_RECHECK',
  'CONFIRMED_FINAL',
];

describe('nextMotorDirectionWorkflowStatus - the full hand-written table', () => {
  it('a first correct answer lands on CONFIRMED_CORRECT', () => {
    expect(
      nextMotorDirectionWorkflowStatus('UNCHECKED', {kind: 'ANSWER_CORRECT'}),
    ).toBe('CONFIRMED_CORRECT');
  });

  it('the recheck after a reversal is the FINAL confirmation - it keeps the reversal in its history', () => {
    expect(
      nextMotorDirectionWorkflowStatus('REVERSED_RECHECK', {
        kind: 'ANSWER_CORRECT',
      }),
    ).toBe('CONFIRMED_FINAL');
  });

  it('re-answering correct from any non-recheck state is CONFIRMED_CORRECT', () => {
    for (const from of [
      'CONFIRMED_CORRECT',
      'NEEDS_REVERSE',
      'CONFIRMED_FINAL',
    ] as const) {
      expect(
        nextMotorDirectionWorkflowStatus(from, {kind: 'ANSWER_CORRECT'}),
      ).toBe('CONFIRMED_CORRECT');
    }
  });

  it('a wrong answer overrides EVERY prior state - the operator just watched it', () => {
    for (const from of ALL) {
      expect(
        nextMotorDirectionWorkflowStatus(from, {kind: 'ANSWER_WRONG'}),
      ).toBe('NEEDS_REVERSE');
    }
  });

  it('§17 - an acknowledgement NEVER confirms: every state maps to REVERSED_RECHECK', () => {
    for (const from of ALL) {
      const next = nextMotorDirectionWorkflowStatus(from, {
        kind: 'REVERSE_ACKNOWLEDGED',
      });
      expect(next).toBe('REVERSED_RECHECK');
      expect(next).not.toBe('CONFIRMED_CORRECT');
      expect(next).not.toBe('CONFIRMED_FINAL');
    }
  });

  it('no transition invents a status outside the five-state union', () => {
    const events = [
      {kind: 'ANSWER_CORRECT'},
      {kind: 'ANSWER_WRONG'},
      {kind: 'REVERSE_ACKNOWLEDGED'},
    ] as const;
    for (const from of ALL) {
      for (const event of events) {
        expect(ALL).toContain(nextMotorDirectionWorkflowStatus(from, event));
      }
    }
  });
});

describe('motorDirectionWorkflowStatusKey - one key per status, all distinct', () => {
  it('maps every status to its own key', () => {
    const keys = ALL.map(motorDirectionWorkflowStatusKey);
    expect(keys).toEqual([
      'directionStatusUnchecked',
      'directionStatusCorrect',
      'directionStatusNeedsReverse',
      'directionStatusReversedRecheck',
      'directionStatusConfirmed',
    ]);
    expect(new Set(keys).size).toBe(ALL.length);
  });
});
