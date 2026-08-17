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

/**
 * EVERY VALIDATION CODE REACHES THE OPERATOR AS A SENTENCE.
 *
 * Failsafe rendered `issues.join(' · ')`, so a real board produced
 * "راجع القيم: CHANNEL_VALUE_INVALID" - an internal identifier, in Latin
 * script, on an Arabic screen, naming nothing the operator could act on. That
 * was fixed there; this checks the other models that emit codes the same way,
 * so the next one added cannot ship without its sentence.
 */
describe('validation codes are translated, never printed raw', () => {
  const MODELS: readonly (readonly [string, string])[] = [
    ['../../core/state/gpsConfigurationModel.ts', 'gpsSystem.validation'],
    ['../../core/state/failsafeConfigurationModel.ts', ''],
  ];

  it.each(MODELS.filter(([, namespace]) => namespace !== ''))(
    '%s has an Arabic sentence for every code it can emit',
    (model, namespace) => {
      const source = fs.readFileSync(path.join(__dirname, model), 'utf8');
      const codes = new Set(
        Array.from(source.matchAll(/issues\.push\('([A-Z_]+)'\)/g), m => m[1]),
      );
      expect(codes.size).toBeGreaterThan(0);

      const locale = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, '..', '..', 'i18n', 'locales', 'ar.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const table = namespace
        .split('.')
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown> | undefined)?.[key],
          locale,
        ) as Record<string, string> | undefined;

      for (const code of codes) {
        const sentence = table?.[code];
        expect(sentence).toBeDefined();
        // Arabic prose, not the identifier. Protocol proper nouns - GPS,
        // SBAS, MSP, Betaflight - stay in Latin script on purpose; they are
        // what the operator sees printed on their own hardware.
        expect(sentence).toMatch(/[؀-ۿ]/);
        expect(sentence).not.toContain(code);
        expect((sentence ?? '').length).toBeGreaterThan(20);
      }
    },
  );
});
