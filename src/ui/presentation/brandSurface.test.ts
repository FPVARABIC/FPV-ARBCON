/**
 * THE BOUNDARY BETWEEN "WHAT THE PROTOCOL IS CALLED" AND "WHAT THE
 * OPERATOR READS", ENFORCED INSTEAD OF REMEMBERED.
 *
 * FPV-ARBCON speaks MSP. The firmware projects that also speak it are
 * other people's work, and printing one of their names in this
 * application's own chrome - a chip, a heading, an error, a filename -
 * reads as a claim of association this application has no right to make.
 *
 * Removing those names once is easy. KEEPING them out is the hard part:
 * the decoded identity carries the name as an ordinary field, so any new
 * screen that renders `identity.firmware.knownFamily` re-introduces it
 * without anyone noticing. That is exactly how it got onto four separate
 * surfaces before this file existed. So the rule is a test, not a note.
 *
 * =====================================================================
 * WHAT IS FORBIDDEN, AND WHAT IS DELIBERATELY NOT
 * =====================================================================
 *
 * FORBIDDEN - text the application itself authors and shows:
 *   1. every value in the translation catalogue;
 *   2. every string literal and JSX text node in the presentation layer
 *      (App*.tsx, src/ui, src/navigation, src/web);
 *   3. every Arabic string literal ANYWHERE in src - Arabic is this
 *      application's operator language, so an Arabic sentence is a
 *      surface no matter which layer authored it. This is the rule that
 *      catches an error message thrown deep in a controller and shown
 *      verbatim by a screen.
 *
 * NOT FORBIDDEN - identifiers, not sentences:
 *   - the wire value a board reports and the enum that gates capability
 *     on it (`'BETAFLIGHT'`, `'BETAFLIGHT_API_1_47'`). Getting these
 *     wrong is a protocol defect; they are matched by shape below and
 *     an Arabic character in one disqualifies it immediately.
 *   - translation KEYS (`diagnostics.compatibilityBetaflight147`). A key
 *     is a lookup, and rule 1 already governs the value it resolves to.
 *   - module specifiers and TypeScript type/identifier names.
 *   - source comments and citations. Naming the firmware whose source
 *     proves a byte layout is how this codebase justifies its decoding,
 *     and a comment is not a surface.
 *
 * TWO THINGS THIS FILE CANNOT PROVE, STATED RATHER THAN IMPLIED:
 *   - It reads literals, so it cannot see a name that only exists at
 *     runtime. `UsbSerialDebugPanel` still prints the raw wire
 *     identifier from a variable - it is `__DEV__`-only and stripped
 *     from every production bundle by `debugPanels.ts`, which is why it
 *     is not a surface.
 *   - CLI terminal output is the BOARD speaking, echoed verbatim, and is
 *     left exactly as the board sent it. Rewriting a diagnostic terminal
 *     would be a correctness defect, and text a board emits is not this
 *     application claiming anything.
 */

import * as fs from 'fs';
import * as path from 'path';

import { containsExternalFirmwareBrand } from './brandSafeText';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Files that ARE the presentation layer. */
const SURFACE_ROOTS = [
  'App.tsx',
  'App.web.tsx',
  'index.web.tsx',
  'src/ui',
  'src/navigation',
  'src/web',
];

/** Everything under here is scanned by the Arabic-sentence rule. */
const ALL_SOURCE_ROOTS = ['App.tsx', 'App.web.tsx', 'index.web.tsx', 'src'];

/**
 * Test code says the real name on purpose - a fixture that lies about
 * which firmware it imitates is a worse fixture. And this very file has
 * to write the brand down to check for it.
 */
function isTestOrFixture(relativePath: string): boolean {
  return (
    /\.test\.tsx?$/.test(relativePath) ||
    relativePath.includes('__tests__') ||
    relativePath.includes('__testUtils__') ||
    relativePath.includes('__fixtures__') ||
    relativePath.includes('__mocks__')
  );
}

/**
 * The one module allowed to write the brand as data: it holds the
 * patterns that strip it. Excluded from the literal scan only - its own
 * unit tests cover what it returns.
 */
const VOCABULARY_MODULE = path.join('src', 'ui', 'presentation', 'brandSafeText.ts');

