/**
 * SETUP P1 - THE STRUCTURAL BOUNDARY.
 *
 * Two guarantees, both enforced by reading source rather than by
 * convention:
 *
 *   1. Setup UI reaches the protocol/session layer ONLY through
 *      setupPresentation (reads) and fcToolsController (Setup-owned
 *      commands). It cannot touch the coordinator, a client, a
 *      transport, a raw MSP command, a codec, or poll registration.
 *   2. setupPresentation's own export surface is hand-listed and stays
 *      narrow - it must not drift into "everything Setup might someday
 *      need", and it must never re-export write authority.
 *
 * WHY A SOURCE SCAN. The P0 defect was not a logic error - it was a
 * screen quietly holding a capability it should never have had (naming
 * raw poll ids) for long enough that two of them stopped existing without
 * anyone noticing. A type system cannot express "this layer may not know
 * that name"; a scan can.
 */

import {readFileSync, readdirSync, statSync} from 'fs';
import {join} from 'path';

import * as setupPresentation from './setupPresentation';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SETUP_UI_ROOTS = [
  join(REPO_ROOT, 'src', 'ui', 'screens'),
  join(REPO_ROOT, 'src', 'ui', 'components', 'setup'),
  join(REPO_ROOT, 'src', 'ui', 'orientation3d'),
];

/** Only the Setup surface - other screens own their own boundaries. */
const SETUP_SCREEN_FILES = new Set(['SetupScreen.tsx']);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function setupUiFiles(): string[] {
  const files: string[] = [];
  for (const root of SETUP_UI_ROOTS) {
    for (const file of listSourceFiles(root)) {
      const name = file.split('/').pop() ?? '';
      if (root.endsWith(join('ui', 'screens'))) {
        if (!SETUP_SCREEN_FILES.has(name)) continue;
      }
      files.push(file);
    }
  }
  return files;
}

/** Every `import ... from '<specifier>'` plus the imported names. */
function importsOf(source: string): {specifier: string; clause: string}[] {
  const out: {specifier: string; clause: string}[] = [];
  const pattern = /import\s+([\s\S]*?)\s*from\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    out.push({clause: match[1], specifier: match[2]});
  }
  return out;
}

/** Comments explain the boundary; they must not trip the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** String literals too, for the checks that look for IDENTIFIERS. A
 * domain tag that happens to read `'MSP_SESSION'` is a presentation
 * enum, not a wire command, and must not be mistaken for one. */
function stripCommentsAndStrings(source: string): string {
  return stripComments(source)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('SETUP P1 - Setup UI protocol boundary', () => {
  const files = setupUiFiles();

  it('scans a non-trivial Setup surface (a silent zero-file scan proves nothing)', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.some(f => f.endsWith('SetupScreen.tsx'))).toBe(true);
  });

  it('never imports mspSessionCoordinator', () => {
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect({file, hit: /\bmspSessionCoordinator\b/.test(source)}).toEqual({
        file,
        hit: false,
      });
    }
  });

  it('never imports a client, a transport, or the protocol barrel wholesale', () => {
    const forbidden = [
      /\bMspClient\b/,
      /\bRNMspTransport\b/,
      /\bUsbSerialTransportClient\b/,
      /from\s*'[^']*\/transport[^']*'/,
      /import\s*\*\s*as/,
    ];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of forbidden) {
        expect({file, pattern: String(pattern), hit: pattern.test(source)}).toEqual(
          {file, pattern: String(pattern), hit: false},
        );
      }
    }
  });

  it('never names a raw MSP command constant', () => {
    for (const file of files) {
      const source = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      expect({file, hit: /\bMSP_[A-Z0-9_]+\b/.test(source)}).toEqual({
        file,
        hit: false,
      });
    }
  });

  it('never names a telemetry poll id or registers a poll', () => {
    const forbidden = [
      /_TELEMETRY_POLL_ID\b/,
      /\bregisterPoll\b/,
      /\bacquirePollSuppression\b/,
      /\bacquirePollIntervalOverride\b/,
      /\bacquirePauseLease\b/,
      /\bgetTelemetryScheduler\b/,
    ];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of forbidden) {
        expect({file, pattern: String(pattern), hit: pattern.test(source)}).toEqual(
          {file, pattern: String(pattern), hit: false},
        );
      }
    }
  });

  it('never calls a frame encoder or decoder directly', () => {
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      // `deriveSetupDiagnostics` and friends are pure view models and are
      // fine; a call into the wire codecs is not.
      expect({file, hit: /\b(decode|encode)[A-Z]\w*\s*\(/.test(source)}).toEqual({
        file,
        hit: false,
      });
    }
  });

  it('never reaches motor-test authority', () => {
    const forbidden = [
      /\breadMotorTestCapability\b/,
      /\bopenMotorTestCapability\b/,
      /\bisMotorTestSessionActive\b/,
      /\bmotorTestController\b/,
      /\bmotorConfigurationController\b/,
    ];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of forbidden) {
        expect({file, pattern: String(pattern), hit: pattern.test(source)}).toEqual(
          {file, pattern: String(pattern), hit: false},
        );
      }
    }
  });

  it('imports from the protocol layer ONLY through the facade or the accepted command surface', () => {
    /** Names Setup UI may still take from the protocol barrel: the
     * Setup-OWNED command controller and its read hooks, the plain UI
     * session store (not a protocol authority), and types.
     *
     * SETUP P3 added exactly one more, and deliberately did NOT put it in
     * the facade. `setupPresentation` is Setup's READ-ONLY window - hooks
     * that observe and reads that snapshot - and every name in it can be
     * called without changing anything. Acquiring a poll-suppression
     * lease is a lifecycle ACTION with a side effect on the scheduler, so
     * routing it through the read-only facade would have made that
     * contract false in order to satisfy this test. It is listed here
     * instead, which is the honest place for it: a reviewer sees a
     * side-effecting protocol call being granted to the UI, by name.
     *
     * The lease itself is still owned by a dedicated protocol-layer
     * module (setupHiddenAttitudeSuppression), beside the two lease
     * owners that already exist for this poll id - Setup passes a session
     * key and gets a release function, and still never names a poll id.
     */
    const ACCEPTED_BARREL_NAMES = new Set([
      'fcToolsController',
      'useFcToolPhase',
      'useFcToolPublication',
      'setupUiSessionStore',
      'acquireSetupHiddenAttitudeSuppression',
    ]);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const {specifier, clause} of importsOf(source)) {
        if (!/platforms\/react-native\/protocol/.test(specifier)) continue;
        if (/setupPresentation$/.test(specifier)) continue; // the facade
        if (/^\s*type\b/.test(clause)) continue; // type-only imports erase
        const names = clause
          .replace(/[{}]/g, '')
          .split(',')
          .map(name => name.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        for (const name of names) {
          expect({file, name, accepted: ACCEPTED_BARREL_NAMES.has(name)}).toEqual({
            file,
            name,
            accepted: true,
          });
        }
      }
    }
  });
});

