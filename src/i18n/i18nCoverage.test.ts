/**
 * THE ARABIC-COVERAGE CI GATE.
 *
 * WHY THIS EXISTS. The installed hardware-test APK rendered every motors
 * string as its own i18n key - `motorsScreen.title`,
 * `motorsScreen.blockReason.CONTINUOUS_SAFETY_MONITORING_UNAVAILABLE`,
 * `motorVerification.title` and the rest. i18next's default behaviour on
 * a missing key is to return the key, so a screen with an incomplete
 * catalogue LOOKS like it rendered. Nothing failed, nothing logged, and
 * the defect survived every build, every unit test and CI.
 *
 * WHAT THIS ASSERTS. Every translation key that source can reference
 * exists in `ar.json`, and resolves to a string rather than a subtree.
 * Three classes of reference are covered, because the first alone would
 * have missed most of the observed failures:
 *
 *   1. LITERAL - `t('motorsScreen.title')`. Extracted from source.
 *   2. TEMPLATE PREFIX - t(`motorsScreen.blockReason.${reason}`). The
 *      prefix is extracted from source and must resolve to a non-empty
 *      subtree; the individual members are covered by (3).
 *   3. ENUMERATED FAMILY - the actual union members a template can
 *      produce, listed below as `Record<Union, true>` maps. TypeScript
 *      fails to compile if a union grows and its map is not updated, so a
 *      new block reason cannot be added without also being translated.
 *
 * IT SCANS SOURCE, NOT THE BUNDLE. That is deliberate and is the reason
 * it can run in `npx jest --ci` before anything is built. The bundle-level
 * counterpart is `scripts/scan-production-bundle.js`.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import ar from './locales/ar.json';
import type { MotorTestActivationBlockReason } from '../core/state/motorTestController';
import type {
  MotorPhysicalPosition,
  MotorRotationDirection,
  MotorVerificationOutcome,
} from '../core/state/motorVerificationModel';
import type {
  SerialPortsValidationCode,
  SerialRoleKey,
} from '../core/state/serialPortsModel';
import type {
  GpsBlockReason,
  PortsBlockReason,
} from '../platforms/react-native/protocol';

const REPO_ROOT = join(__dirname, '..', '..');
const SCAN_ROOTS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'App.tsx')];

/** Test files reference keys that do not have to exist (negative cases,
 * synthetic fixtures), so they are not evidence about the product. */
function isScannableFile(path: string): boolean {
  if (!/\.tsx?$/.test(path)) {
    return false;
  }
  return !/\.test\.tsx?$/.test(path) && !path.includes(`${'__tests__'}`);
}

function collectFiles(entry: string, into: string[]): void {
  const stats = statSync(entry);
  if (stats.isFile()) {
    if (isScannableFile(entry)) {
      into.push(entry);
    }
    return;
  }
  for (const name of readdirSync(entry)) {
    collectFiles(join(entry, name), into);
  }
}

const SOURCE_FILES: string[] = [];
for (const root of SCAN_ROOTS) {
  collectFiles(root, SOURCE_FILES);
}

