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

/* ==================================================================== *
 * PROTOCOL VOCABULARY
 * ==================================================================== */

/**
 * THE SECOND CLASS OF LEAK, found by sweeping the whole app rather than
 * the six examples an earlier round happened to name.
 *
 * The first half of this file catches OUR PROCESS leaking into the
 * product ("Pass 2", "REQUIRES HARDWARE TEST"). This half catches OUR
 * PROTOCOL leaking into it - the operator being shown how the bytes are
 * arranged rather than what the setting means:
 *
 *     غير مكتشف في MSP_STATUS_EX
 *     قنوات MSP_RC
 *     الحالة من MSP_VTX_CONFIG
 *     ثم EEPROM وقراءة تحقق
 *     نتيجة الكتابة غير مؤكدة عند RXFAIL_CONFIG
 *
 * The last one was the worst: a raw write-group identifier interpolated
 * into Arabic copy at the one moment the pilot most needs to understand
 * what happened - an unconfirmed save. Five screens did it.
 *
 * WHAT IS DELIBERATELY STILL ALLOWED. A term the OPERATOR needs is not a
 * leak. "MSP" is the real name of a serial-port function on the Ports
 * screen and a real thing a pilot assigns a UART to; the CLI screen is a
 * developer surface by definition; and a bare `MSP_...` string used as a
 * routing key or a telemetry stage id is code, not copy. Those live in
 * PROTOCOL_ALLOWED below, each with the reason - so an addition to that
 * list is a decision somebody made on purpose, not an accident.
 */
const PROTOCOL_TOKENS: readonly string[] = [
  'MSP_',
  'EEPROM',
  'payload',
  'sbuf',
  'readback',
];

/**
 * Files whose runtime half may legitimately contain a protocol token,
 * with the reason. Anything not on this list must be clean.
 */
const PROTOCOL_ALLOWED: Readonly<Record<string, string>> = {
  // 'MSP' is a serial-port FUNCTION the operator assigns; the screen must
  // be able to name it. (These are 'MSP_SHAREABLE'-style code symbols and
  // port-function labels, not prose about our implementation.)
  'src/ui/screens/PortsScreen.tsx': 'MSP is a port function the operator assigns',
  // A developer surface by definition - the whole screen is a terminal.
  'src/ui/screens/CliScreen.tsx': 'the CLI screen IS the developer surface',
  // Notice-routing domain and connection-stage ids: code identifiers that
  // are never rendered. Verified by reading every use site.
  'src/ui/components/setup/connectionIndicator.ts': 'notice-routing domain key, never rendered',
  'src/ui/screens/UsbConnectionScreen.tsx': 'connection-stage telemetry ids, never rendered',
  // The map that REPLACES the raw identifiers; it must name them to
  // translate them.
  'src/ui/presentation/writeStageNames.ts': 'the translation table itself',
  // Not imported by any screen - a developer diagnostic panel that the
  // product never mounts. Verified by grepping every import site.
  'src/ui/screens/UsbSerialDebugPanel.tsx': 'developer diagnostic panel, mounted by no screen',
};

describe('shipped UI carries no protocol vocabulary', () => {
  const UI_SOURCES = SHIPPED_SOURCES.filter(path =>
    path.startsWith(join(REPO_ROOT, 'src', 'ui')),
  );

  it('finds the UI files to check', () => {
    expect(UI_SOURCES.length).toBeGreaterThan(30);
  });

  /**
   * COPY IS ARABIC. That single fact is what makes this check precise.
   *
   * A first version flagged every occurrence in the runtime half and
   * produced three false positives that were not copy at all:
   * `outcome.stage.kind === 'EEPROM'` (a discriminant), the testID
   * `motor-direction-no-readback` (never rendered), and a re-exported
   * command constant. None of them is a sentence shown to a pilot.
   *
   * This app's user-facing text is Arabic without exception, so the rule
   * is: a STRING OR JSX SPAN that carries Arabic IS copy, and a protocol
   * token inside that same span is a token in a sentence.
   *
   * Per SPAN, not per line - a line is too coarse. ModesScreen puts
   * `outcome.stage.kind === 'EEPROM' ? 'نتيجة الحفظ…' : …` on one line,
   * where the token and the sentence are neighbours but not the same
   * text. A backtick span deliberately keeps its `${...}` interpolation,
   * because that is exactly how the worst leak of this round read:
   * `نتيجة الكتابة غير مؤكدة عند ${outcome.stage.group}`.
   */
  const ARABIC = /[\u0600-\u06FF]/;

  /** Every string literal, template literal and JSX text run. */
  function copySpans(code: string): readonly string[] {
    const spans: string[] = [];
    for (const match of code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`|>([^<>{}]+)</g)) {
      const span = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (span !== undefined && span.length > 0) {
        spans.push(span);
      }
    }
    return spans;
  }

  it('shows the operator no protocol identifier, in any sentence', () => {
    const offenders: string[] = [];
    for (const path of UI_SOURCES) {
      const relative = path.slice(REPO_ROOT.length + 1).split('\\').join('/');
      if (PROTOCOL_ALLOWED[relative] !== undefined) {
        continue;
      }
      const {code} = splitCodeAndComments(readFileSync(path, 'utf8'));
      for (const span of copySpans(code)) {
        if (!ARABIC.test(span)) {
          continue;
        }
        for (const token of PROTOCOL_TOKENS) {
          if (span.includes(token)) {
            offenders.push(`${relative} :: ${token} in "${span.slice(0, 60)}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every allowance justified, so the list cannot quietly grow', () => {
    // An allowance for a file that no longer needs one is an allowance
    // that would hide the next regression in that file.
    for (const [relative, reason] of Object.entries(PROTOCOL_ALLOWED)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(SHIPPED_SOURCES.map(p => p.slice(REPO_ROOT.length + 1).split('\\').join('/'))).toContain(relative);
    }
  });

  /**
   * The five screens that interpolated a raw write group into their
   * unconfirmed-save copy. Named individually so a regression reports
   * WHICH screen came back.
   */
  it.each([
    'FailsafeScreen',
    'OsdScreen',
    'PidTuningScreen',
    'PowerBatteryScreen',
    'VideoTransmitterScreen',
  ])('%s translates its write stage instead of printing it', name => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'ui', 'screens', `${name}.tsx`), 'utf8');
    const {code} = splitCodeAndComments(source);
    // Not merely absent - actively translated through the shared map.
    expect(code).toContain('unconfirmedWriteMessage');
    expect(code).not.toMatch(/\$\{outcome\.stage(\.group)?\}/);
  });
});
