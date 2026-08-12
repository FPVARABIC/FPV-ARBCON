#!/usr/bin/env node
/**
 * WEB PRODUCTION-BUNDLE SCANNER.
 *
 * The browser counterpart of scan-production-bundle.js, and shaped the
 * same way for the same reason: a gate that asserts something untrue is
 * worse than no gate, because it still reports "OK".
 *
 * WHAT IT ASSERTS - four categories, deliberately not merged.
 *
 * A. STRICTLY FORBIDDEN IN THE BROWSER BUNDLE. Android-only and Node-only
 *    runtime code. Each entry is here because it would be a REAL defect,
 *    not because it is untidy:
 *
 *      - TurboModuleRegistry / getEnforcing: the Android transport spec
 *        leaking in. It throws on load in a browser, so the whole app
 *        would white-screen. Its presence means a `.web` resolution
 *        silently stopped working - the exact failure the platform seam
 *        exists to prevent, and one that a passing typecheck would not
 *        catch on its own.
 *      - CanvasKit / react-native-skia: ~7.8MB of WASM canvas engine
 *        pulled in to draw 38 already-projected polygons. Its presence
 *        means OrientationRenderer.web.tsx stopped being resolved.
 *      - The `geo:` map URI: Android's intent scheme, which no browser
 *        handles. Its presence means mapLink.web.ts stopped being
 *        resolved and the GPS map button silently does nothing.
 *      - The debug panels, for exactly the reason the Android scanner
 *        holds them at zero: they are __DEV__-gated and must not ship.
 *
 * B. REQUIRED IN THE BUNDLE. The Web Serial transport and the Arabic
 *    safety copy. Absence is a failure. This is the guard against a
 *    build that "passes" by shipping a working shell with no transport
 *    behind it, or - the defect the Android scanner was written for -
 *    Arabic strings compiled out so every label renders as its own i18n
 *    key.
 *
 * C. POSITIVE CONTROLS. Unrelated sentinels that must be present, so an
 *    empty or truncated build cannot pass by containing nothing.
 *
 * D. CODE SPLITTING. The Firmware Flasher and the main tab shell must not
 *    be in the ENTRY chunk. On Android that separation only saves module
 *    evaluation; in a browser it is bytes the operator downloads before
 *    the first screen paints, and losing it is a silent, permanent
 *    regression that no test would otherwise notice.
 *
 * Usage:  node scripts/scan-web-bundle.js
 * Exit 0 = every invariant holds. Exit 1 = a forbidden token is present,
 * a required token is missing, or the entry chunk swallowed a lazy route.
 * Exit 2 = the bundle could not be built.
 */

const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { existsSync, readFileSync, readdirSync, rmSync, statSync } = require('fs');
const { join } = require('path');

const REPO_ROOT = join(__dirname, '..');
const OUTPUT_DIRECTORY = join(REPO_ROOT, 'dist-web');
const ASSETS_DIRECTORY = join(OUTPUT_DIRECTORY, 'assets');

/** CATEGORY A - every entry must be at exactly zero. */
const FORBIDDEN_TOKENS = [
  // Android transport spec leaking into the browser build.
  'TurboModuleRegistry',
  // The exact call the spec file makes:
  // TurboModuleRegistry.getEnforcing('UsbSerialTransport'). Matched
  // separately from the identifier above because a minifier renames the
  // registry binding but never the module-name string literal.
  "getEnforcing('UsbSerialTransport')",
  // The Skia/CanvasKit renderer.
  'CanvasKit',
  '@shopify/react-native-skia',
  // Android's map intent scheme.
  'geo:${',
  // Debug-only panels, held at zero exactly as the Android scanner does.
  'UsbAppLogCapture',
  'captureAppLog',
  'debug-toggle-app-log',
  'debug-start-reading',
  'debug-send-custom',
  'dev-open-motor-test',
  'DevBenchScreen',
];

