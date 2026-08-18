/**
 * Builds one contact sheet per style, from the spec and the final images.
 *
 * Regenerated from scratch every run - never hand-edited - so a sheet
 * cannot outlive the screenshots it shows.
 *
 * TYPOGRAPHY. Cairo, embedded as a data URI so the sheet renders the same
 * everywhere and never silently falls back. One scale, four roles:
 * style title / step title / body / filename.
 *
 * BIDI. Arabic captions carry Latin technical terms (DShot300, GPS Rescue,
 * Feedforward). Left bare in an RTL paragraph the Arabic conjunction lands
 * visually to the LEFT of the Latin word and reads as a suffix - the
 * "gTelemetry" effect. Every Latin run is therefore wrapped in an isolate
 * so it is laid out as one unit.
 *
 * Usage: node docs/flight-guides/_tools/sheets.mjs
 */
import {chromium} from 'playwright-core';
import {readFileSync, mkdirSync, existsSync} from 'node:fs';
import {STYLES, IMAGE_ROOT, REVIEW_DIR} from './guide-spec.mjs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FONTS = {
  arabic: 'src/web/fonts/cairo-arabic.woff2',
  latin: 'src/web/fonts/cairo-latin.woff2',
};

const dataUri = (path, mime) => `data:${mime};base64,${readFileSync(path).toString('base64')}`;
const fontFace = (path, range) => existsSync(path)
  ? `@font-face{font-family:Cairo;font-style:normal;font-weight:400 700;font-display:block;src:url(${dataUri(path, 'font/woff2')}) format('woff2');unicode-range:${range}}`
  : '';

const CAIRO =
  fontFace(FONTS.arabic, 'U+0600-06FF,U+0750-077F,U+0870-088E,U+FB50-FDFF,U+FE70-FEFF') +
  fontFace(FONTS.latin, 'U+0000-00FF,U+0131,U+2000-206F,U+2212');

/** U+2066 LRI ... U+2069 PDI around every Latin run. */
const isolate = text => String(text).replace(
  /[A-Za-z][A-Za-z0-9_.+/'"-]*(?:\s+[A-Za-z0-9][A-Za-z0-9_.+/'"-]*)*/g,
  run => `⁦${run}⁩`,
);
const escape = text => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const label = text => escape(isolate(text));

/** The values this step's picture must be showing, for the caption. */
function expectedLine(step) {
  const shown = step.targets
    .filter(t => t.kind === 'stepper' || t.kind === 'input')
    .map(t => t.expect);
  const options = step.targets.filter(t => t.kind === 'option' && t.expect === 'selected').length;
  const switches = step.targets.filter(t => t.kind === 'switch' && t.expect === 'on').length;
  const extra = [];
  if (options > 0) extra.push(`${options} خيار محدَّد`);
  if (switches > 0) extra.push(`${switches} مفتاح مفعّل`);
  return [...shown, ...extra].join(' · ');
}

mkdirSync(REVIEW_DIR, {recursive: true});
const browser = await chromium.launch({executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none']});
const made = [];

for (const style of STYLES) {
  const cards = style.steps.map(step => {
    const file = `${IMAGE_ROOT}/${style.id}/images/${step.n}-${step.shot}.png`;
    const values = expectedLine(step);
    const sources = [...new Set(step.targets.map(t => t.source).filter(s => s && s !== 'C'))].join(' · ');
    return `
    <figure>
      <img src="${dataUri(file, 'image/png')}" alt="">
      <figcaption>
        <b class="step">الخطوة ${step.n} — ${label(step.titleAr)}</b>
        <span class="screen">${label(step.screen)}</span>
        ${values ? `<span class="values">الموصى به: ${label(values)}</span>` : ''}
        ${sources ? `<span class="src">${label(sources)}</span>` : ''}
        <code>${escape(`${style.id}/images/${step.n}-${step.shot}.png`)}</code>
      </figcaption>
    </figure>`;
  }).join('');

  const html = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><style>
    ${CAIRO}
    :root{--ink:#12211f;--muted:#5d706e;--line:#ddd6c8;--accent:#0f6b6b;--paper:#faf8f3}
    *{box-sizing:border-box}
    body{margin:0;padding:34px 30px 40px;background:var(--paper);color:var(--ink);
         font-family:Cairo,system-ui,'Segoe UI',Tahoma,sans-serif;font-size:15px;line-height:1.7}
    h1{font-size:30px;font-weight:700;margin:0 0 2px;letter-spacing:-.2px}
    .sub{margin:0 0 6px;color:var(--muted);font-size:14px}
    .note{margin:0 0 26px;color:var(--accent);font-size:13px;font-weight:600}
    .grid{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
    figure{margin:0;width:326px;background:#fff;border:1px solid var(--line);
           border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    /* contain, not cover: a cropped thumbnail hides the very number the
       caption promises. Tall cards scale down and stay complete. */
    img{display:block;width:100%;height:auto;max-height:1000px;object-fit:contain;
        object-position:top center;background:#fff;border-bottom:1px solid #efe9dc}
    figcaption{padding:14px 16px 16px}
    .step{display:block;font-size:16px;font-weight:700;color:var(--accent);margin-bottom:3px}
    .screen{display:block;font-size:14px;color:var(--ink)}
    .values{display:block;margin-top:7px;font-size:14px;font-weight:700}
    .src{display:block;margin-top:3px;font-size:12.5px;color:var(--muted)}
    code{display:block;margin-top:9px;font-size:11.5px;color:var(--muted);
         direction:ltr;text-align:left;font-family:Cairo,ui-monospace,monospace}
  </style>
  <h1>${label(style.titleAr)}</h1>
  <p class="sub">${style.steps.length} خطوة · ورقة مراجعة · لقطات من البناء الحالي</p>
  <p class="note">القيم الظاهرة داخل كل صورة هي القيم التي يوصي بها هذا الدليل — مفحوصة على حالة عنصر التحكم نفسه، لا على وجود النص.</p>
  <div class="grid">${cards}</div></html>`;

  const page = await browser.newPage({viewport: {width: 1120, height: 900}, deviceScaleFactor: 2});
  await page.setContent(html, {waitUntil: 'load'});
  await page.waitForTimeout(700);
  const file = `${REVIEW_DIR}/contact-${style.id}.png`;
  await page.screenshot({path: file, fullPage: true});
  made.push({style: style.id, steps: style.steps.length, file});
  await page.close();
}
await browser.close();
for (const m of made) console.log(`${m.style.padEnd(12)} ${m.steps} خطوة  ${m.file}`);
console.log(`\n${made.length} contact sheets`);
