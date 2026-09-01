/**
 * @jest-environment jsdom
 *
 * THE BROWSER SUPPORT LINK.
 *
 * The Android half is covered where it matters - by pressing the real
 * button on Home and watching `Linking.openURL` (see
 * ui/screens/startSupportSection.test.tsx). This file covers the half
 * that Jest's Android resolution never loads, and it exists for one
 * reason: the browser is where the two window-opening flags apply, and
 * both are one-word mistakes no visual check would ever catch.
 *
 *   noopener   without it, a page the operator is about to type payment
 *              details into holds a live `window.opener` handle back
 *              into this tab and can navigate it somewhere else.
 *   noreferrer without it, every request that tab makes announces the
 *              page it came from.
 *
 * react-native-web's own Linking would supply only `noopener`, which is
 * precisely why this file's implementation exists instead of letting the
 * shared one serve both platforms - so the flag pair is the thing worth
 * pinning.
 */

import {openSupportPage} from './supportLink.web';
import {SUPPORT_PROJECT_URL} from './supportUrl';

describe('supportLink.web', () => {
  it('opens the Ko-fi page in a new tab with BOTH noopener and noreferrer', () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);

    openSupportPage();

    expect(open).toHaveBeenCalledWith(
      'https://ko-fi.com/fpvarconf',
      '_blank',
      'noopener,noreferrer',
    );
    open.mockRestore();
  });

  it('opens that address and no other', () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);

    openSupportPage();

    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(SUPPORT_PROJECT_URL);
    expect(SUPPORT_PROJECT_URL).toBe('https://ko-fi.com/fpvarconf');
    open.mockRestore();
  });

  it('is HTTPS, so the browser can show a padlock on the page it lands on', () => {
    expect(SUPPORT_PROJECT_URL.startsWith('https://')).toBe(true);
  });

  it('does nothing at all when there is no window to open one from', () => {
    // Server-side rendering or a worker: returning quietly is correct,
    // and throwing here would take the whole home screen down.
    const host = globalThis as {window?: Window};
    const realWindow = host.window;
    delete host.window;

    expect(() => {
      openSupportPage();
    }).not.toThrow();

    host.window = realWindow;
  });
});
