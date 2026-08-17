/**
 * NO MOTORS CONTROL MAY BECOME DECORATIVE AGAIN.
 *
 * Every write on this screen commands hardware, and the failure mode that
 * matters is not a crash - it is a button that looks alive, reports success,
 * and reaches nothing. Component tests cannot catch that: they inject a
 * double for the controller, so they pass whichever writer is wired
 * underneath, including none.
 *
 * These tests read the PRODUCTION modules and assert that each critical path
 * still terminates in the real MSP command it claims to send. They are
 * deliberately structural rather than behavioural, because the thing being
 * defended is the WIRING, and wiring is exactly what a mock replaces.
 *
 * Each entry below was traced by hand first; the test freezes what the trace
 * found.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

function source(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Strips comments, so prose naming a command is never mistaken for a call. */
function executable(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('every Motors write reaches a real MSP command', () => {
  const PATHS: readonly (readonly [string, string, string])[] = [
    // control surface            module owning the write            command
    [
      'motor test / pulse',
      'core/state/motorControlCommandEngine.ts',
      'MSP_SET_MOTOR',
    ],
    [
      'all-stop',
      'core/state/motorControlCommandEngine.ts',
      'MSP_SET_MOTOR',
    ],
    [
      'ESC direction',
      'core/state/motorTestController.ts',
      'MSP2_SEND_DSHOT_COMMAND',
    ],
    [
      'motor order',
      'platforms/react-native/protocol/MotorConfigurationController.ts',
      'MSP2_SET_MOTOR_OUTPUT_REORDERING',
    ],
    [
      'motor configuration',
      'platforms/react-native/protocol/MotorConfigurationController.ts',
      'MSP_SET_MOTOR_CONFIG',
    ],
    [
      '3D mode',
      'platforms/react-native/protocol/MotorConfigurationController.ts',
      'MSP_SET_MOTOR_3D_CONFIG',
    ],
    [
      'persist to EEPROM',
      'platforms/react-native/protocol/MotorConfigurationController.ts',
      'MSP_EEPROM_WRITE',
    ],
  ];

  it.each(PATHS.map(entry => [entry[0], entry[1], entry[2]] as const))(
    '%s is written by %s via %s',
    (_label, module, command) => {
      expect(executable(source(module))).toContain(command);
    },
  );
});

describe('the read-only values come off the wire, not from constants', () => {
  const READS: readonly (readonly [string, string, string])[] = [
    ['live motor outputs', 'platforms/react-native/protocol/motorDiagnosticsTelemetry.ts', 'MSP_MOTOR'],
    ['ESC telemetry / RPM', 'platforms/react-native/protocol/motorDiagnosticsTelemetry.ts', 'MSP_MOTOR_TELEMETRY'],
    ['motor configuration', 'platforms/react-native/protocol/MotorConfigurationController.ts', 'MSP_MOTOR_CONFIG'],
    ['stored motor order', 'platforms/react-native/protocol/MotorConfigurationController.ts', 'MSP2_MOTOR_OUTPUT_REORDERING'],
    ['3D configuration', 'platforms/react-native/protocol/MotorConfigurationController.ts', 'MSP_MOTOR_3D_CONFIG'],
    ['armed state', 'platforms/react-native/protocol/MotorConfigurationController.ts', 'MSP_STATUS_EX'],
  ];

  it.each(READS.map(entry => [entry[0], entry[1], entry[2]] as const))(
    '%s is read by %s via %s',
    (_label, module, command) => {
      expect(executable(source(module))).toContain(command);
    },
  );
});

describe('success is never assumed ahead of the board', () => {
  it('ESC direction records COMMANDED only on an acknowledgement', () => {
    // The panel may show a result for every outcome, but only an
    // ACKNOWLEDGED one becomes evidence that a direction was commanded.
    // Anything looser would tell the operator a motor had been reversed
    // because a button was pressed.
    const panel = executable(source('ui/screens/EscDirectionPanel.tsx'));
    expect(panel).toContain("outcome.kind === 'ACKNOWLEDGED'");
    expect(panel).toContain('setCommanded(direction)');
    // The command itself, not a local state flip.
    expect(panel).toContain('operator.setEscDirection');
  });

  it('the configuration gate re-checks output at WRITE time', () => {
    // The operator can start a motor between opening the editor and pressing
    // save, so one check at admission would be a window rather than a gate.
    const controller = executable(
      source('platforms/react-native/protocol/MotorConfigurationController.ts'),
    );
    const checks = controller.match(/this\.isMotorOutputEngaged\(sessionId\)/g);
    expect(checks?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('physical stop is never claimed anywhere', () => {
    // Software can confirm an acknowledged all-stop. It cannot confirm that a
    // propeller stopped turning, and no surface may imply otherwise.
    const engine = source('core/state/motorControlCommandEngine.ts');
    expect(engine).toContain('physicalStopConfirmed');
    // Only ever the literal false - never assigned a computed truth.
    expect(engine).not.toMatch(/physicalStopConfirmed:\s*(?!false)[a-zA-Z]/);
  });
});

describe('the Motors surface carries no developer diagnostics', () => {
  const SCREENS = [
    'ui/screens/MotorsScreen.tsx',
    'ui/screens/MotorConfigurationPanel.tsx',
    'ui/screens/MotorDirectionSection.tsx',
    'ui/screens/MotorDiagnosticsPanel.tsx',
    'ui/screens/MotorOutputReorderPanel.tsx',
    'ui/screens/EscDirectionPanel.tsx',
  ];

  it.each(SCREENS.map(file => [file] as const))(
    '%s shows no protocol-version pinning to the operator',
    file => {
      const arabicLiterals = Array.from(
        source(file).matchAll(/'([^'\\\n]*[؀-ۿ][^'\\\n]*)'/g),
        match => match[1],
      );
      for (const text of arabicLiterals) {
        expect(text).not.toMatch(/MSP\s*API\s*1\.\d+/);
        expect(text).not.toMatch(/رابط\s+MSP/);
      }
    },
  );
});
