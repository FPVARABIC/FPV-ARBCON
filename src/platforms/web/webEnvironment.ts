/**
 * BROWSER CAPABILITY DETECTION - measured, never assumed.
 *
 * Every capability below is decided by looking at the live `navigator` and
 * `window` objects, not by sniffing a user-agent string and not by a build
 * flag. The reason is the single hardest rule in docs/WEB_APP_ARCHITECTURE.md:
 * a missing browser API must NEVER be turned into a demo device or a fake
 * success. The UI asks these functions what actually exists and then either
 * offers the real thing or explains, in Arabic, exactly what is missing.
 *
 * SECURE CONTEXT. Both Web Serial and WebUSB are gated by the browser on
 * `window.isSecureContext`. The APIs are simply absent on a plain-HTTP
 * origin other than localhost, so `hasWebSerial()` would already be false -
 * but reporting "your browser does not support Web Serial" when the real
 * problem is "this page is not on HTTPS" sends the operator to reinstall a
 * browser that was never at fault. `isSecureContext()` exists so the
 * compatibility notice can name the actual cause.
 *
 * These functions are deliberately NOT memoized into module constants.
 * Reading them per call keeps them correct under a test that installs a
 * navigator stub after import, and the cost is a property lookup.
 */

/** True when the page is on HTTPS (or localhost), which both device APIs require. */
export function isSecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

/** True when this browser exposes the Web Serial API. */
export function hasWebSerial(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator).serial === 'object' &&
    (navigator as Navigator).serial !== null
  );
}

/** True when this browser exposes WebUSB (needed for STM32 DFU/DfuSe). */
export function hasWebUsb(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator).usb === 'object' &&
    (navigator as Navigator).usb !== null
  );
}

/**
 * The one machine-readable summary the UI renders from.
 *
 * `serialUnavailableReason` distinguishes the two failures that look
 * identical from inside the app but are completely different for the
 * operator: an unsupported browser (install Chrome/Edge) versus a
 * supported browser served over plain HTTP (fix the URL). `null` means
 * Web Serial is genuinely available.
 */
export type WebEnvironmentReport = {
  readonly secureContext: boolean;
  readonly webSerial: boolean;
  readonly webUsb: boolean;
  readonly serialUnavailableReason: 'INSECURE_CONTEXT' | 'UNSUPPORTED_BROWSER' | null;
  readonly dfuUnavailableReason: 'INSECURE_CONTEXT' | 'UNSUPPORTED_BROWSER' | null;
};

function unavailableReason(
  available: boolean,
  secure: boolean,
): 'INSECURE_CONTEXT' | 'UNSUPPORTED_BROWSER' | null {
  if (available) {
    return null;
  }
  // Order matters. A non-secure origin hides the API entirely, so an
  // absent API on plain HTTP must be reported as the context problem it
  // is, not as a browser that would have worked over HTTPS.
  return secure ? 'UNSUPPORTED_BROWSER' : 'INSECURE_CONTEXT';
}

export function describeWebEnvironment(): WebEnvironmentReport {
  const secureContext = isSecureContext();
  const webSerial = hasWebSerial();
  const webUsb = hasWebUsb();
  return {
    secureContext,
    webSerial,
    webUsb,
    serialUnavailableReason: unavailableReason(webSerial, secureContext),
    dfuUnavailableReason: unavailableReason(webUsb, secureContext),
  };
}

/**
 * Arabic i18n keys for the two reasons. Returned as KEYS rather than text
 * so the strings stay in the single ar.json catalogue that
 * i18nCoverage.test.ts guards - a hard-coded Arabic string here would be
 * the exact defect that catalogue rule exists to prevent.
 */
export const WEB_ENVIRONMENT_REASON_KEYS = {
  INSECURE_CONTEXT: 'webPlatform.reason.insecureContext',
  UNSUPPORTED_BROWSER: 'webPlatform.reason.unsupportedBrowser',
} as const;
