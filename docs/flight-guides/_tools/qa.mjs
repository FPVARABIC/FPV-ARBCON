/**
 * The package's own QA gate. Structural checks, meaning checks, AND the
 * per-style isolation checks.
 *
 * Structural alone is what let the earlier rounds pass with a number that
 * was wrong and a picture that argued with its caption, so this also
 * cross-checks the spec against what is actually on disk and in the text.
 *
 * ISOLATION (U1-U19 below) is the newer half. A corner is not finished
 * because its files exist; it is finished when a reader can open it and
 * follow it to the end WITHOUT opening another corner. Sharing code is
 * fine. Sharing guidance is not.
 *
 * Usage: node docs/flight-guides/_tools/qa.mjs
 * (state-aware control checks live in validate.mjs and need the preview)
 */
import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {STYLES, IMAGE_ROOT, DECISIONS, reviewDir} from './guide-spec.mjs';
import path from 'node:path';

const problems = [];
const note = m => problems.push(m);

const FLIGHT_STYLES = STYLES.filter(s => s.id !== 'firmware');
const KINDS = new Set(['STEP', 'ACTION', 'PILOT_PREFERENCE', 'KEEP_DEFAULT', 'NOT_APPLICABLE']);

/* ---------------------------------------------------- images and links */

const walk = dir => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const all = walk(IMAGE_ROOT);
const markdown = all.filter(f => f.endsWith('.md'));
const sheets = all.filter(f => /\/review\/contact-sheet\.png$/.test(f));
const guideImages = all.filter(f => f.endsWith('.png') && !sheets.includes(f));

