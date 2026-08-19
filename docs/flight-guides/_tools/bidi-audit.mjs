/**
 * Reads the paint, not the source, to find bidi scrambling.
 *
 * Arabic sentences here carry Latin technical terms (DShot300, GPS Rescue,
 * Feedforward, Radio, Telemetry). Whether they READ correctly is a fact
 * about pixels, so this measures pixels: every text node containing both
 * scripts is split into runs, each run's rectangle is measured with a DOM
 * Range, and the visual order (top to bottom, RIGHT to LEFT) is compared
 * with the logical order.
 *
 * If the two agree, the sentence reads the way it was written. If they do
 * not, the reader sees the words in a different order than the author
 * wrote them - which is the defect, regardless of how the string looks in
 * the editor.
 *
 * Usage: node docs/flight-guides/_tools/bidi-audit.mjs
 * Requires the preview build served on PREVIEW (see guide-spec.mjs).
 */
import {chromium} from 'playwright-core';
import {STYLES, query, PREVIEW} from './guide-spec.mjs';
import {prepare} from './drive.mjs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SCAN = root => {
  const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
  const LATIN = /[A-Za-z]/;

  /**
   * Splits into DIRECTIONAL ISLANDS, not into words.
   *
   * "نظام GPS / GNSS" is two islands, not three tokens: inside a Latin
   * island the words are meant to run left to right, and splitting it
   * would report correct text as broken. Only the ORDER OF THE ISLANDS
   * is a bidi question, and only that is compared.
   */
  const islands = text => {
    const out = [];
    let start = 0;
    let kind = null;
    const kindOf = ch => (ARABIC.test(ch) ? 'ar' : LATIN.test(ch) ? 'la' : null);
    for (let i = 0; i < text.length; i += 1) {
      const k = kindOf(text[i]);
      if (k === null || k === kind) continue;
      if (kind !== null) out.push({kind, start, end: i});
      kind = k;
      start = out.length === 0 ? 0 : i;
    }
    if (kind !== null) out.push({kind, start, end: text.length});
    // Trim each island back to its own strong characters so neutral
    // padding never decides which side a rectangle starts on.
    return out.map(part => {
      let a = part.start;
      let b = part.end;
      while (a < b && kindOf(text[a]) === null) a += 1;
      while (b > a && kindOf(text[b - 1]) === null) b -= 1;
      return {...part, start: a, end: b};
    }).filter(part => part.end > part.start);
  };

  /**
   * The mirror-image defect. A measured value like "4.45 V", or a bound
   * like "1.00 V-5.00 V", carries no Arabic at all: it is left-to-right
   * engineering text. Painted inside a right-to-left box it splits into
   * runs that are then laid out right-to-left, so the unit crosses to the
   * far side of its number and a range loses its two ends. Such text must
   * DECLARE `writingDirection: 'ltr'` rather than rely on the browser
   * guessing from its first strong character.
   */
  const measured = (node, text) => {
    const tokens = [];
    for (const m of text.matchAll(/[A-Za-z]+|[0-9][0-9.,:]*/g)) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const box = range.getClientRects()[0];
      if (box === undefined) continue;
      tokens.push({run: m[0], left: box.left, y: Math.round(box.top)});
    }
    if (tokens.length < 2) return null;
    // Compare the SEQUENCE OF TEXT, not object identity: a label like
    // "25 · 25" holds two identical tokens, and swapping them changes
    // nothing a reader could see. Reporting that as a defect would be
    // reporting the comparator's own tie-break.
    const visual = [...tokens].sort((a, b) => a.y - b.y || a.left - b.left);
    const written = tokens.map(t => t.run).join(' ');
    const painted = visual.map(t => t.run).join(' ');
    return written === painted ? null : visual.map(t => t.run);
  };

  /**
   * A RANGE, wherever it is spelled across several nodes.
   *
   * `<Text>{min}-{max}</Text>` is not one string: JSX makes it three
   * children, and react-native-web renders three text nodes. Inside a
   * right-to-left box those three lay out right to left, so "0-200"
   * PAINTS as "200-0" - a bound that now reads backwards. No per-node
   * check can see it, because each node holds one number and one number
   * is never out of order. The two ends must therefore be measured
   * against each other across the whole element.
   */
  const ranges = element => {
    const text = element.textContent ?? '';
    if (!/\d\s*[\u2013\u2014-]\s*\d/.test(text)) return null;
    const fragments = [];
    const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const node = walk.currentNode;
      for (const m of (node.nodeValue ?? '').matchAll(/\d[\d.,]*/g)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const box = range.getClientRects()[0];
        if (box === undefined) continue;
        fragments.push({run: m[0], left: box.left, y: Math.round(box.top)});
      }
    }
    if (fragments.length < 2) return null;
    const visual = [...fragments].sort((a, b) => a.y - b.y || a.left - b.left);
    const written = fragments.map(f => f.run).join(' … ');
    const painted = visual.map(f => f.run).join(' … ');
    return written === painted ? null : {written, readsAs: painted};
  };

  const walker = document.createTreeWalker(root ?? document.body, NodeFilter.SHOW_TEXT);
  const rows = [];
  const ltrRows = [];
  const rangeRows = [];
  const seen = new Set();
  const seenRange = new Set();

  const scope = root ?? document.body;
  for (const element of scope.querySelectorAll('*')) {
    // Leaf containers only: an ancestor would re-report its child's range.
    if (element.querySelector('*') !== null) continue;
    const flipped = ranges(element);
    if (flipped === null) continue;
    const text = (element.textContent ?? '').trim().slice(0, 60);
    if (seenRange.has(text)) continue;
    seenRange.add(text);
    rangeRows.push({text, ...flipped});
  }

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue ?? '';
    if (seen.has(text)) continue;

    if (!ARABIC.test(text)) {
      // No Arabic at all: engineering text that must read left to right.
      // Digits ALONE count. A bound like "0-200" carries no Latin letter
      // at all, and inside a right-to-left box its two ends swap into
      // "200-0" - a range that now reads backwards. Requiring a letter
      // here is what hid exactly that defect the first time.
      if (!/[0-9]/.test(text)) continue;
      if (getComputedStyle(node.parentElement).direction !== 'rtl') continue;
      const scrambled = measured(node, text);
      if (scrambled !== null) {
        seen.add(text);
        ltrRows.push({text: text.trim().slice(0, 60), readsAs: scrambled.join(' ')});
      }
      continue;
    }
    if (!LATIN.test(text)) continue;
    if (text.trim().length < 12) continue;
    seen.add(text);

    const logical = [];
    for (const part of islands(text)) {
      const range = document.createRange();
      range.setStart(node, part.start);
      range.setEnd(node, part.end);
      // FIRST line fragment, never the union box. A wrapped island's
      // union spans the whole column, which would make every wrapped
      // sentence look out of order when nothing is wrong with it.
      const box = range.getClientRects()[0];
      if (box === undefined || (box.width === 0 && box.height === 0)) continue;
      logical.push({run: text.slice(part.start, part.end), right: box.right, y: Math.round(box.top)});
    }
    if (logical.length < 2) continue;

    // Visual order under a right-to-left reading: line by line, and
    // within a line from the right edge leftwards.
    const visual = [...logical].sort((a, b) => a.y - b.y || b.right - a.right);
    const same = visual.every((token, i) => token === logical[i]);
    if (!same) {
      rows.push({
        text: text.trim().slice(0, 90),
        direction: getComputedStyle(node.parentElement).direction,
        logicalOrder: logical.map(t => t.run),
        readsAs: visual.map(t => t.run),
      });
    }
  }
  return {rows, ltrRows, rangeRows};
};

