/**
 * A CONTROL THAT PAINTS ITSELF SELECTED MUST SAY SO.
 *
 * Selection in this app is carried by colour: the chosen chip gets an
 * accent fill, the others do not. Colour is invisible to a screen reader
 * and to every automated check, so a control that paints `styles.*Selected`
 * and exposes no `accessibilityState={{selected}}` is telling a sighted
 * operator one thing and an assistive one nothing at all.
 *
 * The app already had this right in eighteen places and wrong in nine -
 * including two adjacent segmented controls in PidTuningScreen, one
 * correct and one not - which is what a convention with no enforcement
 * looks like. This test is the enforcement. It reads the source rather
 * than a render because the rule is about every such control that exists,
 * not only the ones some fixture happens to mount.
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
 * `style={{...}}` and `onPress={() => x}` do not end the tag early.
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

const PAINTS_SELECTED = /styles\.[A-Za-z]*[Ss]elected\b/;
const ANNOUNCES_SELECTED = /accessibilityState\s*=|aria-checked\s*=/;

interface Offender {
  readonly where: string;
}

function offenders(): {offenders: Offender[]; total: number} {
  const rows: Offender[] = [];
  let total = 0;
  for (const file of screens(UI_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const tag of ['Pressable', 'TouchableOpacity']) {
      for (const element of openings(source, tag)) {
        if (!PAINTS_SELECTED.test(element.text)) continue;
        total += 1;
        if (ANNOUNCES_SELECTED.test(element.text)) continue;
        const line = source.slice(0, element.at).split('\n').length;
        rows.push({where: `${file.slice(file.indexOf('src/'))}:${line}`});
      }
    }
  }
  return {offenders: rows, total};
}

describe('selection is announced, not only painted', () => {
  it('every control that paints a selected style also exposes it', () => {
    const {offenders: rows} = offenders();
    expect(rows.map(row => row.where)).toEqual([]);
  });

  it('the rule has real subjects - it is not passing because it found none', () => {
    const {total} = offenders();
    expect(total).toBeGreaterThanOrEqual(27);
  });

  it('detects a control that paints selection without announcing it', () => {
    /* The detector, attacked. If this ever stops failing on an obvious
       offender, the test above is worthless. */
    const planted = `
      <Pressable
        onPress={() => choose(option.value)}
        style={[styles.chip, value === option.value && styles.chipSelected]}>
        <Text>{option.label}</Text>
      </Pressable>`;
    const [element] = openings(planted, 'Pressable');
    expect(PAINTS_SELECTED.test(element.text)).toBe(true);
    expect(ANNOUNCES_SELECTED.test(element.text)).toBe(false);
  });

  it('accepts the same control once it announces its state', () => {
    const repaired = `
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{selected: value === option.value}}
        onPress={() => choose(option.value)}
        style={[styles.chip, value === option.value && styles.chipSelected]}>
        <Text>{option.label}</Text>
      </Pressable>`;
    const [element] = openings(repaired, 'Pressable');
    expect(PAINTS_SELECTED.test(element.text)).toBe(true);
    expect(ANNOUNCES_SELECTED.test(element.text)).toBe(true);
  });
});