const referenced = new Set();
for (const md of markdown) {
  const text = readFileSync(md, 'utf8');
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = path.resolve(path.dirname(md), m[1]);
    if (!existsSync(target)) note(`BROKEN IMAGE ${md}: ${m[1]}`);
    else referenced.add(path.relative('.', target));
  }
  for (const m of text.matchAll(/\[[^\]]*\]\((?!https?:)([^)#]+\.md)[^)]*\)/g)) {
    if (!existsSync(path.resolve(path.dirname(md), m[1]))) note(`BROKEN LINK ${md}: ${m[1]}`);
  }
  text.split('\n').forEach((line, i) => {
    if (/\bTODO\b|\bTBD\b|\bFIXME\b|XXX|LOREM|final2|new-final/.test(line)) note(`PLACEHOLDER ${md}:${i + 1}`);
  });
  for (const claim of ['FLIGHT VERIFIED', 'HARDWARE VERIFIED', 'RELEASE READY', 'flight tested', 'field verified', 'hardware safe', 'أفضل إعداد']) {
    for (const m of text.matchAll(new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
      const line = text.slice(0, m.index).split('\n').length;
      const ctx = text.split('\n')[line - 1];
      if (/ليست|لم |NOT |ولا|لا /.test(ctx)) continue;
      note(`FORBIDDEN CLAIM ${md}:${line}: ${ctx.trim().slice(0, 60)}`);
    }
  }
}
for (const img of guideImages) {
  if (!referenced.has(img)) note(`ORPHAN IMAGE: ${img}`);
}

/* ------------------------------------------- spec <-> disk <-> metadata */

for (const style of STYLES) {
  const dir = `${IMAGE_ROOT}/${style.id}/images`;
  const onDisk = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.png')) : [];
  const expected = style.steps.map(s => `${s.n}-${s.shot}.png`);
  for (const want of expected) if (!onDisk.includes(want)) note(`MISSING SHOT ${style.id}/${want}`);
  for (const have of onDisk) if (!expected.includes(have)) note(`STALE SHOT ${style.id}/${have}`);

  const numbers = style.steps.map(s => s.n);
  if (new Set(numbers).size !== numbers.length) note(`DUPLICATE STEP NUMBER in ${style.id}`);
  numbers.forEach((n, i) => {
    if (n !== i + 1) note(`STEP ORDER GAP in ${style.id}: step ${i + 1} is numbered ${n}`);
  });

  const meta = JSON.parse(readFileSync(`${IMAGE_ROOT}/${style.id}/guide.json`, 'utf8'));
  if (meta.step_count !== style.steps.length) note(`METADATA ${style.id}: step_count drift`);
  if ((meta.steps ?? []).length !== style.steps.length) note(`METADATA ${style.id}: steps array drift`);
  (meta.steps ?? []).forEach((s, i) => {
    const spec = style.steps[i];
    if (s.n !== spec.n || s.title_ar !== spec.titleAr) note(`METADATA ${style.id}: step ${i + 1} disagrees with spec`);
    if (!existsSync(`${IMAGE_ROOT}/${style.id}/${s.screenshot}`)) note(`METADATA ${style.id}: screenshot missing ${s.screenshot}`);
  });
  if (meta.hardware_verification_status !== 'NOT VERIFIED — DEFERRED') note(`METADATA ${style.id}: hardware status changed`);
  for (const field of ['id', 'title_ar', 'title_en', 'description_ar', 'difficulty',
                       'intended_aircraft', 'required_screens', 'optional_screens',
                       'hardware_requirements', 'hardware_verification_status']) {
    if (!(field in meta)) note(`METADATA ${style.id}: missing ${field}`);
  }
  for (const screen of [...(meta.required_screens ?? []), ...(meta.optional_screens ?? [])]) {
    if (!existsSync(`src/ui/screens/${screen}.tsx`)) note(`METADATA ${style.id}: not a real screen component: ${screen}`);
  }

  const guide = readFileSync(`${IMAGE_ROOT}/${style.id}/guide.md`, 'utf8');
  for (const step of style.steps) {
    if (!guide.includes(`### الخطوة ${step.n} — ${step.titleAr}`)) note(`GUIDE ${style.id}: step ${step.n} heading missing`);
    if (!guide.includes(`images/${step.n}-${step.shot}.png`)) note(`GUIDE ${style.id}: step ${step.n} image not referenced`);
  }
}

/* --------------------------------------------------------- source ids */

const sources = readFileSync(`${IMAGE_ROOT}/_meta/sources.md`, 'utf8');
const defined = new Set([...sources.matchAll(/\bS\d+(?:\.\d+[a-z]?)?\b/g)].map(m => m[0]));
const used = new Set();
for (const md of markdown) {
  if (md.endsWith('sources.md')) continue;
  for (const m of readFileSync(md, 'utf8').matchAll(/\bS\d+\.\d+[a-z]?\b/g)) used.add(m[0]);
}
for (const style of STYLES) {
  for (const step of style.steps) {
    for (const t of step.targets) if (t.source && t.source !== 'C') {
      for (const id of t.source.split(/[,·،]\s*|–/)) if (/^S\d/.test(id.trim())) used.add(id.trim());
    }
  }
}
for (const id of [...used].sort()) if (!defined.has(id)) note(`UNDEFINED SOURCE ID: ${id}`);

/* ----------------------------------------- every [A] row cites a source */

for (const md of markdown) {
  readFileSync(md, 'utf8').split('\n').forEach((line, i) => {
    if (!(line.startsWith('| ') && (line.match(/\|/g) ?? []).length >= 5)) return;
    if (line.includes('`[A]`') && !/`\[A\]`\s*\(S/.test(line)) note(`TYPE-A WITHOUT SOURCE ${md}:${i + 1}`);
  });
}

/* =====================================================================
 * ISOLATION - U1 .. U19
 * =====================================================================
 *
 * The distinction these checks encode, and it is the whole point:
 *
 *   NAMING another style as the ORIGIN of a number that is written out
 *   in full on the same line is provenance, and provenance is honesty.
 *
 *   SENDING the reader to another corner to obtain a value or finish a
 *   step is a dependency, and a dependency means this corner is not
 *   finished. Only the second is a failure.
 */

const isolation = [];
const u = (id, what, ok, detail = '') => {
  isolation.push({id, what, ok});
  if (!ok) note(`${id} ${what}${detail === '' ? '' : `: ${detail}`}`);
};

const guideOf = id => readFileSync(`${IMAGE_ROOT}/${id}/guide.md`, 'utf8');
const metaOf = id => JSON.parse(readFileSync(`${IMAGE_ROOT}/${id}/guide.json`, 'utf8'));

/* U1 - every style owns a guide. */
u('U1', 'each style has its own guide.md',
  STYLES.every(s => existsSync(`${IMAGE_ROOT}/${s.id}/guide.md`)));

/* U2 - every style owns machine-readable metadata. */
u('U2', 'each style has its own guide.json',
  STYLES.every(s => existsSync(`${IMAGE_ROOT}/${s.id}/guide.json`)));

/* U3 - every style owns its pictures. */
u('U3', 'each style has its own images/ folder',
  STYLES.every(s => existsSync(`${IMAGE_ROOT}/${s.id}/images`)));

/* U4 - every style owns its review sheet, inside its own corner. */
{
  const missing = STYLES.filter(s => !existsSync(`${reviewDir(s.id)}/contact-sheet.png`));
  u('U4', 'each style has its own review/contact-sheet.png',
    missing.length === 0, missing.map(s => s.id).join(', '));
}

/* U5 - no shared content folder survives anywhere in the package. */
{
  const shared = all.filter(f => /\/_shared\//.test(f) || /contact-shared/.test(f));
  u('U5', 'no _shared/ content and no combined sheet',
    shared.length === 0, shared.join(', '));
}

/* U6 - a guide only ever shows pictures from its own folder. */
{
  const bad = [];
  for (const s of STYLES) {
    for (const m of guideOf(s.id).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      if (!m[1].startsWith('images/')) bad.push(`${s.id} -> ${m[1]}`);
    }
  }
  u('U6', 'no guide shows a picture from another corner', bad.length === 0, bad.join(', '));
}

/* U7 - a guide never links into another style's folder. */
{
  const ids = STYLES.map(s => s.id);
  const bad = [];
  for (const s of STYLES) {
    for (const m of guideOf(s.id).matchAll(/\]\(([^)]+)\)/g)) {
      const href = m[1];
      if (ids.some(id => id !== s.id && (href.startsWith(`${id}/`) || href.includes(`/${id}/`)))) {
        bad.push(`${s.id} -> ${href}`);
      }
    }
  }
  u('U7', 'no guide links into another corner', bad.length === 0, bad.join(', '));
}

/* U8 - no guide defers a value or a step to another corner. This is the
 * referral pattern the owner named: "ينطبق أيضاً على ..." and friends. */
{
  const REFERRAL = [
    /للتفاصيل\s*:?\s*دليل/, /انظر\s+دليل/, /راجع\s+دليل/, /راجع\s+ركن/, /افتح\s+دليل\s+\*\*/,
    /ينطبق\s+أيضًا\s+على/, /ينطبق\s+أيضاً\s+على/, /كما\s+في\s+دليل/, /مثل\s+دليل/,
    /استعمل\s+ضبط\s+ال/, /نفس\s+خطوات\s+دليل/, /see\s+the\s+\w+\s+guide/i,
  ];
  const bad = [];
  for (const s of STYLES) {
    guideOf(s.id).split('\n').forEach((line, i) => {
      if (REFERRAL.some(rx => rx.test(line))) bad.push(`${s.id}/guide.md:${i + 1}`);
    });
  }
  u('U8', 'no guide sends the reader to another corner', bad.length === 0, bad.join(', '));
}

/* U9 - steps run 1..N with no gap, per style, in the file itself. */
{
  const bad = [];
  for (const s of STYLES) {
    const found = [...guideOf(s.id).matchAll(/^### الخطوة (\d+) — /gm)].map(m => Number(m[1]));
    if (found.join(',') !== s.steps.map(x => x.n).join(',')) bad.push(s.id);
  }
  u('U9', 'each guide numbers its own steps 1..N', bad.length === 0, bad.join(', '));
}

/* U10 - every step in every corner carries a picture. */
{
  const bad = STYLES.flatMap(s => s.steps
    .filter(step => !existsSync(`${IMAGE_ROOT}/${s.id}/images/${step.n}-${step.shot}.png`))
    .map(step => `${s.id}/${step.n}`));
  u('U10', 'every step has its picture on disk', bad.length === 0, bad.join(', '));
}

/* U11 - and no picture belongs to a step that no longer exists. */
{
  const bad = [];
  for (const s of STYLES) {
    const dir = `${IMAGE_ROOT}/${s.id}/images`;
    const want = new Set(s.steps.map(step => `${step.n}-${step.shot}.png`));
    for (const f of (existsSync(dir) ? readdirSync(dir) : [])) if (!want.has(f)) bad.push(`${s.id}/${f}`);
  }
  u('U11', 'no stale picture in any corner', bad.length === 0, bad.join(', '));
}

/* U12 - every picture in the package is owned by exactly one style. */
{
  const owners = new Map();
  for (const img of guideImages) {
    const owner = STYLES.find(s => img.startsWith(`${IMAGE_ROOT}/${s.id}/`));
    if (owner === undefined) owners.set(img, null);
  }
  u('U12', 'every picture has exactly one owning style',
    owners.size === 0, [...owners.keys()].join(', '));
}

/* U13 - every style states a verdict for what its steps do not change. */
{
  const bad = STYLES.filter(s => (DECISIONS[s.id] ?? []).length === 0).map(s => s.id);
  u('U13', 'every style carries its own decision list', bad.length === 0, bad.join(', '));
}

/* U14 - and every verdict is one of the five, not free text. */
{
  const bad = STYLES.flatMap(s => (DECISIONS[s.id] ?? [])
    .filter(d => !KINDS.has(d.kind)).map(d => `${s.id}: ${d.kind}`));
  u('U14', 'every decision uses one of the five classifications', bad.length === 0, bad.join(', '));
}

/* U15 - the verdicts a reader sees match the verdicts a machine reads. */
{
  const bad = [];
  for (const s of STYLES) {
    const decisions = DECISIONS[s.id] ?? [];
    const md = guideOf(s.id);
    const json = metaOf(s.id).decisions ?? [];
    if (json.length !== decisions.length) bad.push(`${s.id} json count`);
    for (const d of decisions) if (!md.includes(`| ${d.what} |`)) bad.push(`${s.id}: "${d.what}" missing from guide.md`);
    for (const d of decisions) {
      if (!json.some(j => j.requirement === d.what && j.decision === d.kind)) {
        bad.push(`${s.id}: "${d.what}" missing or disagreeing in guide.json`);
      }
    }
  }
  u('U15', 'decisions agree between guide.md and guide.json', bad.length === 0, bad.join(' · '));
}

/* U16 - the three that must never silently vanish from a flight style:
 * Rates, PID, and the filters each get an explicit verdict. */
{
  const NEEDED = [
    {label: 'Rates', rx: /rates/i},
    {label: 'PID', rx: /\bPID\b/},
    {label: 'الفلاتر', rx: /الفلاتر|Notch|LPF/},
  ];
  const bad = [];
  for (const s of FLIGHT_STYLES) {
    const covered = [...(DECISIONS[s.id] ?? []).map(d => d.what), ...s.steps.map(x => x.titleAr)];
    for (const need of NEEDED) {
      if (!covered.some(what => need.rx.test(what))) bad.push(`${s.id}: ${need.label}`);
    }
  }
  u('U16', 'Rates · PID · filters each have a verdict in every flight style',
    bad.length === 0, bad.join(', '));
}

/* U17 - no picture goes unchecked: every step declares state to verify. */
{
  const bad = STYLES.flatMap(s => s.steps.filter(step => step.targets.length === 0)
    .map(step => `${s.id}/${step.n}`));
  u('U17', 'every step declares at least one state-aware check', bad.length === 0, bad.join(', '));
}

/* U18 - a corner's review sheet is never older than its own pictures. */
{
  const stale = [];
  for (const s of STYLES) {
    const sheet = `${reviewDir(s.id)}/contact-sheet.png`;
    if (!existsSync(sheet)) continue;
    const sheetTime = statSync(sheet).mtimeMs;
    const dir = `${IMAGE_ROOT}/${s.id}/images`;
    for (const f of (existsSync(dir) ? readdirSync(dir) : [])) {
      if (statSync(path.join(dir, f)).mtimeMs > sheetTime + 1000) stale.push(`${s.id}/${f}`);
    }
  }
  u('U18', 'every review sheet is newer than the pictures it shows', stale.length === 0, stale.join(', '));
}

/* U19 - the isolation test in one line: a corner opened alone still has
 * a start, an end, a verdict for the rest, and a sheet of its own. */
{
  const bad = [];
  for (const s of STYLES) {
    const md = guideOf(s.id);
    const complete = md.includes('### الخطوة 1 — ')
      && md.includes(`### الخطوة ${s.steps.length} — `)
      && md.includes('## بقية الإعدادات — قرار لكل واحد')
      && existsSync(`${reviewDir(s.id)}/contact-sheet.png`);
    if (!complete) bad.push(s.id);
  }
  u('U19', 'every corner is followable start to finish on its own',
    bad.length === 0, bad.join(', '));
}

/* ------------------------------------------------------------- report */

console.log(`markdown ${markdown.length} · guide images ${guideImages.length} · contact sheets ${sheets.length}`);
console.log(`steps ${STYLES.reduce((n, s) => n + s.steps.length, 0)} · source ids used ${used.size} · decisions ${STYLES.reduce((n, s) => n + (DECISIONS[s.id] ?? []).length, 0)}`);
console.log('');
for (const check of isolation) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.id}  ${check.what}`);
console.log('');
if (problems.length === 0) {
  console.log(`GUIDE QA: NO PROBLEMS FOUND (${isolation.length}/${isolation.length} isolation checks pass)`);
} else {
  console.log(`GUIDE QA: ${problems.length} PROBLEM(S)`);
  for (const p of problems) console.log(' -', p);
  process.exitCode = 1;
}