/** CATEGORY B - every entry must be PRESENT at least once. */
const REQUIRED_TOKENS = [
  // The Web Serial transport itself. If these vanish, the browser build
  // has a UI and no way to reach a flight controller.
  'navigator.serial',
  'getPorts',
  'requestPort',
  'setSignals',
  'WEB_SERIAL',
  // The honest capability reporting. Their absence would mean an
  // unsupported browser gets a generic error instead of an actionable one.
  'WEB_SERIAL_UNSUPPORTED',
  'INSECURE_CONTEXT',
  // The browser Alert host - without it every confirmation in the shared
  // screens silently does nothing (react-native-web's Alert.alert is a
  // no-op). This is a safety surface, not a convenience.
  'web-alert-host',
  // The shared screens and the engine behind them.
  'motors-screen',
  'motors-stop-button',
  'ports-screen',
  'gps-screen',
  'configurations-screen',
  'firmware-flasher-screen',
  'main-tab-bar',
  // The browser map link, which must be OpenStreetMap over HTTPS.
  'openstreetmap.org',
];

/*
 * EVERY TOKEN ABOVE IS A STRING LITERAL, NOT AN IDENTIFIER, AND THAT IS
 * NOT A STYLE CHOICE.
 *
 * The Android scanner can assert on names like `createMotorTestController`
 * and `MSP_EEPROM_WRITE` because `react-native bundle --dev false` does not
 * minify. Vite's production build does: Rolldown mangles every local and
 * imported binding, so an identifier is simply absent from the shipped
 * bytes whether or not the code that defined it shipped. Asserting on one
 * would either fail permanently (as it first did here) or - far worse, if
 * it were moved to the FORBIDDEN list - pass forever while testing
 * nothing.
 *
 * testIDs, Arabic copy, and property names survive minification, so the
 * lists are built from those. Where a bundled engine must be proven
 * present, its own emitted string is used instead of its class name.
 */

/**
 * CATEGORY B, second half - THE ARABIC SAFETY COPY, in the shipped bytes.
 *
 * Bundlers may emit non-ASCII literally or as `\uXXXX` escapes, so each
 * string is looked for in BOTH forms and a match in either is a pass.
 * Guessing one form would make this check fail for the wrong reason, or
 * silently stop testing anything if the emitted form changed.
 */
const REQUIRED_ARABIC_STRINGS = [
  // The propeller warning - the single most important string in the app.
  // P3: the propeller warning became one concise sentence - the same
  // safety intent, stated once instead of as a checklist ritual.
  'أزل المراوح قبل اختبار المحركات.',
  // The emergency instruction after an unconfirmed stop.
  'تعذّر تأكيد توقف المحرك — افصل بطارية LiPo فورًا',
  // Configuration transaction truthfulness.
  'نتيجة الكتابة أو الحفظ غير مؤكدة',
  'يجب الإبقاء على منفذ MSP واحد على الأقل.',
  // Firmware erase gates.
  'أزلت جميع المراوح',
  'تجاوز عدم تطابق Target',
  // The browser-specific capability messages.
  'هذا المتصفح لا يدعم Web Serial. استخدم Chrome أو Edge على سطح المكتب للاتصال بمتحكم الطيران.',
  'يتطلب الاتصال بجهاز USB صفحة آمنة عبر HTTPS. افتح التطبيق من عنوان HTTPS ثم أعد المحاولة.',
];

