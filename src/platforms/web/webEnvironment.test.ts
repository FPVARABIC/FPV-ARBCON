/**
 * @jest-environment jsdom
 *
 * CAPABILITY DETECTION MUST NEVER GUESS.
 *
 * The rule these tests enforce is the one in
 * docs/WEB_APP_ARCHITECTURE.md that matters most: a missing browser API is
 * reported as missing, never softened into something that looks usable.
 * The second rule is subtler and is the reason `serialUnavailableReason`
 * exists at all - "your browser does not support Web Serial" is the WRONG
 * message for a supported browser served over plain HTTP, and sends the
 * operator off to reinstall software that was never the problem.
 */

import {
  WEB_ENVIRONMENT_REASON_KEYS,
  describeWebEnvironment,
  hasWebSerial,
  hasWebUsb,
  isSecureContext,
} from './webEnvironment';

type MutableNavigator = {serial?: unknown; usb?: unknown};

const originalSerial = (navigator as MutableNavigator).serial;
const originalUsb = (navigator as MutableNavigator).usb;
const originalIsSecureContext = window.isSecureContext;

function setEnvironment(options: {
  secure: boolean;
  serial: boolean;
  usb: boolean;
}): void {
  Object.defineProperty(window, 'isSecureContext', {
    value: options.secure,
    configurable: true,
  });
  if (options.serial) {
    (navigator as MutableNavigator).serial = {getPorts: () => Promise.resolve([])};
  } else {
    delete (navigator as MutableNavigator).serial;
  }
  if (options.usb) {
    (navigator as MutableNavigator).usb = {getDevices: () => Promise.resolve([])};
  } else {
    delete (navigator as MutableNavigator).usb;
  }
}

afterEach(() => {
  Object.defineProperty(window, 'isSecureContext', {
    value: originalIsSecureContext,
    configurable: true,
  });
  if (originalSerial === undefined) {
    delete (navigator as MutableNavigator).serial;
  } else {
    (navigator as MutableNavigator).serial = originalSerial;
  }
  if (originalUsb === undefined) {
    delete (navigator as MutableNavigator).usb;
  } else {
    (navigator as MutableNavigator).usb = originalUsb;
  }
});

describe('webEnvironment', () => {
  it('reports every capability present on a secure Chrome-like context', () => {
    setEnvironment({secure: true, serial: true, usb: true});

    expect(isSecureContext()).toBe(true);
    expect(hasWebSerial()).toBe(true);
    expect(hasWebUsb()).toBe(true);
    expect(describeWebEnvironment()).toEqual({
      secureContext: true,
      webSerial: true,
      webUsb: true,
      serialUnavailableReason: null,
      dfuUnavailableReason: null,
    });
  });

  it('blames the BROWSER when the origin is secure but the API is absent', () => {
    setEnvironment({secure: true, serial: false, usb: false});

    const report = describeWebEnvironment();
    expect(report.serialUnavailableReason).toBe('UNSUPPORTED_BROWSER');
    expect(report.dfuUnavailableReason).toBe('UNSUPPORTED_BROWSER');
  });

  it('blames the INSECURE CONTEXT, not the browser, on a plain-HTTP origin', () => {
    // The observable state is identical to the previous case - the APIs
    // are simply absent - so nothing but isSecureContext can tell these
    // two apart. Getting this backwards is what makes an operator
    // reinstall a browser that would have worked over HTTPS.
    setEnvironment({secure: false, serial: false, usb: false});

    const report = describeWebEnvironment();
    expect(report.serialUnavailableReason).toBe('INSECURE_CONTEXT');
    expect(report.dfuUnavailableReason).toBe('INSECURE_CONTEXT');
  });

  it('reports the two transports independently', () => {
    // Real and common: a Chromium build with Web Serial enabled and
    // WebUSB blocked by enterprise policy. Serial-based flashing and MSP
    // still work; only STM32 DFU does not, and only that one must be
    // reported as unavailable.
    setEnvironment({secure: true, serial: true, usb: false});

    const report = describeWebEnvironment();
    expect(report.serialUnavailableReason).toBeNull();
    expect(report.dfuUnavailableReason).toBe('UNSUPPORTED_BROWSER');
  });

  it('never reports a capability as available merely because the page is secure', () => {
    setEnvironment({secure: true, serial: false, usb: false});

    const report = describeWebEnvironment();
    expect(report.webSerial).toBe(false);
    expect(report.webUsb).toBe(false);
  });

  it('maps both reasons to catalogued Arabic keys, never to inline text', () => {
    // Guards against a regression to hard-coded Arabic here, which would
    // escape src/i18n's own coverage gate.
    expect(WEB_ENVIRONMENT_REASON_KEYS.INSECURE_CONTEXT).toBe(
      'webPlatform.reason.insecureContext',
    );
    expect(WEB_ENVIRONMENT_REASON_KEYS.UNSUPPORTED_BROWSER).toBe(
      'webPlatform.reason.unsupportedBrowser',
    );
  });
});
