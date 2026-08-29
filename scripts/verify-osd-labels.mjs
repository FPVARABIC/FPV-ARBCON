/**
 * WIDER MUST NOT MEAN LESS READABLE — the OSD element labels, measured
 * in a real browser.
 *
 * The defect this exists to prevent: the element grid wraps chips that
 * declare `flexGrow: 1` over a flex BASIS, and `flexGrow` only shares
 * out leftover space. So the more columns fit, the closer every chip
 * sits to that basis — and a basis smaller than the widest real label
 * makes a WIDER window produce NARROWER chips and newly ellipsized
 * Arabic labels. Measured at the shipped widths with the old 180 basis:
 * 0 truncated at 768, 4 at 1024, 10 at 1366, 10 at 1920.
 *
 * WHAT COUNTS AS TRUNCATION HERE. Not the presence of `numberOfLines`,
 * not `overflow: hidden`, not `text-overflow: ellipsis` — those are
 * present by design and say nothing about whether any glyph was
 * actually lost. A label is truncated when its OWN INTRINSIC width,
 * measured by laying the same text out with every width constraint
 * released, exceeds the width it was actually given; or when a
 * non-scrollable ancestor clips it. A label inside a legitimately
 * scrollable region is not truncated, because scrolling reveals it.
 *
 * Run: npm run verify:osd-labels
 * Exits non-zero naming the label and the transition that broke it.
 */
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** RTL is the product's primary direction; LTR is checked for parity. */
const WIDTHS = [390, 430, 768, 1024, 1366, 1920];
const LTR_WIDTHS = [768, 1024, 1366, 1920];

/** Mobile must keep the single-column density this phase did not touch. */
const MOBILE_SINGLE_COLUMN = [390, 430];

/**
 * THE ROOT-CAUSE ASSERTION, separate from the symptom.
 *
 * A wrapped flex line always satisfies `chip >= flexBasis`, so the
 * guarantee "every label fits at every width" reduces to one number
 * being large enough. This pins that number against the content it has
 * to hold, measured live: if a future edit lowers the basis, or a
 * longer element name is added, or the chip's fixed furniture grows,
 * this fails with the arithmetic rather than with a pixel diff.
 */
const CHIP_MUST_HOLD_LONGEST_LABEL = true;

const failures = [];
const notes = [];
const fail = message => failures.push(message);