/** CATEGORY C - unrelated sentinels. Without these the scan is vacuous. */
/**
 * RECEIVER P5 - Receiver coverage in the WEB bundle.
 *
 * P0 recorded that this scanner had no Receiver-specific coverage at all:
 * the browser build could have shipped without the professional Receiver
 * workspace, or with the P4 capability gating tree-shaken out, and every
 * category here would still have said OK.
 *
 * These are SEMANTIC markers taken from the real built bundle - stable
 * test ids and i18n keys the Receiver implementation emits - never chunk
 * filenames, which are content-hashed and change on every edit.
 *
 * What each one proves:
 *   receiver-live-monitor      P3 live workspace ships
 *   receiver-observed-rate     the MEASURED-cadence surface ships, so the
 *                              honest "no fabricated Hz" path is present
 *   receiver-channel-          the per-channel rows ship
 *   -fill                      P3's animated fill node ships (the
 *                              smoothing target is `receiver-channel-N-fill`)
 *   receiver-signal-alert      P2 failsafe indication ships
 *   receiver-reboot-required   P2/P4 reboot truth ships
 *   receiver-mode-row          P4 mode surface ships
 *   receiver-mode-select       P4 capability-gated mode control ships
 *   receiver-provider-select   P4 capability-gated provider control ships
 *   receiver-dependency-block  P4 Ports dependency blocking ships
 *   receiverScreen.capabilityNotProven
 *                              the NOT-PROVEN wording ships, so an
 *                              unverifiable build cannot silently present
 *                              an unrestricted selector
 */
const REQUIRED_RECEIVER_TOKENS = [
  'receiver-live-monitor',
  'receiver-observed-rate',
  'receiver-status-strip',
  'receiver-channel-',
  '-fill',
  'receiver-signal-alert',
  'receiver-reboot-required',
  'receiver-mode-row',
  'receiver-mode-select',
  'receiver-provider-select',
  'receiver-dependency-block',
  'receiverScreen.capabilityNotProven',
];

const POSITIVE_CONTROLS = ['diagnostics-section', 'fc-tools-section'];

/**
 * CATEGORY D - tokens that must NOT be in the entry chunk, with the lazy
 * chunk each belongs to. `token` is searched in the entry chunk only.
 */
const LAZY_ONLY_TOKENS = [
  { token: 'firmware-flasher-screen', route: 'FirmwareFlasher' },
  { token: 'main-tab-bar', route: 'Setup (MainTabs)' },
  { token: 'motors-hold-button', route: 'Setup (Motors tab)' },
  // esptool-js's own log text, not its `ESPLoader` class name: the class
  // name is minified away and would make this check vacuous.
  { token: 'Stub is already running', route: 'FirmwareFlasher (esptool)' },
];

/**
 * CATEGORY E - the HTML shell's own layout contract.
 *
 * react-native-web mounts an AppContainer styled `flex: 1 1 0%`, and
 * flex-grow does NOTHING inside a `display: block` parent. If #root ever
 * loses `display: flex`, every descendant - navigator, screen, ScrollView,
 * all of them `flex: 1` - resolves to height 0 while the content still
 * PAINTS through overflow. That is the worst possible failure shape: the
 * page looks completely correct, nothing scrolls, and clicks land on #root
 * instead of the button under the cursor. It was found by driving the real
 * build in Chromium, and no screenshot or unit test would have caught it.
 */
const REQUIRED_HTML_RULES = [
  {pattern: /#root\s*\{[^}]*display:\s*flex/, description: '#root { display: flex }'},
];

/** Counts non-overlapping occurrences of a literal token. */
function countOccurrences(haystack, token) {
  let count = 0;
  let index = haystack.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(token, index + token.length);
  }
  return count;
}

/** The `\uXXXX`-escaped form of every non-ASCII character in `text`. */
function escapeNonAscii(text) {
  return Array.from(text)
    .map(character => {
      const code = character.codePointAt(0);
      if (code < 0x80) {
        return character;
      }
      return Array.from(character)
        .map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join('');
    })
    .join('');
}

/** True when `text` appears either literally or fully escaped. */
function containsEitherForm(haystack, text) {
  return haystack.includes(text) || haystack.includes(escapeNonAscii(text));
}

/**
 * Pure analysis of already-read bundle text, so tests can exercise every
 * verdict against synthetic bundles without invoking Vite.
 *
 * `combined` is every emitted chunk concatenated; `entry` is the entry
 * chunk alone, which is what category D is about.
 */
function analyzeHtmlShell(html) {
  return REQUIRED_HTML_RULES.filter(rule => !rule.pattern.test(html));
}

