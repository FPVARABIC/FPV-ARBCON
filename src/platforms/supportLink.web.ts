/**
 * "SUPPORT THE PROJECT" - the browser implementation.
 *
 * A new tab, opened with BOTH `noopener` and `noreferrer`. Neither is
 * boilerplate:
 *
 *   noopener   without it the opened page receives a `window.opener`
 *              handle back into the configurator and can navigate this
 *              tab elsewhere - the classic tabnabbing shape, and worse
 *              than usual here because the page it would be imitating is
 *              one an operator is about to enter payment details into.
 *   noreferrer without it every request that tab makes carries a Referer
 *              naming the page it came from.
 *
 * react-native-web's own `Linking.openURL` would do only the first of
 * those (it calls window.open(url, target, 'noopener')), which is why
 * this file exists rather than letting the Android half serve both
 * platforms.
 *
 * A blocked pop-up returns null and is ignored, for the same reason the
 * Android half swallows its rejection: an optional link that did not
 * open is not an error worth interrupting anyone over.
 */

import {SUPPORT_PROJECT_URL} from './supportUrl';

/** Opens the project's support page in a new browser tab. */
export function openSupportPage(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.open(SUPPORT_PROJECT_URL, '_blank', 'noopener,noreferrer');
}