const PROBE = () => {
  const chips = [...document.querySelectorAll('[data-testid^="osd-element-"]')].filter(
    el => /^osd-element-\d+$/.test(el.getAttribute('data-testid') ?? ''),
  );
  const grid = chips.length > 0 ? chips[0].parentElement : null;

  let columns = 0;
  if (chips.length > 0) {
    const firstTop = Math.round(chips[0].getBoundingClientRect().top);
    columns = chips.filter(
      c => Math.abs(Math.round(c.getBoundingClientRect().top) - firstTop) <= 2,
    ).length;
  }

  /** The nearest ancestor that constrains overflow, and how. */
  const clipperOf = el => {
    for (let n = el.parentElement; n !== null; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/auto|scroll/.test(s.overflowX)) return {mode: 'scrollable', node: n};
      if (s.overflowX === 'hidden') return {mode: 'hidden', node: n};
    }
    return {mode: 'none', node: null};
  };

  const labels = [];
  for (const chip of chips) {
    const id = chip.getAttribute('data-testid');
    const index = Number(id.replace('osd-element-', ''));
    const posEl = chip.querySelector(`[data-testid="osd-element-${index}-position"]`);
    if (posEl === null) continue;
    const labelEl = [...chip.querySelectorAll('div,span')].find(
      n =>
        n !== posEl &&
        !n.contains(posEl) &&
        n.children.length === 0 &&
        (n.innerText ?? '').trim().length > 0,
    );
    if (labelEl === undefined) continue;

    const chipRect = chip.getBoundingClientRect();
    const labelRect = labelEl.getBoundingClientRect();

    /* INTRINSIC WIDTH: the same text, laid out with nothing constraining
       it. This is the oracle - a clone rather than `scrollWidth`,
       because a flex item's scrollWidth can be rounded to its own
       border box and then reports no overflow for a clipped label. */
    const probe = labelEl.cloneNode(true);
    Object.assign(probe.style, {
      position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0',
      width: 'auto', maxWidth: 'none', minWidth: '0', flex: 'none',
      whiteSpace: 'nowrap', overflow: 'visible', textOverflow: 'clip',
    });
    document.body.appendChild(probe);
    const intrinsic = probe.getBoundingClientRect().width;
    document.body.removeChild(probe);

    const clip = clipperOf(labelEl);
    /* 1px of slack so sub-pixel text metrics never read as truncation. */
    const ownClipped = intrinsic > labelRect.width + 1;
    const ancestorClipped =
      clip.mode === 'hidden' && clip.node !== null
        ? (() => {
            const b = clip.node.getBoundingClientRect();
            /* `getBoundingClientRect` is in VISUAL pixels; `clientLeft`
               and `clientWidth` are in LAYOUT pixels. Under a zoomed
               page those differ, and mixing them made every label look
               clipped at 200%. Convert the layout values into the rect's
               own space before comparing. */
            const scale =
              clip.node.offsetWidth > 0 ? b.width / clip.node.offsetWidth : 1;
            const left = b.left + clip.node.clientLeft * scale;
            const right = left + clip.node.clientWidth * scale;
            return labelRect.left < left - 1 || labelRect.right > right + 1;
          })()
        : false;

    labels.push({
      index,
      testID: id,
      text: (labelEl.innerText ?? '').trim(),
      chipWidth: Math.round(chipRect.width * 100) / 100,
      visible: Math.round(labelRect.width * 100) / 100,
      intrinsic: Math.round(intrinsic * 100) / 100,
      overhead: Math.round((chipRect.width - labelRect.width) * 100) / 100,
      scrollable: clip.mode === 'scrollable',
      ownClipped,
      ancestorClipped,
      truncated: ownClipped || ancestorClipped,
    });
  }

  /* PHYSICAL PREVIEW GEOMETRY. Positions are expressed as a FRACTION of
     the canvas so that legitimately resizing the canvas in a responsive
     column reads as unchanged, while an element that actually moved -
     or that got mirrored because the page is RTL - does not. OSD
     coordinates are physical: left is left on the goggles regardless of
     the interface's reading direction. */
  const canvas = document.querySelector('[data-testid="osd-canvas"]');
  const cRect = canvas === null ? null : canvas.getBoundingClientRect();
  /* The canvas grid the screen itself reports, e.g. "53×20". */
  const gridText = (document.body.innerText ?? '').match(/(\d+)\s*×\s*(\d+)/);
  const canvasColumns = gridText === null ? null : Number(gridText[1]);
  const canvasRows = gridText === null ? null : Number(gridText[2]);
  const previewItems = [];
  if (cRect !== null && cRect.width > 0) {
    for (const el of document.querySelectorAll('[data-testid^="osd-canvas-item-"]')) {
      const id = el.getAttribute('data-testid');
      const index = Number(id.replace('osd-canvas-item-', ''));
      const posEl = document.querySelector(`[data-testid="osd-element-${index}-position"]`);
      const posText = posEl === null ? '' : (posEl.innerText ?? '').trim();
      const m = /^(\d+),(\d+)$/.exec(posText);
      const r = el.getBoundingClientRect();
      previewItems.push({
        id,
        index,
        fx: Math.round(((r.left - cRect.left) / cRect.width) * 1000) / 1000,
        fy: Math.round(((r.top - cRect.top) / cRect.height) * 1000) / 1000,
        /* What the element's OWN coordinates say its fraction should be.
           An absolute expectation, so a preview that mirrors or offsets
           uniformly is caught even though it would look self-consistent
           when RTL is only ever compared against LTR. */
        expectedFx:
          m === null || canvasColumns === null
            ? null
            : Math.round((Number(m[1]) / canvasColumns) * 1000) / 1000,
        expectedFy:
          m === null || canvasRows === null
            ? null
            : Math.round((Number(m[2]) / canvasRows) * 1000) / 1000,
      });
    }
  }

  /* Chip overlap: growing a responsive cell must not push cells on top
     of one another, which would make one control eat another's taps. */
  const overlaps = [];
  for (let i = 0; i < chips.length; i += 1) {
    for (let j = i + 1; j < chips.length; j += 1) {
      const a = chips[i].getBoundingClientRect();
      const b = chips[j].getBoundingClientRect();
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 1 && iy > 1)
        overlaps.push(
          `${chips[i].getAttribute('data-testid')} x ${chips[j].getAttribute('data-testid')}`,
        );
    }
  }

  /* The R-4 floor still holds on this screen after the reflow. */
  const SEL =
    '[role="button"],[role="tab"],[role="switch"],[role="radio"],[role="checkbox"],' +
    '[role="adjustable"],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
  const underFloor = [...document.querySelectorAll(SEL)]
    .map(el => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? '?',
        w: Math.round(r.width), h: Math.round(r.height),
      };
    })
    .filter(c => (c.w > 0 || c.h > 0) && (c.w < 44 || c.h < 44));

  const doc = document.documentElement;
  return {
    viewport: window.innerWidth,
    grid: grid === null ? null : Math.round(grid.getBoundingClientRect().width),
    columns,
    docOverflow: doc.scrollWidth - doc.clientWidth,
    labels,
    canvasAspect:
      cRect === null || cRect.height === 0
        ? null
        : Math.round((cRect.width / cRect.height) * 100) / 100,
    previewItems,
    overlaps: overlaps.slice(0, 6),
    underFloor: underFloor.slice(0, 6),
  };
};

