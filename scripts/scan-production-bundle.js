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
  // OUR OWN REVIEW VOCABULARY, held at zero in the shipped bundle.
  //
  // Nine shared screens rendered this English phrase as the title of
  // their hardware warning. They are SHARED files, so Android carried it
  // exactly as the browser did - which is why this guard is mirrored in
  // scripts/scan-web-bundle.js rather than living only there. Comments,
  // audit documents and test names keep the phrase and are stripped by
  // the release build, so enforcing zero HERE separates engineering
  // vocabulary from product copy without policing either one wrongly.
  // The warning itself still ships; see the two hardware-verification
  // titles in the required-Arabic list below.
  'REQUIRES HARDWARE TEST',
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
  // PID phase two must ship as an operational screen, not as navigation
  // chrome around a read-only or mocked panel.
  'pid-screen',
  'PidTuningController',
  'decodePidTuningSnapshot',
  'encodeChangedPidTuning',
  'MSP_SET_PID',
  'MSP_SET_PID_ADVANCED',
  'MSP_SET_RC_TUNING',
  'MSP_SET_FILTER_CONFIG',
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
  // RECEIVER P5. The tokens above prove the Receiver PROTOCOL owner ships.
  // These prove the professional surface built in P3/P4 ships with it -
  // a Release that tree-shook the workspace, the smoothing node or the
  // capability gating would otherwise pass every category here.
  //
  //   receiver-live-monitor      P3 live workspace
  //   receiver-status-strip      P3 live/stale/rate/RSSI strip
  //   receiver-observed-rate     MEASURED cadence surface (no fabricated Hz)
  //   -fill                      P3 smoothing target (receiver-channel-N-fill)
  //   CHANNEL_SMOOTHING_MS       the 50ms presentation constant itself
  //   receiver-mode-row          P4 mode surface
  //   receiver-mode-select       P4 capability-gated mode control
  //   receiver-provider-select   P4 capability-gated provider control
  //   receiver-dependency-block  P4 Ports dependency blocking
  //   applyReceiverModeToFeatureMask
  //                              the ONLY legal feature-mask mutation
  //   resolveProviderAvailability
  //                              connected-build capability resolution
  //   selectableReceiverModes    capability-filtered mode offering
  //   encodeFeatureConfig        the whole-mask encoder
  'receiver-live-monitor',
  'receiver-status-strip',
  'receiver-observed-rate',
  '-fill',
  'CHANNEL_SMOOTHING_MS',
  'receiver-mode-row',
  'receiver-mode-select',
  'receiver-provider-select',
  'receiver-dependency-block',
  'applyReceiverModeToFeatureMask',
  'resolveProviderAvailability',
  'selectableReceiverModes',
  'encodeFeatureConfig',
  // Firmware Flasher and the landing route are product surfaces, not
  // optional debug code. Their protocol owners must ship in Release.
  // ENTRY CLEANUP: 'start-configure' replaced 'start-connection' - the
  // Home choice now opens the configurator DIRECTLY, and the connection
  // workspace ships inside the Setup tab (SetupScreen/setupSessionHost).
  // Board alignment ships as a working transaction, not as a read-only
  // panel: the controller, both codecs, the write command and the card's
  // own surface must all be present together.
  'BoardAlignmentController',
  'board-alignment-card',
  'board-alignment-save',
  'decodeBoardAlignment',
  'encodeChangedBoardAlignment',
  'MSP_SET_BOARD_ALIGNMENT_CONFIG',
  'firmware-flasher-screen',
  'start-configure',
  'setup-connect-workspace',
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
  // P3: the propeller warning became one concise sentence - the same
  // safety intent, stated once instead of as a checklist ritual.
  'أزل المراوح قبل اختبار المحركات.',
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
  // The hardware-verification titles that replaced the English review
  // token above. Required, not merely permitted: removing an internal
  // phrase must not quietly remove the warning with it. A software ACK
  // still proves storage, never physical behaviour, and these two lines
  // are how the operator is told so.
  'يتطلب التحقق على جهاز فعلي',
  'يتطلب اختبارًا على جهاز فعلي',
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
 *
 * `reExporters` lists every non-test module permitted to RE-EXPORT the
 * token (`export { token } from ...`, or `export * from` the defining
 * module). A named import is not the only way to widen a boundary: a
 * barrel that re-exports the token makes it reachable from anywhere that
 * imports the barrel, including through a namespace import that never
 * names the token in an import statement at all. Omitted means "no module
 * may re-export this", which is what every P1 primitive wants.
 *
 * The analysis additionally rejects any USE of the token identifier in a
 * module that is neither the definer nor a permitted importer, with
 * comments and string literals stripped first. That is what turns this
 * from a check on import statements into a check on reachability: a
 * namespace import (`import * as core`) or a dynamic import followed by
 * `.token(...)` is caught even though no import statement names it.
 */
