#!/usr/bin/env node
/**
 * DOES THE APPLICATION USE THE MONITOR, OR SIT INSIDE IT?
 *
 * This gate exists because the defect it guards against is invisible to
 * every other kind of check. A cap of 2040 is a legal number, its unit
 * test passed, the screens rendered, nothing overflowed, no label was
 * truncated - and on a 3440x1440 ultrawide the operator saw an
 * application inside a page, with 596px of dead ground down each side.
 * The only oracle that can tell the difference is a RENDERED workspace
 * measured against a RENDERED viewport, so that is what this does.
 *
 * WHAT IT MEASURES, in Chromium, on the real shell (brand strip +
 * navigation rail + the real screen, `e2e/touch-targets/fixture.tsx`):
 *
 *   usableWorkspace  = the width the shell hands the screen, which is
 *                      the viewport minus the navigation rail. Taken
 *                      from the rendered rect of the shell's content
 *                      box, never computed from a constant.
 *   screenWorkspace  = the rendered width of the screen's own content
 *                      container - the box `useContentEnvelope` caps.
 *   utilization      = screenWorkspace / usableWorkspace
 *
 * AND WHY EACH OF THE OTHER ASSERTIONS IS HERE:
 *
 *   - NO OLD ISLAND. A screen must not land within a pixel or two of
 *     1600 or 2040 while the window is much wider. Utilization alone
 *     would catch that, but naming the two retired caps makes the
 *     failure say WHICH regression happened.
 *   - PROSE STAYS BOUNDED. Releasing the container is only correct
 *     while sentences keep their measure; a 3196px line of Arabic is
 *     the failure mode this trade has, and it is checked here rather
 *     than assumed. Measured on leaf text nodes of 40+ characters, so a
 *     label, a readout or a heading is not mistaken for a paragraph.
 *   - THE RAIL IS ATTACHED. The rail must touch the viewport edge it
 *     belongs to and the workspace must start immediately beside it,
 *     with no band between them.
 *   - NOTHING OVERFLOWS. Filling the width must not create a page-level
 *     horizontal scrollbar.
 *   - THE GUTTER IS A GUTTER. The first card must clear the workspace
 *     edge by a desktop gutter, not sit flush against it.
 *
 * Failures print the numbers, e.g.
 *   setup@3440: workspace used 2040/3232 = 63.1% (floor 94%)
 * because "desktop layout failed" tells a maintainer nothing about
 * which way the layout failed.
 */
import {spawn, spawnSync} from 'node:child_process';
import {chromium} from 'playwright-core';

const PORT = Number(process.env.W1_PORT ?? 4211);
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const CHROME =
  process.env.CHROMIUM_PATH ??
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Representative tool screens: a dashboard, a workspace, a table, a grid. */
const SCREENS = ['setup', 'motors', 'ports', 'osd'];
const WIDTHS = [1920, 2560, 3440, 3840];

/**
 * The floor from the brief. Not 1.0: a screen is free to leave a little
 * at the edge, and a scrollbar or a sub-pixel rounding must not be a
 * failure. It IS well above the 63% the 2040 cap produced at 3440.
 */
const UTILIZATION_FLOOR = 0.94;

/** The two caps this phase retired. Landing on either again is the
 *  specific regression, so it is named rather than merely measured. */
const RETIRED_CAPS = [1600, 2040];

/** How wide a sentence may be, from src/ui/theme/layout.ts. Kept as a
 *  literal on purpose: a gate that imported the value it checks would
 *  pass no matter what the value became. */
const PROSE_MEASURE = 760;
/** Rounding, borders and the odd inline element that wraps around one. */
const PROSE_SLACK = 24;

/** §3: a normal desktop gutter, in px, between the workspace edge and
 *  the first card. */
const GUTTER_MIN = 8;
const GUTTER_MAX = 64;

const violations = [];
const notes = [];
/** screen -> width -> the sorted set of rendered text sizes. */
const typography = new Map();

