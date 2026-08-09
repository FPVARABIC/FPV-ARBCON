/**
 * THE ~98% STALL. The operator reported flashing reaching about 98% and
 * freezing with no phase name, no reason and no safe guidance. These pin
 * the two facts that make that impossible to repeat: 98% is a NAMED
 * phase, and a silent phase is classified rather than retried.
 */

import {
  FLASH_STALL_THRESHOLD_MS,
  buildFlashReport,
  evaluateFlashStall,
  flashPhaseLabelKey,
  toFlashPhase,
} from './flashPhaseModel';
import type {FlashProgressSnapshot} from './flashPhaseModel';

function snapshotOf(
  overrides: Partial<FlashProgressSnapshot> = {},
): FlashProgressSnapshot {
  return {
    method: 'DFU_WEBUSB',
    phase: 'VERIFYING',
    percent: 98,
    bytesProcessed: 400_000,
    totalBytes: 410_000,
    lastProgressAtMs: 10_000,
    startedAtMs: 0,
    transferMayBePending: true,
    ...overrides,
  };
}

describe('toFlashPhase', () => {
  it.each([
    ['erasing', 'ERASING'],
    ['writing', 'WRITING'],
    ['verifying', 'VERIFYING'],
    ['finalizing', 'FINALIZING'],
    ['manifesting', 'MANIFESTING'],
    ['resetting', 'RESETTING'],
    ['complete', 'COMPLETE'],
  ] as const)('maps the transport phase %s to %s', (raw, expected) => {
    expect(toFlashPhase(raw)).toBe(expected);
  });

  it('reports an unrecognised phase as UNKNOWN rather than guessing a neighbour', () => {
    expect(toFlashPhase('something-new')).toBe('UNKNOWN');
    expect(toFlashPhase(undefined)).toBe('UNKNOWN');
    expect(toFlashPhase('')).toBe('UNKNOWN');
  });

  it('every phase has a translation key under one namespace', () => {
    expect(flashPhaseLabelKey('MANIFESTING')).toBe(
      'firmwareFlasher.phase.MANIFESTING',
    );
  });
});

describe('evaluateFlashStall', () => {
  it('a phase making progress is never stalled', () => {
    const snapshot = snapshotOf({phase: 'WRITING', lastProgressAtMs: 10_000});
    expect(evaluateFlashStall(snapshot, 12_000).stalled).toBe(false);
  });

  it('THE FIELD CASE: verification silent past its own threshold is classified STALLED', () => {
    const snapshot = snapshotOf({phase: 'VERIFYING', lastProgressAtMs: 10_000});
    const verdict = evaluateFlashStall(
      snapshot,
      10_000 + FLASH_STALL_THRESHOLD_MS.VERIFYING,
    );
    expect(verdict.stalled).toBe(true);
    expect(verdict.silentForMs).toBe(FLASH_STALL_THRESHOLD_MS.VERIFYING);
  });

  it('manifestation gets a LONGER window than writing, because the board resets inside it', () => {
    expect(FLASH_STALL_THRESHOLD_MS.MANIFESTING).toBeGreaterThan(
      FLASH_STALL_THRESHOLD_MS.WRITING,
    );
    const snapshot = snapshotOf({phase: 'MANIFESTING', lastProgressAtMs: 0});
    expect(
      evaluateFlashStall(snapshot, FLASH_STALL_THRESHOLD_MS.WRITING + 1).stalled,
    ).toBe(false);
  });

  it('a completed or failed operation can never be reported as stalled', () => {
    for (const phase of ['COMPLETE', 'FAILED'] as const) {
      const snapshot = snapshotOf({phase, lastProgressAtMs: 0});
      expect(evaluateFlashStall(snapshot, 10_000_000).stalled).toBe(false);
    }
  });

  it('a clock that runs backwards never produces a negative silence', () => {
    const snapshot = snapshotOf({lastProgressAtMs: 10_000});
    expect(evaluateFlashStall(snapshot, 5_000).silentForMs).toBe(0);
  });
});

describe('buildFlashReport', () => {
  it('names the method, the exact phase and the last completed operation', () => {
    const report = buildFlashReport(
      snapshotOf({
        phase: 'MANIFESTING',
        percent: 99,
        blockNumber: 812,
        targetIdentity: 'STM32 BOOTLOADER 0483:df11',
        lastCompletedOperation: 'verify block 811',
      }),
      60_000,
      {buildIdentity: 'abc1234', lastErrorCode: 'DFU_TRANSFER_FAILED'},
    );
    expect(report).toContain('الطريقة: DFU_WEBUSB');
    expect(report).toContain('المرحلة: MANIFESTING');
    expect(report).toContain('رقم الكتلة: 812');
    expect(report).toContain('آخر عملية مكتملة: verify block 811');
    expect(report).toContain('STM32 BOOTLOADER 0483:df11');
    expect(report).toContain('آخر كود خطأ: DFU_TRANSFER_FAILED');
    expect(report).toContain('البنية: abc1234');
  });

  it('states explicitly that a pending WebUSB transfer cannot be cancelled', () => {
    const report = buildFlashReport(snapshotOf(), 20_000);
    expect(report).toContain('قد يكون نقل المتصفح ما زال معلّقًا: نعم');
    expect(report).toContain('لا يمكن إلغاء نقل WebUSB');
  });

  it('prints an unavailable fact as unavailable, never as a plausible zero', () => {
    const report = buildFlashReport(
      snapshotOf({blockNumber: undefined, targetIdentity: undefined}),
      20_000,
    );
    expect(report).toContain('رقم الكتلة: غير متاح');
    expect(report).toContain('الجهاز الهدف: غير متاح');
    expect(report).not.toContain('رقم الكتلة: 0');
  });

  it('carries no firmware content and no payload bytes - it is counters and codes only', () => {
    const report = buildFlashReport(
      snapshotOf({lastCompletedOperation: 'write block 40'}),
      20_000,
    );
    expect(report).not.toMatch(/Uint8Array/);
    expect(report).not.toMatch(/0x[0-9a-f]{8,}/i);
  });
});
