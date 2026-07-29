#!/usr/bin/env node
/**
 * Production-bundle containment scanner.
 *
 * Generates a REAL `--dev false` Android bundle into a temporary directory
 * OUTSIDE this repository and scans the emitted bytes. It never scans
 * source files: source proves what was written, only the bundle proves
 * what actually ships.
 *
 * Pass 7.7 introduced it for the debug panels. Repair Pass R2 extends it to
 * the motor-test engine and makes it a mandatory CI gate.
 *
 * TWO CATEGORIES, DELIBERATELY NOT MERGED
 * ---------------------------------------
 * A. STRICTLY FORBIDDEN. The motor-test engine: controller, binding,
 *    encoder, vector builders, command id, pulse constant, monitor states
 *    and screen sentinels. Any occurrence at all is a failure.
 *
 * B. APPROVED RETAINED LEASE-KERNEL SENTINEL.
 *    `emergencyStopWithMotorTestLease` is a method on `MspClient`, the one
 *    object that owns MSP request admission. `MspClient` is legitimately
 *    in Release because all telemetry runs through it, and extracting the
 *    lease from it would weaken the same-client exclusivity guarantee that
 *    its placement IS. Retained under explicit architectural review,
 *    capped at one occurrence, and printed by name on every run so it can
 *    never become invisible. It is NOT the motor engine: it carries no
 *    command id, no vector, no pulse value, no encoder and no Release
 *    consumer, and cannot construct or authorize a motor command alone.
 *
 * Bare numbers (214, 1000, 1050) are deliberately NOT scanned: they have
 * legitimate unrelated occurrences and would produce meaningless failures.
 *
 * Usage:  node scripts/scan-production-bundle.js
 * Exit 0 = containment holds. Exit 1 = a forbidden token is present, a
 * positive control is missing, or the retained sentinel exceeded its cap.
 * Exit 2 = the bundle could not be generated.
 */

const {execFileSync} = require('child_process');
const {createHash} = require('crypto');
const {mkdtempSync, readFileSync, rmSync} = require('fs');
const {tmpdir} = require('os');
const {join} = require('path');

/** CATEGORY A - every entry must be at exactly zero. Copied verbatim from
 * real source in this repository. */
const FORBIDDEN_TOKENS = [
  // Pass 7.7 - the debug panels.
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
  // R2 - the motor-test engine.
  'createMotorTestController',
  'MOTOR_TEST_FIXED_PULSE_VALUE',
  'pulseMotor',
  'MSP_SET_MOTOR',
  'createMotorTestSessionBinding',
  'getMotorTestSessionCapability',
  'operatorPort',
  'beginSession',
  'buildSingleMotorVector',
  'buildAllStopVector',
  'encodeSetMotorPayload',
  'UNAVAILABLE_NO_ACCEPTED_SOURCE',
  'CONTINUOUS_SAFETY_MONITORING_UNAVAILABLE',
  'physicalStopConfirmed',
  // R2 - motor screen / wizard sentinels.
  'motors-hold-button',
  'motors-stop-button',
  'motors-screen',
  'verification-wizard',
  'motor-test-report',
  'dev-open-motor-test',
  'MOTOR_TEST_EXPECTED_CONFIGURATION',
];

/** CATEGORY B - approved retained sentinel, with a hard cap. Exceeding it
 * fails: that would mean something beyond the shared kernel's own
 * definition had entered Release. */
const RETAINED_KERNEL_SENTINELS = [
  {token: 'emergencyStopWithMotorTestLease', maxOccurrences: 1},
];

/** The wider retained lease surface, reported for transparency only.
 * Definitions inside the shared `MspClient` kernel: infrastructure, NOT
 * evidence that the engine shipped. */
const RETAINED_KERNEL_INVENTORY = [
  'MspMotorTestLeaseToken',
  'tryAcquireMotorTestLease',
  'isMotorTestLeaseToken',
  'isMotorTestLeaseHeld',
  'requestWithMotorTestLease',
  'emergencyStopWithMotorTestLease',
  'releaseMotorTestLease',
  'faultMotorTestLeaseByToken',
  'MSP_MOTOR_TEST_LEASE_HELD',
  'MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID',
];