if (process.env.W1_SKIP_BUILD !== '1') {
  const build = spawnSync(
    'npx',
    ['vite', 'build', '--config', 'e2e/touch-targets/vite.config.mts'],
    {stdio: 'inherit'},
  );
  if (build.status !== 0) {
    console.error('desktop-workspace: the fixture build failed');
    process.exit(1);
  }
}

const server = spawn(
  'npx',
  [
    'vite', 'preview', '--config', 'e2e/touch-targets/vite.config.mts',
    '--port', String(PORT), '--strictPort',
  ],
  {stdio: 'ignore'},
);
let up = false;
for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(BASE)).ok) { up = true; break; }
  } catch { /* still starting */ }
  await new Promise(r => setTimeout(r, 500));
}
if (!up) {
  server.kill('SIGTERM');
  console.error('desktop-workspace: the fixture preview server never came up');
  process.exit(1);
}

/** Runs INSIDE the page. Everything it returns is a rendered rect. */
const PROBE = () => {
  const rect = el => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    return {
      l: +r.left.toFixed(2), r: +r.right.toFixed(2),
      w: +r.width.toFixed(2), t: +r.top.toFixed(2),
    };
  };
  const content = document.querySelector('[data-testid="shell-content"]');
  const rail = document.querySelector('[data-testid="main-side-rail"]');
  const logo = document.querySelector('[data-testid="brand-logo"]');
  const strip = document.querySelector('[data-testid="brand-top-chrome"]');

  /* The screen's content container. react-native-web renders a
     ScrollView as a scrollable box wrapping exactly one content
     container, and `contentContainerStyle` - where the envelope lands -
     is applied to that inner box. Found by structure, so this does not
     depend on a class name or a testID a screen might not have. */
  let scroller = null;
  if (content !== null) {
    for (const el of [content, ...content.querySelectorAll('*')]) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') { scroller = el; break; }
    }
  }
  const container = scroller?.firstElementChild ?? null;
  /* Overflow the PAGE cannot see. A ScrollView scrolls internally, so
     content wider than the workspace produces a scrollbar inside the
     workspace and leaves `document.scrollWidth` untouched - which is how
     two mutations that widened a content container walked straight past
     an oracle that only looked at the document. */
  const scrollerOverflow =
    scroller === null ? 0 : scroller.scrollWidth - scroller.clientWidth;

  /* Every real hit target in the shell, so a layout change cannot quietly
     shrink one. The rail only exists at desktop widths, and it is part of
     the shell rather than of any screen, so nothing else measures it. */
  const shortTargets = [];
  for (const el of document.querySelectorAll('[role="tab"], [role="button"], button')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.height < 43.5) {
      shortTargets.push({
        id: el.getAttribute('data-testid') ?? el.getAttribute('role') ?? '?',
        h: +r.height.toFixed(1),
      });
    }
  }

  /* The first thing the screen actually draws, so the gutter is the gap
     a person sees rather than the padding a stylesheet claims. */
  let firstChild = null;
  for (const el of container?.children ?? []) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) { firstChild = el; break; }
  }

  let prose = {w: 0, text: ''};
  for (const el of document.querySelectorAll('div, span')) {
    if (el.children.length !== 0) continue;
    const text = (el.textContent ?? '').trim();
    if (text.length < 40) continue;
    const w = el.getBoundingClientRect().width;
    if (w > prose.w) prose = {w: +w.toFixed(2), text: text.slice(0, 48)};
  }

  /* THE TYPOGRAPHY FINGERPRINT. Filling a monitor by making everything
     bigger is a forbidden solution (§19), and it is one a width-only
     oracle would wave straight through, so the SET of text sizes the
     workspace renders is captured and compared across widths. */
  const sizes = new Set();
  for (const el of (content?.querySelectorAll('div, span') ?? [])) {
    if (el.children.length !== 0) continue;
    if ((el.textContent ?? '').trim() === '') continue;
    sizes.add(getComputedStyle(el).fontSize);
  }

  const doc = document.documentElement;
  return {
    fontSizes: [...sizes].sort(),
    viewport: window.innerWidth,
    content: rect(content), rail: rect(rail), container: rect(container),
    firstChild: rect(firstChild), logo: rect(logo), strip: rect(strip),
    prose,
    scrollerOverflow,
    shortTargets,
    docOverflow: doc.scrollWidth - doc.clientWidth,
  };
};

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu'],
});

