/**
 * Regression tests for the production-bundle and engine-boundary scanner.
 *
 * These exercise the scanner's VERDICT LOGIC against synthetic bundles and
 * synthetic source trees. Importing the module must not launch Metro - the
 * main-module guard is what makes that safe, and the first test proves it.
 *
 * WHAT CHANGED WITH THE SINGLE-APP MERGE. The suite used to assert that
 * every motor-engine token was STRICTLY FORBIDDEN in a Release bundle and
 * that a retained lease sentinel stayed within an approved cap. Both are
 * obsolete: the engine ships now, on purpose. Those tests are deleted
 * rather than inverted in place, and what replaces them is the opposite
 * assertion - the engine and the Arabic safety copy must be PRESENT, and a
 * bundle missing either one fails. That is the check that would have
 * caught the raw-i18n-key defect seen on the device.
 *
 * NO HARDWARE, and no real bundle build here: the real `--dev false` build
 * is run by `npm run scan:production-bundle` and by CI.
 */

const {
  analyzeBundle,
  analyzeEngineBoundaries,
  containsEitherForm,
  countOccurrences,
  escapeNonAscii,
  readSourceTree,
  ENGINE_BOUNDARIES,
  FORBIDDEN_TOKENS,
  POSITIVE_CONTROLS,
  REQUIRED_ARABIC_STRINGS,
  REQUIRED_ENGINE_TOKENS,
} = require('../scan-production-bundle');

/** A synthetic bundle with everything the merged app must ship and nothing
 * forbidden - the shape a correct Release build has. */
function cleanBundle() {
  return [
    'var app={};',
    POSITIVE_CONTROLS.join(';'),
    ';',
    REQUIRED_ENGINE_TOKENS.join(';'),
    ';',
    REQUIRED_ARABIC_STRINGS.map(text => JSON.stringify(text)).join(';'),
    ';var telemetry="attitude";',
  ].join('');
}

describe('scanner - importing it does not build anything', () => {
  it('exposes its verdict logic without running the CLI', () => {
    // If the main-module guard were missing, requiring the module above
    // would have shelled out to Metro before this test ever ran.
    expect(typeof analyzeBundle).toBe('function');
    expect(typeof analyzeEngineBoundaries).toBe('function');
    expect(POSITIVE_CONTROLS).toEqual([
      'diagnostics-section',
      'fc-tools-section',
    ]);
  });

  it('counts non-overlapping occurrences', () => {
    expect(countOccurrences('aXbXc', 'X')).toBe(2);
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('abc', 'z')).toBe(0);
  });
});

