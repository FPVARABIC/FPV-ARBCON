/**
 * M-D §0 - COMMAND 42 IS A READ, COMMAND 43 IS A WRITE, AND THE MOTORS
 * SCREEN IS ALLOWED EXACTLY ONE OF THEM.
 *
 * WHY THIS FILE EXISTS: A CORRECTION.
 *
 * M-C claimed "Motors sends no mixer write" and cited a test asserting
 * `expect(commands).not.toContain(42)`, with a comment that called 42
 * "MSP_SET_MIXER_CONFIG". Both halves were wrong:
 *
 *   src/main/msp/msp_protocol.h:114-115 @ 7348054f
 *     #define MSP_MIXER_CONFIG      42   // out message: Get mixer configuration
 *     #define MSP_SET_MIXER_CONFIG  43   // in message:  Set mixer configuration
 *
 *   - 42 is the READ. Forbidding it forbids the wrong thing, and Motors is
 *     entitled to observe the mixer it is drawing.
 *   - That assertion passed VACUOUSLY: the motor-test controller requests
 *     no mixer read at all, so `not.toContain(42)` was never going to fail
 *     whatever the code did.
 *   - Nothing anywhere asserted anything about 43.
 *
 * AND THE UNDERLYING CLAIM WAS FALSE. The Motors screen hosts
 * MotorConfigurationPanel, which owns a `motor-config-yaw-reversed`
 * toggle bound to `draft.yawMotorsReversed`. That field is byte 1 of
 * MSP_SET_MIXER_CONFIG, so saving a change to it DOES put command 43 on
 * the wire from the Motors screen.
 *
 * WHAT IS ACTUALLY TRUE, AND IS WHAT THIS FILE PINS.
 *
 * The mixer command carries TWO fields that are not the same kind of
 * thing (msp.c:3734-3743 @ 7348054f):
 *
 *     mixerConfigMutable()->mixerMode           = sbufReadU8(src);  // byte 0
 *     mixerConfigMutable()->yaw_motors_reversed = sbufReadU8(src);  // byte 1
 *
 *   BYTE 0 IS AIRFRAME SELECTION. Changing it changes what the aircraft
 *   IS - and it does not even take effect until a reboot, because
 *   mixerInit() is called only from fc/init.c:512. Motors observes this;
 *   it must never author it.
 *
 *   BYTE 1 IS A PID SIGN FLIP. mixer.c uses `yaw_motors_reversed` in
 *   exactly one place, to flip the sign of the yaw PID term. It remaps no
 *   output and selects no airframe. It is a motor-behaviour setting, and
 *   the reference Configurator's own Motors tab owns this same write.
 *
 * So the provable invariant is NOT "command 43 never leaves Motors" - it
 * is the stronger and more useful one:
 *
 *     MOTORS NEVER CHANGES THE MIXER MODE.
 *
 * Byte 0 of any mixer write Motors emits is byte-identical to what the
 * flight controller reported, and no control in the Motors surface edits
 * it. That is asserted below three different ways, so a regression cannot
 * slip through one of them.
 *
 * THE PRODUCT DECISION, TAKEN DELIBERATELY. The yaw-reversed toggle stays.
 * MotorConfigurationPanel is the only place in the app where
 * yaw_motors_reversed can be edited, so removing it would put the setting
 * out of reach outside the CLI, and the reference Configurator keeps this
 * same control on its own Motors tab. The M-D §49 requirement is therefore
 * held in its provable form - Motors never changes the mixer MODE - and
 * not in its literal one.
 *
 * The end-to-end measurement of what the save transaction really puts on
 * the wire lives with the harness that can drive it:
 * MotorConfigurationController.test.ts, "M-D §0 - what the Motors screen
 * really does with command 43".
 */

import fs from 'fs';
import path from 'path';

import {
  MSP_MIXER_CONFIG,
  MSP_SET_MIXER_CONFIG,
} from '../../core/protocol/msp/commands/mspCommands';
import {
  encodeChangedMotorConfiguration,
  encodeMixerConfiguration,
} from '../../core/protocol/msp/encoding/encodeMotorConfiguration';
import {
  createMotorConfigurationDraft,
  type MotorConfigurationSnapshot,
} from '../../core/state/motorConfigurationModel';

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** A decoded configuration as the flight controller reported it. The mixer
 * is HEX6X (10) with yaw not reversed - a non-quad on purpose, so a
 * mutation that normalises the mode to QUADX shows up as a changed byte.
 * Typed, not cast: a fixture that lies about its shape proves nothing. */
const REPORTED: MotorConfigurationSnapshot = Object.freeze({
  mixer: Object.freeze({
    mixerModeRaw: 10,
    yawMotorsReversedConfigured: false,
    yawMotorsReversedRaw: 0,
  }),
  motor: Object.freeze({
    deprecatedMinThrottle: 0,
    maxThrottle: 2000,
    minCommand: 1000,
    motorCount: 6,
    motorPoleCount: 14,
    dshotTelemetryRaw: 0,
    escSensorRaw: 0,
  }),
  motor3d: Object.freeze({
    deadband3dLow: 1406,
    deadband3dHigh: 1514,
    neutral3d: 1500,
  }),
  advanced: Object.freeze({
    deprecatedGyroSyncDenom: 1,
    pidProcessDenom: 1,
    useContinuousUpdate: 0,
    motorProtocolRaw: 7,
    motorPwmRate: 480,
    motorIdleRaw: 550,
    deprecatedGyroUse32kHz: 0,
    motorInversionRaw: 0,
    deprecatedGyroToUse: 0,
    gyroHighFsr: 0,
    gyroMovementCalibrationThreshold: 32,
    gyroCalibrationDuration: 125,
    gyroYawOffset: 0,
    checkOverflow: 0,
    debugMode: 0,
    debugModeCount: 0,
  }),
  feature: Object.freeze({enabledFeaturesRaw: 0, feature3dEnabled: false}),
});