for (const screen of SCREENS) {
  for (const width of WIDTHS) {
    const key = `${screen}@${width}`;
    const ctx = await browser.newContext({
      viewport: {width, height: width >= 3440 ? 1440 : 1080},
    });
    const page = await ctx.newPage();
    let m;
    try {
      await page.goto(`${BASE}?dir=rtl&s=shell-${screen}`, {
        waitUntil: 'networkidle',
      });
      await page.waitForTimeout(600);
      m = await page.evaluate(PROBE);
    } finally {
      await ctx.close();
    }

    if (m.content === null || m.container === null || m.rail === null) {
      violations.push(
        `${key}: could not locate the shell - content=${m.content !== null} ` +
        `rail=${m.rail !== null} container=${m.container !== null}. The ` +
        `fixture did not render, so nothing here was measured.`,
      );
      continue;
    }

    const usable = m.content.w;
    const used = m.container.w;
    const utilization = used / usable;

    if (used > usable + 2) {
      violations.push(
        `${key}: the workspace is ${used.toFixed(0)}px inside a ` +
        `${usable.toFixed(0)}px space - ${(used - usable).toFixed(0)}px WIDER ` +
        `than the room the shell gave it. Filling the width is not the same ` +
        `as exceeding it; the excess becomes a scrollbar, not a workspace.`,
      );
    }

    if (utilization < UTILIZATION_FLOOR) {
      violations.push(
        `${key}: workspace used ${used.toFixed(0)}/${usable.toFixed(0)} = ` +
        `${(utilization * 100).toFixed(1)}% (floor ` +
        `${(UTILIZATION_FLOOR * 100).toFixed(0)}%) - ` +
        `${((usable - used) / 2).toFixed(0)}px of dead ground down each side`,
      );
    }

    for (const cap of RETIRED_CAPS) {
      if (Math.abs(used - cap) <= 2 && usable > cap + 40) {
        violations.push(
          `${key}: the workspace is ${used.toFixed(0)}px inside a ` +
          `${usable.toFixed(0)}px space, which is the retired ${cap}px cap. ` +
          `A centred island is exactly what this gate exists to stop.`,
        );
      }
    }

    if (m.prose.w > PROSE_MEASURE + PROSE_SLACK) {
      violations.push(
        `${key}: a paragraph rendered ${m.prose.w.toFixed(0)}px wide, past ` +
        `the ${PROSE_MEASURE}px reading measure (+${PROSE_SLACK} slack). ` +
        `Full-width workspace is not full-width prose. «${m.prose.text}»`,
      );
    }

    /* The rail is on the RTL start edge, so its outer edge is the
       viewport's right edge, and the workspace begins where it ends. */
    const railGap = Math.abs(m.viewport - m.rail.r);
    if (railGap > 1) {
      violations.push(
        `${key}: the navigation rail's outer edge is ${railGap.toFixed(1)}px ` +
        `from the viewport edge (${m.rail.r.toFixed(1)} vs ${m.viewport}). ` +
        `The rail must be attached to the application edge.`,
      );
    }
    const seam = Math.abs(m.rail.l - m.content.r);
    if (seam > 1) {
      violations.push(
        `${key}: there is a ${seam.toFixed(1)}px band between the rail and ` +
        `the workspace (rail starts ${m.rail.l.toFixed(1)}, workspace ends ` +
        `${m.content.r.toFixed(1)}). They must read as one application.`,
      );
    }

    if (m.docOverflow > 0) {
      violations.push(
        `${key}: the page overflows horizontally by ${m.docOverflow}px. ` +
        `Filling the width must not create a page-level scrollbar.`,
      );
    }

    if (m.scrollerOverflow > 0) {
      violations.push(
        `${key}: the workspace scrolls horizontally by ` +
        `${m.scrollerOverflow}px inside itself. The page does not overflow, ` +
        `so nothing above would have noticed - but the operator still gets a ` +
        `sideways scrollbar across the tool.`,
      );
    }

    if (m.shortTargets.length > 0) {
      const worst = m.shortTargets
        .slice(0, 3)
        .map(t => `${t.id}=${t.h}px`)
        .join(', ');
      violations.push(
        `${key}: ${m.shortTargets.length} interactive target(s) below the ` +
        `44px floor (${worst}). The navigation rail lives in the SHELL, so ` +
        `this is the only gate that renders it.`,
      );
    }

    if (m.firstChild !== null) {
      const gutter = Math.min(
        m.firstChild.l - m.container.l,
        m.container.r - m.firstChild.r,
      );
      if (gutter < GUTTER_MIN || gutter > GUTTER_MAX) {
        violations.push(
          `${key}: the outer gutter is ${gutter.toFixed(1)}px, outside the ` +
          `${GUTTER_MIN}-${GUTTER_MAX}px desktop band. Content must clear ` +
          `the workspace edge without being marooned inside it.`,
        );
      }
    }

    /* The brand rail follows the application, not a cap of its own. */
    if (m.logo !== null && m.strip !== null) {
      const appEdge = m.strip.r - 18; // strip paddingHorizontal, spacing.lg
      const drift = Math.abs(appEdge - m.logo.r);
      if (drift > 2) {
        violations.push(
          `${key}: the brand emblem's edge is ${drift.toFixed(1)}px inside ` +
          `the application edge (logo ${m.logo.r.toFixed(1)}, app ` +
          `${appEdge.toFixed(1)}). The identity must sit on the same edge ` +
          `system as the workspace, not on a centred rail of its own.`,
        );
      }
    }

    if (!typography.has(screen)) typography.set(screen, new Map());
    typography.get(screen).set(width, m.fontSizes);

    notes.push(
      `${key.padEnd(16)} usable=${usable.toFixed(0).padStart(4)} ` +
      `used=${used.toFixed(0).padStart(4)} ` +
      `util=${(utilization * 100).toFixed(1).padStart(5)}% ` +
      `prose=${m.prose.w.toFixed(0).padStart(4)} ` +
      `overflow=${m.docOverflow}`,
    );
  }
}

