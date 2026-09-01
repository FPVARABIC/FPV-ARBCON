/** @jest-environment jsdom */
/**
 * THE DIRECTION OWNER, ON THE BROWSER SIDE.
 *
 * react-native-web's I18nManager is a no-op stub: `forceRTL()` has an
 * empty body and there is no `isRTL` property at all, so every shared
 * module that asked it which way the page ran was told "left to right"
 * no matter what the Arabic document actually did. That is why the web
 * sibling exists and why it asks the DOCUMENT instead - `index.html`
 * ships `dir="rtl"` on <html> before any JavaScript runs, and that
 * attribute is what lays out every row, inset and text run.
 *
 * The module is imported by its EXPLICIT `.web` path: under the React
 * Native Jest preset the resolver would otherwise take the native file,
 * and this suite would be testing the wrong implementation while looking
 * like it tested the right one.
 */
import {isRtlLayout} from './layoutDirection.web';

function setDocumentDir(value: string | null): void {
  if (value === null) document.documentElement.removeAttribute('dir');
  else document.documentElement.setAttribute('dir', value);
  document.body?.removeAttribute('dir');
}

afterEach(() => { setDocumentDir(null); });

describe('isRtlLayout in the browser', () => {
  it('reads the document attribute the browser actually lays out with', () => {
    setDocumentDir('rtl');
    expect(isRtlLayout()).toBe(true);
    setDocumentDir('ltr');
    expect(isRtlLayout()).toBe(false);
  });

  it('is case-insensitive, as the HTML attribute is', () => {
    setDocumentDir('RTL');
    expect(isRtlLayout()).toBe(true);
    setDocumentDir('LTR');
    expect(isRtlLayout()).toBe(false);
  });

  it('falls back to <body> when <html> carries no direction', () => {
    setDocumentDir(null);
    document.body.setAttribute('dir', 'ltr');
    expect(isRtlLayout()).toBe(false);
    document.body.setAttribute('dir', 'rtl');
    expect(isRtlLayout()).toBe(true);
    document.body.removeAttribute('dir');
  });

  it('answers again on every call - a flipped document is not stale', () => {
    setDocumentDir('rtl');
    const first = isRtlLayout();
    setDocumentDir('ltr');
    const second = isRtlLayout();
    setDocumentDir('rtl');
    expect([first, second, isRtlLayout()]).toEqual([true, false, true]);
  });

  it('defaults to the product\'s Arabic layout rather than claiming LTR', () => {
    // With nothing to read, the honest answer is the app's own default -
    // the failure this whole file exists to prevent is silently
    // reporting "left to right" for an Arabic-first product.
    setDocumentDir(null);
    expect(isRtlLayout()).toBe(true);
  });
});
