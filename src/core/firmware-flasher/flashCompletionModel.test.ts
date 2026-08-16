/**
 * THE TERMINAL-STATE TRUTH TABLE.
 *
 * classifyDfuOverrun decides what a FROZEN WebUSB transfer means, and
 * classifyFlashRejection decides what a settled rejection means to the
 * operator. Both are the safety argument of the 98%-stall fix in table
 * form, so every row the brief pinned is asserted here:
 *
 *  - a deadline is NEVER converted into SUCCESS by itself;
 *  - the ONE success-from-overrun case carries the full evidence triple
 *    (all bytes verified + manifestation issued + device physically
 *    gone) - the same evidence the Android worker and the pinned
 *    Betaflight reference accept for a post-manifestation reset;
 *  - a still-present-but-silent board is never success;
 *  - a device that vanished BEFORE the manifestation was issued is not
 *    blessed either - unexpected disappearance stays UNCONFIRMED;
 *  - an incomplete image (erase/write freeze) is a stated FAILURE.
 */

import {
  DFU_CODE_UNCONFIRMED_MANIFEST,
  DFU_CODE_UNCONFIRMED_VERIFY,
  DFU_CODE_UNRESPONSIVE_ERASE,
  DFU_CODE_UNRESPONSIVE_WRITE,
  FLASH_CODE_UI_BACKSTOP,
  classifyDfuOverrun,
  classifyFlashRejection,
  flashNextActionLabelKey,
  flashReasonLabelKey,
} from './flashCompletionModel';
import type {DfuOverrunEvidence} from './flashCompletionModel';

function evidence(over: Partial<DfuOverrunEvidence>): DfuOverrunEvidence {
  return {
    stage: 'MANIFEST',
    allBytesWritten: true,
    allBytesVerified: true,
    manifestationRequested: true,
    deviceGone: true,
    ...over,
  };
}

describe('classifyDfuOverrun', () => {
  it('accepts the expected post-manifestation disappearance as SUCCESS - full evidence only', () => {
    expect(classifyDfuOverrun(evidence({}))).toEqual({outcome: 'SUCCESS'});
  });

  it('a still-present, silent board is NEVER success, even fully verified', () => {
    expect(classifyDfuOverrun(evidence({deviceGone: false}))).toEqual({
      outcome: 'UNCONFIRMED',
      code: DFU_CODE_UNCONFIRMED_MANIFEST,
    });
  });

  it('a device that vanished BEFORE the manifestation was issued is not blessed', () => {
    expect(
      classifyDfuOverrun(
        evidence({stage: 'FINALIZE', manifestationRequested: false}),
      ),
    ).toEqual({outcome: 'UNCONFIRMED', code: DFU_CODE_UNCONFIRMED_MANIFEST});
  });

  it('a manifestation freeze without complete verification is not blessed either', () => {
    expect(
      classifyDfuOverrun(evidence({allBytesVerified: false})),
    ).toEqual({outcome: 'UNCONFIRMED', code: DFU_CODE_UNCONFIRMED_MANIFEST});
  });

  it('a verify-stage freeze is UNCONFIRMED: written and acknowledged, but unproven', () => {
    expect(
      classifyDfuOverrun(
        evidence({
          stage: 'VERIFY',
          allBytesVerified: false,
          manifestationRequested: false,
          deviceGone: false,
        }),
      ),
    ).toEqual({outcome: 'UNCONFIRMED', code: DFU_CODE_UNCONFIRMED_VERIFY});
  });

  it.each([
    ['OPEN', DFU_CODE_UNRESPONSIVE_ERASE],
    ['ERASE', DFU_CODE_UNRESPONSIVE_ERASE],
    ['WRITE', DFU_CODE_UNRESPONSIVE_WRITE],
  ] as const)('an incomplete image (%s freeze) is a stated FAILURE', (stage, code) => {
    const verdict = classifyDfuOverrun(
      evidence({
        stage,
        allBytesWritten: false,
        allBytesVerified: false,
        manifestationRequested: false,
        deviceGone: false,
      }),
    );
    expect(verdict).toEqual({outcome: 'FAILED', code});
  });

  it('device disappearance during WRITE does not upgrade the failure', () => {
    // Item 5 of the contract: an UNEXPECTED disappearance is never
    // accepted as success. Mid-write it is a failure like any other.
    expect(
      classifyDfuOverrun(
        evidence({
          stage: 'WRITE',
          allBytesWritten: false,
          allBytesVerified: false,
          manifestationRequested: false,
          deviceGone: true,
        }),
      ),
    ).toEqual({outcome: 'FAILED', code: DFU_CODE_UNRESPONSIVE_WRITE});
  });
});