/** Must be PRESENT. Without these the scan is vacuous - an empty or
 * truncated bundle would otherwise "pass" with zero forbidden tokens.
 * Region 4/5 testIDs are used rather than their Arabic titles because
 * Metro escapes non-ASCII literals, making a literal match unreliable. */
const POSITIVE_CONTROLS = ['diagnostics-section', 'fc-tools-section'];

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
      forbidden.push({token, count, offset: bundleText.indexOf(token)});
    }
  }

  const retained = RETAINED_KERNEL_SENTINELS.map(({token, maxOccurrences}) => {
    const count = countOccurrences(bundleText, token);
    return {token, count, maxOccurrences, exceeded: count > maxOccurrences};
  });

  const inventory = RETAINED_KERNEL_INVENTORY.map(token => ({
    token,
    count: countOccurrences(bundleText, token),
  }));

  const missingControls = POSITIVE_CONTROLS.filter(
    token => countOccurrences(bundleText, token) === 0,
  );

  return {
    forbidden,
    retained,
    inventory,
    missingControls,
    ok:
      forbidden.length === 0 &&
      missingControls.length === 0 &&
      retained.every(entry => !entry.exceeded),
  };
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
    {stdio: 'inherit'},
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
    rmSync(outputDirectory, {recursive: true, force: true});
  }

  const result = analyzeBundle(bundleText);

  console.log(`Bundle size: ${bytes} bytes`);
  console.log(`Bundle SHA-256: ${sha256}`);
  console.log(`Scanned ${FORBIDDEN_TOKENS.length} strictly forbidden tokens.`);

  for (const entry of result.forbidden) {
    console.error(
      `FORBIDDEN TOKEN PRESENT: ${JSON.stringify(entry.token)} x${entry.count} at byte offset ${entry.offset}`,
    );
  }
  for (const token of result.missingControls) {
    console.error(
      `MISSING POSITIVE CONTROL: ${JSON.stringify(token)} - the scan would be vacuous.`,
    );
  }

  console.log('');
  console.log('RETAINED LEASE SAFETY KERNEL — NOT RELEASE MOTOR ENGINE');
  for (const entry of result.retained) {
    const verdict = entry.exceeded
      ? `EXCEEDS approved maximum ${entry.maxOccurrences}`
      : `within approved maximum ${entry.maxOccurrences}`;
    const line = `  ${entry.token}: ${entry.count} (${verdict})`;
    if (entry.exceeded) {
      console.error(line);
    } else {
      console.log(line);
    }
  }
  console.log('  Retained lease-surface inventory (infrastructure only):');
  for (const entry of result.inventory) {
    console.log(`    ${entry.token}: ${entry.count}`);
  }

  const sentinel = result.retained.find(
    entry => entry.token === 'emergencyStopWithMotorTestLease',
  );
  console.log('');
  console.log(
    `Strictly forbidden motor-engine tokens: ${result.forbidden.length}`,
  );
  console.log(
    `Approved retained lease-kernel sentinel: ${sentinel ? sentinel.count : 0}`,
  );

  if (!result.ok) {
    console.error('');
    console.error('CONTAINMENT FAILED.');
    return 1;
  }
  console.log('');
  console.log(
    'OK - no strictly forbidden token present, positive controls present, retained kernel within its approved cap.',
  );
  return 0;
}

module.exports = {
  analyzeBundle,
  countOccurrences,
  FORBIDDEN_TOKENS,
  POSITIVE_CONTROLS,
  RETAINED_KERNEL_SENTINELS,
  RETAINED_KERNEL_INVENTORY,
  main,
};

// Explicit main-module guard: importing this file for tests must never
// launch a Metro build as a side effect.
if (require.main === module) {
  process.exit(main());
}
