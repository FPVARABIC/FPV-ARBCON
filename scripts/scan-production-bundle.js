#!/usr/bin/env node
/**
 * Production-bundle and engine-boundary scanner.
 *
 * WHAT IT USED TO ASSERT, AND WHY THAT IS GONE
 * --------------------------------------------
 * Until the single-app merge this script asserted ZERO motor tokens in a
 * `--dev false` bundle: the motor-test engine was held out of every
 * shipped build by a `__DEV__` seam. The owner has settled on one unified
 * app in which Motors is reached through normal navigation after a real
 * connection, so that assertion is now FALSE BY DESIGN. It has been
 * removed rather than relaxed - a gate that asserts something untrue is
 * worse than no gate, because it still reports "OK".
 *
 * Two of the defects observed on the hardware-test device came directly
 * from that containment, which is why the replacement checks are shaped
 * the way they are:
 *   - the Arabic motors strings were compiled out, so every label
 *     rendered as its own i18n key;
 *   - the engine was absent, so nothing could reach a testable state.
 * Both are now things this script FAILS ON IF THEY RECUR.
 *
 * WHAT IT ASSERTS NOW - four categories, deliberately not merged
 * -------------------------------------------------------------
 * A. STRICTLY FORBIDDEN IN THE BUNDLE. The debug-only diagnostic panels
 *    and their native log-capture access. These remain `__DEV__`-gated and
 *    remain at exactly zero: `com.fpvarbcon.debug` exists only in the
 *    debug source set, and the release DEX must contain none of it.
 *
 * B. REQUIRED IN THE BUNDLE. The motor engine and the Arabic safety copy.
 *    Absence is a failure. This is the direct guard against a silent
 *    re-containment: if a future change puts the engine or the catalogue
 *    back behind a build conditional, the app ships raw i18n keys and a
 *    permanently-blocked Motors tab again, and CI would otherwise be
 *    perfectly green while it happened.
 *
 * C. POSITIVE CONTROLS. Unrelated UI sentinels that must be present, so an
 *    empty or truncated bundle cannot "pass" by containing nothing.
 *
 * D. ENGINE BOUNDARY (source, not bundle). The invariants that genuinely
 *    survive the merge and are now the ONLY structural containment:
 *      D1. the payload encoder and the vector builders are reachable from
 *          exactly one module - MotorTestController;
 *      D2. the MSP_SET_MOTOR command id is imported by that module alone;
 *      D3. every dispatch of it goes through a LEASE-GUARDED MspClient
 *          method, so no motor command can be issued without an active
 *          lease.
 *    These are checked against source because that is where they are
 *    expressible: after minification an import edge is not recoverable
 *    from bundle text. Stated plainly rather than implied - this is a
 *    weaker guarantee than "the bytes are not there", and that trade was
 *    made deliberately when the two apps were merged.
 *
 * Bare numbers (214, 1000, 1050) are deliberately NOT scanned: they have
 * legitimate unrelated occurrences and would produce meaningless failures.
 *
 * Usage:  node scripts/scan-production-bundle.js
 * Exit 0 = every invariant holds. Exit 1 = a forbidden token is present, a
 * required token is missing, or an engine boundary was crossed.
 * Exit 2 = the bundle could not be generated.
 */

const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const REPO_ROOT = join(__dirname, '..');

/** CATEGORY A - every entry must be at exactly zero. Copied verbatim from
 * real source in this repository. */
const FORBIDDEN_TOKENS = [
  // Pass 7.7 - the debug panels and their native log-capture access.
  'UsbAppLogCapture',
  'UsbAppLogCapturePackage',
  'UsbAppLogCaptureModule',
  'UsbBoundedProcessReader',
  'captureAppLog',
  'App Log Capture (own process, no adb needed)',
  'debug-toggle-app-log',
  'polling-capacity-audit-run',
  'debug-start-reading',
  'debug-stop-reading',
  'debug-byte-input',
  'debug-send-custom',
  'debug-clear-log',
  // The removed development-only motor entry. Motors is an ordinary tab
  // now; a re-appearance of this token means a second, ungoverned way in.
  'dev-open-motor-test',
  'DevBenchScreen',
  'DevBenchEntry',
];