/**
 * NOTHING SCALES TO FILL THE MONITOR.
 *
 * The workspace grows; the type does not. Compared as a SET rather than
 * a single value because a screen legitimately renders several sizes -
 * what must not happen is that the set changes with the window.
 */
for (const [screen, byWidth] of typography) {
  const widths = [...byWidth.keys()];
  const [first, ...rest] = widths;
  const base = byWidth.get(first).join(',');
  for (const w of rest) {
    const here = byWidth.get(w).join(',');
    if (here !== base) {
      violations.push(
        `${screen}@${w}: the rendered text sizes changed with the window ` +
        `(${first}px -> [${base}], ${w}px -> [${here}]). The workspace is ` +
        `allowed to fill the monitor; the typography is not allowed to ` +
        `grow with it.`,
      );
    }
  }
}

/**
 * AND THE PHONE IS NOT COLLATERAL DAMAGE.
 *
 * A desktop fill policy has one obvious way to go wrong that no desktop
 * measurement can see: a rule meant for a wide window that also applies
 * to a narrow one. So the same shell is measured at 390, where the rail
 * is gone and the bottom bar is showing, and the only questions asked are
 * the ones a phone can fail - does anything overflow, sideways, at all,
 * and is every hit target still reachable.
 */
for (const screen of SCREENS) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await ctx.newPage();
  let m;
  try {
    await page.goto(`${BASE}?dir=rtl&s=shell-${screen}`, {
      waitUntil: 'networkidle',
    });
    await page.waitForTimeout(500);
    m = await page.evaluate(PROBE);
  } finally {
    await ctx.close();
  }
  const key = `${screen}@390`;
  if (m.content === null) {
    violations.push(`${key}: the shell did not render on a phone.`);
    continue;
  }
  if (m.docOverflow > 0) {
    violations.push(
      `${key}: the page overflows horizontally by ${m.docOverflow}px on a ` +
      `390px phone. A desktop rule reached a phone.`,
    );
  }
  if (m.scrollerOverflow > 0) {
    violations.push(
      `${key}: the workspace scrolls sideways by ${m.scrollerOverflow}px ` +
      `inside itself on a 390px phone. A desktop rule reached a phone.`,
    );
  }
  if (m.shortTargets.length > 0) {
    violations.push(
      `${key}: ${m.shortTargets.length} interactive target(s) below the 44px ` +
      `floor on a phone (` +
      `${m.shortTargets.slice(0, 3).map(t => `${t.id}=${t.h}px`).join(', ')}).`,
    );
  }
  notes.push(
    `${key.padEnd(16)} rail=${m.rail === null ? 'none' : 'SHOWING'} ` +
    `overflow=${m.docOverflow} innerOverflow=${m.scrollerOverflow} ` +
    `shortTargets=${m.shortTargets.length}`,
  );
}