describe('M-D §0 - the two mixer commands are not interchangeable', () => {
  it('pins 42 as the READ and 43 as the WRITE, from msp_protocol.h', () => {
    expect(MSP_MIXER_CONFIG).toBe(42);
    expect(MSP_SET_MIXER_CONFIG).toBe(43);
    expect(MSP_MIXER_CONFIG).not.toBe(MSP_SET_MIXER_CONFIG);
  });
});

describe('M-D §0 - Motors never authors the mixer MODE', () => {
  it('emits no mixer write at all when nothing changed', () => {
    const draft = createMotorConfigurationDraft(REPORTED);
    const writes = encodeChangedMotorConfiguration(REPORTED, draft);
    expect(writes.map(write => write.group)).not.toContain('MIXER');
  });

  it('keeps mixer MODE byte-identical when the yaw sign flip is changed', () => {
    // The one legitimate reason Motors touches command 43. Byte 1 moves;
    // byte 0 - the airframe - must not.
    const draft = {
      ...createMotorConfigurationDraft(REPORTED),
      yawMotorsReversed: true,
    };
    const writes = encodeChangedMotorConfiguration(REPORTED, draft);
    const mixerWrite = writes.find(write => write.group === 'MIXER');
    expect(mixerWrite).toBeDefined();
    expect(Array.from(mixerWrite!.payload)).toEqual([
      REPORTED.mixer.mixerModeRaw, // 10 - HEX6X, unchanged
      1, // the yaw sign flip, the only thing that moved
    ]);
  });

  it('never normalises the mixer mode to QUADX on the way out', () => {
    // The exact regression a "default to quad" bug would produce: byte 0
    // arriving as 3 on a hexacopter.
    const draft = {
      ...createMotorConfigurationDraft(REPORTED),
      yawMotorsReversed: true,
    };
    const payload = encodeMixerConfiguration(draft);
    expect(payload[0]).toBe(10);
    expect(payload[0]).not.toBe(3);
  });

  it('carries the mixer mode straight through for every one of the 27 modes', () => {
    for (let mixerModeRaw = 1; mixerModeRaw <= 27; mixerModeRaw++) {
      const reported = {
        ...REPORTED,
        mixer: {...REPORTED.mixer, mixerModeRaw},
      } as MotorConfigurationSnapshot;
      const draft = {
        ...createMotorConfigurationDraft(reported),
        yawMotorsReversed: true,
      };
      expect(encodeMixerConfiguration(draft)[0]).toBe(mixerModeRaw);
    }
  });
});

describe('M-D §0 - the Motors surface offers no mixer selector', () => {
  const code = (file: string): string =>
    fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');

  const MOTORS_SURFACE = [
    'src/ui/screens/MotorsScreen.tsx',
    'src/ui/screens/MotorConfigurationPanel.tsx',
    'src/ui/screens/MotorWorkspace.tsx',
    'src/ui/screens/MotorConfigurationSummary.tsx',
  ];

  it.each(MOTORS_SURFACE)('%s writes no mixerModeRaw', file => {
    // A selector would have to assign the field. Reading it to LABEL the
    // airframe is not only allowed, it is what M-D asks for.
    expect(code(file)).not.toMatch(/setNumber\(\s*'mixerModeRaw'/);
    expect(code(file)).not.toMatch(/mixerModeRaw\s*[:=]\s*(?!.*readonly)/);
    expect(code(file)).not.toMatch(/onValueChange.*mixerMode/i);
  });

  it.each(MOTORS_SURFACE)('%s names no mixer SET command', file => {
    expect(code(file)).not.toContain('MSP_SET_MIXER_CONFIG');
  });

  it('leaves the mixer write to exactly one owner in the whole repository', () => {
    // Every production module that names command 43 in EXECUTABLE code,
    // with its role stated. Comments are stripped first, so the several
    // files that merely DOCUMENT the command do not appear. If a second
    // module ever starts issuing the write, this list grows and fails.
    const named: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), {
        withFileTypes: true,
      })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__testUtils__') {
            walk(rel);
          }
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) {
          continue;
        }
        if (code(rel).includes('MSP_SET_MIXER_CONFIG')) {
          named.push(rel);
        }
      }
    };
    walk('src');
    expect(named.sort()).toEqual([
      // The definition. `export const MSP_SET_MIXER_CONFIG = 43`.
      'src/core/protocol/msp/commands/mspCommands.ts',
      // Three barrels that re-export the constant and issue nothing.
      'src/core/index.ts',
      'src/core/protocol/index.ts',
      'src/core/protocol/msp/index.ts',
      // THE SOLE WRITER, and only for the yaw sign flip.
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    ].sort());
  });

  it('routes the MIXER write group through one command mapping only', () => {
    const owner = code(
      'src/platforms/react-native/protocol/MotorConfigurationController.ts',
    );
    // One mapping entry, so the write group cannot silently acquire a
    // second command or be repointed at the read.
    expect(owner.match(/MIXER:\s*MSP_SET_MIXER_CONFIG/g)).toHaveLength(1);
    expect(owner).not.toMatch(/MIXER:\s*MSP_MIXER_CONFIG\b/);
  });
});