/**
 * CATEGORY B - every entry must be PRESENT at least once.
 *
 * The motor engine ships. If any of these vanishes, the Motors tab cannot
 * reach a testable state on a real device - exactly the failure the
 * hardware-test build exhibited.
 */
const REQUIRED_ENGINE_TOKENS = [
  'createMotorTestController',
  'MOTOR_TEST_FIXED_PULSE_VALUE',
  'pulseMotor',
  'createMotorTestSessionBinding',
  'operatorPort',
  'buildSingleMotorVector',
  'buildAllStopVector',
  'encodeSetMotorPayload',
  'emergencyStopWithMotorTestLease',
  'requestWithMotorTestLease',
  'ARMED_STATE_UNKNOWN_OR_STALE',
  // This branch's safety monitor and displaced-response quarantine. They
  // did not exist on main; their absence would mean the merge dropped the
  // very layer the runtime gates now rest on. `observeMotorArmedState` is
  // the ONE production read the whole bench gate rests on - if it is
  // missing from the bundle, nothing is proving the FC disarmed.
  'readMotorArmedStateEvidence',
  'observeMotorArmedState',
  'MOTOR_TEST_SAFETY_OBSERVATION_TIMEOUT_MILLIS',
  'motors-screen',
  'motors-hold-button',
  'motors-stop-button',
  'main-tab-bar',
  // The independent settings transaction must not disappear behind a dev
  // seam while leaving a read-only shell on device.
  'MotorConfigurationController',
  'motor-configuration-panel',
  'encodeChangedMotorConfiguration',
  'acquireMotorConfigurationInterlock',
  'MSP_EEPROM_WRITE',
  'MotorDiagnosticsPanel',
  'decodeMotorTelemetry',
  'MotorOutputReorderPanel',
  'encodeMotorOutputOrder',
  'EscDirectionPanel',
  'encodeDshotEscDirection',
  'MSP2_SET_MOTOR_OUTPUT_REORDERING',
  'MSP2_SEND_DSHOT_COMMAND',
  // Ports is a real production editor, not a static tab.
  'PortsConfigurationController',
  'ports-screen',
  'ports-save',
  'MSP2_COMMON_SERIAL_CONFIG',
  'MSP2_COMMON_SET_SERIAL_CONFIG',
  'decodeSerialPorts',
  'encodeSerialPorts',
  // GPS is a complete production subsystem: screen, screen-scoped live
  // telemetry and the guarded persistent configuration transaction.
  'gps-screen',
  'GpsConfigurationController',
  'acquireGpsDetailTelemetry',
  'decodeDetailedGps',
  'decodeGpsSatelliteInfo',
  'encodeGpsConfiguration',
  'MSP_SET_GPS_CONFIG',
  // General Configurations is a first-class production subsystem. Its
  // complete encoder and guarded transaction must ship together.
  'configurations-screen',
  'GeneralConfigurationController',
  'encodeChangedGeneralConfiguration',
  'MSP_SET_ARMING_CONFIG',
  'MSP_SET_BEEPER_CONFIG',
  'MSP_SET_RX_CONFIG',
  'MSP2_SET_TEXT',
  'receiver-screen',
  'ReceiverConfigurationController',
  'acquireReceiverTelemetry',
  'decodeRcChannels',
  'encodeChangedReceiverConfiguration',
  'MSP_SET_RX_MAP',
  'MSP_SET_RSSI_CONFIG',
  'MSP_SET_RC_DEADBAND',
  // Firmware Flasher and the new landing route are product surfaces, not
  // optional debug code. Their protocol owners must ship in Release.
  'firmware-flasher-screen',
  'start-connection',
  'start-firmware',
  'start-safe-flash',
  'CloudBuildCoordinator',
  'FirmwareBootloaderController',
  'Stm32SerialFlasher',
  'EspFirmwareFlasher',
  'parseFirmwareFile',
  'applyCustomDefaultsToFirmware',
  'unprotectDfuDevice',
];