describe('classifyFlashRejection', () => {
  it('never returns SUCCESS for any code - a rejection has no completion evidence', () => {
    for (const code of [
      undefined,
      'DFU_VERIFY_FAILED',
      'DFU_TRANSFER_FAILED',
      'DFU_CANCELLED',
      DFU_CODE_UNCONFIRMED_VERIFY,
      'anything-else',
    ]) {
      expect(['FAILED', 'UNCONFIRMED']).toContain(
        classifyFlashRejection(code, 'MANIFESTING'),
      );
    }
  });

  it('passes the engine UNCONFIRMED codes through regardless of phase', () => {
    expect(classifyFlashRejection(DFU_CODE_UNCONFIRMED_VERIFY, undefined)).toBe('UNCONFIRMED');
    expect(classifyFlashRejection(DFU_CODE_UNCONFIRMED_MANIFEST, 'WRITING')).toBe('UNCONFIRMED');
    expect(classifyFlashRejection(FLASH_CODE_UI_BACKSTOP, undefined)).toBe('UNCONFIRMED');
  });

  it("maps Android's manifestation-window DFU_STATUS_TIMEOUT to UNCONFIRMED, and only there", () => {
    // The Kotlin worker throws DFU_STATUS_TIMEOUT from waitForManifestation
    // when a still-present board never confirms its reset - the same
    // present-but-silent situation the web engine names explicitly.
    expect(classifyFlashRejection('DFU_STATUS_TIMEOUT', 'MANIFESTING')).toBe('UNCONFIRMED');
    expect(classifyFlashRejection('DFU_STATUS_TIMEOUT', 'RESETTING')).toBe('UNCONFIRMED');
    // Everywhere else the same code is an ordinary failure (idle/erase
    // polling never reached its state - nothing completed).
    expect(classifyFlashRejection('DFU_STATUS_TIMEOUT', 'ERASING')).toBe('FAILED');
    expect(classifyFlashRejection('DFU_STATUS_TIMEOUT', undefined)).toBe('FAILED');
  });

  it('verify mismatch is FAILED - never softened into unconfirmed', () => {
    expect(classifyFlashRejection('DFU_VERIFY_FAILED', 'VERIFYING')).toBe('FAILED');
  });

  it('cancellation is FAILED with its own stated reason, not a hang and not a success', () => {
    expect(classifyFlashRejection('DFU_CANCELLED', 'WRITING')).toBe('FAILED');
  });
});

describe('label keys', () => {
  it('reason keys are addressed per code', () => {
    expect(flashReasonLabelKey('DFU_VERIFY_FAILED')).toBe(
      'firmwareFlasher.reason.DFU_VERIFY_FAILED',
    );
  });

  it('next-action keys distinguish the two unconfirmed situations', () => {
    expect(flashNextActionLabelKey(DFU_CODE_UNCONFIRMED_VERIFY)).toBe(
      'firmwareFlasher.nextAction.VERIFY_UNFINISHED',
    );
    expect(flashNextActionLabelKey(DFU_CODE_UNCONFIRMED_MANIFEST)).toBe(
      'firmwareFlasher.nextAction.MANIFEST_SILENT',
    );
    expect(flashNextActionLabelKey(undefined)).toBe(
      'firmwareFlasher.nextAction.GENERIC',
    );
  });
});
