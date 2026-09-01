/**
 * WHERE "SUPPORT THE PROJECT" POINTS - written once, for both platforms.
 *
 * The Android and browser halves of supportLink differ only in HOW a URL
 * is handed to the system; the destination is identical, so it lives here
 * rather than being spelled twice. A second copy would be the one place a
 * typo could send someone to an address the owner never chose - and the
 * test that pins this value could still pass while the other half pointed
 * somewhere else.
 *
 * KO-FI, AND NOTHING ELSE IS BUILT AROUND IT. The app has no payment
 * surface of its own and gains none from this: no card field, no account
 * number, no name, no amount, no record of who gave or whether anyone
 * did. Pressing the button hands this plain HTTPS address to the
 * browser, and the application's involvement ends at that call.
 *
 * Nothing in the product reads this value to decide what an operator may
 * do. Support unlocks no feature, hides no screen and gates no setting;
 * it is a link in a footer, and the flight-controller surfaces do not
 * import this module at all.
 */
export const SUPPORT_PROJECT_URL = 'https://ko-fi.com/fpvarconf';
