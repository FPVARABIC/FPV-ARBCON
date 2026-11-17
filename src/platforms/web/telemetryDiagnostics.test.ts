/**
 * The telemetry report's CONTENT contract - what it must carry, and what
 * it must never carry. Clipboard plumbing is deliberately out of scope
 * here (it is the same two-step strategy connectionDiagnostics.test.ts
 * already covers); this file is about whether the evidence is honest.
 */

import {
  buildTelemetryReport,
  recordMspErrorCode,
  recordTelemetryEvent,
  recordTransportErrorCode,
  resetTelemetryDiagnosticsForTests,
} from './telemetryDiagnostics';
import {
  recordBytesReceived,
  recordBytesWritten,
  resetConnectionDiagnosticsForTests,
} from './connectionDiagnostics';
import type {TelemetrySchedulerDiagnostics} from '../../core';

function scheduler(
  overrides: Partial<TelemetrySchedulerDiagnostics> = {},
): TelemetrySchedulerDiagnostics {
  return {
    tickCount: 412,
    inFlightCount: 0,
    pauseReasons: [],
    polls: [
      {
        id: 'attitude',
        command: 108,
        intervalMs: 50,
        staleAfterMs: 500,
        priority: 0,
        requestCount: 205,
        responseCount: 205,
        errorCount: 0,
        lastErrorCode: undefined,
        inFlight: false,
        status: 'FRESH',
        sampleSeq: 205,
        updatedAtMs: 1_000_000,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  resetTelemetryDiagnosticsForTests();
  resetConnectionDiagnosticsForTests();
});

describe('telemetry report - required evidence', () => {
  it('carries the build identity, the session lifecycle, and whether Setup is active', () => {
    const report = buildTelemetryReport({
      sessionId: 'usb-1',
      generation: 3,
      ownershipState: 'ACTIVE',
      identificationStatus: 'SUCCEEDED',
      appStatePhase: 'ACTIVE',
      setupActive: true,
      scheduler: scheduler(),
    });

    expect(report).toContain("Build: dev");
    expect(report).toContain('sessionId: usb-1');
    expect(report).toContain("Gen: 3");
    expect(report).toContain("Eigendomsstatus: ACTIVE");
    expect(report).toContain("Identificatiestatus: SUCCEEDED");
    expect(report).toContain("Setup actief: Ja");
  });

  it('carries per-poll registration, counts, status, sampleSeq and sample age', () => {
    const report = buildTelemetryReport({
      scheduler: scheduler(),
      wallClockMs: 1_000_320,
    });

    expect(report).toContain("attitude: cmd=108 status=FRESH geregistreerd=ja");
    expect(report).toContain("verzoeken=205 antwoorden=205 fouten=0");
    expect(report).toContain('sampleSeq=205');
    expect(report).toContain("meetleeftijd=320ms");
  });

  it('states that a poll is MISSING rather than printing zeros for it', () => {
    const report = buildTelemetryReport({scheduler: scheduler()});
    // The fixture registers attitude only.
    expect(report).toContain("battery: niet geregistreerd (MISSING)");
  });

  it('distinguishes "no scheduler at all" from "a scheduler that sent nothing"', () => {
    const none = buildTelemetryReport({});
    expect(none).toContain("Er is geen telemetrieplanner voor deze sessie.");

    const silent = buildTelemetryReport({
      scheduler: scheduler({
        tickCount: 0,
        polls: [
          {
            id: 'attitude',
            command: 108,
            intervalMs: 50,
            staleAfterMs: 500,
            priority: 0,
            requestCount: 0,
            responseCount: 0,
            errorCount: 0,
            inFlight: false,
            status: 'WAITING',
          },
        ],
      }),
    });
    expect(silent).toContain("tick: 0");
    expect(silent).toContain("verzoeken=0 antwoorden=0");
    expect(silent).not.toContain("Er is geen telemetrieplanner voor deze sessie");
  });

  it('names the reason polling is held off, so a pause is never read as a dead link', () => {
    const report = buildTelemetryReport({
      scheduler: scheduler({pauseReasons: ['MOTOR_TEST', 'APP_BACKGROUND']}),
    });
    expect(report).toContain("Oorzaken van de actieve tijdelijke stop: MOTOR_TEST, APP_BACKGROUND");
  });

  it('carries the enumerated scheduler, MSP and transport error codes', () => {
    recordMspErrorCode('MSP_TIMEOUT');
    recordTransportErrorCode('SESSION_DETACHED');
    const report = buildTelemetryReport({
      scheduler: scheduler({
        polls: [
          {
            id: 'attitude',
            command: 108,
            intervalMs: 50,
            staleAfterMs: 500,
            priority: 0,
            requestCount: 9,
            responseCount: 4,
            errorCount: 5,
            lastErrorCode: 'MSP_RECOVERING',
            inFlight: false,
            status: 'ERROR',
          },
        ],
      }),
    });
    expect(report).toContain("laatsteSchedulerfout=MSP_RECOVERING");
    expect(report).toContain("Laatste MSP-foutcode: MSP_TIMEOUT.");
    expect(report).toContain("Laatste transportfoutcode: SESSION_DETACHED.");
  });

  it('carries the byte counters the transport already recorded, not a second set of its own', () => {
    recordBytesWritten(6);
    recordBytesWritten(6);
    recordBytesReceived(12);
    const report = buildTelemetryReport({});
    expect(report).toContain('bytes: sent=12 (2 writes) received=12 (1 chunks)');
  });

  it('reports whether the renderer was handed a CHANGED pose - the fact that separates a frozen app from a frozen board', () => {
    const report = buildTelemetryReport({
      render: {
        sessionToken: 'usb-1:3',
        lastSampleSeq: 205,
        lastStatus: 'LIVE',
        lastRollDeg: 12.5,
        lastPitchDeg: -7,
        lastYawDeg: 214,
        heroSampleCount: 205,
        rendererSampleCount: 205,
        distinctPoseCount: 1,
        lastPoseChangeAtMs: 812,
      },
    });
    expect(report).toContain("Weergavestatus: LIVE");
    expect(report).toContain("Laatste sampleSeq op de interface: 205.");
    expect(report).toContain('roll=12.5 pitch=-7 yaw=214');
    expect(report).toContain("hero-metingen=205 renderer-metingen=205 verschillendeHoudingen=1");
  });

  it('prints an unavailable fact as unavailable, never as a plausible zero', () => {
    const report = buildTelemetryReport({});
    expect(report).toContain("sessionId: Niet beschikbaar");
    expect(report).toContain("Setup actief: Niet beschikbaar");
    expect(report).toContain("Laatste MSP-foutcode: Niet beschikbaar.");
    expect(report).not.toContain('sessionId: 0');
  });
});

describe('telemetry report - what it refuses to carry', () => {
  it('never contains payload bytes, frame content or an error message', () => {
    recordTelemetryEvent('TELEMETRY_POLL_REGISTERED', {pollId: 'attitude', intervalMs: 50});
    const report = buildTelemetryReport({
      scheduler: scheduler(),
      render: {
        sessionToken: 'usb-1:3',
        lastSampleSeq: 4,
        lastStatus: 'LIVE',
        lastRollDeg: 1,
        lastPitchDeg: 2,
        lastYawDeg: 3,
        heroSampleCount: 4,
        rendererSampleCount: 4,
        distinctPoseCount: 4,
        lastPoseChangeAtMs: 10,
      },
    });

    // The report is built ONLY from counters, enumerated codes and
    // already-decoded display angles: there is no field anywhere in it
    // that a Uint8Array, a base64 chunk or a free-text message could
    // reach.
    expect(report).not.toMatch(/Uint8Array/);
    expect(report).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/); // base64-ish run
    expect(report).not.toMatch(/attempted to read/); // MspPayloadReadError's own wording
  });

  it('bounds its event history instead of growing without limit', () => {
    for (let i = 0; i < 500; i++) {
      recordTelemetryEvent(`STAGE_${i}`);
    }
    const report = buildTelemetryReport({});
    const stageLines = report.split('\n').filter(line => line.includes('STAGE_'));
    expect(stageLines.length).toBeLessThanOrEqual(60);
    // The earliest stages are preserved - a long session must not push
    // the moment telemetry began out of the report.
    expect(report).toContain('STAGE_0');
    expect(report).toContain('STAGE_499');
  });
});