function listSourceFiles(roots: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (absolute: string): void => {
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
      if (/\.tsx?$/.test(absolute)) found.push(absolute);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(absolute).sort()) {
      if (entry === 'node_modules' || entry === '__snapshots__') continue;
      visit(path.join(absolute, entry));
    }
  };
  for (const root of roots) {
    const absolute = path.join(REPO_ROOT, root);
    if (fs.existsSync(absolute)) visit(absolute);
  }
  return found;
}

interface ExtractedText {
  readonly value: string;
  readonly line: number;
}

interface ScannedSource {
  /** Every string / template literal, comments excluded. */
  readonly literals: readonly ExtractedText[];
  /** Text between JSX tags, comments and literals excluded. */
  readonly jsxText: readonly ExtractedText[];
}

/**
 * A DELIBERATELY SMALL TOKENIZER, not a TypeScript parser.
 *
 * It needs to answer one question - "is this run of characters something
 * a person could read?" - and for that it must tell a comment from a
 * string from code. It tracks: line comments, block comments, and the
 * three quote forms with backslash escapes. Template substitutions are
 * NOT unwrapped: a whole template is treated as one literal, which
 * over-reports rather than under-reports, and over-reporting a brand hit
 * fails loudly instead of passing quietly.
 *
 * Regular expression literals are not tracked, because a regex is code:
 * the only characters it could contribute are its own, and the sole
 * module whose regexes spell the brand is excluded above.
 *
 * `scans its own behaviour` below is the proof that it works, on a
 * synthetic file that puts the brand in all five positions.
 */
export function scanSource(source: string): ScannedSource {
  const literals: ExtractedText[] = [];
  const jsxText: ExtractedText[] = [];

  let line = 1;
  let index = 0;
  /** Code with comments and literals blanked out - JSX text survives. */
  let residue = '';

  const isEscaped = (): boolean => {
    let backslashes = 0;
    let cursor = index - 1;
    while (cursor >= 0 && source[cursor] === '\\') {
      backslashes += 1;
      cursor -= 1;
    }
    return backslashes % 2 === 1;
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') {
          line += 1;
          residue += '\n';
        }
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      const startLine = line;
      index += 1;
      let value = '';
      while (index < source.length) {
        if (source[index] === quote && !isEscaped()) break;
        if (source[index] === '\n') {
          line += 1;
          residue += '\n';
        }
        value += source[index];
        index += 1;
      }
      index += 1;
      literals.push({ value, line: startLine });
      continue;
    }

    if (char === '\n') {
      line += 1;
    }
    residue += char;
    index += 1;
  }

  /**
   * JSX text is what sits between a `>` and the next `<` with no braces
   * or angle brackets in between. Run over the residue - literals and
   * comments already removed - this also matches a few comparisons that
   * are not JSX at all, which is harmless: the only thing asked of the
   * result is whether it spells the brand.
   */
  let residueLine = 1;
  const pattern = /(^|[^\n])>([^<>{}]+)</g;
  let consumed = 0;
  let match = pattern.exec(residue);
  while (match !== null) {
    const at = match.index;
    for (let i = consumed; i < at; i += 1) {
      if (residue[i] === '\n') residueLine += 1;
    }
    consumed = at;
    const text = match[2];
    if (text.trim().length > 0) jsxText.push({ value: text, line: residueLine });
    match = pattern.exec(residue);
  }

  return { literals, jsxText };
}

/**
 * Shapes that are identifiers rather than sentences. An Arabic character
 * disqualifies a literal before any of these are consulted, so a shape
 * can never launder operator copy.
 */
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
/** `BETAFLIGHT`, `BETAFLIGHT_API_1_47`, `BTFL`. */
const ENUM_LITERAL = /^[A-Z][A-Z0-9_]*$/;
/** `diagnostics.compatibilityBetaflight147`. */
const TRANSLATION_KEY = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
/** `../../core/firmware-adapters/betaflightMotorVectorsV147`, `react-native`. */
const MODULE_SPECIFIER = /^(\.{1,2}\/[\w./-]+|@?[a-z0-9-]+(\/[\w.-]+)*)$/;

function isInternalIdentifier(value: string): boolean {
  if (ARABIC.test(value)) return false;
  const trimmed = value.trim();
  if (trimmed !== value) return false;
  return (
    ENUM_LITERAL.test(value) ||
    TRANSLATION_KEY.test(value) ||
    MODULE_SPECIFIER.test(value)
  );
}