const ENGINE_BOUNDARIES = [
  {
    token: 'encodeSetMotorPayload',
    from: 'src/core/protocol/msp/encoding/encodeSetMotorPayload.ts',
    importers: [
      'src/core/state/motorControlCommandEngine.ts',
    ],
  },
  {
    token: 'buildSingleMotorVector',
    from: 'src/core/firmware-adapters/betaflightMotorVectorsV147.ts',
    importers: [],
  },
  // P1-C/P1-D declared these general motor-command primitives without a
  // runtime caller. An EMPTY importer list is the point: the boundary is
  // in place from the day the primitive exists, so the P2 pass that first
  // imports one has to say so here rather than slipping it in.
  {
    token: 'buildMotorVector',
    from: 'src/core/firmware-adapters/betaflightMotorVectorsV147.ts',
    importers: [
      'src/core/state/motorControlCommandEngine.ts',
    ],
  },
  {
    token: 'buildAllStopVectorForDomain',
    from: 'src/core/firmware-adapters/betaflightMotorVectorsV147.ts',
    importers: [
      'src/core/state/motorControlCommandEngine.ts',
    ],
  },
  {
    token: 'buildSingleOutputVectorForDomain',
    from: 'src/core/firmware-adapters/betaflightMotorVectorsV147.ts',
    importers: [
      'src/core/state/motorTestController.ts',
    ],
  },
  {
    token: 'encodeDshotCommand',
    from: 'src/core/protocol/msp/encoding/encodeDshotEscDirection.ts',
    importers: [],
  },
  {
    token: 'encodeDshotMotorStopCommand',
    from: 'src/core/protocol/msp/encoding/encodeDshotEscDirection.ts',
    importers: [
      'src/core/state/motorControlCommandEngine.ts',
    ],
  },
  {
    token: 'buildAllStopVector',
    from: 'src/core/firmware-adapters/betaflightMotorVectorsV147.ts',
    importers: [],
  },
  {
    token: 'MSP_SET_MOTOR',
    from: 'src/core/protocol/msp/commands/motorTestCommands.ts',
    importers: [
      'src/core/state/motorControlCommandEngine.ts',
    ],
  },
  {
    token: 'encodeChangedMotorConfiguration',
    from: 'src/core/protocol/msp/encoding/encodeMotorConfiguration.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
    reExporters: [
      'src/core/protocol/msp/index.ts',
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
      'src/platforms/react-native/protocol/PidTuningController.ts',
      'src/platforms/react-native/protocol/ModesConfigurationController.ts',
      'src/platforms/react-native/protocol/FailsafeConfigurationController.ts',
      'src/platforms/react-native/protocol/PowerConfigurationController.ts',
      'src/platforms/react-native/protocol/OsdConfigurationController.ts',
      'src/platforms/react-native/protocol/VtxConfigurationController.ts',
      'src/platforms/react-native/protocol/BoardAlignmentController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'encodeChangedPidTuning',
    from: 'src/core/protocol/msp/encoding/encodePidTuning.ts',
    importers: ['src/platforms/react-native/protocol/PidTuningController.ts'],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_PID',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: ['src/platforms/react-native/protocol/PidTuningController.ts'],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_PID_ADVANCED',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: ['src/platforms/react-native/protocol/PidTuningController.ts'],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_FILTER_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: ['src/platforms/react-native/protocol/PidTuningController.ts'],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_RC_TUNING',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: ['src/platforms/react-native/protocol/PidTuningController.ts'],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
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
      // RECEIVER P4: writing the receiver MODE means replacing the whole
      // feature word (msp.c:3712-3714 is featureConfigReplace), so this
      // controller joins the registry deliberately and visibly. Its
      // mutation is the shared, tested one in
      // src/core/state/receiverModeCapability.ts, which clears ONLY the
      // five RX bits and preserves every other bit of a mask read fresh
      // inside the same transaction.
      'src/platforms/react-native/protocol/ReceiverConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP2_COMMON_SET_SERIAL_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/PortsConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_GPS_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GpsConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    // Board alignment's write command. One owner, and the rule exists so
    // it stays one: these three angles rotate every sensor reading the
    // aircraft flies on, and a second module reaching them would be a
    // second place that can silently change how the board is mounted.
    token: 'MSP_SET_BOARD_ALIGNMENT_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/BoardAlignmentController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'encodeChangedBoardAlignment',
    from: 'src/core/protocol/msp/encoding/encodeBoardAlignment.ts',
    importers: [
      'src/platforms/react-native/protocol/BoardAlignmentController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_MIXER_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_ADVANCED_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'encodeChangedGeneralConfiguration',
    from: 'src/core/protocol/msp/encoding/encodeGeneralConfiguration.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_ARMING_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_BEEPER_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'encodeChangedReceiverConfiguration',
    from: 'src/core/protocol/msp/encoding/encodeReceiver.ts',
    importers: [
      'src/platforms/react-native/protocol/ReceiverConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_RX_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
      'src/platforms/react-native/protocol/ReceiverConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_RX_MAP',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/ReceiverConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_RSSI_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/ReceiverConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_RC_DEADBAND',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/ReceiverConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP2_SET_TEXT',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/GeneralConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_MOTOR_3D_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP_SET_MOTOR_CONFIG',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'encodeMotorOutputOrder',
    from: 'src/core/protocol/msp/encoding/encodeMotorOutputOrder.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'encodeDshotEscDirection',
    from: 'src/core/protocol/msp/encoding/encodeDshotEscDirection.ts',
    importers: [
      'src/core/state/motorTestController.ts',
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP2_SET_MOTOR_OUTPUT_REORDERING',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
    ],
  },
  {
    token: 'MSP2_SEND_DSHOT_COMMAND',
    from: 'src/core/protocol/msp/commands/mspCommands.ts',
    importers: [
      'src/core/state/motorTestController.ts',
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
          'src/core/state/motorControlCommandEngine.ts',
    ],
    reExporters: [
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
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
/**
 * Bidi isolate marks (U+2066 LRI .. U+2069 PDI) are invisible: Arabic copy
 * uses them so an RTL line does not print the conjunction to the LEFT of a
 * Latin word ("...و" landing after "Telemetry"). Stripping them here keeps
 * this guard asking the question it is for - did the SENTENCE ship, or did
 * a raw i18n key ship - instead of failing on punctuation a reader cannot
 * see. A missing sentence still fails, which is the point.
 */
function withoutBidiMarks(text) {
  // Both the real characters and the \uXXXX escapes a minifier emits.
  return text
    .replace(/[\u2066-\u2069\u200e\u200f]/g, '')
    .replace(/\\u20(?:6[6-9]|0[ef])/gi, '');
}

function containsEitherForm(haystack, text) {
  if (haystack.includes(text)) {
    return true;
  }
  if (haystack.includes(escapeNonAscii(text))) {
    return true;
  }
  const bare = withoutBidiMarks(text);
  const plain = withoutBidiMarks(haystack);
  return plain.includes(bare) || plain.includes(escapeNonAscii(bare));
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
/** Comments and string/template literals removed, so a token mentioned in
 * prose or in a log message is never mistaken for a reference to it. */
function executableText(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** Module specifier without extension, for `export * from` matching. */
function moduleSpecifierOf(path) {
  return path.replace(/^src\//, '').replace(/\.tsx?$/, '');
}

function analyzeEngineBoundaries(sources) {
  const violations = [];
  const stale = [];
  const reExportViolations = [];
  const indirectUses = [];

  for (const boundary of ENGINE_BOUNDARIES) {
    const allowedReExporters = boundary.reExporters ?? [];
    const definingSpecifier = moduleSpecifierOf(boundary.from);
    const actual = [];
    for (const [path, text] of Object.entries(sources)) {
      if (path === boundary.from) {
        continue;
      }
      const code = executableText(text);
      // 1. An import edge: the token inside an import statement.
      const importPattern = new RegExp(
        `import[^;]*\\b${boundary.token}\\b[^;]*from[^;]*;`,
        'g',
      );
      if (importPattern.test(text)) {
        actual.push(path);
      }
      // 2. A re-export edge, named or wildcard. Either makes the token
      //    reachable from every module that imports THIS one.
      const namedReExport = new RegExp(
        `export[^;]*\\b${boundary.token}\\b[^;]*from[^;]*;`,
        'g',
      );
      const wildcardReExport = new RegExp(
        `export\\s*\\*\\s*from\\s*['"][^'"]*${definingSpecifier.split('/').pop()}['"]`,
        'g',
      );
      if (
        (namedReExport.test(text) || wildcardReExport.test(text)) &&
        !allowedReExporters.includes(path)
      ) {
        reExportViolations.push({ token: boundary.token, reExporter: path });
      }
      // 3. Any USE of the identifier in executable code from a module that
      //    is neither a permitted importer nor a permitted re-exporter.
      //    Catches namespace imports and dynamic imports, which name
      //    nothing in an import statement.
      if (
        !boundary.importers.includes(path) &&
        !allowedReExporters.includes(path) &&
        new RegExp(`\\b${boundary.token}\\b`).test(code)
      ) {
        indirectUses.push({ token: boundary.token, module: path });
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

  // D3: every dispatch of the motor command goes through a lease.
  //
  // P2-ii FINAL STATE: the dispatch sites moved OUT of the controller and
  // into its tightly-owned command engine - the controller now encodes and
  // sends nothing itself. Both files are scanned so a dispatch reappearing
  // in the controller is caught, and the engine's sites are still required
  // to be lease-shaped.
  const dispatchOwners = [
    'src/core/state/motorTestController.ts',
    'src/core/state/motorControlCommandEngine.ts',
  ];
  const dispatchSites = dispatchOwners.flatMap(file => {
    const executable = (sources[file] ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    return Array.from(
      executable.matchAll(
        /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(\s*MSP_SET_MOTOR\b/g,
      ),
    ).map(match => ({ file, receiver: match[1], method: match[2] }));
  });
  const unleashed = dispatchSites.filter(
    site =>
      site.receiver !== 'lease' &&
      !LEASE_GUARDED_DISPATCH.includes(site.method),
  );

  return {
    violations,
    stale,
    reExportViolations,
    indirectUses,
    dispatchSites,
    unleashed,
    ok:
      violations.length === 0 &&
      stale.length === 0 &&
      reExportViolations.length === 0 &&
      indirectUses.length === 0 &&
      unleashed.length === 0,
  };
}

/**
 * RECEIVER P5 - the UI/protocol authority boundary, checked in CI.
 *
 * ReceiverScreen is a presentation component. It must reach protocol only
 * through the narrow `receiverPresentation` facade, never through the
 * ~180-symbol platform barrel that also exports RNMspTransport and the
 * live session coordinator, and it must name no raw MSP command constant.
 *
 * SOURCE-AWARE, not prose-aware: comments are stripped first, because the
 * screen legitimately DISCUSSES these names in its documentation and the
 * pre-P3 version of this check would have fired on ordinary explanatory
 * text rather than on executable authority.
 *
 * receiverBoundary.test.ts asserts the same contract at a finer grain;
 * this runs it in the production scan so a bundle cannot be published
 * from a tree that violates it.
 */
const RECEIVER_SCREEN_PATH = 'src/ui/screens/ReceiverScreen.tsx';
const RECEIVER_FACADE_SPECIFIER = 'platforms/react-native/protocol/receiverPresentation';
const RECEIVER_FORBIDDEN_AUTHORITY = [
  'MspClient',
  'RNMspTransport',
  'mspSessionCoordinator',
  'MspTelemetryScheduler',
  'MSP_RC',
  'MSP_SET_RX_CONFIG',
  'MSP_SET_RX_MAP',
  'MSP_SET_RSSI_CONFIG',
  'MSP_SET_RC_DEADBAND',
  'MSP_SET_FEATURE_CONFIG',
  'MSP2_COMMON_SET_SERIAL_CONFIG',
  'MSP_SET_RXFAIL_CONFIG',
  'MSP_REBOOT',
  'MSP_EEPROM_WRITE',
  'encodeFeatureConfig',
  'encodeChangedReceiverConfiguration',
  'applyReceiverModeToFeatureMask',
];

function analyzeReceiverBoundary(sources) {
  const source = sources[RECEIVER_SCREEN_PATH];
  if (source === undefined) {
    return { violations: [{ kind: 'MISSING_SCREEN', detail: RECEIVER_SCREEN_PATH }], ok: false };
  }
  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const violations = [];

  const specifiers = [...executable.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
  if (!specifiers.some(specifier => specifier.endsWith(RECEIVER_FACADE_SPECIFIER))) {
    violations.push({ kind: 'FACADE_NOT_USED', detail: RECEIVER_FACADE_SPECIFIER });
  }
  for (const specifier of specifiers) {
    if (
      specifier.includes('platforms/react-native/protocol') &&
      !specifier.endsWith(RECEIVER_FACADE_SPECIFIER)
    ) {
      violations.push({ kind: 'BROAD_PROTOCOL_IMPORT', detail: specifier });
    }
  }
  for (const token of RECEIVER_FORBIDDEN_AUTHORITY) {
    if (executable.includes(token)) {
      violations.push({ kind: 'RAW_AUTHORITY', detail: token });
    }
  }
  return { violations, ok: violations.length === 0 };
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
  const sourceTree = readSourceTree();
  const boundaries = analyzeEngineBoundaries(sourceTree);
  const receiverBoundary = analyzeReceiverBoundary(sourceTree);

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
      `   BOUNDARY CROSSED: ${entry.importer} imports ${entry.token} outside its reviewed allowlist.`,
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

  console.log('');
  console.log('E. Receiver UI/protocol authority boundary (source)');
  for (const entry of receiverBoundary.violations) {
    if (entry.kind === 'FACADE_NOT_USED') {
      console.error(
        `   BOUNDARY BROKEN: ReceiverScreen no longer imports the narrow ${entry.detail} facade.`,
      );
    } else if (entry.kind === 'BROAD_PROTOCOL_IMPORT') {
      console.error(
        `   BOUNDARY CROSSED: ReceiverScreen imports ${JSON.stringify(
          entry.detail,
        )} - the broad platform barrel also exports RNMspTransport and the live session coordinator.`,
      );
    } else if (entry.kind === 'RAW_AUTHORITY') {
      console.error(
        `   RAW AUTHORITY IN UI: ReceiverScreen names ${JSON.stringify(
          entry.detail,
        )} in executable code.`,
      );
    } else {
      console.error(`   ${entry.kind}: ${entry.detail}`);
    }
  }
  if (receiverBoundary.ok) {
    console.log(
      `   ReceiverScreen reaches protocol only through receiverPresentation; ${RECEIVER_FORBIDDEN_AUTHORITY.length} raw-authority tokens absent from executable code.`,
    );
  }

  if (!bundle.ok || !boundaries.ok || !receiverBoundary.ok) {
    console.error('');
    console.error('SCAN FAILED.');
    return 1;
  }
  console.log('');
  console.log(
    'OK - no forbidden token present, engine and Arabic safety copy both shipped, positive controls present, engine and Receiver boundaries intact.',
  );
  return 0;
}

module.exports = {
  analyzeReceiverBoundary,
  RECEIVER_FORBIDDEN_AUTHORITY,
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