/**
 * AND IT SURVIVES REAL BROWSER ZOOM.
 *
 * Emulated the way a browser actually zooms - by HALVING the CSS
 * viewport with a doubled device pixel ratio - not by scaling `body`,
 * which would leave `innerWidth` at the nominal value and let the app
 * lay out for a width it does not have.
 */
for (const screen of SCREENS) {
  for (const width of [1366, 3440]) {
    const ctx = await browser.newContext({
      viewport: {width: Math.round(width / 2), height: 720},
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    let z;
    try {
      await page.goto(`${BASE}?dir=rtl&s=shell-${screen}`, {
        waitUntil: 'networkidle',
      });
      await page.waitForTimeout(500);
      z = await page.evaluate(PROBE);
    } finally {
      await ctx.close();
    }
    const key = `${screen}@${width}@200%`;
    if (z.content === null) {
      violations.push(`${key}: the shell did not render under zoom.`);
      continue;
    }
    if (z.docOverflow > 0) {
      violations.push(
        `${key}: the page overflows horizontally by ${z.docOverflow}px at ` +
        `an effective ${Math.round(width / 2)} CSS px. A desktop fill ` +
        `policy must fall back, not overflow.`,
      );
    }
    /* The same two questions the unzoomed pass asks. Without them this
       pass could only see page-level overflow, and a workspace wider
       than its zoomed room scrolls INSIDE itself - which is how a
       tier-conditional break that only bites at an effective 1720 CSS px
       walked past this gate the first time it was tried. */
    if (z.scrollerOverflow > 0) {
      violations.push(
        `${key}: the workspace scrolls sideways by ${z.scrollerOverflow}px ` +
        `inside itself at an effective ${Math.round(width / 2)} CSS px.`,
      );
    }
    if (z.container !== null && z.container.w > z.content.w + 2) {
      violations.push(
        `${key}: the workspace is ${z.container.w.toFixed(0)}px inside a ` +
        `${z.content.w.toFixed(0)}px space under zoom - ` +
        `${(z.container.w - z.content.w).toFixed(0)}px wider than the room ` +
        `it has. Zoom must reduce the composition, not overflow it.`,
      );
    }
    if (z.prose.w > PROSE_MEASURE + PROSE_SLACK) {
      violations.push(
        `${key}: a paragraph rendered ${z.prose.w.toFixed(0)}px under zoom, ` +
        `past the ${PROSE_MEASURE}px measure.`,
      );
    }
    notes.push(
      `${key.padEnd(16)} cssWidth=${Math.round(width / 2)} ` +
      `usable=${z.content.w.toFixed(0)} overflow=${z.docOverflow} ` +
      `prose=${z.prose.w.toFixed(0)}`,
    );
  }
}

await browser.close();
server.kill('SIGTERM');

for (const note of notes) console.log(note);

if (violations.length > 0) {
  console.error(
    `\ndesktop-workspace: ${violations.length} violation(s)\n`,
  );
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(
  `\ndesktop-workspace: OK - ${SCREENS.length} screens x ${WIDTHS.length} ` +
  `widths, every workspace at or above ` +
  `${(UTILIZATION_FLOOR * 100).toFixed(0)}% of the space the shell gave it.`,
);
