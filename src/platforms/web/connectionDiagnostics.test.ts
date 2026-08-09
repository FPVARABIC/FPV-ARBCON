/**
 * @jest-environment jsdom
 *
 * THE CONNECTION REPORT.
 *
 * Two properties matter and both are user-facing promises, not plumbing:
 * the report must CONTAIN the staged evidence a bug report needs
 * (stages, codes, byte counts, capability status, build identity), and
 * it must NOT contain what it promises to refuse - payload bytes. The
 * refusal is structural (the API only accepts counts), so the test pins
 * the API shape as much as the output.
 */

import {
  buildConnectionReport,
  copyConnectionReport,
  recordBytesReceived,
  recordBytesWritten,
  recordDiagnostic,
  resetConnectionDiagnosticsForTests,
} from './connectionDiagnostics';

beforeEach(() => {
  resetConnectionDiagnosticsForTests();
});

describe('buildConnectionReport', () => {
  it('carries stages in order with their codes and details', () => {
    recordDiagnostic('SCAN_OK', {authorizedPorts: 1});
    recordDiagnostic('OPEN_REQUESTED', {deviceId: 1, baudRate: 115200});
    recordDiagnostic('OPEN_FAILED', {deviceId: 1, code: 'CONNECT_TIMEOUT'});

    const report = buildConnectionReport();

    const scanIndex = report.indexOf('SCAN_OK authorizedPorts=1');
    const openIndex = report.indexOf('OPEN_REQUESTED deviceId=1 baudRate=115200');
    const failIndex = report.indexOf('OPEN_FAILED deviceId=1 code=CONNECT_TIMEOUT');
    expect(scanIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(scanIndex);
    expect(failIndex).toBeGreaterThan(openIndex);
  });

  it('reports byte totals and directions, never payload bytes', () => {
    recordBytesWritten(6);
    recordBytesWritten(6);
    recordBytesReceived(11);

    const report = buildConnectionReport();

    expect(report).toContain('sent=12 (2 writes)');
    expect(report).toContain('received=11 (1 chunks)');
  });

  it('includes capability and secure-context booleans from the live browser', () => {
    const report = buildConnectionReport();

    expect(report).toMatch(/secureContext: (true|false)/);
    expect(report).toMatch(/webSerial: (true|false)/);
    expect(report).toMatch(/webUsb: (true|false)/);
  });

  it('appends the screen snapshot the caller supplies', () => {
    const report = buildConnectionReport({
      connectionState: 'error',
      errorMessage: 'انتهت مهلة محاولة الاتصال بالجهاز.',
    });

    expect(report).toContain('connectionState: error');
    expect(report).toContain('انتهت مهلة محاولة الاتصال بالجهاز.');
  });

  it('reports the build identity line', () => {
    // Jest has no Vite define, so the guarded read reports 'dev' - which
    // is itself the correct answer for a non-Vite build.
    expect(buildConnectionReport()).toContain('البنية: dev');
  });

  it('keeps the FIRST ten entries when the buffer overflows', () => {
    // The capability probe and first open attempt are what a report needs
    // most; hours of telemetry stages must not push them out.
    recordDiagnostic('FIRST_STAGE', {marker: 1});
    for (let index = 0; index < 400; index += 1) {
      recordDiagnostic('NOISE', {index});
    }

    const report = buildConnectionReport();

    expect(report).toContain('FIRST_STAGE marker=1');
    expect(report).toContain('NOISE index=399');
    expect(report).not.toContain('NOISE index=200');
  });
});

describe('copyConnectionReport', () => {
  it('writes the report through navigator.clipboard when available', async () => {
    const writeText = jest.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: {writeText},
      configurable: true,
    });
    recordDiagnostic('SCAN_OK', {authorizedPorts: 2});

    await expect(copyConnectionReport({connectionState: 'ready'})).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    expect(copied).toContain('SCAN_OK authorizedPorts=2');
    expect(copied).toContain('connectionState: ready');

    Reflect.deleteProperty(navigator as object, 'clipboard');
  });

  it('resolves false - never throws - when no clipboard mechanism works', async () => {
    Reflect.deleteProperty(navigator as object, 'clipboard');
    const execCommand = (document as Document & {execCommand?: unknown}).execCommand;
    (document as Document & {execCommand?: unknown}).execCommand = () => false;

    await expect(copyConnectionReport()).resolves.toBe(false);

    (document as Document & {execCommand?: unknown}).execCommand = execCommand;
  });
});
