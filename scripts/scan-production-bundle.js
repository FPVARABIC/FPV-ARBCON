#!/usr/bin/env node
/**
 * Pass 7.7 - generates a dev=false production JS bundle into a TEMPORARY
 * directory OUTSIDE this repository and scans it for a narrow,
 * source-derived forbidden-token list.
 *
 * The list is deliberately specific. Generic words like "diagnostic",
 * "diagnostics" or "تشخيص" are NOT forbidden and must never be added:
 * Region 4 legitimately ships a diagnostics section titled
 * "التشخيص والجاهزية".
 *
 * Usage:  node scripts/scan-production-bundle.js
 * Exit 0 = no forbidden token found. Exit 1 = at least one found (each is
 * printed with its byte offset). Exit 2 = the bundle could not be built.
 */

const {execFileSync} = require('child_process');
const {mkdtempSync, readFileSync, rmSync} = require('fs');
const {tmpdir} = require('os');
const {join} = require('path');

/** Every entry is copied verbatim from real source in this repository. */
const FORBIDDEN_TOKENS = [
  // Native module + package names (UsbAppLogCapturePanel.tsx, the debug
  // Kotlin source set).
  'UsbAppLogCapture',
  'UsbAppLogCapturePackage',
  'UsbAppLogCaptureModule',
  'UsbBoundedProcessReader',
  // The bridge method the panel calls.
  'captureAppLog',
  // The panel's own user-facing copy and its exact test ID
  // (UsbAppLogCapturePanel.tsx:88, :90).
  'App Log Capture (own process, no adb needed)',
  'debug-toggle-app-log',
  // The other debug panel's exact test IDs (UsbSerialDebugPanel.tsx).
  'polling-capacity-audit-run',
  'debug-start-reading',
  'debug-stop-reading',
  'debug-byte-input',
  'debug-send-custom',
  'debug-clear-log',
];

function main() {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'fpv-arbcon-bundle-'));
  const bundlePath = join(outputDirectory, 'index.android.bundle');
  try {
    console.log(`Generating dev=false bundle into ${outputDirectory} (outside the repository)...`);
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

    const bundle = readFileSync(bundlePath, 'utf8');
    const found = [];
    for (const token of FORBIDDEN_TOKENS) {
      const index = bundle.indexOf(token);
      if (index >= 0) {
        found.push({token, index});
      }
    }

    console.log(`Bundle size: ${bundle.length} bytes. Scanned ${FORBIDDEN_TOKENS.length} forbidden tokens.`);
    if (found.length > 0) {
      for (const {token, index} of found) {
        console.error(`FORBIDDEN TOKEN PRESENT: ${JSON.stringify(token)} at byte offset ${index}`);
      }
      process.exitCode = 1;
      return;
    }
    // A positive control, so an empty or failed bundle cannot pass this
    // scan by accident. Region 4's testID is used rather than its Arabic
    // title because Metro escapes non-ASCII string literals in the
    // bundle, which would make a literal Arabic match unreliable.
    const positiveControls = ['diagnostics-section', 'fc-tools-section'];
    const missing = positiveControls.filter(token => !bundle.includes(token));
    if (missing.length > 0) {
      console.error(`Sanity check failed: the bundle is missing ${missing.join(', ')} - is it really this app?`);
      process.exitCode = 2;
      return;
    }
    console.log('OK - no forbidden token present, and Regions 4 and 5 ARE present.');
  } catch (error) {
    console.error('Failed to generate or scan the production bundle:', error && error.message);
    process.exitCode = 2;
  } finally {
    rmSync(outputDirectory, {recursive: true, force: true});
  }
}

main();