/** The element this step's picture actually contains. */
async function pictureRoot(page, step) {
  if (step.card === null || step.card === undefined) return null;
  if (typeof step.card === 'string') return await page.$(`[data-testid="${step.card}"]`);
  return (await page.evaluateHandle(({needle, min}) => {
    const blocks = [...document.querySelectorAll('div')].filter(n =>
      (n.innerText || '').includes(needle) && n.querySelectorAll('[data-testid]').length >= min);
    return blocks.sort((a, b) => a.innerText.length - b.innerText.length)[0] ?? null;
  }, {needle: step.card.text, min: step.card.min ?? 3})).asElement();
}

const browser = await chromium.launch({executablePath: CHROME, args: ['--no-sandbox']});
const inPicture = new Map();
const onScreen = new Map();
const measuredText = new Map();
const flippedRanges = new Map();
const directions = new Map();

for (const style of STYLES) {
  for (const step of style.steps) {
    const page = await browser.newPage({viewport: {width: 390, height: 4000}, locale: 'ar'});
    await page.goto(`${PREVIEW}?${query(step.fixture)}`, {waitUntil: 'networkidle'});
    await page.waitForTimeout(1200);
    await prepare(page, step.prepare);
    const where = `${style.id}/${step.n} · ${step.screen}`;

    const all = await page.evaluate(SCAN, null);
    for (const row of all.rows) {
      directions.set(row.direction, (directions.get(row.direction) ?? 0) + 1);
      if (!onScreen.has(row.text)) onScreen.set(row.text, {...row, where});
    }
    for (const row of all.ltrRows) {
      if (!measuredText.has(row.text)) measuredText.set(row.text, {...row, where});
    }
    for (const row of all.rangeRows) {
      if (!flippedRanges.has(row.text)) flippedRanges.set(row.text, {...row, where});
    }
    const root = await pictureRoot(page, step);
    const inside = await page.evaluate(SCAN, root);
    for (const row of inside.rows) {
      if (!inPicture.has(row.text)) inPicture.set(row.text, {...row, where});
    }
    await page.close();
  }
}
await browser.close();

