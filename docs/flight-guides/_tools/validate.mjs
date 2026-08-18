/**
 * STATE-AWARE screenshot validation.
 *
 * The previous check asked "does this string appear anywhere on screen?"
 * and passed a Tiny Whoop picture whose selected protocol was DSHOT600,
 * because DSHOT300 was also on screen - as an UNSELECTED chip. That is
 * the class of defect this file exists to make impossible.
 *
 * Every target names a control by testID and a KIND, and each kind reads
 * the property that actually carries state:
 *
 *   stepper  - the rendered value of that control, not page text
 *   option   - aria-checked / aria-selected on the chip itself
 *   switch   - the toggle's own checked state
 *   input    - the field's value attribute
 *   contains / not-contains - text, but scoped INSIDE one testID
 *
 * Usage: node docs/flight-guides/_tools/validate.mjs
 * Requires the preview build served on PREVIEW (see guide-spec.mjs).
 */
import {chromium} from 'playwright-core';
import {STYLES, query, PREVIEW} from './guide-spec.mjs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Reads real state out of the DOM react-native-web produced.
 *
 * SELECTION IS READ FROM PAINT, NOT FROM MARKUP. These chips carry no
 * aria-selected: react-native-web emits the selected style as a class
 * whose name is generated, so there is nothing stable to match on. What
 * IS stable - and is what a reader actually sees - is that the selected
 * chip is painted differently from its siblings. The probe groups the
 * chips by their shared testID prefix, finds the odd background out, and
 * calls that one selected. A group where every chip is painted the same
 * returns undefined rather than guessing.
 */
const PROBE = ({testid, kind}) => {
  const node = document.querySelector(`[data-testid="${testid}"]`);
  if (node === null) return {found: false};

  const valueOf = element => {
    const box = element.matches('input,textarea') ? element : element.querySelector('input,textarea');
    if (box !== null) return box.value ?? '';
    const lines = (element.innerText || '').split('\n').map(s => s.trim())
      .filter(s => s.length > 0 && s !== '+' && s !== '-' && s !== '\u2212');
    return lines[0] ?? '';
  };

  const selectedInGroup = element => {
    const id = element.getAttribute('data-testid') ?? '';
    const prefix = id.replace(/-?\d+$/, '');
    const siblings = [...document.querySelectorAll(`[data-testid^="${prefix}"]`)]
      .filter(n => /-\d+$/.test(n.getAttribute('data-testid') ?? ''));
    if (siblings.length < 2) return undefined;
    const paint = n => getComputedStyle(n).backgroundColor;
    const tally = new Map();
    for (const n of siblings) tally.set(paint(n), (tally.get(paint(n)) ?? 0) + 1);
    if (tally.size < 2) return undefined;
    // The minority paint is the selected one.
    const minority = [...tally.entries()].sort((a, b) => a[1] - b[1])[0][0];
    return paint(element) === minority;
  };

  if (kind === 'option') return {found: true, selected: selectedInGroup(node)};
  if (kind === 'switch') {
    // The testID sits on the whole row; the toggle inside carries
    // role="switch" and aria-checked, which is the real state.
    const toggle = node.matches('[role="switch"]') ? node : node.querySelector('[role="switch"],input[type="checkbox"]');
    if (toggle === null) return {found: true, selected: undefined};
    if (toggle.matches('input')) return {found: true, selected: toggle.checked};
    return {found: true, selected: toggle.getAttribute('aria-checked') === 'true'};
  }
  if (kind === 'stepper' || kind === 'input') return {found: true, value: valueOf(node)};
  return {found: true, text: node.innerText || ''};
};

const browser = await chromium.launch({executablePath: CHROME, args: ['--no-sandbox']});
const failures = [];
let checked = 0;

for (const style of STYLES) {
  for (const step of style.steps) {
    if (step.targets.length === 0) continue;
    const page = await browser.newPage({viewport: {width: 390, height: 4000}, locale: 'ar'});
    await page.goto(`${PREVIEW}?${query(step.fixture)}`, {waitUntil: 'networkidle'});
    await page.waitForTimeout(1400);

    for (const target of step.targets) {
      checked += 1;
      const probe = await page.evaluate(PROBE, {testid: target.testid, kind: target.kind});
      const where = `${style.id} · الخطوة ${step.n} · ${target.testid}`;
      if (!probe.found) {
        failures.push(`${where}: control NOT FOUND`);
        continue;
      }
      if (target.kind === 'option' || target.kind === 'switch') {
        const want = target.expect === 'selected' || target.expect === 'on';
        if (probe.selected !== want) {
          failures.push(`${where}: expected ${target.expect}, state is ${probe.selected}`);
        }
      } else if (target.kind === 'contains' || target.kind === 'not-contains') {
        const has = (probe.text ?? '').includes(target.expect);
        if (target.kind === 'contains' ? !has : has) {
          failures.push(`${where}: ${target.kind} "${target.expect}" failed`);
        }
      } else {
        const actual = (probe.value ?? '').replace(/‏|‎/g, '').trim();
        if (actual !== target.expect) {
          failures.push(`${where}: expected "${target.expect}", control holds "${actual}"`);
        }
      }
    }
    await page.close();
  }
}
await browser.close();

console.log(`state-aware checks: ${checked}`);
if (failures.length === 0) {
  console.log('ALL CONTROLS HOLD THE VALUE THEIR GUIDE RECOMMENDS');
} else {
  console.log(`FAILURES (${failures.length}):`);
  for (const f of failures) console.log(' -', f);
  process.exitCode = 1;
}
