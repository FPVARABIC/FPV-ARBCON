/**
 * Takes every guide screenshot, driven entirely by guide-spec.mjs.
 *
 * Each style owns its pictures: docs/flight-guides/<style>/images/. Two
 * styles that recommend different values get different files even for the
 * same screen, which is the point - a Racing page must not illustrate
 * itself with a Freestyle capture.
 *
 * A react-native-web ScrollView is a fixed-height scrolling box, so a
 * `fullPage` capture of it returns exactly one screenful. The viewport is
 * therefore grown to the scroller's own scrollHeight first; that is why
 * the output heights differ per screen instead of all being identical.
 *
 * Some states are reachable only by using the app: choosing a board from
 * its picker, moving to the second stage, arming a safety switch. A step
 * may therefore declare `prepare: [{click: 'testid'}, ...]`, which drives
 * the real controls. Nothing is injected that a user could not produce.
 *
 * Usage: node docs/flight-guides/_tools/capture.mjs
 */
import {chromium} from 'playwright-core';
import {mkdirSync, rmSync} from 'node:fs';
import {STYLES, query, PREVIEW, IMAGE_ROOT} from './guide-spec.mjs';
import {prepare} from './drive.mjs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--font-render-hinting=none'],
});

const report = [];
for (const style of STYLES) {
  const dir = `${IMAGE_ROOT}/${style.id}/images`;
  // Rebuilt from scratch every run, so a renamed or dropped step can
  // never leave a stale picture behind.
  rmSync(dir, {recursive: true, force: true});
  mkdirSync(dir, {recursive: true});

  for (const step of style.steps) {
    const context = await browser.newContext({
      viewport: {width: 390, height: 900}, deviceScaleFactor: 2, locale: 'ar',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${PREVIEW}?${query(step.fixture)}`, {waitUntil: 'networkidle'});
    await page.waitForTimeout(1500);
    try {
      await prepare(page, step.prepare);
    } catch (error) {
      report.push({style: style.id, step: step.n, file: `${dir}/${step.n}-${step.shot}.png`,
                   error: `prepare failed: ${String(error).split('\n')[0]}`});
      await context.close();
      continue;
    }

    const file = `${dir}/${step.n}-${step.shot}.png`;
    let size;

    if (step.card === null || step.card === undefined) {
      const height = await page.evaluate(() => {
        const scroller = [...document.querySelectorAll('div')]
          .find(n => n.scrollHeight > n.clientHeight + 8 && n.clientHeight > 200);
        return scroller === undefined ? document.body.scrollHeight : scroller.scrollHeight + 24;
      });
      await page.setViewportSize({width: 390, height: Math.min(Math.max(Math.ceil(height), 900), 8000)});
      await page.waitForTimeout(500);
      await page.screenshot({path: file, fullPage: true});
      size = {w: 390, h: height};
    } else {
      await page.setViewportSize({width: 390, height: 4000});
      await page.waitForTimeout(400);
      const handle = typeof step.card === 'string'
        ? await page.$(`[data-testid="${step.card}"]`)
        : (await page.evaluateHandle(({needle, min}) => {
            const blocks = [...document.querySelectorAll('div')].filter(n =>
              (n.innerText || '').includes(needle) && n.querySelectorAll('[data-testid]').length >= min);
            return blocks.sort((a, b) => a.innerText.length - b.innerText.length)[0] ?? null;
          }, {needle: step.card.text, min: step.card.min ?? 3})).asElement();
      if (handle === null) {
        report.push({style: style.id, step: step.n, file, error: 'card not found'});
        await context.close();
        continue;
      }
      const box = await handle.boundingBox();
      await handle.screenshot({path: file});
      size = {w: Math.round(box.width), h: Math.round(box.height)};
    }

    report.push({style: style.id, step: step.n, shot: step.shot, file, ...size, errors: errors.length});
    await context.close();
  }
}
await browser.close();

const bad = report.filter(r => r.error !== undefined || (r.errors ?? 0) > 0);
for (const r of report) {
  console.log(`${(r.style + '/' + r.step).padEnd(20)} ${String(r.shot ?? '').padEnd(20)} ${r.w}x${r.h}${r.error ? '  ERROR: ' + r.error : ''}`);
}
console.log(`\n${report.length} screenshots, ${bad.length} problem(s)`);
if (bad.length > 0) process.exitCode = 1;
