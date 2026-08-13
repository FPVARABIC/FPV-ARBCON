/**
 * INTERNAL REVIEW VOCABULARY MUST NOT REACH THE OPERATOR.
 *
 * WHY THIS SUITE EXISTS, and why the one before it was not enough.
 * `src/platforms/web/webOperatorCopy.test.ts` walks `ar.json` and proved
 * the Arabic catalogue was clean. It was — and the product still showed
 * the operator this, on nine screens, in English, inside an Arabic-first
 * interface:
 *
 *     REQUIRES HARDWARE TEST
 *
 * Those titles were hard-coded in JSX and never entered the catalogue,
 * so a catalogue-walking test could not see them by construction. The
 * measured browser sweep could not see them either: with no flight
 * controller attached the sweep never left the Start screen, so it
 * reported a clean product while nine tabs carried the token. Two green
 * checks, one defect straight through the middle. This file closes that
 * gap by reading the SOURCE THAT SHIPS.
 *
 * WHAT IS FORBIDDEN, AND WHERE. Only the RUNTIME half of each file.
 * These phrases are legitimate engineering vocabulary and stay welcome
 * in comments, audit documents, test names and historical records — the
 * `hardware` NoticeBox variant exists precisely because the underlying
 * distinction is load-bearing. What must never happen again is a review
 * token rendering as product copy. So the check is positional, not
 * lexical: the same word passes in a comment and fails in a string.
 *
 * HOW THE SPLIT IS TRUSTED. `splitCodeAndComments()` replaces the other
 * half of the file with spaces, so every character lands in exactly one
 * bucket and offsets never shift. Each file then RECONCILES: raw
 * occurrences must equal code occurrences plus comment occurrences. If
 * the splitter ever loses its place — an exotic template literal, a
 * regex that looks like a comment — the reconciliation fails loudly
 * instead of quietly reporting a clean file it never really parsed.
 */

import {readFileSync, readdirSync, statSync} from 'fs';
import {join} from 'path';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Phrases that describe OUR development process. An operator has no use
 * for any of them, and reading one is how the reported defect felt from
 * the outside: an internal artefact, not a product.
 */
const INTERNAL_TOKENS: readonly string[] = [
  'REQUIRES HARDWARE TEST',
  'Phase 1',
  'Phase 2',
  'Pass 1',
  'Pass 2',
  'TODO',
  'FIXME',
];

/** Roots that contain code the operator actually runs. */
const RUNTIME_ROOTS = [join(REPO_ROOT, 'src')];
const RUNTIME_ENTRY_FILES = [
  join(REPO_ROOT, 'App.tsx'),
  join(REPO_ROOT, 'App.web.tsx'),
  join(REPO_ROOT, 'index.web.tsx'),
];

/**
 * Tests, fixtures and mocks are evidence about the product, not part of
 * it. A test is allowed — encouraged — to name the regression it pins.
 */
function isShippedSourceFile(path: string): boolean {
  if (!/\.tsx?$/.test(path)) {
    return false;
  }
  if (/\.test\.tsx?$/.test(path)) {
    return false;
  }
  return (
    !path.includes('__tests__') &&
    !path.includes('__testUtils__') &&
    !path.includes('__mocks__')
  );
}

function collectShippedSources(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (isShippedSourceFile(path)) {
        found.push(path);
      }
    }
  };
  for (const root of RUNTIME_ROOTS) {
    walk(root);
  }
  for (const file of RUNTIME_ENTRY_FILES) {
    if (isShippedSourceFile(file)) {
      found.push(file);
    }
  }
  return found;
}

/**
 * Splits a source file into the half that executes and the half that
 * only documents, preserving every offset.
 *
 * Both halves are the same length as the input: whatever does not belong
 * to a half is blanked to spaces rather than removed. That is what makes
 * the per-file reconciliation below meaningful — a character cannot be
 * counted twice, and cannot vanish.
 *
 * Template literals are tracked through `${...}` because an interpolation
 * is ordinary code that may contain its own strings and comments, and a
 * naive backtick-to-backtick scan would swallow it.
 */