/**
 * CATEGORY B, second half - THE ARABIC SAFETY COPY, in the shipped bytes.
 *
 * This is the check that would have caught the on-device defect. Metro may
 * emit non-ASCII either literally or as `\uXXXX` escapes depending on the
 * minifier's settings, so each string is looked for in BOTH forms and a
 * match in either is a pass. Guessing one form and asserting it would make
 * this check fail for the wrong reason - or, worse, silently stop testing
 * anything if the emitted form changed.
 */
const REQUIRED_ARABIC_STRINGS = [
  // The propeller warning - the single most important string in the app.
  'أزل جميع المراوح قبل المتابعة',
  // The honest manual battery-suitability boundary. This build does not
  // read cell count inside the motor-test controller.
  'لا يقرأ هذا الإصدار عدد خلايا البطارية آليًا',
  // The emergency instruction after an unconfirmed stop.
  'تعذّر تأكيد توقف المحرك — افصل بطارية LiPo فورًا',
  // A block reason, proving the whole blockReason subtree shipped.
  'تعذّرت قراءة حالة التسليح أو أصبحت القراءة قديمة.',
  // Configuration transaction truthfulness.
  'نتيجة الكتابة أو الحفظ غير مؤكدة',
  'المحركات وESC',
  'إعادة ترتيب مخارج المحركات',
  'اتجاه دوران DShot',
  'لم يثبت التطبيق الاتجاه ميكانيكيًا',
  'حفظ وإعادة تشغيل المتحكم',
  'يجب الإبقاء على منفذ MSP واحد على الأقل.',
  // Firmware erase gates: absence would turn a present flasher into an
  // untranslated or unsafe release surface.
  'أزلت جميع المراوح',
  'فصلت البطارية والطاقة من USB فقط',
  'تجاوز عدم تطابق Target',
  'إزالة DFU Read Protection',
  'Unified Config / Custom Defaults',
  'نظام GPS / GNSS',
  'لا يوجد منفذ GPS معيّن',
  'تهيئة GPS',
  'نتيجة إحدى الكتابات غير مؤكدة',
  'التكوينات',
  'حفظ جراحي موثّق',
  'لا توجد روابط أو واجهات خارجية',
];

/** CATEGORY C - unrelated sentinels. Without these the scan is vacuous.
 * testIDs rather than Arabic titles: they are ASCII and therefore immune
 * to whatever escaping the minifier applies. */
const POSITIVE_CONTROLS = ['diagnostics-section', 'fc-tools-section'];

/**
 * CATEGORY D - the engine boundary, as source-file rules.
 *
 * `importers` lists every non-test module permitted to import the token.
 * A module not on the list importing it is a failure; so is the list
 * naming a module that no longer imports it, because a stale allowance is
 * how a boundary quietly stops being one.
 */
