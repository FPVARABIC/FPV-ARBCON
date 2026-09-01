/**
 * THE OPERATOR SEES WHAT THEY CAN ACT ON.
 *
 * Screens were telling an Arabic operator things only a developer of this app
 * could use: the wire protocol version pinned in the permanent top bar ("MSP
 * 1.47"), block reasons citing "عقد MSP API 1.47 المعتمد الذي تمت مراجعته
 * بايتًا ببايت", a hint explaining our own byte layout ("لا بايتات 0.1V
 * القديمة"), and "رابط MSP" / "جلسة MSP" wherever the plain word "connection"
 * was meant.
 *
 * None of it changed what the operator could do. All of it occupied space
 * ahead of the controls they came for. It is gone from the interface and
 * still present where it belongs - in the code, in the connection trace, and
 * in the developer diagnostics export.
 *
 * WHAT IS NOT DEVELOPER INFORMATION, and deliberately stays:
 *   DShot, ProShot, Bidirectional DShot  - motor protocols the operator picks
 *   ESC, VTX, GPS, SoftSerial, ADC       - hardware they own
 *   MSP as a serial PORT ROLE            - a switch they set in Ports, and
 *                                          the same word Betaflight uses
 * The test targets the operator-facing surface, not the vocabulary of the
 * hobby.
 */

import * as fs from 'fs';
import * as path from 'path';

const SCREENS = __dirname;
const LOCALE = path.join(__dirname, '..', '..', 'i18n', 'locales', 'ar.json');

/** Protocol-version pinning and link-internals: never actionable. */
const FORBIDDEN = [
  /MSP\s*API\s*1\.\d+/,
  /MSP\s+1\.\d+/,
  /رابط\s+MSP/,
  /جلسة\s+MSP/,
  /واجهة\s+MSP\s*1\.\d+/,
  /بايتًا\s+ببايت/,
];

function offendingStrings(source: string): readonly string[] {
  // Arabic string literals only - code identifiers and comments are fine.
  const literals = Array.from(
    source.matchAll(/'([^'\\\n]*[؀-ۿ][^'\\\n]*)'/g),
    match => match[1],
  );
  return literals.filter(text => FORBIDDEN.some(rule => rule.test(text)));
}

describe('operator-facing copy carries no protocol-version pinning', () => {
  const files = fs
    .readdirSync(SCREENS)
    .filter(name => name.endsWith('.tsx') && !name.endsWith('.test.tsx'));

  it('scans real screens, so it cannot pass by finding nothing', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map(name => [name] as const))('%s', name => {
    expect(offendingStrings(fs.readFileSync(path.join(SCREENS, name), 'utf8'))).toEqual([]);
  });

  it('the Arabic locale is clean too', () => {
    const strings: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') strings.push(node);
      else if (node !== null && typeof node === 'object')
        for (const value of Object.values(node as Record<string, unknown>))
          walk(value);
    };
    walk(JSON.parse(fs.readFileSync(LOCALE, 'utf8')));
    expect(strings.length).toBeGreaterThan(100);
    expect(strings.filter(text => FORBIDDEN.some(rule => rule.test(text)))).toEqual([]);
  });

  /**
   * THE PERMANENT SURFACE STAYS CLEAN - AND IT CHANGED IDENTITY.
   *
   * This assertion used to read TopSystemBar, the 139px bar that held
   * the top of Setup at every width. SETUP R9 deleted it: what an
   * operator can never navigate away from is now SetupChromeBar, a 48px
   * toolbar carrying the way back and the way to disconnect.
   *
   * The rule it enforced is unchanged and still enforced HERE: the
   * permanent surface may not spend its space on a version number the
   * operator cannot act on.
   *
   * WHAT DID CHANGE, deliberately and on the product owner's
   * instruction: the MSP API version IS now shown - in SetupStatusBar,
   * which is scrolling CONTENT about the connected board, beside its
   * name and its firmware. That is a different bargain. It costs nothing
   * on any other screen, it sits with the facts it belongs to, and it is
   * the one place an operator checking compatibility looks for it.
   */
  it('the permanent chrome does not show the wire protocol version', () => {
    const chrome = fs.readFileSync(
      path.join(__dirname, '..', 'components', 'setup', 'SetupChromeBar.tsx'),
      'utf8',
    );
    expect(chrome).not.toContain('apiVersionMajor');
    expect(chrome).not.toContain('apiVersionMinor');
    expect(chrome).not.toContain('mspProtocolVersion');

    // And the bar it replaced is gone outright, not merely unused.
    expect(
      fs.existsSync(
        path.join(__dirname, '..', 'components', 'setup', 'TopSystemBar.tsx'),
      ),
    ).toBe(false);
  });

  it('never shows the MSP PROTOCOL version anywhere - the API version is the actionable one', () => {
    // mspProtocolVersion is the framing revision. It is identical across
    // every firmware this application can talk to, so it tells an
    // operator nothing and must not appear on any Setup surface.
    for (const file of [
      'SetupChromeBar.tsx',
      'SetupStatusBar.tsx',
      'SetupInfoGrid.tsx',
    ]) {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'components', 'setup', file),
        'utf8',
      );
      expect(`${file}: ${source.includes('mspProtocolVersion')}`).toBe(
        `${file}: false`,
      );
    }
  });
});