describe('SETUP P1 - setupPresentation export contract', () => {
  /** The complete, deliberate surface. A new export must be added here on
   * purpose, with a reviewer looking at it. */
  const EXPECTED_EXPORTS = [
    'ensureSetupArmedStateAvailable',
    'readSetupAppStatePhase',
    'readSetupFreshAttitude',
    'readSetupIdentificationStatus',
    'readSetupOwnershipState',
    'readSetupTelemetryDiagnostics',
    'startSetupTelemetryOwnership',
    'useSetupAppStatePhase',
    'useSetupArmedState',
    'useSetupAttitude',
    'useSetupBattery',
    'useSetupChannelState',
    'useSetupConnected',
    'useSetupGps',
    'useSetupIdentificationState',
    'useSetupOwnershipState',
    'useSetupReceiver',
    'useSetupRecoveryState',
    'useSetupStatus',
  ].sort();

  it('exports exactly the hand-listed surface, and nothing more', () => {
    expect(Object.keys(setupPresentation).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it('stays small - a facade that grows without review is not a boundary', () => {
    expect(EXPECTED_EXPORTS.length).toBeLessThanOrEqual(24);
  });

  it('uses no wildcard re-export', () => {
    const source = readFileSync(join(__dirname, 'setupPresentation.ts'), 'utf8');
    expect(stripComments(source)).not.toMatch(/export\s*\*\s*from/);
  });

  it('exposes no write, command or scheduler-mutation verb', () => {
    const forbidden =
      /^(save|write|set|send|request|apply|reboot|calibrate|arm|disarm|register|unregister|pause|resume|suppress|override|close|open)/i;
    for (const name of Object.keys(setupPresentation)) {
      // `ensureSetupArmedStateAvailable` is the one outbound call and is
      // named for the READ it enables; it can only trigger the
      // at-most-once BOXIDS acquisition.
      if (name === 'ensureSetupArmedStateAvailable') continue;
      if (name === 'startSetupTelemetryOwnership') continue;
      expect({name, forbidden: forbidden.test(name)}).toEqual({
        name,
        forbidden: false,
      });
    }
  });

  it('every export is a function - no singleton, store or client escapes through it', () => {
    for (const [name, value] of Object.entries(setupPresentation)) {
      expect({name, type: typeof value}).toEqual({name, type: 'function'});
    }
  });
});

describe('SETUP P1 - Setup steals no other screen ownership', () => {
  const files = setupUiFiles();

  it.each([
    ['Receiver', /receiverConfigurationController|ReceiverConfigurationController/],
    ['GPS', /gpsConfigurationController|GpsConfigurationController/],
    ['Ports', /portsConfigurationController|PortsConfigurationController/],
    ['Power', /powerConfigurationController|PowerConfigurationController/],
    ['Sensors', /acquireSensorsTelemetry|sensorsTelemetry/],
    ['Failsafe', /failsafeConfigurationController|FailsafeConfigurationController/],
    ['Motors', /motorTest|MotorTest|motorConfiguration/],
    ['Modes', /modesConfigurationController|ModesConfigurationController/],
    ['OSD', /osdConfigurationController|OsdConfigurationController/],
    ['VTX', /vtxConfigurationController|VtxConfigurationController/],
    ['PID', /pidTuningController|PidTuningController/],
    ['CLI', /rawCliSessionController|RawCliSessionController/],
  ])('writes nothing owned by %s', (_owner, pattern) => {
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect({file, hit: pattern.test(source)}).toEqual({file, hit: false});
    }
  });

  it('the only Setup-owned command surface is fcToolsController', () => {
    const controllerImports = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const {clause} of importsOf(source)) {
        for (const name of clause.replace(/[{}]/g, '').split(',')) {
          const trimmed = name.trim().split(/\s+as\s+/)[0].trim();
          if (/Controller$|controller$/.test(trimmed)) {
            controllerImports.add(trimmed);
          }
        }
      }
    }
    expect([...controllerImports].sort()).toEqual([
      'FcToolsController',
      'fcToolsController',
    ]);
  });
});