/** `t('a.b')` / `t("a.b")` - a fully static key. */
const LITERAL_KEY_PATTERN = /\bt\(\s*(['"])([A-Za-z][\w]*(?:\.[\w]+)+)\1/g;
/** t(`a.b.${x}`) - the static prefix ahead of the first interpolation. */
const TEMPLATE_PREFIX_PATTERN = /\bt\(\s*`([^`$]*)\$\{/g;

interface Reference {
  readonly key: string;
  readonly file: string;
}

function relative(file: string): string {
  return file.slice(REPO_ROOT.length + 1);
}

function scanSource(): {
  literals: Reference[];
  prefixes: Reference[];
} {
  const literals: Reference[] = [];
  const prefixes: Reference[] = [];
  for (const file of SOURCE_FILES) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(LITERAL_KEY_PATTERN)) {
      literals.push({ key: match[2], file: relative(file) });
    }
    for (const match of text.matchAll(TEMPLATE_PREFIX_PATTERN)) {
      const prefix = match[1].replace(/\.$/, '');
      if (prefix.length > 0) {
        prefixes.push({ key: prefix, file: relative(file) });
      }
    }
  }
  return { literals, prefixes };
}

function resolve(key: string): unknown {
  let node: unknown = ar;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * (3) ENUMERATED FAMILIES.
 *
 * Each map is typed `Record<Union, true>`, so `npx tsc --noEmit` fails if
 * a union member is added and not listed here - and this test then fails
 * if the listed member has no Arabic string. Both halves are required:
 * the type keeps the list complete, the test keeps the catalogue complete.
 * ------------------------------------------------------------------ */

const BLOCK_REASONS: Record<MotorTestActivationBlockReason, true> = {
  CONTROLLER_LINK_UNAVAILABLE: true,
  FC_ARMED: true,
  ARMED_STATE_UNKNOWN_OR_STALE: true,
  FIRMWARE_IDENTITY_UNAVAILABLE: true,
  FIRMWARE_UNSUPPORTED: true,
  MOTOR_3D_ENABLED: true,
  MOTOR_SCOPE_UNSUPPORTED: true,
  PULSE_OR_STOP_IN_PROGRESS: true,
  REQUIRES_NEW_CONNECTION: true,
};

const POSITIONS: Record<MotorPhysicalPosition, true> = {
  FRONT_LEFT: true,
  FRONT_RIGHT: true,
  REAR_LEFT: true,
  REAR_RIGHT: true,
};

const DIRECTIONS: Record<MotorRotationDirection, true> = {
  CW: true,
  CCW: true,
};

const OUTCOMES: Record<MotorVerificationOutcome, true> = {
  MATCH: true,
  POSITION_MISMATCH: true,
  DIRECTION_MISMATCH: true,
  POSITION_AND_DIRECTION_MISMATCH: true,
  NO_MOVEMENT: true,
  MULTIPLE_MOTORS: true,
  UNCERTAIN: true,
  UNTESTED: true,
  UNSAFE_OR_AMBIGUOUS: true,
};

const PORT_ROLES: Record<SerialRoleKey, true> = {
  MSP: true,
  GPS: true,
  TELEMETRY_FRSKY: true,
  TELEMETRY_HOTT: true,
  TELEMETRY_LTM: true,
  TELEMETRY_SMARTPORT: true,
  RX_SERIAL: true,
  BLACKBOX: true,
  TELEMETRY_MAVLINK: true,
  ESC_SENSOR: true,
  TBS_SMARTAUDIO: true,
  TELEMETRY_IBUS: true,
  IRC_TRAMP: true,
  RUNCAM_DEVICE_CONTROL: true,
  LIDAR_TF: true,
  FRSKY_OSD: true,
  VTX_MSP: true,
};

const PORT_BLOCK_REASONS: Record<PortsBlockReason, true> = {
  DISCONNECTED: true,
  IDENTIFYING: true,
  UNSUPPORTED_FIRMWARE: true,
  APP_BACKGROUNDED: true,
  LINK_RECOVERING: true,
  FC_ARMED: true,
  ARMED_STATE_UNKNOWN: true,
  MOTOR_TEST_ACTIVE: true,
  CONFIGURATION_BUSY: true,
  STALE_BASE: true,
  INVALID_CONFIGURATION: true,
};

const GPS_BLOCK_REASONS: Record<GpsBlockReason, true> = {
  DISCONNECTED: true,
  IDENTIFYING: true,
  UNSUPPORTED_FIRMWARE: true,
  APP_BACKGROUNDED: true,
  LINK_RECOVERING: true,
  FC_ARMED: true,
  ARMED_STATE_UNKNOWN: true,
  MOTOR_TEST_ACTIVE: true,
  CONFIGURATION_BUSY: true,
  STALE_BASE: true,
  INVALID_CONFIGURATION: true,
};

const PORT_VALIDATION: Record<SerialPortsValidationCode, true> = {
  NO_MSP_PORT: true,
  TOO_MANY_MSP_PORTS: true,
  USB_MSP_REQUIRED: true,
  ROLE_ASSIGNED_MORE_THAN_ONCE: true,
  INVALID_PORT_SHARING: true,
  VTX_MSP_REQUIRES_MSP_OR_RX: true,
  SOFTSERIAL_MSP_OR_RX: true,
  SOFTSERIAL_BAUD_TOO_HIGH: true,
  UNSUPPORTED_BAUD_INDEX: true,
  ROLE_NOT_COMPILED: true,
  ROLE_NOT_SUPPORTED_BY_API: true,
  DUPLICATE_PORT_IDENTIFIER: true,
};

/** Families whose members are produced by a template at runtime. */
const ENUMERATED_FAMILIES: readonly {
  readonly prefix: string;
  readonly members: readonly string[];
}[] = [
  { prefix: 'motorsScreen.blockReason', members: Object.keys(BLOCK_REASONS) },
  { prefix: 'motorVerification.position', members: Object.keys(POSITIONS) },
  { prefix: 'motorVerification.direction', members: Object.keys(DIRECTIONS) },
  { prefix: 'motorVerification.outcome', members: Object.keys(OUTCOMES) },
  { prefix: 'portsConfiguration.roles', members: Object.keys(PORT_ROLES) },
  {
    prefix: 'portsConfiguration.blockReason',
    members: Object.keys(PORT_BLOCK_REASONS),
  },
  {
    prefix: 'gpsSystem.blockReason',
    members: Object.keys(GPS_BLOCK_REASONS),
  },
  {
    prefix: 'portsConfiguration.validation',
    members: Object.keys(PORT_VALIDATION),
  },
  {
    prefix: 'portsConfiguration.outcome',
    members: [
      'noChanges',
      'saved',
      'savedUnverified',
      'unconfirmed',
      'sessionEnded',
      'failed',
    ],
  },
  {
    // MotorsScreen builds these from `positionKey`/`directionKey` values.
    // The compact bench-warning strings are ordinary literal lookups and
    // are covered by the source scanner above; there is no acknowledgement
    // key family after removal of the checkbox ritual.
    prefix: 'motorsScreen',
    members: [
      'positionFrontRight',
      'positionFrontLeft',
      'positionRearRight',
      'positionRearLeft',
      'directionCw',
      'directionCcw',
    ],
  },
  {
    // MotorVerificationWizard's exception buttons and report headings.
    prefix: 'motorVerification',
    members: [
      'noMovement',
      'multipleMotors',
      'positionUncertain',
      'directionUncertain',
      'overallUnsafe',
      'overallMismatch',
      'overallIncomplete',
      'overallMatch',
    ],
  },
  {
    // BatteryCard resolves this key through a helper, so no literal or
    // template prefix appears at the call site (`t(stateKey)`).
    prefix: 'batteryCard.state',
    members: ['OK', 'WARNING'],
  },
];

describe('Arabic catalogue coverage', () => {
  const { literals, prefixes } = scanSource();

  it('scans a non-empty set of source files (the scan is not vacuous)', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(20);
    expect(literals.length).toBeGreaterThan(50);
    // The motors screens must actually be among what was scanned - the
    // whole point of this gate.
    expect(literals.some(entry => entry.key.startsWith('motorsScreen.'))).toBe(
      true,
    );
    expect(
      literals.some(entry => entry.key.startsWith('motorVerification.')),
    ).toBe(true);
  });

  it('has an Arabic string for every literal key referenced in source', () => {
    const missing = literals
      .filter(entry => typeof resolve(entry.key) !== 'string')
      .map(entry => `${entry.key} (${entry.file})`);
    expect(missing).toEqual([]);
  });

  it('has a non-empty subtree for every template-built key prefix', () => {
    const missing = prefixes
      .filter(entry => {
        const node = resolve(entry.key);
        return (
          typeof node !== 'object' ||
          node === null ||
          Object.keys(node as object).length === 0
        );
      })
      .map(entry => `${entry.key} (${entry.file})`);
    expect(missing).toEqual([]);
  });

  it('has an Arabic string for every member of every enumerated family', () => {
    const missing: string[] = [];
    for (const family of ENUMERATED_FAMILIES) {
      for (const member of family.members) {
        const key = `${family.prefix}.${member}`;
        if (typeof resolve(key) !== 'string') {
          missing.push(key);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('translates every activation block reason - the exact set observed as raw keys on device', () => {
    for (const reason of Object.keys(BLOCK_REASONS)) {
      const value = resolve(`motorsScreen.blockReason.${reason}`);
      expect(typeof value).toBe('string');
      // A translation that is merely the key echoed back is not a
      // translation.
      expect(value).not.toBe(reason);
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the motors strings in the ONE statically imported catalogue, with no build conditional', () => {
    const index = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    // Comments are stripped first: this file DOCUMENTS the removed seam by
    // name, and that documentation must not be what the assertion trips on.
    const code = index
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // The seam that caused the on-device defect must not come back: no
    // __DEV__, no conditional require, no second resource file merged in.
    expect(code).not.toContain('__DEV__');
    expect(code).not.toContain('require(');
    expect(code).toContain("import ar from './locales/ar.json'");
    // And the strings must genuinely live in that one file.
    expect(typeof resolve('motorsScreen.title')).toBe('string');
    expect(typeof resolve('motorVerification.title')).toBe('string');
  });

  it('keeps the safety-critical strings present, non-empty and imperative', () => {
    const propellers = resolve('motorsScreen.propellerWarning');
    const battery = resolve('motorsScreen.batteryScopeWarning');
    const emergency = resolve('motorsScreen.emergencyDisconnect');
    for (const value of [propellers, battery, emergency]) {
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(10);
    }
    // The three facts the operator must not have to infer. Battery copy is
    // intentionally honest: the motor-test controller does not read cell
    // count, so the catalogue may not resurrect the removed 4S/6S claim.
    expect(propellers as string).toContain('أزل');
    expect(battery as string).toContain('لا يقرأ');
    expect(battery as string).toContain('مطابقة');
    expect(battery as string).not.toContain('4S فقط');
    expect(emergency as string).toContain('LiPo');
  });
});
