/**
 * ZERO IS A READING. IT IS NOT A MISSING READING.
 *
 * Every screen in this application uses one placeholder - the em dash -
 * to say "the board did not tell us this". That is the right thing to
 * show when a value is absent, and the wrong thing to show when the
 * value is zero, because on a flight controller zero is real and often
 * the most important reading there is: zero satellites locked, zero
 * amps drawn, zero mAh consumed, zero RSSI, an ESC turning at zero RPM.
 * A screen that draws the dash for both is telling the operator "no
 * data" at the exact moment the data says "nothing is there", and those
 * two mean opposite things when you are deciding whether to arm.
 *
 * The failure is a one-character slip:
 *
 *     value === undefined ? '—' : String(value)      correct
 *     value ? String(value) : '—'                     zero becomes '—'
 *
 * Both read the same at a glance, both compile, and no render test
 * catches the second unless the fixture happens to carry a zero. So the
 * rule is enforced at the source: WHEREVER THE UNAVAILABLE PLACEHOLDER
 * IS PRODUCED BY A CONDITION, THAT CONDITION MUST BE AN EXPLICIT
 * ABSENCE TEST - a nullish comparison, a `??`, an emptiness check, a
 * finiteness check, or a named boolean that carries the question in its
 * own name. A bare truthiness test on a value is not an absence test.
 *
 * Read from source rather than from a render, because the rule is about
 * every such site that exists, not the ones some fixture mounts.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const UI_ROOT = join(__dirname);
/** The one placeholder this application uses for "not reported". */
const DASH = '—';

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (
      (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) &&
      !entry.name.includes('.test.')
    ) {
      found.push(path);
    }
  }
  return found;
}

/**
 * An explicit statement about ABSENCE, in any of the forms this codebase
 * actually uses. Each one asks "is there a value at all?" - none of them
 * can be answered differently by a zero.
 */
const ABSENCE = [
  /[=!]==?\s*undefined/,
  /[=!]==?\s*null/,
  /\?\?/,
  /\.length\s*[=!<>]/,
  /Number\.isFinite|isFinite|Number\.isNaN|isNaN/,
  /\bhas[A-Z]\w*/,
  /\bis(Live|Known|Present|Available|Reported|Valid|Fresh|Ready|Supported)\w*/i,
  /\b\w*(Live|Known|Present|Available|Reported|Supported|Unsupported)\b/,
  /\.kind\s*[=!]==?/,
  /\.state\s*[=!]==?/,
  /\bin\b\s+\w/,
];

/**
 * The condition governing a `? <dash>` or `: <dash>` branch: the text
 * from the start of the enclosing expression up to the `?`. Newlines are
 * collapsed first, because the condition and the dash are routinely on
 * different lines and a line-at-a-time reader sees only the dash.
 */
interface Site {
  readonly where: string;
  readonly condition: string;
}

/**
 * The WHOLE condition owning a `?`, walking left with bracket depth.
 *
 * The obvious version of this - "slice back to the last `=`" - is wrong,
 * and wrong in the direction that manufactures findings: `raw ===
 * undefined ? …` truncates to `undefined`, which matches no absence
 * pattern, and twenty-six correct sites are reported as defects. So the
 * scan stops only at a real boundary: an unbalanced opener, a statement
 * separator at depth zero, or a lone `=` that is an assignment rather
 * than part of `===`, `!==`, `>=`, `<=` or `=>`.
 */