function analyzeWebBundle(combined, entry) {
  const forbidden = [];
  for (const token of FORBIDDEN_TOKENS) {
    const count = countOccurrences(combined, token);
    if (count > 0) {
      forbidden.push({ token, count, offset: combined.indexOf(token) });
    }
  }

  const missingRequired = REQUIRED_TOKENS.filter(
    token => countOccurrences(combined, token) === 0,
  );
  const missingArabic = REQUIRED_ARABIC_STRINGS.filter(
    text => !containsEitherForm(combined, text),
  );
  const missingReceiver = REQUIRED_RECEIVER_TOKENS.filter(
    token => countOccurrences(combined, token) === 0,
  );
  const missingControls = POSITIVE_CONTROLS.filter(
    token => countOccurrences(combined, token) === 0,
  );
  const eagerlyBundled = LAZY_ONLY_TOKENS.filter(
    entryToken => countOccurrences(entry, entryToken.token) > 0,
  );

  return {
    forbidden,
    missingRequired,
    missingArabic,
    missingReceiver,
    missingControls,
    eagerlyBundled,
    ok:
      forbidden.length === 0 &&
      missingRequired.length === 0 &&
      missingArabic.length === 0 &&
      missingReceiver.length === 0 &&
      missingControls.length === 0 &&
      eagerlyBundled.length === 0,
  };
}

/** Builds the real production bundle. Throws rather than returning a
 * partial result that could be mistaken for a clean scan. */