const ENGINE_BOUNDARIES = [
  {
    token: 'encodeSetMotorPayload',
    from: 'src/core/protocol/msp/encoding/encodeSetMotorPayload.ts',
    importers: ['src/core/state/motorTestController.ts'],
  },
  {
    token: 'buildSingleMotorVector',
    from: 'src/core/firmware-adapters/betaflightMotorVectorsV147.ts',
    importers: ['src/core/state/motorTestController.ts'],
  },
  {
    token: 'buildAllStopVector',
    from: 'src/core/firmware-adapters/betaflightMotorVectorsV147.ts',
    importers: ['src/core/state/motorTestController.ts'],
  },
  {
    token: 'MSP_SET_MOTOR',
    from: 'src/core/protocol/msp/commands/motorTestCommands.ts',
    importers: ['src/core/state/motorTestController.ts'],
  },
  {
    token: 'encodeChangedMotorConfiguration',
    from: 'src/core/protocol/msp/encoding/encodeMotorConfiguration.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_EEPROM_WRITE',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
      'src/platforms/react-native/protocol/PortsConfigurationController.ts',
      'src/platforms/react-native/protocol/GpsConfigurationController.ts',
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
      'src/platforms/react-native/protocol/ReceiverConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_SET_FEATURE_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
      'src/platforms/react-native/protocol/PortsConfigurationController.ts',
      'src/platforms/react-native/protocol/GpsConfigurationController.ts',
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
  },
  {
    token: 'MSP2_COMMON_SET_SERIAL_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/PortsConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_SET_GPS_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GpsConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_SET_MIXER_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_SET_ADVANCED_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
  },
  {
    token: 'encodeChangedGeneralConfiguration',
    from: 'src/core/protocol/msp/encoding/encodeGeneralConfiguration.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_SET_ARMING_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_SET_BEEPER_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
  },
  {
    token: 'encodeChangedReceiverConfiguration',
    from: 'src/core/protocol/msp/encoding/encodeReceiver.ts',
    importers: ['src/platforms/react-native/protocol/ReceiverConfigurationController.ts'],
  },
  {
    token: 'MSP_SET_RX_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
      'src/platforms/react-native/protocol/ReceiverConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_SET_RX_MAP',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: ['src/platforms/react-native/protocol/ReceiverConfigurationController.ts'],
  },
  {
    token: 'MSP_SET_RSSI_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: ['src/platforms/react-native/protocol/ReceiverConfigurationController.ts'],
  },
  {
    token: 'MSP_SET_RC_DEADBAND',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: ['src/platforms/react-native/protocol/ReceiverConfigurationController.ts'],
  },
  {
    token: 'MSP2_SET_TEXT',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_SET_MOTOR_3D_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
  },
  {
    token: 'MSP_SET_MOTOR_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
  },
  {
    token: 'encodeMotorOutputOrder',
    from: 'src/core/protocol/msp/encoding/encodeMotorOutputOrder.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
  },
  {
    token: 'encodeDshotEscDirection',
    from: 'src/core/protocol/msp/encoding/encodeDshotEscDirection.ts',
    importers: [
      'src/core/state/motorTestController.ts',
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
  },
  {
    token: 'MSP2_SET_MOTOR_OUTPUT_REORDERING',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
  },
  {
    token: 'MSP2_SEND_DSHOT_COMMAND',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/core/state/motorTestController.ts',
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
  },
];

/**
 * The ONLY MspClient methods that may carry a motor command, and the fact
 * that makes them safe: both take a lease token as their first argument
 * and reject a token that is not the currently-held one.
 */
const LEASE_GUARDED_DISPATCH = [
  'requestWithMotorTestLease',
  'emergencyStopWithMotorTestLease',
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
  if (haystack.includes(text)) {
    return true;
  }
  return haystack.includes(escapeNonAscii(text));
}

/**
 * Pure analysis of already-read bundle text. Separated from bundle
 * generation so tests can exercise every verdict against synthetic
 * bundles without invoking Metro.
 */
function analyzeBundle(bundleText) {
  const forbidden = [];
  for (const token of FORBIDDEN_TOKENS) {
    const count = countOccurrences(bundleText, token);
    if (count > 0) {
      forbidden.push({ token, count, offset: bundleText.indexOf(token) });
    }
  }

  const missingEngine = REQUIRED_ENGINE_TOKENS.filter(
    token => countOccurrences(bundleText, token) === 0,
  );

  const missingArabic = REQUIRED_ARABIC_STRINGS.filter(
    text => !containsEitherForm(bundleText, text),
  );

  const missingControls = POSITIVE_CONTROLS.filter(
    token => countOccurrences(bundleText, token) === 0,
  );

  return {
    forbidden,
    missingEngine,
    missingArabic,
    missingControls,
    ok:
      forbidden.length === 0 &&
      missingEngine.length === 0 &&
      missingArabic.length === 0 &&
      missingControls.length === 0,
  };
}

/* ------------------------------------------------------------------ *
 * CATEGORY D - the source-level engine boundary
 * ------------------------------------------------------------------ */

function collectSourceFiles(directory, into) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      collectSourceFiles(path, into);
      continue;
    }
    if (!/\.tsx?$/.test(path) || /\.test\.tsx?$/.test(path)) {
      continue;
    }
    if (
      path.includes(`${'__tests__'}`) ||
      path.includes(`${'__testUtils__'}`)
    ) {
      continue;
    }
    into.push(path);
  }
}