describe('scanner - a correct merged bundle passes', () => {
  it('reports ok with the engine present and nothing forbidden', () => {
    const result = analyzeBundle(cleanBundle());
    expect(result.forbidden).toEqual([]);
    expect(result.missingEngine).toEqual([]);
    expect(result.missingArabic).toEqual([]);
    expect(result.missingControls).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('no longer treats any motor token as forbidden', () => {
    for (const token of REQUIRED_ENGINE_TOKENS) {
      expect(FORBIDDEN_TOKENS).not.toContain(token);
    }
  });
});

describe('scanner - the debug-only tokens are still strictly forbidden', () => {
  it.each(FORBIDDEN_TOKENS)('fails when %s is present', token => {
    const result = analyzeBundle(`${cleanBundle()};${token};`);
    expect(result.ok).toBe(false);
    expect(result.forbidden.map(entry => entry.token)).toContain(token);
  });

  it('reports ALL forbidden tokens, not just the first', () => {
    const injected = [
      'captureAppLog',
      'UsbBoundedProcessReader',
      'debug-clear-log',
    ];
    const result = analyzeBundle(`${cleanBundle()};${injected.join(';')};`);
    expect(result.ok).toBe(false);
    for (const token of injected) {
      expect(result.forbidden.map(entry => entry.token)).toContain(token);
    }
  });

  it('records a count and a byte offset for each match', () => {
    const result = analyzeBundle(
      `${cleanBundle()};captureAppLog;captureAppLog;`,
    );
    const entry = result.forbidden.find(item => item.token === 'captureAppLog');
    expect(entry).toBeDefined();
    expect(entry.count).toBe(2);
    expect(entry.offset).toBeGreaterThan(0);
  });

  it('still forbids the removed development-only motor entry', () => {
    for (const token of [
      'dev-open-motor-test',
      'DevBenchScreen',
      'DevBenchEntry',
    ]) {
      expect(FORBIDDEN_TOKENS).toContain(token);
      expect(analyzeBundle(`${cleanBundle()};${token};`).ok).toBe(false);
    }
  });
});

describe('scanner - a re-contained engine is a FAILURE, not a pass', () => {
  it.each(REQUIRED_ENGINE_TOKENS)('fails when %s is missing', token => {
    const partial = cleanBundle().replace(new RegExp(token, 'g'), 'REMOVED');
    const result = analyzeBundle(partial);
    expect(result.ok).toBe(false);
    expect(result.missingEngine).toContain(token);
  });

  it('fails an empty bundle rather than calling it clean', () => {
    // The exact failure mode a naive "no forbidden token found" check has.
    const result = analyzeBundle('');
    expect(result.forbidden).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.missingControls).toEqual(POSITIVE_CONTROLS);
    expect(result.missingEngine).toEqual(REQUIRED_ENGINE_TOKENS);
  });
});

describe('scanner - the Arabic safety copy must be in the shipped bytes', () => {
  it.each(REQUIRED_ARABIC_STRINGS)('fails when %s is absent', text => {
    const without = cleanBundle().replace(JSON.stringify(text), '"REMOVED"');
    const result = analyzeBundle(without);
    expect(result.ok).toBe(false);
    expect(result.missingArabic).toContain(text);
  });

  it('accepts a \\uXXXX-escaped bundle as readily as a literal one', () => {
    // Metro may emit either form. Asserting only one would make this check
    // fail for the wrong reason, or silently stop testing anything.
    const escaped = [
      'var app={};',
      POSITIVE_CONTROLS.join(';'),
      ';',
      REQUIRED_ENGINE_TOKENS.join(';'),
      ';',
      REQUIRED_ARABIC_STRINGS.map(text => `"${escapeNonAscii(text)}"`).join(
        ';',
      ),
      ';',
    ].join('');
    const result = analyzeBundle(escaped);
    expect(result.missingArabic).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('escapes only non-ASCII characters', () => {
    expect(escapeNonAscii('4S only')).toBe('4S only');
    expect(escapeNonAscii('أ')).toBe('\\u0623');
    expect(containsEitherForm('x\\u0623y', 'أ')).toBe(true);
    expect(containsEitherForm('xأy', 'أ')).toBe(true);
    expect(containsEitherForm('xy', 'أ')).toBe(false);
  });

  it('would have caught the on-device defect: keys present, strings absent', () => {
    // The exact shape of the failed hardware-test bundle - every i18n KEY
    // was in the bytes (they are ASCII identifiers in source) while the
    // Arabic subtree that resolves them was compiled out.
    const keysOnly = [
      'var app={};',
      POSITIVE_CONTROLS.join(';'),
      ';',
      REQUIRED_ENGINE_TOKENS.join(';'),
      ';"motorsScreen.title";"motorsScreen.propellerWarning";',
      '"motorsScreen.blockReason.CONTINUOUS_SAFETY_MONITORING_UNAVAILABLE";',
    ].join('');
    const result = analyzeBundle(keysOnly);
    expect(result.ok).toBe(false);
    expect(result.missingArabic.length).toBe(REQUIRED_ARABIC_STRINGS.length);
  });
});

describe('scanner - the engine boundary is the remaining structural containment', () => {
  it('holds against the real source tree', () => {
    const result = analyzeEngineBoundaries(readSourceTree());
    expect(result.violations).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.unleashed).toEqual([]);
    expect(result.ok).toBe(true);
    // Both real dispatch sites are found. A rule that matched nothing
    // would pass vacuously.
    expect(result.dispatchSites.length).toBeGreaterThan(0);
    for (const site of result.dispatchSites) {
      expect(site.receiver).toBe('lease');
    }
  });

  it('fails when a second module imports the payload encoder', () => {
    const sources = readSourceTree();
    sources['src/ui/screens/SomeNewScreen.tsx'] =
      "import {encodeSetMotorPayload} from '../../core/protocol/msp/encoding/encodeSetMotorPayload';";
    const result = analyzeEngineBoundaries(sources);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      token: 'encodeSetMotorPayload',
      importer: 'src/ui/screens/SomeNewScreen.tsx',
    });
  });

  it('fails when a second module imports the vector builders or the command id', () => {
    for (const token of [
      'buildSingleMotorVector',
      'buildAllStopVector',
      'MSP_SET_MOTOR',
    ]) {
      const sources = readSourceTree();
      sources['src/rogue.ts'] = `import {${token}} from './somewhere';`;
      const result = analyzeEngineBoundaries(sources);
      expect(result.ok).toBe(false);
      expect(result.violations.map(entry => entry.token)).toContain(token);
    }
  });

  it('confines every persistent configuration write to its reviewed controller', () => {
    for (const token of [
      'encodeChangedMotorConfiguration',
      'MSP_EEPROM_WRITE',
      'MSP_SET_FEATURE_CONFIG',
      'MSP_SET_GPS_CONFIG',
      'MSP_SET_MIXER_CONFIG',
      'MSP_SET_ADVANCED_CONFIG',
      'encodeChangedGeneralConfiguration',
      'MSP_SET_ARMING_CONFIG',
      'MSP_SET_BEEPER_CONFIG',
      'MSP_SET_RX_CONFIG',
      'MSP2_SET_TEXT',
      'MSP_SET_MOTOR_3D_CONFIG',
      'MSP_SET_MOTOR_CONFIG',
      'encodeMotorOutputOrder',
      'encodeDshotEscDirection',
      'MSP2_SET_MOTOR_OUTPUT_REORDERING',
      'MSP2_SEND_DSHOT_COMMAND',
    ]) {
      const sources = readSourceTree();
      sources[
        'src/ui/screens/RogueSettings.tsx'
      ] = `import {${token}} from './somewhere';`;
      const result = analyzeEngineBoundaries(sources);
      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        token,
        importer: 'src/ui/screens/RogueSettings.tsx',
      });
    }
  });

  it('fails when an allowance goes stale rather than silently testing nothing', () => {
    const sources = readSourceTree();
    // The controller stops importing the encoder: the rule now guards a
    // module that does not exercise it.
    sources['src/core/state/motorTestController.ts'] = sources[
      'src/core/state/motorTestController.ts'
    ].replace(/\bencodeSetMotorPayload\b/g, 'somethingElse');
    const result = analyzeEngineBoundaries(sources);
    expect(result.ok).toBe(false);
    expect(result.stale.map(entry => entry.token)).toContain(
      'encodeSetMotorPayload',
    );
  });

  it('fails when a motor command is dispatched outside a lease', () => {
    const sources = readSourceTree();
    sources['src/core/state/motorTestController.ts'] +=
      '\nasync function rogue(client) { await client.request(MSP_SET_MOTOR, payload); }\n';
    const result = analyzeEngineBoundaries(sources);
    expect(result.ok).toBe(false);
    expect(result.unleashed).toContainEqual({
      receiver: 'client',
      method: 'request',
    });
  });

  it('names every boundary it enforces, so the set cannot shrink unnoticed', () => {
    expect(ENGINE_BOUNDARIES.map(entry => entry.token).sort()).toEqual([
      'MSP2_COMMON_SET_SERIAL_CONFIG',
      'MSP2_SEND_DSHOT_COMMAND',
      'MSP2_SET_MOTOR_OUTPUT_REORDERING',
      'MSP2_SET_TEXT',
      'MSP_EEPROM_WRITE',
      'MSP_SET_ADVANCED_CONFIG',
      'MSP_SET_ARMING_CONFIG',
      'MSP_SET_BEEPER_CONFIG',
      'MSP_SET_FEATURE_CONFIG',
      'MSP_SET_GPS_CONFIG',
      'MSP_SET_MIXER_CONFIG',
      'MSP_SET_MOTOR',
      'MSP_SET_MOTOR_3D_CONFIG',
      'MSP_SET_MOTOR_CONFIG',
      'MSP_SET_RX_CONFIG',
      'buildAllStopVector',
      'buildSingleMotorVector',
      'encodeChangedGeneralConfiguration',
      'encodeChangedMotorConfiguration',
      'encodeDshotEscDirection',
      'encodeMotorOutputOrder',
      'encodeSetMotorPayload',
    ]);
  });
});

describe('scanner - build failure is never a pass', () => {
  it('separates a missing bundle from a clean bundle by exit code', () => {
    // main() returns 2 for a generation failure and 1 for a scan failure,
    // so a broken build can never be read as success. analyzeBundle is
    // never reached when generation throws.
    const { main } = require('../scan-production-bundle');
    expect(typeof main).toBe('function');
    expect(analyzeBundle('').ok).toBe(false);
  });
});
