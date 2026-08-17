/**
 * NO SCREEN INTRODUCES ITSELF IN ENGLISH PROTOCOL SHORTHAND.
 *
 * Several screens opened with a decorative eyebrow line built out of internal
 * identifiers - "MODES · AUXILIARY · BETAFLIGHT API 1.47", "SENSORS ·
 * MSP_RAW_IMU 20 HZ · MSP_ALTITUDE 5 HZ", "PID TUNING · BETAFLIGHT API 1.47",
 * "OSD · API 1.47", "RAW BETAFLIGHT CLI · EXCLUSIVE LINK". They said nothing
 * an operator could act on, they were the first thing read on a
 * right-to-left screen, and they pushed the first real control further down
 * on every phone width.
 *
 * They are gone. This keeps them gone: an eyebrow is either a localized
 * lookup or a short Arabic phrase, never a hardcoded Latin string. Protocol
 * identifiers still belong in the code, in commit messages and in the
 * diagnostics export - just not as chrome above the operator's first control.
 */

import * as fs from 'fs';
import * as path from 'path';

const SCREENS = path.join(__dirname);

/** Text nodes styled as an eyebrow, with whatever they render. */
function eyebrowContents(source: string): readonly string[] {
  const pattern = /<Text style=\{styles\.(?:live)?[eE]yebrow\}>([\s\S]*?)<\/Text>/g;
  return Array.from(source.matchAll(pattern), match => match[1].trim());
}

describe('screen eyebrows', () => {
  const files = fs
    .readdirSync(SCREENS)
    .filter(name => name.endsWith('.tsx') && !name.endsWith('.test.tsx'));

  it('scans every screen, so this suite cannot pass by finding nothing', () => {
    expect(files.length).toBeGreaterThan(10);
    const total = files.reduce(
      (count, name) =>
        count +
        eyebrowContents(fs.readFileSync(path.join(SCREENS, name), 'utf8'))
          .length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it.each(
    files.map(name => [name] as const),
  )('%s introduces itself in Arabic, not in protocol shorthand', name => {
    const source = fs.readFileSync(path.join(SCREENS, name), 'utf8');
    for (const content of eyebrowContents(source)) {
      // A localized lookup or any interpolation is fine - the string itself
      // then lives in the locale file, which is reviewed as Arabic copy.
      if (content.includes('{')) continue;
      expect(content).not.toMatch(/[A-Za-z]/);
    }
  });
});
