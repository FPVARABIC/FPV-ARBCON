/**
 * A BUTTON IS THE SIZE OF ITS ACTION, NOT THE SIZE OF THE SCREEN.
 *
 * THE BUG THIS FREEZES. A React Native View is a column whose `alignItems`
 * defaults to `stretch`, so any child that does not name its own
 * cross-axis size fills the container width. Every hand-rolled action
 * surface in this app was such a child, which is why the product was full
 * of screen-wide bars carrying two words - «اتصال», «إعادة ضبط الاتجاه»,
 * «إيقاف كل المحركات الآن» - and why the shared Button's `block={false}`
 * did nothing to stop it: omitting `alignSelf: 'stretch'` is not the same
 * as asking for intrinsic width.
 *
 * The shared Button now sets `alignSelf: 'flex-start'` by default and
 * `block` is the deliberate exception. These tests hold that, and catch
 * the hand-rolled variety that never went through Button at all.
 *
 * WHAT IS DELIBERATELY NOT FLAGGED. Full width is right for some things,
 * and the rule is about ACTIONS: rows, cards, list items, inputs, notice
 * surfaces and containers may all stretch. So this looks only for styles
 * that are unmistakably a button - a filled tap target, meaning a solid
 * accent/error/success background AND a minimum touch height - and asks
 * whether that particular object states a width intent.
 */

import * as fs from 'fs';
import * as path from 'path';

const UI = path.join(__dirname, '..', '..');

function walk(dir: string): readonly string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.tsx') && !full.endsWith('.test.tsx')
      ? [full]
      : [];
  });
}

/** Named style bodies, as written in a StyleSheet.create block. */
function styleBodies(source: string): readonly {name: string; body: string}[] {
  return Array.from(
    source.matchAll(/^\s*([A-Za-z0-9_]+):\s*\{([^}]*)\}/gm),
    m => ({name: m[1], body: m[2]}),
  );
}

/** A filled, finger-sized surface: the shape of a button. */
function isFilledTapTarget(body: string): boolean {
  const filled =
    /backgroundColor:\s*colors\.(accent|error|success|info|warning)\b/.test(body) &&
    !/Soft\b/.test(body);
  const tappable =
    /minHeight:\s*(MIN_TOUCH_TARGET|4[4-9]|5\d|6\d)/.test(body) ||
    /height:\s*(MIN_TOUCH_TARGET|4[4-9]|5\d)/.test(body);
  return filled && tappable;
}

/** Any statement of how wide this thing means to be. */
function declaresWidthIntent(body: string): boolean {
  return (
    /alignSelf:/.test(body) ||
    /\bwidth:/.test(body) ||
    /maxWidth:/.test(body) ||
    /minWidth:/.test(body) ||
    /flex:\s*1/.test(body) ||
    /flexGrow:/.test(body) ||
    // A row lays its children out along the main axis, so a child of one
    // is already content-sized.
    /flexDirection:\s*'row'/.test(body) ||
    /position:\s*'absolute'/.test(body)
  );
}

describe('the shared Button', () => {
  const source = fs.readFileSync(path.join(__dirname, 'Button.tsx'), 'utf8');

  it('is intrinsic-width by default', () => {
    expect(source).toContain("intrinsic: {alignSelf: 'flex-start'}");
    // Applied as the ELSE of block, so there is no third state where a
    // button silently stretches again.
    expect(source).toContain('block ? styles.block : styles.intrinsic');
  });

  it('still lets a caller ask for full width explicitly', () => {
    expect(source).toContain("block: {alignSelf: 'stretch'}");
  });

  it('keeps the 44pt touch floor at every size', () => {
    // Narrower must never become shorter - that would trade an
    // accessibility floor for density.
    expect(source).toContain('sm: {minHeight: MIN_TOUCH_TARGET');
    expect(source).toContain('md: {minHeight: MIN_TOUCH_TARGET}');
  });
});

describe('no hand-rolled button stretches to the screen', () => {
  const files = walk(UI);

  it('scans real files, so it cannot pass by finding nothing', () => {
    const total = files.reduce(
      (count, file) =>
        count +
        styleBodies(fs.readFileSync(file, 'utf8')).filter(s =>
          isFilledTapTarget(s.body),
        ).length,
      0,
    );
    expect(total).toBeGreaterThan(5);
  });

  it('every filled tap target states how wide it means to be', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const {name, body} of styleBodies(source)) {
        if (!isFilledTapTarget(body)) continue;
        if (declaresWidthIntent(body)) continue;
        offenders.push(`${path.relative(UI, file)}:${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