function conditionBefore(flat: string, question: number): string {
  let depth = 0;
  let index = question - 1;
  for (; index >= 0; index -= 1) {
    const character = flat[index];
    if (character === ')' || character === '}' || character === ']') {
      depth += 1;
      continue;
    }
    if (character === '(' || character === '{' || character === '[') {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (character === ';' || character === ',') break;
    if (character === '?' || character === ':') break;
    if (character === '=') {
      const before = flat[index - 1] ?? '';
      const after = flat[index + 1] ?? '';
      const partOfComparison =
        before === '=' ||
        before === '!' ||
        before === '<' ||
        before === '>' ||
        after === '=' ||
        after === '>';
      if (!partOfComparison) break;
    }
  }
  return flat.slice(index + 1, question).trim();
}

function placeholderSites(path: string, source: string): Site[] {
  const flat = source.replace(/\s+/g, ' ');
  /* Offsets in the flattened text mapped back to line numbers. */
  const lineAt = (flatIndex: number): number => {
    let seen = 0;
    let line = 1;
    let wasSpace = false;
    for (let i = 0; i < source.length; i += 1) {
      const isSpace = /\s/.test(source[i]);
      if (isSpace && wasSpace) {
        if (source[i] === '\n') line += 1;
        continue;
      }
      if (seen === flatIndex) return line;
      seen += 1;
      if (source[i] === '\n') line += 1;
      wasSpace = isSpace;
    }
    return line;
  };

  const found: Site[] = [];
  const dash = new RegExp(
    `(\\?|:)\\s*(?:'${DASH}[^']*'|"${DASH}[^"]*"|\`${DASH}[^\`]*\`|<Text[^>]*>${DASH}<)`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = dash.exec(flat)) !== null) {
    const question =
      match[1] === '?' ? match.index : flat.lastIndexOf('?', match.index);
    if (question < 0) continue;
    const condition = conditionBefore(flat, question);
    if (condition.length === 0) continue;
    found.push({
      where: `${path.slice(path.indexOf('src/'))}:${lineAt(question)}`,
      condition: condition.slice(-160),
    });
  }
  return found;
}

function gatesOnAbsence(condition: string): boolean {
  return ABSENCE.some(pattern => pattern.test(condition));
}

function audit(): {sites: Site[]; truthinessGated: Site[]} {
  const sites: Site[] = [];
  for (const file of sources(UI_ROOT)) {
    sites.push(...placeholderSites(file, readFileSync(file, 'utf8')));
  }
  return {sites, truthinessGated: sites.filter(s => !gatesOnAbsence(s.condition))};
}

describe('the unavailable placeholder means unavailable, never zero', () => {
  it('every placeholder branch is gated on absence, not on truthiness', () => {
    const {truthinessGated} = audit();
    expect(
      truthinessGated.map(site => `${site.where}  <- if (${site.condition})`),
    ).toEqual([]);
  });

  it('the rule has real subjects - it is not passing because it found none', () => {
    const {sites} = audit();
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  it('detects a reading whose zero would be drawn as "no data"', () => {
    /* The detector, attacked. Both of these render a dash; only one of
       them can tell a zero from a silence. */
    const planted = `value={satellites ? String(satellites) : '${DASH}'}`;
    const [site] = placeholderSites('src/ui/Planted.tsx', planted);
    expect(site).toBeDefined();
    expect(gatesOnAbsence(site.condition)).toBe(false);
  });

  it('accepts the same reading once it asks whether the value exists', () => {
    const repaired = `value={satellites === undefined ? '${DASH}' : String(satellites)}`;
    const [site] = placeholderSites('src/ui/Repaired.tsx', repaired);
    expect(site).toBeDefined();
    expect(gatesOnAbsence(site.condition)).toBe(true);
  });

  it('a zero is not mistaken for absence by the absence tests themselves', () => {
    /* The whole rule in one table. A truthiness test and an absence test
       agree everywhere except at zero - which is exactly the reading
       this contract exists to protect, and exactly where a screen using
       the wrong one starts lying. */
    const readings: readonly (number | undefined)[] = [0, 5, undefined];
    const table = readings.map(value => ({
      value,
      truthy: Boolean(value),
      present: value !== undefined,
      throughNullish: value ?? 'absent',
      finite: Number.isFinite(value),
    }));
    expect(table).toEqual([
      {value: 0, truthy: false, present: true, throughNullish: 0, finite: true},
      {value: 5, truthy: true, present: true, throughNullish: 5, finite: true},
      {
        value: undefined,
        truthy: false,
        present: false,
        throughNullish: 'absent',
        finite: false,
      },
    ]);
  });
});
