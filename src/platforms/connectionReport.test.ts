/**
 * THE CONNECTION-REPORT SEAM, FROM THE ANDROID SIDE.
 *
 * Runs against the native module resolution, so it pins the half of the
 * contract the shared screen relies on there: the capability is absent,
 * recording is inert, and a copy call never pretends it copied. The web
 * half is covered in src/platforms/web/connectionDiagnostics.test.ts.
 */

import {
  copyConnectionReportToClipboard,
  isConnectionReportSupported,
  recordConnectionStage,
} from './connectionReport';

describe('connection report on Android', () => {
  it('reports no support, so the screen never renders the button', () => {
    expect(isConnectionReportSupported()).toBe(false);
  });

  it('recording is a no-op that never throws', () => {
    expect(() =>
      recordConnectionStage('CONNECT_PRESSED', {vendorId: 0x0483}),
    ).not.toThrow();
  });

  it('a defensive copy call resolves false rather than faking success', async () => {
    await expect(copyConnectionReportToClipboard({a: 1})).resolves.toBe(false);
  });
});
