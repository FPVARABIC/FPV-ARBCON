/**
 * P2-ii - THE PURE STOP PROJECTION, TESTED BEFORE IT IS ROUTED.
 *
 * The previous stop migration compiled and then failed ~20 legacy
 * assertions because the translation invented fields it could not
 * observe. This suite exists so that never happens silently again: the
 * mapping is proven here, on pure data, before `requestStop` is allowed
 * to depend on it.
 *
 * Nothing here touches a lease, a transport or a device, and nothing
 * asserts a physical outcome.
 */
import {
  EMPTY_LEGACY_STOP_RECORD,
  projectStopOutcomeKind,
  projectStopOutcomeToLegacyRecord,
  stopOutcomeIsUnsafe,
  stopPermitsVerificationReceipt,
  type LegacyStopExecutionRecord,
} from './motorStopExecutionProjection';
import type {
  MotorControlStopAttribution,
  MotorControlStopOutcome,
} from './motorControlCommandEngine';

const attribution = (
  over: Partial<MotorControlStopAttribution> = {},
): MotorControlStopAttribution =>
  Object.freeze({
    deferredBehindActiveWrite: false,
    attributionAmbiguous: false,
    resolvedByConfirmation: false,
    stopFramesDispatched: 1,
    ...over,
  });

const acknowledged = (
  over: Partial<MotorControlStopAttribution> = {},
): MotorControlStopOutcome => ({
  kind: 'ACKNOWLEDGED',
  dshotSupplemental: 'PENDING',
  attribution: attribution(over),
});

const failed = (
  reason: 'REQUEST_FAILED' | 'AUTHORITY_CHANGED' | 'ATTRIBUTION_AMBIGUOUS',
  over: Partial<MotorControlStopAttribution> = {},
): MotorControlStopOutcome => ({
  kind: 'FAILED',
  reason,
  attribution: attribution(over),
});

const project = (
  outcome: MotorControlStopOutcome,
  previous: LegacyStopExecutionRecord = EMPTY_LEGACY_STOP_RECORD,
  episodeId = 1,
): LegacyStopExecutionRecord =>
  projectStopOutcomeToLegacyRecord(outcome, {previous, episodeId});

/* ------------------------------------------------------------------ *
 * 1-2. Clean stop, and stop while an active write was in flight
 * ------------------------------------------------------------------ */

