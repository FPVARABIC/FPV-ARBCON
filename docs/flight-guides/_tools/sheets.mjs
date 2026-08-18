/**
 * Builds one contact sheet per style, from the spec and the final images.
 *
 * ONE SHEET PER CORNER, and it lives inside that corner: the sheet for a
 * style sits next to the pictures it shows, in `<style>/review/`. There is
 * no combined sheet and no shared review folder, because a reviewer looking
 * at one corner must never be shown another corner's numbers.
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
import {STYLES, IMAGE_ROOT, DECISIONS, reviewDir} from './guide-spec.mjs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FONTS = {
  arabic: 'src/web/fonts/cairo-arabic.woff2',
  latin: 'src/web/fonts/cairo-latin.woff2',
};

const dataUri = (path, mime) => `data:${mime};base64,${readFileSync(path).toString('base64')}`;

/** PNG IHDR: width and height are the two big-endian words at byte 16. */
function pngSize(path) {
  const head = readFileSync(path).subarray(16, 24);
  return {w: head.readUInt32BE(0), h: head.readUInt32BE(4)};
}
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

/** The verdict table, so one sheet answers "did you forget anything?". */
const LABEL = {
  STEP: 'خطوة',
  ACTION: 'إجراء',
  PILOT_PREFERENCE: 'تفضيل الطيار',
  KEEP_DEFAULT: 'اتركه كما هو',
  NOT_APPLICABLE: 'لا ينطبق',
};
const TONE = {
  STEP: 'step', ACTION: 'act', PILOT_PREFERENCE: 'pref',
  KEEP_DEFAULT: 'keep', NOT_APPLICABLE: 'na',
};

const browser = await chromium.launch({executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none']});
const made = [];

for (const style of STYLES) {
  const cards = style.steps.map(step => {
    const file = `${IMAGE_ROOT}/${style.id}/images/${step.n}-${step.shot}.png`;
    const values = expectedLine(step);
    const sources = [...new Set(step.targets.map(t => t.source).filter(s => s && s !== 'C'))].join(' · ');
    // A whole-screen capture is many times taller than a card. Shrinking
    // it into a card-sized box makes the very values the caption promises
    // unreadable, so tall captures get a wider, taller frame - and every
    // caption states the real pixel size, so a reviewer knows when to
    // open the file itself.
    const size = pngSize(file);
    const tall = size.h / size.w > 3;
    return `
    <figure class="${tall ? 'tall' : ''}">
      <img src="${dataUri(file, 'image/png')}" alt="">
      <figcaption>
        <b class="step">الخطوة ${step.n} — ${label(step.titleAr)}</b>
        <span class="screen">${label(step.screen)}</span>
        ${values ? `<span class="values">الموصى به: ${label(values)}</span>` : ''}
        ${sources ? `<span class="src">${label(sources)}</span>` : ''}
        <code>${escape(`${style.id}/images/${step.n}-${step.shot}.png`)} · ${size.w}×${size.h}</code>
      </figcaption>
    </figure>`;
  }).join('');

  const decisions = DECISIONS[style.id] ?? [];
  const verdicts = decisions.map(d => `
    <tr><td>${label(d.what)}</td>
        <td><span class="tag ${TONE[d.kind]}">${LABEL[d.kind]}</span></td>
        <td class="detail">${label(d.detail)}</td></tr>`).join('');

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
    figure.tall{width:404px}
    figure.tall img{max-height:2400px}
    figcaption{padding:14px 16px 16px}
    .step{display:block;font-size:16px;font-weight:700;color:var(--accent);margin-bottom:3px}
    .screen{display:block;font-size:14px;color:var(--ink)}
    .values{display:block;margin-top:7px;font-size:14px;font-weight:700}
    .src{display:block;margin-top:3px;font-size:12.5px;color:var(--muted)}
    code{display:block;margin-top:9px;font-size:11.5px;color:var(--muted);
         direction:ltr;text-align:left;font-family:Cairo,ui-monospace,monospace}
    h2{font-size:20px;font-weight:700;margin:38px 0 4px}
    .h2sub{margin:0 0 14px;color:var(--muted);font-size:13.5px}
    table{border-collapse:collapse;width:100%;max-width:1040px;background:#fff;
          border:1px solid var(--line);border-radius:14px;overflow:hidden}
    td{padding:10px 14px;border-top:1px solid #efe9dc;font-size:13.5px;vertical-align:top}
    tr:first-child td{border-top:0}
    td:first-child{font-weight:700;width:23%}
    .detail{color:#33403f}
    .tag{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12.5px;
         font-weight:700;white-space:nowrap}
    .tag.step{background:#dff0ee;color:#0f6b6b}
    .tag.act{background:#e3ecf7;color:#245080}
    .tag.pref{background:#f6ecd8;color:#7a5714}
    .tag.keep{background:#e8eae4;color:#4a544a}
    .tag.na{background:#f0e6e6;color:#7a3b3b}
  </style>
  <h1>${label(style.titleAr)}</h1>
  <p class="sub">${style.steps.length} خطوة · ورقة مراجعة هذا الركن وحده · لقطات من البناء الحالي</p>
  <p class="note">القيم الظاهرة داخل كل صورة هي القيم التي يوصي بها هذا الدليل — مفحوصة على حالة عنصر التحكم نفسه، لا على وجود النص.</p>
  <div class="grid">${cards}</div>
  ${verdicts === '' ? '' : `
  <h2>بقية الإعدادات — قرار لكل واحد</h2>
  <p class="h2sub">ما لا تغيّره الخطوات أعلاه، وقرارُه في هذا النمط تحديدًا.</p>
  <table>${verdicts}</table>`}
  </html>`;

  const page = await browser.newPage({viewport: {width: 1120, height: 900}, deviceScaleFactor: 2});
  await page.setContent(html, {waitUntil: 'load'});
  await page.waitForTimeout(700);
  const dir = reviewDir(style.id);
  mkdirSync(dir, {recursive: true});
  const file = `${dir}/contact-sheet.png`;
  await page.screenshot({path: file, fullPage: true});
  made.push({style: style.id, steps: style.steps.length, verdicts: decisions.length, file});
  await page.close();
}
await browser.close();
for (const m of made) {
  console.log(`${m.style.padEnd(12)} ${m.steps} خطوة · ${m.verdicts} قرار  ${m.file}`);
}
console.log(`\n${made.length} contact sheets, one per corner`);
