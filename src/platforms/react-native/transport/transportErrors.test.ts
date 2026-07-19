import {
  KNOWN_ERROR_CODES,
  localizeTransportError,
  normalizeNativeError,
} from './transportErrors';
import i18n from '../../../i18n';

describe('normalizeNativeError', () => {
  it('extracts code and message from a native rejection object', () => {
    const result = normalizeNativeError({
      code: 'PERMISSION_DENIED',
      message: 'Permission denied for device 3.',
      userInfo: null,
    });
    expect(result).toEqual({
      code: 'PERMISSION_DENIED',
      nativeMessage: 'Permission denied for device 3.',
    });
  });

  it('extracts code and message from a real Error instance with extra own properties', () => {
    const error = new Error('Failed to close session s-1.') as Error & {
      code?: string;
      nativeStackAndroid?: unknown[];
    };
    error.code = 'CLOSE_FAILED';
    error.nativeStackAndroid = [{class: 'java.lang.RuntimeException'}];
    const result = normalizeNativeError(error);
    expect(result.code).toBe('CLOSE_FAILED');
    expect(result.nativeMessage).toBe('Failed to close session s-1.');
    // Only code/nativeMessage exist on the returned shape - nothing else
    // from the source object (e.g. nativeStackAndroid) can leak through.
    expect(Object.keys(result).sort()).toEqual(['code', 'nativeMessage']);
  });

  it('falls back to an unknown code when no code string is present', () => {
    const result = normalizeNativeError({message: 'Something odd happened.'});
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.nativeMessage).toBe('Something odd happened.');
  });

  it('normalizes a thrown plain string', () => {
    const result = normalizeNativeError('boom');
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.nativeMessage).toBe('boom');
  });

  it('normalizes a thrown non-object, non-string value without throwing', () => {
    expect(() => normalizeNativeError(42)).not.toThrow();
    expect(() => normalizeNativeError(undefined)).not.toThrow();
    expect(() => normalizeNativeError(null)).not.toThrow();
    const result = normalizeNativeError(undefined);
    expect(result.code).toBe('UNKNOWN_ERROR');
  });

  it('ignores a non-string code field', () => {
    const result = normalizeNativeError({code: 123, message: 'x'});
    expect(result.code).toBe('UNKNOWN_ERROR');
  });
});

describe('localizeTransportError', () => {
  const t = i18n.t.bind(i18n);

  it('has a distinct Arabic message for every known native error code', () => {
    for (const code of KNOWN_ERROR_CODES) {
      const message = localizeTransportError(t, {code, nativeMessage: 'x'});
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe('errors.UNKNOWN');
      // A missing ar.json key does not throw and does not equal
      // 'errors.UNKNOWN' either - i18next instead returns the raw,
      // untranslated key string (e.g. "errors.MODULE_INVALIDATED"), which
      // the two checks above would silently let through. Guard against that
      // directly, per code, so a future code added to KNOWN_ERROR_CODES
      // without a matching ar.json entry fails here instead of shipping an
      // English key string to the user.
      expect(message).not.toBe(`errors.${code}`);
    }
  });

  it('maps an unknown code to the safe Arabic fallback', () => {
    const message = localizeTransportError(t, {
      code: 'SOMETHING_NEW_AND_UNRECOGNIZED',
      nativeMessage: 'x',
    });
    expect(message).toBe(t('errors.UNKNOWN'));
  });

  it('never returns the raw native message or a stack-trace-shaped string', () => {
    const message = localizeTransportError(t, {
      code: 'OPEN_FAILED',
      nativeMessage: 'java.lang.RuntimeException: boom at com.fpvarbcon.Foo.bar(Foo.kt:1)',
    });
    expect(message).not.toContain('RuntimeException');
    expect(message).not.toContain('com.fpvarbcon');
  });
});
