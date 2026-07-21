import i18n from '../../../i18n';
import { MSP_CLIENT_ERROR_CODES } from '../mspClientErrorCodes';

describe('MSP_CLIENT_ERROR_CODES ar.json coverage', () => {
  const t = i18n.t.bind(i18n);

  it('has a distinct Arabic message for every MSP client error code introduced in Pass 6.2a', () => {
    for (const code of MSP_CLIENT_ERROR_CODES) {
      const message = t(`errors.${code}`);
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe('errors.UNKNOWN');
      // A missing ar.json key does not throw and does not equal
      // 'errors.UNKNOWN' either - i18next returns the raw, untranslated key
      // string instead (e.g. "errors.MSP_TIMEOUT"). Guard against that
      // directly, per code, mirroring transportErrors.test.ts's own
      // coverage test for KNOWN_ERROR_CODES.
      expect(message).not.toBe(`errors.${code}`);
    }
  });
});
