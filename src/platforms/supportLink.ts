/**
 * "SUPPORT THE PROJECT" - the Android implementation.
 *
 * `Linking.openURL` hands the address to the system, which opens it in
 * whichever browser the operator actually uses. Deliberately NOT a
 * WebView inside the application: a donation page rendered in the app's
 * own frame asks someone to type payment details into a window they
 * cannot verify the origin of, with no address bar and no padlock. The
 * system browser shows both. That is the whole reason this is a link.
 *
 * The rejection is swallowed for the same reason the map link swallows
 * its own (see mapLink.ts): the only way this fails is that the device
 * has no browser able to take an HTTPS URL, which is not an error about
 * the aircraft, the board or anything the operator was doing. Raising an
 * alert over a failed optional link would interrupt them for nothing.
 *
 * There is a `.web.ts` sibling. It exists because react-native-web's own
 * `Linking.openURL` opens with `noopener` but WITHOUT `noreferrer`, and
 * this product's standing rule for outbound links is both (see
 * mapLink.web.ts). Importing './supportLink' with no extension gets the
 * right half per platform, exactly like the map link and the USB
 * transport.
 */

import {Linking} from 'react-native';

import {SUPPORT_PROJECT_URL} from './supportUrl';

/** Opens the project's support page in the system browser. */
export function openSupportPage(): void {
  Linking.openURL(SUPPORT_PROJECT_URL).catch(() => {});
}