const show = (title, map) => {
  console.log(`${title}: ${map.size}`);
  for (const row of map.values()) {
    console.log('');
    console.log(`  ${row.where}   [direction: ${row.direction}]`);
    console.log(`  text     ${row.text}`);
    console.log(`  written  ${row.logicalOrder.join(' | ')}`);
    console.log(`  reads as ${row.readsAs.join(' | ')}`);
  }
  console.log('');
};

console.log(`bidi scan over ${STYLES.reduce((n, s) => n + s.steps.length, 0)} screens`);
console.log(`computed direction of out-of-order nodes: ${[...directions].map(([d, n]) => `${d} ${n}`).join(' · ')}`);
console.log('');
if (onScreen.size === 0) {
  console.log('MIXED ARABIC/LATIN: every sentence reads in the order it was written');
} else {
  show('MIXED ARABIC/LATIN - INSIDE A PUBLISHED PICTURE', inPicture);
  show('MIXED ARABIC/LATIN - ELSEWHERE ON THE SAME SCREENS',
       new Map([...onScreen].filter(([t]) => !inPicture.has(t))));
  process.exitCode = 1;
}

console.log('');
if (flippedRanges.size === 0) {
  console.log('RANGES SPELLED ACROSS NODES: every bound still reads low to high');
} else {
  console.log(`RANGES READING BACKWARDS: ${flippedRanges.size}`);
  for (const row of flippedRanges.values()) {
    console.log('');
    console.log(`  ${row.where}`);
    console.log(`  text     ${row.text}`);
    console.log(`  written  ${row.written}`);
    console.log(`  reads as ${row.readsAs}`);
  }
  process.exitCode = 1;
}

console.log('');
if (measuredText.size === 0) {
  console.log('MEASURED VALUES AND RANGES: every one keeps its left-to-right order');
} else {
  console.log(`MEASURED VALUES AND RANGES REORDERED BY AN RTL BOX: ${measuredText.size}`);
  for (const row of measuredText.values()) {
    console.log('');
    console.log(`  ${row.where}`);
    console.log(`  text     ${row.text}`);
    console.log(`  reads as ${row.readsAs}`);
  }
  process.exitCode = 1;
}