function buildBundle() {
  rmSync(OUTPUT_DIRECTORY, { recursive: true, force: true });
  execFileSync('npx', ['vite', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

/**
 * Reads every emitted .js chunk. Source maps are excluded deliberately:
 * they embed the ORIGINAL source of every module, so a forbidden token
 * would match inside a comment that never ships as executable code, and a
 * required token would "pass" from a file that was tree-shaken away.
 */
function readChunks() {
  if (!existsSync(ASSETS_DIRECTORY)) {
    throw new Error(`No assets directory at ${ASSETS_DIRECTORY}.`);
  }
  const chunks = [];
  for (const name of readdirSync(ASSETS_DIRECTORY)) {
    const path = join(ASSETS_DIRECTORY, name);
    if (!name.endsWith('.js') || !statSync(path).isFile()) {
      continue;
    }
    chunks.push({ name, text: readFileSync(path, 'utf8') });
  }
  if (chunks.length === 0) {
    throw new Error('The build produced no JavaScript chunks.');
  }
  return chunks;
}

/**
 * The entry chunk is the one index.html loads with <script type="module">.
 * Identified from the HTML rather than by filename convention, so a
 * change in Vite's naming cannot silently make category D vacuous.
 */
function findEntryChunk(chunks) {
  const html = readFileSync(join(OUTPUT_DIRECTORY, 'index.html'), 'utf8');
  const match = html.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
  if (!match) {
    throw new Error('Could not identify the entry chunk from index.html.');
  }
  const entry = chunks.find(chunk => chunk.name === match[1]);
  if (!entry) {
    throw new Error(`index.html references a missing chunk: ${match[1]}.`);
  }
  return entry;
}

function main() {
  let chunks;
  let entry;
  try {
    console.log('Building the production web bundle...');
    buildBundle();
    chunks = readChunks();
    entry = findEntryChunk(chunks);
  } catch (error) {
    console.error('FAILED to build or read the production web bundle.');
    console.error(error && error.message ? error.message : String(error));
    // Exit 2 is distinct from a containment failure on purpose: a build
    // that never produced a bundle has proven nothing.
    return 2;
  }

  const combined = chunks.map(chunk => chunk.text).join('\n');
  const bytes = combined.length;
  const sha256 = createHash('sha256').update(combined).digest('hex');
  const result = analyzeWebBundle(combined, entry.text);
  const missingHtmlRules = analyzeHtmlShell(
    readFileSync(join(OUTPUT_DIRECTORY, 'index.html'), 'utf8'),
  );

  console.log(`Chunks: ${chunks.length}`);
  console.log(`Entry chunk: ${entry.name} (${entry.text.length} bytes)`);
  console.log(`Combined JavaScript: ${bytes} bytes`);
  console.log(`Combined SHA-256: ${sha256}`);
  console.log('');

  console.log(
    `A. Forbidden Android/Node-only tokens: ${FORBIDDEN_TOKENS.length} scanned`,
  );
  for (const entryFound of result.forbidden) {
    console.error(
      `   FORBIDDEN TOKEN PRESENT: ${JSON.stringify(entryFound.token)} x${
        entryFound.count
      } at offset ${entryFound.offset}`,
    );
  }
  if (result.forbidden.length === 0) {
    console.log('   all at zero.');
  }

  console.log('');
  console.log(
    `B. Required: ${REQUIRED_TOKENS.length} transport/screen tokens, ${REQUIRED_ARABIC_STRINGS.length} Arabic safety strings`,
  );
  for (const token of result.missingRequired) {
    console.error(`   MISSING REQUIRED TOKEN: ${JSON.stringify(token)}`);
  }
  for (const text of result.missingArabic) {
    console.error(
      `   MISSING ARABIC SAFETY STRING: ${JSON.stringify(
        text,
      )} - this ships as a raw i18n key in the browser.`,
    );
  }
  if (result.missingRequired.length === 0 && result.missingArabic.length === 0) {
    console.log('   all present.');
  }

  console.log('');
  console.log(
    `C. Receiver professional surface: ${REQUIRED_RECEIVER_TOKENS.length} markers`,
  );
  for (const token of result.missingReceiver) {
    console.error(
      `   MISSING RECEIVER MARKER: ${JSON.stringify(token)} - the browser build does not ship the Receiver workspace/capability behaviour this marker represents.`,
    );
  }
  if (result.missingReceiver.length === 0) {
    console.log('   all present.');
  }

  console.log('');
  console.log('D. Positive controls');
  for (const token of result.missingControls) {
    console.error(
      `   MISSING POSITIVE CONTROL: ${JSON.stringify(token)} - the scan would be vacuous.`,
    );
  }
  if (result.missingControls.length === 0) {
    console.log('   all present.');
  }

  console.log('');
  console.log('E. Code splitting (entry chunk)');
  for (const eager of result.eagerlyBundled) {
    console.error(
      `   EAGERLY BUNDLED: ${JSON.stringify(eager.token)} is in the entry chunk; ${
        eager.route
      } must stay lazy.`,
    );
  }
  if (result.eagerlyBundled.length === 0) {
    console.log(
      `   ${LAZY_ONLY_TOKENS.length} lazy-route sentinels absent from the entry chunk.`,
    );
  }

  console.log('');
  console.log('F. HTML shell layout contract');
  for (const rule of missingHtmlRules) {
    console.error(
      `   MISSING SHELL RULE: ${rule.description} - without it every flex:1 descendant collapses to height 0 while still painting through overflow, so the page LOOKS correct but cannot scroll and swallows clicks.`,
    );
  }
  if (missingHtmlRules.length === 0) {
    console.log(`   ${REQUIRED_HTML_RULES.length} rule(s) present.`);
  }

  if (!result.ok || missingHtmlRules.length > 0) {
    console.error('');
    console.error('WEB SCAN FAILED.');
    return 1;
  }
  console.log('');
  console.log(
    'OK - no Android/Node-only code in the browser bundle, Web Serial transport and Arabic safety copy both shipped, the Receiver professional surface present, lazy routes still lazy, shell layout contract intact.',
  );
  return 0;
}

module.exports = {
  analyzeHtmlShell,
  analyzeWebBundle,
  REQUIRED_HTML_RULES,
  containsEitherForm,
  countOccurrences,
  escapeNonAscii,
  FORBIDDEN_TOKENS,
  LAZY_ONLY_TOKENS,
  POSITIVE_CONTROLS,
  REQUIRED_ARABIC_STRINGS,
  REQUIRED_TOKENS,
  main,
};

// Explicit main-module guard: importing this file for tests must never
// launch a build as a side effect.
if (require.main === module) {
  process.exit(main());
}
