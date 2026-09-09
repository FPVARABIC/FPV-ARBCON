/**
 * A TEXT FIELD MUST SAY WHICH FIELD IT IS.
 *
 * React Native has no `<label for>`. A `<Text>` sitting above a
 * `<TextInput>` is a visual arrangement and nothing more: TalkBack
 * focusing the field announces its VALUE and "Edit box", and says nothing
 * about what the value means. For a single field on a screen the
 * surrounding context often carries it. For several in a row it does not.
 *
 * VideoTransmitterScreen had exactly that shape. The VTX band table draws,
 * per band, an 8-character name field and a 1-character letter field side
 * by side, then repeats the pair for every band the firmware reports; the
 * power table adds a 3-character tag field per level. Each had a `<Text>`
 * label beside it and no accessibilityLabel, so a TalkBack operator moving
 * through the table heard "BAND, Edit box", "B, Edit box", "25, Edit box",
 * over and over, with nothing to say which band or which level.
 *
 * That is a real editing hazard rather than a cosmetic one: these fields
 * are written back to the flight controller, and the letter field is one
 * character wide, so being one row off is both easy and invisible.
 *
 * The app already got this right in sixteen of nineteen text fields. This
 * test is the enforcement, and it reads the SOURCE rather than a render
 * because the rule is about every field that exists, not the ones some
 * fixture happens to mount.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const UI_ROOT = join(__dirname);

/** Every production .tsx under src/ui. */
function screens(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) screens(path, found);
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * JSX openings of one tag, aware of braces and strings so that
 * `style={{...}}` and `onChangeText={v => x}` do not end the tag early.
 * Deliberately the same walker as selectionStateContract.test.ts: two
 * source contracts disagreeing about where a JSX tag ends would be worse
 * than either of them.
 */
function openings(source: string, tag: string): {text: string; at: number}[] {
  const found: {text: string; at: number}[] = [];
  const opener = new RegExp(`<${tag}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = match.index + match[0].length; i < source.length; i += 1) {
      const character = source[i];
      if (quote !== null) {
        if (character === quote && source[i - 1] !== '\\') quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      else if (character === '>' && depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    found.push({text: source.slice(match.index, end + 1), at: match.index});
  }
  return found;
}

/**
 * What counts as telling a screen reader which field this is.
 *
 * `placeholder` is included because React Native maps it onto the field's
 * accessible name when nothing else is set, and `aria-label` because the
 * web build accepts it. `accessibilityLabelledBy` is the explicit
 * association where one exists.
 */
const NAMES_ITSELF =
  /accessibilityLabel\s*=|accessibilityLabelledBy\s*=|aria-label\s*=|placeholder\s*=/;

interface Offender {
  readonly where: string;
}

function offenders(): {offenders: Offender[]; total: number} {
  const rows: Offender[] = [];
  let total = 0;
  for (const file of screens(UI_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const element of openings(source, 'TextInput')) {
      total += 1;
      if (NAMES_ITSELF.test(element.text)) continue;
      const line = source.slice(0, element.at).split('\n').length;
      rows.push({where: `${file.slice(file.indexOf('src/'))}:${line}`});
    }
  }
  return {offenders: rows, total};
}

describe('every text field names itself to a screen reader', () => {
  it('no TextInput is left without an accessible name', () => {
    const {offenders: rows} = offenders();
    expect(rows.map(row => row.where)).toEqual([]);
  });

  it('the rule has real subjects - it is not passing because it found none', () => {
    const {total} = offenders();
    expect(total).toBeGreaterThanOrEqual(19);
  });

  it('detects a field whose only label is an adjacent Text element', () => {
    /* The detector, attacked. This is the exact shape the VTX band table
       had: a visual label beside a field that is programmatically
       anonymous. If this ever stops being detected, the test above is
       worthless. */
    const planted = `
      <View style={styles.textFieldSmall}>
        <Text style={styles.label}>الحرف</Text>
        <TextInput
          value={band.letter}
          maxLength={1}
          onChangeText={letter => updateBand(bandIndex, {letter})}
          style={styles.input}
        />
      </View>`;
    const [element] = openings(planted, 'TextInput');
    expect(NAMES_ITSELF.test(element.text)).toBe(false);
  });

  it('accepts the same field once it names itself', () => {
    const repaired = `
      <TextInput
        value={band.letter}
        maxLength={1}
        onChangeText={letter => updateBand(bandIndex, {letter})}
        style={styles.input}
        accessibilityLabel={\`حرف Band \${band.number}\`}
      />`;
    const [element] = openings(repaired, 'TextInput');
    expect(NAMES_ITSELF.test(element.text)).toBe(true);
  });

  it('the walker does not end a tag early on a brace or an arrow', () => {
    /* A field whose props contain `{`, `}`, `=>` and a quoted string, all
       before the accessibilityLabel. A walker that stopped at the first
       `>` would slice the tag in half and report a false offender. */
    const tricky = `
      <TextInput
        style={[styles.input, {textAlign: 'right'}]}
        onChangeText={value => update('name', value)}
        accessibilityLabel="اسم"
      />`;
    const [element] = openings(tricky, 'TextInput');
    expect(NAMES_ITSELF.test(element.text)).toBe(true);
  });
});