/**
 * Pure analysis of an already-collected {relativePath -> source} map, so
 * tests can drive every verdict without touching the real tree.
 */
function analyzeEngineBoundaries(sources) {
  const violations = [];
  const stale = [];

  for (const boundary of ENGINE_BOUNDARIES) {
    const actual = [];
    for (const [path, text] of Object.entries(sources)) {
      if (path === boundary.from) {
        continue;
      }
      // An import edge, not a mention: the token must appear inside an
      // import statement naming the defining module's basename.
      const importPattern = new RegExp(
        `import[^;]*\\b${boundary.token}\\b[^;]*from[^;]*;`,
        'g',
      );
      if (importPattern.test(text)) {
        actual.push(path);
      }
    }
    for (const path of actual) {
      if (!boundary.importers.includes(path)) {
        violations.push({ token: boundary.token, importer: path });
      }
    }
    for (const allowed of boundary.importers) {
      if (!actual.includes(allowed)) {
        stale.push({ token: boundary.token, importer: allowed });
      }
    }
  }

  // D3: every dispatch of the motor command goes through a lease. The
  // controller is the only importer (D2), so this is checked there.
  const controller = sources['src/core/state/motorTestController.ts'] ?? '';
  const executable = controller
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const dispatchSites = Array.from(
    executable.matchAll(
      /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(\s*MSP_SET_MOTOR/g,
    ),
  ).map(match => ({ receiver: match[1], method: match[2] }));
  const unleashed = dispatchSites.filter(
    site =>
      site.receiver !== 'lease' &&
      !LEASE_GUARDED_DISPATCH.includes(site.method),
  );

  return {
    violations,
    stale,
    dispatchSites,
    unleashed,
    ok: violations.length === 0 && stale.length === 0 && unleashed.length === 0,
  };
}

function readSourceTree() {
  const files = [];
  collectSourceFiles(join(REPO_ROOT, 'src'), files);
  const sources = {};
  for (const path of files) {
    sources[path.slice(REPO_ROOT.length + 1)] = readFileSync(path, 'utf8');
  }
  return sources;
}

/** Generates the real Release bundle. Throws on failure - never returns a
 * partial or empty result that could be mistaken for a clean scan. */
function generateBundle(outputDirectory) {
  const bundlePath = join(outputDirectory, 'index.android.bundle');
  execFileSync(
    'npx',
    [
      'react-native',
      'bundle',
      '--platform',
      'android',
      '--dev',
      'false',
      '--entry-file',
      'index.js',
      '--bundle-output',
      bundlePath,
      '--assets-dest',
      outputDirectory,
    ],
    { stdio: 'inherit' },
  );
  return bundlePath;
}

function main() {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'fpv-arbcon-bundle-'));
  let bundleText;
  let bytes;
  let sha256;
  try {
    console.log(
      `Generating dev=false bundle into ${outputDirectory} (outside the repository)...`,
    );
    const bundlePath = generateBundle(outputDirectory);
    const raw = readFileSync(bundlePath);
    bytes = raw.length;
    sha256 = createHash('sha256').update(raw).digest('hex');
    bundleText = raw.toString('utf8');
  } catch (error) {
    console.error('FAILED to generate the production bundle.');
    console.error(error && error.message ? error.message : String(error));
    // Exit 2 is distinct from a containment failure on purpose: a build
    // that never produced a bundle has proven nothing, and must never be
    // reported as a clean scan.
    return 2;
  } finally {
    // Cleaned on EVERY path - success, containment failure, build failure.
    rmSync(outputDirectory, { recursive: true, force: true });
  }

  const bundle = analyzeBundle(bundleText);
  const boundaries = analyzeEngineBoundaries(readSourceTree());

  console.log(`Bundle size: ${bytes} bytes`);
  console.log(`Bundle SHA-256: ${sha256}`);
  console.log('');

  console.log(
    `A. Strictly forbidden (debug-only) tokens: ${FORBIDDEN_TOKENS.length} scanned`,
  );
  for (const entry of bundle.forbidden) {
    console.error(
      `   FORBIDDEN TOKEN PRESENT: ${JSON.stringify(entry.token)} x${
        entry.count
      } at byte offset ${entry.offset}`,
    );
  }
  if (bundle.forbidden.length === 0) {
    console.log('   all at zero.');
  }

  console.log('');
  console.log(
    `B. Required in the shipped bundle: ${REQUIRED_ENGINE_TOKENS.length} engine tokens, ${REQUIRED_ARABIC_STRINGS.length} Arabic safety strings`,
  );
  for (const token of bundle.missingEngine) {
    console.error(
      `   MISSING ENGINE TOKEN: ${JSON.stringify(
        token,
      )} - the Motors tab cannot reach a testable state without it.`,
    );
  }
  for (const text of bundle.missingArabic) {
    console.error(
      `   MISSING ARABIC SAFETY STRING: ${JSON.stringify(
        text,
      )} - this ships as a raw i18n key on device.`,
    );
  }
  if (bundle.missingEngine.length === 0 && bundle.missingArabic.length === 0) {
    console.log('   all present.');
  }

  console.log('');
  console.log('C. Positive controls');
  for (const token of bundle.missingControls) {
    console.error(
      `   MISSING POSITIVE CONTROL: ${JSON.stringify(
        token,
      )} - the scan would be vacuous.`,
    );
  }
  if (bundle.missingControls.length === 0) {
    console.log('   all present.');
  }

  console.log('');
  console.log('D. Engine boundary (source)');
  for (const entry of boundaries.violations) {
    console.error(
      `   BOUNDARY CROSSED: ${entry.importer} imports ${entry.token}. Only MotorTestController may.`,
    );
  }
  for (const entry of boundaries.stale) {
    console.error(
      `   STALE ALLOWANCE: ${entry.importer} no longer imports ${entry.token}; the rule is not testing anything.`,
    );
  }
  for (const site of boundaries.unleashed) {
    console.error(
      `   UNLEASED DISPATCH: ${site.receiver}.${site.method}(MSP_SET_MOTOR ...) is not a lease-guarded route.`,
    );
  }
  if (boundaries.ok) {
    console.log(
      `   ${boundaries.dispatchSites.length} MSP_SET_MOTOR dispatch site(s), all lease-guarded; encoder and vector builders reachable from MotorTestController only.`,
    );
  }

  if (!bundle.ok || !boundaries.ok) {
    console.error('');
    console.error('SCAN FAILED.');
    return 1;
  }
  console.log('');
  console.log(
    'OK - no forbidden token present, engine and Arabic safety copy both shipped, positive controls present, engine boundary intact.',
  );
  return 0;
}

module.exports = {
  analyzeBundle,
  analyzeEngineBoundaries,
  containsEitherForm,
  countOccurrences,
  escapeNonAscii,
  readSourceTree,
  ENGINE_BOUNDARIES,
  FORBIDDEN_TOKENS,
  LEASE_GUARDED_DISPATCH,
  POSITIVE_CONTROLS,
  REQUIRED_ARABIC_STRINGS,
  REQUIRED_ENGINE_TOKENS,
  main,
};

// Explicit main-module guard: importing this file for tests must never
// launch a Metro build as a side effect.
if (require.main === module) {
  process.exit(main());
}