function collectTranslationValues(
  node: unknown,
  keyPath: string,
  into: { path: string; value: string }[],
): void {
  if (typeof node === 'string') {
    into.push({ path: keyPath, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, i) => collectTranslationValues(entry, `${keyPath}[${i}]`, into));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      collectTranslationValues(value, keyPath ? `${keyPath}.${key}` : key, into);
    }
  }
}

describe('no external firmware brand reaches the operator', () => {
  it('scans its own behaviour before it is trusted to scan the app', () => {
    const synthetic = [
      '// Betaflight decodes this the same way (fc/init.c).',
      '/* Betaflight fixture citation across',
      '   Betaflight lines. */',
      "import {betaflightBuildApi} from '../core/betaflightBuildApi';",
      "const gate = family === 'BETAFLIGHT';",
      "const key = 'diagnostics.compatibilityBetaflight147';",
      "const heading = 'إعدادات Betaflight';",
      'const jsx = <Text>Powered by Betaflight</Text>;',
    ].join('\n');

    const { literals, jsxText } = scanSource(synthetic);
    const literalValues = literals.map(entry => entry.value);

    // Comments contributed nothing at all.
    expect(literalValues.some(value => value.includes('fc/init.c'))).toBe(false);

    // The three internal forms are seen, and classified as internal.
    expect(literalValues).toContain('../core/betaflightBuildApi');
    expect(literalValues).toContain('BETAFLIGHT');
    expect(literalValues).toContain('diagnostics.compatibilityBetaflight147');
    expect(isInternalIdentifier('../core/betaflightBuildApi')).toBe(true);
    expect(isInternalIdentifier('BETAFLIGHT')).toBe(true);
    expect(isInternalIdentifier('diagnostics.compatibilityBetaflight147')).toBe(true);

    // The two REAL violations are seen, and classified as violations.
    expect(literalValues).toContain('إعدادات Betaflight');
    expect(isInternalIdentifier('إعدادات Betaflight')).toBe(false);
    expect(jsxText.map(entry => entry.value.trim())).toContain('Powered by Betaflight');

    // ...which is to say: this test can fail. On the synthetic file it does.
    const violations = [
      ...literalValues.filter(v => containsExternalFirmwareBrand(v) && !isInternalIdentifier(v)),
      ...jsxText.map(e => e.value).filter(containsExternalFirmwareBrand),
    ];
    expect(violations).toHaveLength(2);
  });

  it('has no brand in any translated value', () => {
    const catalogue = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'src/i18n/locales/ar.json'), 'utf8'),
    ) as unknown;
    const values: { path: string; value: string }[] = [];
    collectTranslationValues(catalogue, '', values);

    expect(values.length).toBeGreaterThan(500);
    expect(
      values
        .filter(entry => containsExternalFirmwareBrand(entry.value))
        .map(entry => `${entry.path} = ${entry.value}`),
    ).toEqual([]);
  });

  it('has no brand in any literal or JSX text the presentation layer renders', () => {
    const files = listSourceFiles(SURFACE_ROOTS);
    expect(files.length).toBeGreaterThan(80);

    const violations: string[] = [];
    for (const absolute of files) {
      const relative = path.relative(REPO_ROOT, absolute);
      if (isTestOrFixture(relative) || relative === VOCABULARY_MODULE) continue;
      const { literals, jsxText } = scanSource(fs.readFileSync(absolute, 'utf8'));
      for (const entry of literals) {
        if (!containsExternalFirmwareBrand(entry.value)) continue;
        if (isInternalIdentifier(entry.value)) continue;
        violations.push(`${relative}:${entry.line} literal ${JSON.stringify(entry.value)}`);
      }
      for (const entry of jsxText) {
        if (!containsExternalFirmwareBrand(entry.value)) continue;
        violations.push(`${relative}:${entry.line} JSX text ${JSON.stringify(entry.value.trim())}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('has no brand in any Arabic sentence anywhere in the source', () => {
    const files = listSourceFiles(ALL_SOURCE_ROOTS);
    expect(files.length).toBeGreaterThan(200);

    const violations: string[] = [];
    for (const absolute of files) {
      const relative = path.relative(REPO_ROOT, absolute);
      if (isTestOrFixture(relative)) continue;
      for (const entry of scanSource(fs.readFileSync(absolute, 'utf8')).literals) {
        if (!ARABIC.test(entry.value)) continue;
        if (!containsExternalFirmwareBrand(entry.value)) continue;
        violations.push(`${relative}:${entry.line} ${JSON.stringify(entry.value)}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