export function splitCodeAndComments(source: string): {
  readonly code: string;
  readonly comments: string;
} {
  const code: string[] = [];
  const comments: string[] = [];
  /** Non-empty while inside template literals; counts `{` depth per level. */
  const templateStack: number[] = [];
  let index = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' =
    'code';

  const emit = (character: string, isComment: boolean): void => {
    const blank = character === '\n' ? '\n' : ' ';
    code.push(isComment ? blank : character);
    comments.push(isComment ? character : blank);
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (state === 'line') {
      emit(character, true);
      if (character === '\n') {
        state = 'code';
      }
      index += 1;
      continue;
    }

    if (state === 'block') {
      if (character === '*' && next === '/') {
        emit(character, true);
        emit(next, true);
        state = 'code';
        index += 2;
        continue;
      }
      emit(character, true);
      index += 1;
      continue;
    }

    if (state === 'single' || state === 'double' || state === 'template') {
      emit(character, false);
      if (character === '\\') {
        // Escaped character: consume it verbatim so a `\'` cannot end the
        // string and a `\\` cannot escape the quote that follows it.
        if (index + 1 < source.length) {
          emit(next, false);
        }
        index += 2;
        continue;
      }
      if (
        (state === 'single' && character === "'") ||
        (state === 'double' && character === '"') ||
        (state === 'template' && character === '`')
      ) {
        state = 'code';
        index += 1;
        continue;
      }
      if (state === 'template' && character === '$' && next === '{') {
        emit(next, false);
        // Back to real code until the matching brace closes.
        templateStack.push(0);
        state = 'code';
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    // state === 'code'
    if (character === '/' && next === '/') {
      emit(character, true);
      emit(next, true);
      state = 'line';
      index += 2;
      continue;
    }
    if (character === '/' && next === '*') {
      emit(character, true);
      emit(next, true);
      state = 'block';
      index += 2;
      continue;
    }
    emit(character, false);
    if (character === "'") {
      state = 'single';
    } else if (character === '"') {
      state = 'double';
    } else if (character === '`') {
      state = 'template';
    } else if (templateStack.length > 0 && character === '{') {
      templateStack[templateStack.length - 1] += 1;
    } else if (templateStack.length > 0 && character === '}') {
      if (templateStack[templateStack.length - 1] === 0) {
        templateStack.pop();
        state = 'template';
      } else {
        templateStack[templateStack.length - 1] -= 1;
      }
    }
    index += 1;
  }

  return {code: code.join(''), comments: comments.join('')};
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
}

const SHIPPED_SOURCES = collectShippedSources();

describe('the splitter itself', () => {
  /**
   * A guard on the guard. If these stopped holding, every assertion
   * below would keep passing while checking nothing.
   */
  it('sees a token inside a string literal', () => {
    const {code, comments} = splitCodeAndComments(
      'const title = "REQUIRES HARDWARE TEST";',
    );
    expect(code).toContain('REQUIRES HARDWARE TEST');
    expect(comments).not.toContain('REQUIRES HARDWARE TEST');
  });

  it('sees a token in JSX text, which is neither a string nor a comment', () => {
    const {code} = splitCodeAndComments('<Text>REQUIRES HARDWARE TEST</Text>');
    expect(code).toContain('REQUIRES HARDWARE TEST');
  });

  it('ignores a token in a line comment', () => {
    const {code, comments} = splitCodeAndComments(
      '// still REQUIRES HARDWARE TEST\nconst x = 1;',
    );
    expect(code).not.toContain('REQUIRES HARDWARE TEST');
    expect(comments).toContain('REQUIRES HARDWARE TEST');
  });

  it('ignores a token in a JSDoc block', () => {
    const {code, comments} = splitCodeAndComments(
      '/**\n * remains REQUIRES HARDWARE TEST.\n */\nexport const x = 1;',
    );
    expect(code).not.toContain('REQUIRES HARDWARE TEST');
    expect(comments).toContain('REQUIRES HARDWARE TEST');
  });

  it('does not mistake a URL inside a string for a line comment', () => {
    const {code} = splitCodeAndComments(
      "const u = 'https://example.test/x'; const t = 'REQUIRES HARDWARE TEST';",
    );
    expect(code).toContain('REQUIRES HARDWARE TEST');
  });

  it('keeps its place through a template literal with an interpolation', () => {
    const {code, comments} = splitCodeAndComments(
      'const a = `x${cond ? "y" : "z"}w`; // REQUIRES HARDWARE TEST\nconst b = "REQUIRES HARDWARE TEST";',
    );
    expect(countOccurrences(code, 'REQUIRES HARDWARE TEST')).toBe(1);
    expect(countOccurrences(comments, 'REQUIRES HARDWARE TEST')).toBe(1);
  });

  it('preserves offsets, so neither half can invent or lose characters', () => {
    const source = 'const a = 1; /* c */ const b = "s"; // t\n';
    const {code, comments} = splitCodeAndComments(source);
    expect(code).toHaveLength(source.length);
    expect(comments).toHaveLength(source.length);
  });
});

describe('shipped source carries no internal review vocabulary', () => {
  it('finds a non-trivial number of files to check', () => {
    // A collector that silently matched nothing would make every
    // assertion below vacuous.
    expect(SHIPPED_SOURCES.length).toBeGreaterThan(100);
  });

  it('accounts for every occurrence it finds, in every file', () => {
    const unreconciled: string[] = [];
    for (const path of SHIPPED_SOURCES) {
      const source = readFileSync(path, 'utf8');
      const {code, comments} = splitCodeAndComments(source);
      for (const token of INTERNAL_TOKENS) {
        const raw = countOccurrences(source, token);
        const split =
          countOccurrences(code, token) + countOccurrences(comments, token);
        if (raw !== split) {
          unreconciled.push(
            `${path.slice(REPO_ROOT.length + 1)} :: ${token} raw=${raw} split=${split}`,
          );
        }
      }
    }
    expect(unreconciled).toEqual([]);
  });

  it('renders no internal review token to the operator', () => {
    const offenders: string[] = [];
    for (const path of SHIPPED_SOURCES) {
      const {code} = splitCodeAndComments(readFileSync(path, 'utf8'));
      for (const token of INTERNAL_TOKENS) {
        const hits = countOccurrences(code, token);
        if (hits > 0) {
          offenders.push(
            `${path.slice(REPO_ROOT.length + 1)} :: ${token} x${hits}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The nine screens the operator actually read the token on. Named
   * individually rather than swept, so that a regression reports WHICH
   * screen came back rather than a bare count.
   */
  it.each([
    'CliScreen',
    'FailsafeScreen',
    'ModesScreen',
    'OsdScreen',
    'PidTuningScreen',
    'PowerBatteryScreen',
    'PresetsScreen',
    'SensorsScreen',
    'VideoTransmitterScreen',
  ])('%s renders a localized hardware-verification title', name => {
    const source = readFileSync(
      join(REPO_ROOT, 'src', 'ui', 'screens', `${name}.tsx`),
      'utf8',
    );
    const {code} = splitCodeAndComments(source);
    expect(code).not.toContain('REQUIRES HARDWARE TEST');
    // The warning is not merely gone - it is still being made, through
    // the shared catalogue key rather than an inline English token.
    expect(code).toContain('hardwareVerification.');
  });
});
