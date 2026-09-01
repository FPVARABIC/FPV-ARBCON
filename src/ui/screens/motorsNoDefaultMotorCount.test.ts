/**
 * M-D §4 - THERE IS NO SECOND MOTOR-COUNT OWNER, AND NO FALLBACK OF FOUR.
 *
 * WHAT THIS CAUGHT WHEN IT WAS WRITTEN. MotorDiagnosticsPanel held
 *
 *     const DEFAULT_VISIBLE_MOTOR_COUNT = 4;
 *
 * and used it whenever the motor count had not been read. That is the
 * whole failure mode in one line: a pending load, a dropped link or a
 * board still identifying produced four output rows on a hexacopter, at
 * exactly the moment the operator is deciding whether the connection is
 * working. Nothing crashed and no test failed, because four rows look
 * exactly like a correct quad.
 *
 * THE RULE. MSP_MOTOR_CONFIG offset 6 is the only authority for how many
 * motor outputs exist. A screen that has not read it renders no motors -
 * not four, not eight, not the mixer's expectation, not the telemetry
 * frame's record count, and not however many output slots MSP_MOTOR
 * happened to return.
 *
 * WHY A SOURCE SCAN. Behavioural tests cover the paths they think to
 * exercise; this covers the ones nobody thought of, including files that
 * do not exist yet. It is deliberately blunt: any literal 4 used as a
 * count fallback in the Motors surface fails here, and a legitimate one
 * has to be named in ALLOWED below with a reason.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Comments name numbers constantly while describing firmware. Only
 *  executable code can default anything. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** Every production file that draws or drives motors. Collected by walk
 *  rather than listed, so a new Motors file is covered on the day it is
 *  added rather than on the day somebody remembers this test. */
function motorsProductionFiles(): readonly string[] {
  const found: string[] = [];
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
      if (/motor/i.test(entry.name)) {
        found.push(rel);
      }
    }
  };
  walk('src/ui');
  walk('src/core/state');
  walk('src/platforms/react-native/protocol');
  return found.sort();
}

/**
 * Literal fours that are NOT motor-count fallbacks, each with the reason
 * it is allowed. Anything not listed here fails.
 *
 * EMPTY, AND VERIFIED EMPTY. No Motors production file currently needs an
 * exemption - emptying this map changes no result, which is how it was
 * checked. It is kept as the declared escape hatch so that a future
 * legitimate four is granted deliberately, with its reason written down,
 * rather than by loosening a pattern above until the test goes quiet.
 */
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({});

describe('M-D §4 - no Motors module defaults a motor count', () => {
  const FILES = motorsProductionFiles();

  it('finds a substantial set of Motors production files (not vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(15);
    expect(FILES).toContain('src/ui/screens/MotorDiagnosticsPanel.tsx');
    expect(FILES).toContain('src/ui/screens/MotorsScreen.tsx');
    expect(FILES).toContain('src/core/state/motorTestController.ts');
  });

  it.each(
    motorsProductionFiles().map(file => [file] as const),
  )('%s uses no fallback-to-four', file => {
    const source = executable(fs.readFileSync(path.join(ROOT, file), 'utf8'));

    // `x ?? 4`, `x || 4`, `: 4` in a ternary tail, and a named default.
    //
    // THE FIRST VERSION OF THIS TEST ONLY LOOKED FOR THE LITERAL 4, and
    // it missed two live defects because both wore a constant's name:
    //
    //   MotorAirframeDiagram.tsx  motorCount = MOTOR_AIRFRAME_QUAD_COUNT
    //   MotorsScreen.tsx          liveMotorCount ?? MOTOR_AIRFRAME_QUAD_COUNT
    //
    // A default named QUAD is still a default of four, so the patterns
    // below match the NAME as well as the number.
    const QUADISH = String.raw`(?:4|[A-Z_]*QUAD[A-Z_]*)`;
    const FALLBACKS: readonly RegExp[] = [
      new RegExp(String.raw`\?\?\s*${QUADISH}\b`),
      new RegExp(String.raw`\|\|\s*${QUADISH}\b`),
      // A default parameter value, which is a fallback that fires on
      // every call the caller did not think about.
      new RegExp(String.raw`\b(?:motorCount|count)\s*=\s*${QUADISH}\b`),
      /\bDEFAULT[_A-Z]*(?:MOTOR|COUNT)[_A-Z]*\s*=\s*4\b/,
      /\bFALLBACK[_A-Z]*\s*=\s*4\b/,
      // The specific shape the first real defect had: a ternary whose
      // else-arm is a bare 4 following a motorCount test.
      /motorCount[\s\S]{0,160}?:\s*4\s*[;,)]/,
    ];
    for (const pattern of FALLBACKS) {
      if (ALLOWED[file] !== undefined && pattern.test(source)) {
        continue;
      }
      expect({file, matched: pattern.source, hit: pattern.test(source)}).toEqual({
        file,
        matched: pattern.source,
        hit: false,
      });
    }
  });

  it.each(
    motorsProductionFiles().map(file => [file] as const),
  )('%s hard-codes no four-motor number list', file => {
    const source = executable(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    // The literal M-C deleted from the controller. It must not come back
    // anywhere, under any name.
    //
    // THE TRAILING COMMA MATTERED. The first version of this pattern
    // ended `4\s*\]` and so walked straight past
    //
    //     Object.freeze([
    //       1, 2, 3, 4,
    //     ])
    //
    // which is how MOTOR_TEST_OUTPUT_SLOTS was actually written - a
    // prettier-formatted list the regex could not see. The optional comma
    // below is the whole fix.
    expect(source).not.toMatch(/\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,?\s*\]/);
    // Trimming any collection to four is the same assumption wearing a
    // different hat.
    expect(source).not.toMatch(/\.slice\(\s*0\s*,\s*4\s*\)/);
    // `Array.from({length: 4})` builds four of something.
    expect(source).not.toMatch(/\{\s*length:\s*4\s*\}/);
  });
});
