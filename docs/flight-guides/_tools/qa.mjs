/**
 * The package's own QA gate. Structural checks AND meaning checks.
 *
 * Structural alone is what let the earlier rounds pass with a number that
 * was wrong and a picture that argued with its caption, so this also
 * cross-checks the spec against what is actually on disk and in the text.
 *
 * Usage: node docs/flight-guides/_tools/qa.mjs
 * (state-aware control checks live in validate.mjs and need the preview)
 */
import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {STYLES, IMAGE_ROOT, REVIEW_DIR} from './guide-spec.mjs';
import path from 'node:path';

const problems = [];
const note = m => problems.push(m);

/* ---------------------------------------------------- images and links */

const walk = dir => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const all = walk(IMAGE_ROOT);
const markdown = all.filter(f => f.endsWith('.md'));
const guideImages = all.filter(f => f.endsWith('.png') && !f.includes('_shared/review'));
const sheets = all.filter(f => f.includes('_shared/review') && f.endsWith('.png'));

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
  if (!existsSync(`${REVIEW_DIR}/contact-${style.id}.png`)) note(`MISSING CONTACT SHEET for ${style.id}`);
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

/* ------------------------------------------------------------- report */

console.log(`markdown ${markdown.length} · guide images ${guideImages.length} · contact sheets ${sheets.length}`);
console.log(`steps ${STYLES.reduce((n, s) => n + s.steps.length, 0)} · source ids used ${used.size}`);
console.log('');
if (problems.length === 0) {
  console.log('GUIDE QA: NO PROBLEMS FOUND');
} else {
  console.log(`GUIDE QA: ${problems.length} PROBLEM(S)`);
  for (const p of problems) console.log(' -', p);
  process.exitCode = 1;
}