describe('projection - clean stop', () => {
  it('records a dispatched, acknowledged, non-ambiguous stop', () => {
    const record = project(acknowledged());
    expect(record).toMatchObject({
      attempts: 1,
      commandDispatched: true,
      commandAcknowledged: true,
      deferredBehindActiveWrite: false,
      attributionAmbiguous: false,
      attributionResolvedByConfirmation: false,
      submittedNextOnTransport: true,
      episodeId: 1,
      outcome: {kind: 'ACKNOWLEDGED'},
    });
  });

  it('NEVER claims a physical stop, and never claims wire preemption', () => {
    const record = project(acknowledged());
    expect(record.physicalStopConfirmed).toBe(false);
    expect(record.wirePreemptionClaimed).toBe(false);
  });

  it('carries deferredBehindActiveWrite through from the engine', () => {
    // The stop registered while an uncancellable write was in flight, so
    // no deterministic latency bound may be claimed for it.
    const record = project(acknowledged({deferredBehindActiveWrite: true}));
    expect(record.deferredBehindActiveWrite).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3-5. Attribution ambiguity
 * ------------------------------------------------------------------ */

describe('projection - attribution ambiguity', () => {
  it('records an ambiguity that a confirmation stop resolved', () => {
    const record = project(
      acknowledged({
        attributionAmbiguous: true,
        resolvedByConfirmation: true,
        stopFramesDispatched: 2,
      }),
    );
    // BOTH facts survive: the ambiguity happened, AND something else
    // supplied the proof. Clearing the first would erase the history.
    expect(record.attributionAmbiguous).toBe(true);
    expect(record.attributionResolvedByConfirmation).toBe(true);
    expect(record.outcome).toEqual({kind: 'ACKNOWLEDGED'});
  });

  it('an UNRESOLVED ambiguity is a failure, never an acknowledgement', () => {
    const record = project(
      failed('ATTRIBUTION_AMBIGUOUS', {
        attributionAmbiguous: true,
        stopFramesDispatched: 2,
      }),
    );
    expect(record.commandAcknowledged).toBe(false);
    expect(record.attributionResolvedByConfirmation).toBe(false);
    expect(record.outcome).toEqual({
      kind: 'FAILED',
      reason: 'ATTRIBUTION_AMBIGUOUS',
    });
  });

  it('an unresolved ambiguity yields NO verification receipt', () => {
    expect(
      stopPermitsVerificationReceipt(
        failed('ATTRIBUTION_AMBIGUOUS', {attributionAmbiguous: true}),
      ),
    ).toBe(false);
  });

  it('a RESOLVED ambiguity still permits a receipt', () => {
    expect(
      stopPermitsVerificationReceipt(
        acknowledged({attributionAmbiguous: true, resolvedByConfirmation: true}),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 7-8. Failures
 * ------------------------------------------------------------------ */

describe('projection - failures', () => {
  it('a failed request still records that a frame was dispatched', () => {
    // The single most important distinction on this path: a stop that was
    // sent and never answered is NOT the same as one never attempted.
    const record = project(failed('REQUEST_FAILED'));
    expect(record.commandDispatched).toBe(true);
    expect(record.commandAcknowledged).toBe(false);
    expect(record.outcome).toEqual({kind: 'FAILED', reason: 'REQUEST_FAILED'});
  });

  it('NOT_ATTEMPTED records no dispatch at all', () => {
    const record = project({
      kind: 'NOT_ATTEMPTED',
      reason: 'AUTHORITY_STALE',
      attribution: attribution({stopFramesDispatched: 0}),
    });
    expect(record.commandDispatched).toBe(false);
    expect(record.submittedNextOnTransport).toBe(false);
    expect(record.outcome).toEqual({
      kind: 'NOT_ATTEMPTED',
      reason: 'AUTHORITY_STALE',
    });
  });

  it('SCOPE_REJECTED sends nothing and says so', () => {
    const record = project({
      kind: 'SCOPE_REJECTED',
      attribution: attribution({stopFramesDispatched: 0}),
    });
    expect(record.commandDispatched).toBe(false);
    expect(record.outcome).toEqual({kind: 'SCOPE_REJECTED'});
  });

  it('no failure permits a verification receipt', () => {
    for (const outcome of [
      failed('REQUEST_FAILED'),
      failed('AUTHORITY_CHANGED'),
      {kind: 'SCOPE_REJECTED' as const, attribution: attribution()},
      {
        kind: 'NOT_ATTEMPTED' as const,
        reason: 'AUTHORITY_STALE' as const,
        attribution: attribution(),
      },
    ]) {
      expect(stopPermitsVerificationReceipt(outcome)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 9. Repeated stops - monotonic folding
 * ------------------------------------------------------------------ */

describe('projection - repeated stops fold monotonically', () => {
  it('counts attempts and never un-sets a fact that was once true', () => {
    const first = project(
      acknowledged({attributionAmbiguous: true, resolvedByConfirmation: true}),
    );
    // A later, perfectly clean episode must not erase the earlier history.
    const second = project(acknowledged(), first, 2);
    expect(second.attempts).toBe(2);
    expect(second.attributionAmbiguous).toBe(true);
    expect(second.attributionResolvedByConfirmation).toBe(true);
    expect(second.commandAcknowledged).toBe(true);
    // The episode id, however, is the CURRENT one.
    expect(second.episodeId).toBe(2);
  });

  it('a later failure cannot un-acknowledge an earlier success', () => {
    const first = project(acknowledged());
    const second = project(failed('REQUEST_FAILED'), first, 2);
    expect(second.commandAcknowledged).toBe(true);
    // ...but the CURRENT outcome is the failure.
    expect(second.outcome).toEqual({kind: 'FAILED', reason: 'REQUEST_FAILED'});
  });

  it('a later success does not clear an earlier deferred flag', () => {
    const first = project(acknowledged({deferredBehindActiveWrite: true}));
    const second = project(acknowledged(), first, 2);
    expect(second.deferredBehindActiveWrite).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 10. Episode identity is an INPUT, never inferred
 * ------------------------------------------------------------------ */

describe('projection - episode binding', () => {
  it('uses the episode id it was given, not one it derived', () => {
    expect(project(acknowledged(), EMPTY_LEGACY_STOP_RECORD, 7).episodeId).toBe(
      7,
    );
  });

  it('is pure: the same inputs always give the same record', () => {
    const a = project(acknowledged(), EMPTY_LEGACY_STOP_RECORD, 3);
    const b = project(acknowledged(), EMPTY_LEGACY_STOP_RECORD, 3);
    expect(a).toEqual(b);
  });

  it('returns a frozen record and does not mutate its input', () => {
    const previous = project(acknowledged());
    const next = project(failed('REQUEST_FAILED'), previous, 2);
    expect(Object.isFrozen(next)).toBe(true);
    expect(previous.attempts).toBe(1);
    expect(previous.outcome).toEqual({kind: 'ACKNOWLEDGED'});
  });
});

/* ------------------------------------------------------------------ *
 * The stop-uncertainty rule, preserved exactly
 * ------------------------------------------------------------------ */

describe('projection - stop uncertainty', () => {
  it('once a command may have reached the FC, anything but an ACK is unsafe', () => {
    for (const outcome of [
      {kind: 'FAILED' as const, reason: 'REQUEST_FAILED' as const},
      {kind: 'SCOPE_REJECTED' as const},
      {kind: 'NOT_ATTEMPTED' as const, reason: 'AUTHORITY_STALE' as const},
    ]) {
      expect(stopOutcomeIsUnsafe(outcome, true)).toBe(true);
    }
    expect(stopOutcomeIsUnsafe({kind: 'ACKNOWLEDGED'}, true)).toBe(false);
  });

  it('before any command exists, only a genuine failure is unsafe', () => {
    // A session blocked for an unrelated reason must report ITS cause,
    // not a stop uncertainty it never had.
    expect(
      stopOutcomeIsUnsafe(
        {kind: 'NOT_ATTEMPTED', reason: 'AUTHORITY_STALE'},
        false,
      ),
    ).toBe(false);
    expect(stopOutcomeIsUnsafe({kind: 'SCOPE_REJECTED'}, false)).toBe(false);
    expect(
      stopOutcomeIsUnsafe({kind: 'FAILED', reason: 'REQUEST_FAILED'}, false),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Totality
 * ------------------------------------------------------------------ */

describe('projection - totality', () => {
  it('handles every outcome kind the engine can produce', () => {
    const kinds = [
      acknowledged(),
      failed('REQUEST_FAILED'),
      failed('AUTHORITY_CHANGED'),
      failed('ATTRIBUTION_AMBIGUOUS'),
      {kind: 'SCOPE_REJECTED' as const, attribution: attribution()},
      {
        kind: 'NOT_ATTEMPTED' as const,
        reason: 'AUTHORITY_STALE' as const,
        attribution: attribution(),
      },
    ];
    for (const outcome of kinds) {
      expect(projectStopOutcomeKind(outcome)).toBeDefined();
      expect(() => project(outcome)).not.toThrow();
    }
  });

  it('a DShot stop that was unsupported does NOT downgrade the stop', () => {
    // The all-stop VECTOR was acknowledged; that is the stop the ordinary
    // control path honours. An FC without MSP2 is not a failed stop.
    const outcome: MotorControlStopOutcome = {
      kind: 'ACKNOWLEDGED',
      dshotSupplemental: 'UNSUPPORTED',
      attribution: attribution(),
    };
    expect(projectStopOutcomeKind(outcome)).toEqual({kind: 'ACKNOWLEDGED'});
    expect(stopPermitsVerificationReceipt(outcome)).toBe(true);
  });
});