function serve() {
  return spawn(
    'npx',
    ['vite', 'preview', '--config', 'e2e/touch-targets/vite.config.mts',
      '--port', String(PORT), '--strictPort'],
    {stdio: 'ignore'},
  );
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`fixture server never answered on ${BASE}`);
}

/** One direction's sweep, returning width -> probe result. */
async function sweep(browser, dir, widths) {
  const byWidth = {};
  for (const width of widths) {
    const ctx = await browser.newContext({
      viewport: {width, height: width <= 480 ? 844 : 900},
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}?dir=${dir}&s=osd`, {waitUntil: 'networkidle'});
    await page.waitForTimeout(600);
    const res = await page.evaluate(PROBE);
    if (res.labels.length === 0)
      fail(`${dir}@${width}: the OSD element list rendered no labels at all`);
    byWidth[width] = res;
    await ctx.close();
  }
  return byWidth;
}

/** The semantic contract, stated as a transition rather than a pixel. */
function judge(dir, byWidth, widths) {
  for (const width of widths) {
    const res = byWidth[width];
    if (res === undefined) continue;
    for (const label of res.labels)
      if (label.truncated)
        fail(
          `${dir}@${width}: ${label.testID} "${label.text}" is truncated ` +
            `(needs ${label.intrinsic}px, given ${label.visible}px)`,
        );
    if (res.docOverflow > 1)
      fail(`${dir}@${width}: the OSD page overflows horizontally by ${res.docOverflow}px`);
    for (const o of res.overlaps)
      fail(`${dir}@${width}: element chips overlap - ${o}`);
    for (const c of res.underFloor)
      fail(
        `${dir}@${width}: ${c.id} is ${c.w}x${c.h}, under the 44px touch floor`,
      );
  }

  /* Wider must not be worse. Reported as the transition that broke it,
     because "readable at 1024, truncated at 1366" is the defect, while
     a raw pixel delta is only ever a symptom. */
  for (let i = 0; i + 1 < widths.length; i += 1) {
    const narrow = widths[i];
    const wide = widths[i + 1];
    const A = byWidth[narrow];
    const B = byWidth[wide];
    if (A === undefined || B === undefined) continue;
    const before = new Map(A.labels.map(l => [l.index, l]));
    let newlyTruncated = 0;
    for (const after of B.labels) {
      const prior = before.get(after.index);
      if (prior === undefined) continue;
      if (!prior.truncated && after.truncated) {
        newlyTruncated += 1;
        fail(
          `${dir}: ${after.testID} "${after.text}" readable at ${narrow}, ` +
            `truncated at ${wide} ` +
            `(${narrow}: ${prior.visible}px visible / ${prior.intrinsic}px needed; ` +
            `${wide}: ${after.visible}px visible / ${after.intrinsic}px needed)`,
        );
      }
    }
    notes.push(
      `${dir} ${narrow}->${wide}: columns ${A.columns}->${B.columns}, ` +
        `chip ${A.labels[0]?.chipWidth}->${B.labels[0]?.chipWidth}, ` +
        `newly truncated ${newlyTruncated}`,
    );
  }
}

const server = serve();
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const rtl = await sweep(browser, 'rtl', WIDTHS);
  judge('rtl', rtl, WIDTHS);

  /* Mobile density is a freeze, not a target: this phase widened a
     desktop basis and must not have reflowed the phone. */
  for (const width of MOBILE_SINGLE_COLUMN) {
    const res = rtl[width];
    if (res !== undefined && res.columns !== 1)
      fail(
        `rtl@${width}: the element grid is ${res.columns} columns; the phone ` +
          'layout is expected to stay one per row',
      );
  }

  /* THE ROOT CAUSE, pinned against live content rather than a constant
     copied into the test. */
  if (CHIP_MUST_HOLD_LONGEST_LABEL) {
    for (const width of WIDTHS) {
      const res = rtl[width];
      if (res === undefined || res.labels.length === 0) continue;
      const longest = Math.max(...res.labels.map(l => l.intrinsic));
      const overhead = Math.max(...res.labels.map(l => l.overhead));
      const narrowest = Math.min(...res.labels.map(l => l.chipWidth));
      if (narrowest + 0.5 < longest + overhead)
        fail(
          `rtl@${width}: the narrowest element chip is ${narrowest}px but the ` +
            `longest label needs ${longest}px plus ${overhead}px of chip ` +
            `furniture = ${Math.round((longest + overhead) * 100) / 100}px. ` +
            'The flex basis no longer covers the longest shipped label.',
        );
    }
  }

  const ltr = await sweep(browser, 'ltr', LTR_WIDTHS);
  judge('ltr', ltr, LTR_WIDTHS);

  /* THE PHYSICAL OSD PREVIEW IS NOT A READING DIRECTION.
     The interface flips for Arabic; the goggles do not. An element at
     the left of the OSD canvas is at the left in both directions, so
     the same element's fractional position must match across RTL and
     LTR at the same width. Mirroring would put "battery, bottom-left"
     on the operator's bottom-right in flight. */
  /* First, absolutely: every preview item sits where its OWN x,y says
     it should, as a fraction of the declared canvas grid. A preview
     that mirrored or shifted uniformly would still agree with itself
     under a direction-to-direction comparison, so the coordinates are
     checked against the numbers the screen reports for each element. */
  for (const width of WIDTHS) {
    const res = rtl[width];
    if (res === undefined) continue;
    for (const item of res.previewItems) {
      if (item.expectedFx === null || item.expectedFy === null) continue;
      if (Math.abs(item.fx - item.expectedFx) > 0.02)
        fail(
          `preview@${width}: ${item.id} is drawn at x-fraction ${item.fx} but its ` +
            `coordinates say ${item.expectedFx} - the preview no longer agrees ` +
            'with the element position it reports',
        );
      if (Math.abs(item.fy - item.expectedFy) > 0.02)
        fail(
          `preview@${width}: ${item.id} is drawn at y-fraction ${item.fy} but its ` +
            `coordinates say ${item.expectedFy}`,
        );
    }
  }

  for (const width of LTR_WIDTHS) {
    const a = rtl[width];
    const b = ltr[width];
    if (a === undefined || b === undefined) continue;
    if (a.canvasAspect !== b.canvasAspect)
      fail(
        `preview@${width}: canvas aspect differs by direction ` +
          `(rtl ${a.canvasAspect} vs ltr ${b.canvasAspect})`,
      );
    const byId = new Map(b.previewItems.map(i => [i.id, i]));
    for (const item of a.previewItems) {
      const other = byId.get(item.id);
      if (other === undefined) {
        fail(`preview@${width}: ${item.id} renders in RTL but not in LTR`);
        continue;
      }
      /* 0.01 of the canvas absorbs sub-pixel rounding, nothing more. */
      if (Math.abs(item.fx - other.fx) > 0.01 || Math.abs(item.fy - other.fy) > 0.01)
        fail(
          `preview@${width}: ${item.id} sits at (${item.fx}, ${item.fy}) in RTL but ` +
            `(${other.fx}, ${other.fy}) in LTR - physical OSD coordinates must not ` +
            'follow the interface reading direction',
        );
    }
  }

  /* 200% ZOOM.
   *
   * Emulated the way a browser actually zooms: at 200% a CSS pixel is
   * twice as large, so a `width`-pixel window presents HALF that many
   * CSS pixels and the app sees a genuinely narrower viewport. Setting
   * `body { zoom: 200% }` instead would scale the pixels while leaving
   * `window.innerWidth` at its unzoomed value, so the app would lay out
   * for a width it does not have - which measures the emulation, not
   * the product.
   *
   * WHAT IS ASSERTED HERE, and what is not. At 195 CSS pixels a long
   * Arabic label legitimately ellipsizes; demanding otherwise would be
   * inventing a requirement no layout can meet at that size. What must
   * never happen is text pushed OFF the viewport by a container that
   * cannot be scrolled, or the page gaining horizontal scroll: an
   * ellipsis is readable-with-effort, a clipped glyph is simply gone. */
  for (const width of [390, 768, 1366]) {
    const ctx = await browser.newContext({
      viewport: {width: Math.round(width / 2), height: 450},
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}?dir=rtl&s=osd`, {waitUntil: 'networkidle'});
    await page.waitForTimeout(500);
    const zoomed = await page.evaluate(PROBE);
    if (zoomed.docOverflow > 1)
      fail(
        `rtl@${width}@200%: the OSD page overflows horizontally by ${zoomed.docOverflow}px`,
      );
    if (zoomed.labels.length === 0)
      fail(`rtl@${width}@200%: the OSD element list rendered no labels`);
    for (const l of zoomed.labels.filter(l => l.ancestorClipped).slice(0, 4))
      fail(
        `rtl@${width}@200%: ${l.testID} "${l.text}" is clipped off-screen by a ` +
          'non-scrollable ancestor',
      );
    for (const o of zoomed.overlaps)
      fail(`rtl@${width}@200%: element chips overlap - ${o}`);
    notes.push(
      `rtl@${width}@200% (${Math.round(width / 2)} CSS px): columns=${zoomed.columns} ` +
        `labels=${zoomed.labels.length} ellipsized=${zoomed.labels.filter(l => l.ownClipped).length} ` +
        `clippedOffScreen=${zoomed.labels.filter(l => l.ancestorClipped).length} ` +
        `overflow=${zoomed.docOverflow}`,
    );
    await ctx.close();
  }
} finally {
  if (browser !== undefined) await browser.close();
  server.kill('SIGTERM');
}

for (const note of notes) console.log(`  ${note}`);

if (failures.length > 0) {
  console.error(`\nOSD LABEL READABILITY VIOLATIONS (${failures.length}):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `\nOK - every OSD element label is fully readable at ${WIDTHS.join('/')} RTL ` +
    `and ${LTR_WIDTHS.join('/')} LTR, no label becomes newly truncated as the ` +
    'viewport widens, the phone keeps one chip per row, and the chip basis still ' +
    'covers the longest shipped Arabic label.',
);
