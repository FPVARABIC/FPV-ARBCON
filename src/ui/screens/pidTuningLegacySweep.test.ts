/**
 * THE PID PAGE MUST NOT GROW ITS OWN OPINIONS BACK.
 *
 * P-D deleted an inline `RATE_TYPES` table from `PidTuningScreen.tsx`. That
 * table held rate-type names, display scales and per-type bounds - a second
 * copy of a subsystem P-A and P-B had already pinned to firmware source.
 *
 * IT WAS NOT WRONG when it was removed: its five bound pairs still matched
 * `RATE_SETTING_LIMITS` field for field. The objection is structural. Two
 * copies existed and NOTHING COMPARED THEM, so the day one of them drifted
 * every test would still have passed - both copies render, both look
 * plausible, and the screen would only disagree with the engine on the
 * boards using the drifted formula. So this suite reads the SOURCE THAT
 * SHIPS and checks that the duplication has not returned.
 *
 * The check is POSITIONAL, using the same code/comment splitter as the
 * operator-vocabulary sweep: the phrases below are welcome in a comment
 * explaining why they are gone, and forbidden in executable code.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {splitCodeAndComments} from '../__testUtils__/sourceSplit';

const SCREEN = join(__dirname, 'PidTuningScreen.tsx');
const PRESENTATION_DIR = join(__dirname, '..', 'presentation');

function code(path: string): string {
  const source = readFileSync(path, 'utf8');
  const split = splitCodeAndComments(source);
  // The splitter blanks the other half rather than deleting it, so lengths
  // must still line up. If it ever loses its place, fail loudly instead of
  // quietly reporting a clean file that was never really parsed.
  expect(split.code).toHaveLength(source.length);
  expect(split.comments).toHaveLength(source.length);
  return split.code;
}

describe('the screen holds no second copy of the rate tables', () => {
  const screen = code(SCREEN);

  it('declares no local rate-type table', () => {
    expect(screen).not.toContain('RATE_TYPES');
  });

  it('carries no per-type display scales of its own', () => {
    // These were the field names of the deleted table. Their return in
    // executable code means the screen has started scaling values itself
    // again instead of asking `ratesPresentation`.
    for (const field of ['rcScale', 'superScale', 'expoScale', 'rcMax', 'superMax']) {
      expect(screen).not.toContain(field);
    }
  });

  it('reimplements no rate mathematics', () => {
    for (const token of ['power3', 'power5', 'superFactor', '14.54', 'RC_RATE_INCREMENTAL']) {
      expect(screen).not.toContain(token);
    }
  });

  it('reimplements no simplified-generator mathematics', () => {
    // The screen may CALL the generator; it must not contain its arithmetic.
    for (const token of ['scaleHz', 'truncateThenClamp', 'dynLpfMaxHz']) {
      expect(screen).not.toContain(token);
    }
  });

  it('compares rates types by classification, not by magic index', () => {
    // `rates.type === 1` was how the old card decided a formula was
    // Raceflight. The indices belong to `classifyRatesType`.
    expect(screen).not.toMatch(/rates\.type\s*===\s*\d/);
    expect(screen).toContain('classifyRatesType');
  });
});

describe('the presentation layer stays presentation', () => {
  for (const file of ['ratesPresentation.ts', 'simplifiedTuningPresentation.ts']) {
    it(`${file} contains no engine arithmetic`, () => {
      const source = code(join(PRESENTATION_DIR, file));
      for (const token of ['power3', 'power5', 'superFactor', 'Math.pow', 'truncateThenClamp']) {
        expect(source).not.toContain(token);
      }
    });
  }
});

describe('commands that must not be reachable from this page', () => {
  const screen = code(SCREEN);

  it('never exposes the firmware calculator RPC to a pilot', () => {
    // MSP_CALCULATE_SIMPLIFIED_PID runs against a TEMPORARY copy and stores
    // nothing. It is an oracle the controller consults before a write, and
    // presenting it as an action would promise a change that never happens.
    expect(screen).not.toContain('CALCULATE_SIMPLIFIED');
    expect(screen).not.toContain('calculateSimplified');
  });

  it('offers no path to the whole-configuration reset', () => {
    // MSP_RESET_CONF (208) wipes far more than this page owns - the whole
    // board, not one profile - and nothing here may reach it.
    //
    // P-E §23 DID add the PID-PROFILE reset, which is a different command
    // with a different scope. That is deliberate, and the assertion that
    // used to forbid `resetPidProfile` alongside RESET_CONF was retired
    // with it rather than weakened: the two are checked separately now,
    // and the profile reset has its own contract below.
    expect(screen).not.toContain('RESET_CONF');
    expect(screen).not.toContain('resetConfiguration');
  });

  it('reports the profile reset as APPLIED and PARTIALLY VERIFIED, never as saved', () => {
    // The firmware command rewrites the profile in RAM and writes no
    // EEPROM, and this screen can only observe part of what it rewrote.
    // The outcome name carries both facts, and the screen must render THAT
    // outcome rather than a success sentence of its own.
    expect(screen).toContain('RESET_APPLIED_PARTIALLY_VERIFIED');
    expect(screen).toContain('verifiedScope');
    // No sentence anywhere on this page may call a reset "saved".
    expect(screen).not.toMatch(/حُفظت[^\n]*المصنع/);
  });
});
