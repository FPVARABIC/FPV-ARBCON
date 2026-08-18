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

  const walker = document.createTreeWalker(root ?? document.body, NodeFilter.SHOW_TEXT);
  const rows = [];
  const seen = new Set();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue ?? '';
    if (!ARABIC.test(text) || !LATIN.test(text)) continue;
    if (text.trim().length < 12) continue;
    if (seen.has(text)) continue;
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
  return rows;
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
const directions = new Map();

for (const style of STYLES) {
  for (const step of style.steps) {
    const page = await browser.newPage({viewport: {width: 390, height: 4000}, locale: 'ar'});
    await page.goto(`${PREVIEW}?${query(step.fixture)}`, {waitUntil: 'networkidle'});
    await page.waitForTimeout(1200);
    await prepare(page, step.prepare);
    const where = `${style.id}/${step.n} · ${step.screen}`;

    for (const row of await page.evaluate(SCAN, null)) {
      directions.set(row.direction, (directions.get(row.direction) ?? 0) + 1);
      if (!onScreen.has(row.text)) onScreen.set(row.text, {...row, where});
    }
    const root = await pictureRoot(page, step);
    for (const row of await page.evaluate(SCAN, root)) {
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
  console.log('EVERY MIXED-SCRIPT SENTENCE READS IN THE ORDER IT WAS WRITTEN');
} else {
  show('INSIDE A PUBLISHED PICTURE', inPicture);
  show('ELSEWHERE ON THE SAME SCREENS', new Map([...onScreen].filter(([t]) => !inPicture.has(t))));
  process.exitCode = 1;
}
