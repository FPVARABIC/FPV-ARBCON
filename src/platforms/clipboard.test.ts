/**
 * The clipboard seam, from the Android side: absent, inert, and never
 * pretending a copy happened. The browser half is exercised through the
 * connection and telemetry report suites.
 */

import {copyPlainTextToClipboard} from './clipboard';

describe('clipboard on Android', () => {
  it('resolves false rather than faking success', async () => {
    await expect(copyPlainTextToClipboard('anything')).resolves.toBe(false);
  });

  it('never throws, whatever it is handed', async () => {
    await expect(copyPlainTextToClipboard('')).resolves.toBe(false);
  });
});
