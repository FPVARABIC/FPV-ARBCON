/**
 * A NOTICE IS CONTEXT, NOT CONTENT - AND STAYS THAT SIZE.
 *
 * The shared NoticeBox had already been brought down to a compact scale, but
 * an audit found it used in five places against SEVENTEEN hand-rolled banners
 * across twelve files, built from `padding: spacing.md`, `radii.lg` and
 * `typography.heading`. The fix to the shared component had never reached
 * them, so a one-line "settings changed, read again" still rendered as a card
 * taller than the setting it referred to, and screens stacked two or three of
 * those above the first real control.
 *
 * All of them now spread `noticeSurface` from the theme, so there is one
 * thing to change instead of seventeen that drift apart. This test keeps it
 * that way: a status-tinted surface may not re-grow its own padding, radius
 * or heading-sized type.
 *
 * Colour is deliberately NOT centralised - a danger banner and a success
 * banner must not look alike - and nothing here touches the words, the icon,
 * or the alert role a danger notice announces to assistive technology.
 */

import * as fs from 'fs';
import * as path from 'path';

const UI = path.join(__dirname, '..');

function walk(dir: string): readonly string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() &&
      full.endsWith('.tsx') &&
      !full.endsWith('.test.tsx')
      ? [full]
      : [];
  });
}

/** Style bodies whose background is one of the status tints. */
function statusSurfaces(source: string): readonly {name: string; body: string}[] {
  const pattern =
    /^\s*([A-Za-z0-9_]+):\s*\{([^}]*colors\.(?:error|warning|success|info)Soft[^}]*)\}/gm;
  return Array.from(source.matchAll(pattern), m => ({name: m[1], body: m[2]}));
}

describe('status notices keep one shared scale', () => {
  const files = walk(UI);

  it('finds real notices, so it cannot pass by scanning nothing', () => {
    const total = files.reduce(
      (count, file) =>
        count + statusSurfaces(fs.readFileSync(file, 'utf8')).length,
      0,
    );
    expect(total).toBeGreaterThan(15);
  });

  it.each(files.map(file => [path.relative(UI, file), file] as const))(
    '%s',
    (_label, file) => {
      const source = fs.readFileSync(file, 'utf8');
      for (const {name, body} of statusSurfaces(source)) {
        // A pill/badge sizes itself; a BLOCK notice takes the shared surface.
        const isPill =
          /radii\.pill/.test(body) || /^(?:availabilityPill|statusPill)/.test(name);
        if (isPill) continue;
        expect({name, rule: 'no own padding', body}).toEqual({
          name,
          rule: 'no own padding',
          body: expect.not.stringMatching(/\bpadding:\s*spacing\.(?:md|lg)/),
        });
        expect({name, rule: 'no large radius', body}).toEqual({
          name,
          rule: 'no large radius',
          body: expect.not.stringMatching(/borderRadius:\s*radii\.lg/),
        });
      }
    },
  );

  it('no notice text is set at heading size', () => {
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const headings = Array.from(
        source.matchAll(
          /\n\s*((?:warning|error|danger|success|notice|loadError|stall)\w*(?:Title|Text)):\s*\{\.\.\.typography\.(heading|title)/g,
        ),
        m => `${path.relative(UI, file)}:${m[1]}`,
      );
      expect(headings).toEqual([]);
    }
  });
});
