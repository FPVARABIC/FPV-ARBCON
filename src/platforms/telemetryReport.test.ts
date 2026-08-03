/**
 * THE TELEMETRY-REPORT SEAM, FROM THE ANDROID SIDE.
 *
 * Runs against the native module resolution, so it pins the half of the
 * contract the shared Setup screen relies on there: the capability is
 * absent, recording is inert, and a copy call never pretends it copied.
 * The web half is covered in src/platforms/web/telemetryDiagnostics.test.ts.
 */

import {
  copyTelemetryReportToClipboard,
  isTelemetryReportSupported,
  recordTelemetryStage,
} from './telemetryReport';

describe('telemetry report on Android', () => {
  it('reports no support, so the screen never renders the button', () => {
    expect(isTelemetryReportSupported()).toBe(false);
  });

  it('recording is a no-op that never throws', () => {
    expect(() =>
      recordTelemetryStage('TELEMETRY_POLL_REGISTERED', {pollId: 'attitude'}),
    ).not.toThrow();
  });

  it('a defensive copy call resolves false rather than faking success', async () => {
    await expect(copyTelemetryReportToClipboard({sessionId: 'usb-1'})).resolves.toBe(false);
  });
});
