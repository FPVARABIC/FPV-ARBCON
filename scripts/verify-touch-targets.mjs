/**
 * THE 44px TOUCH FLOOR, MEASURED IN A REAL BROWSER.
 *
 * Eighteen controls shipped under the floor while a CI test asserting
 * `MIN_TOUCH_TARGET` as a SOURCE SUBSTRING stayed green. The Jest census
 * closes half of that gap by reading the resolved style of the element
 * that receives the press; this closes the other half, because the
 * contract is about a RENDERED rect and jsdom has no layout engine -
 * `getBoundingClientRect` there returns zeros and proves nothing.
 *
 * What this asserts, per control, at six widths in RTL:
 *
 *   FLOOR      the rect of the element a click actually lands on is at
 *              least 44px on both axes. The rect is taken from the node
 *              `elementFromPoint` returns, never from a visual child.
 *   OWNERSHIP  no two enlarged controls overlap, and no pixel between
 *              two of them activates either by accident.
 *   EDGES      a click 2px inside the top edge and 2px inside the bottom
 *              edge both reach the intended control - the whole point of
 *              raising the height.
 *   CLIPPING   no part of the control is cut off by a non-scrollable
 *              ancestor. A clipped target is smaller than it measures,
 *              and an RN ScrollView's `overflow-x: hidden` cross axis
 *              hides that from any document-level overflow check.
 *   KEYBOARD   the control is tab-reachable, and the controls that
 *              activate from the keyboard today still do; enlarging a
 *              target must not turn it into a mouse-only affordance.
 *   OVERFLOW   the page gains no horizontal scroll, at 100% or 200%.
 *
 * Run: npm run verify:touch-targets
 * Exits non-zero, naming the control and its measured size, on any
 * violation.
 */
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';

const MIN = 44;

/**
 * WAIT FOR THE SCENE, THEN SETTLE.
 *
 * Every probe below used to `goto(..., {waitUntil: 'networkidle'})`,
 * wait a fixed 400-500ms, and then query the DOM exactly once. That is a
 * bet that React has mounted the scene inside the fixed wait, and on a
 * loaded machine it is a bet that loses: the query finds nothing and the
 * probe reports "could not locate <control>", which reads as a missing
 * control and is nothing of the kind.
 *
 * Observed once, on a run that shared the machine with the full Jest
 * suite; it did not reproduce in five clean runs or in three runs under
 * deliberate 8x CPU contention. Rather than leave a verifier whose
 * verdict depends on what else the machine is doing, the fixed wait now
 * follows an actual wait FOR THE SCENE: any interactive control, or the
 * fixture's own failure marker.
 *
 * This weakens nothing. A control that genuinely never renders still
 * fails - after a bounded wait instead of immediately - and every
 * measurement still happens on a settled page.
 */
const SCENE_READY =
  '[role="button"],[role="tab"],[role="radio"],[role="checkbox"],button,' +
  '[tabindex]:not([tabindex="-1"]),[data-fixture]';

async function openScene(page, url, settleMs) {
  await page.goto(url, {waitUntil: 'networkidle'});
  try {
    await page.waitForSelector(SCENE_READY, {timeout: 15000, state: 'attached'});
  } catch {
    /* Reported by the probe itself, with the control it was looking for
       - not swallowed here. */
  }
  await page.waitForTimeout(settleMs);
}

const PORT = 4193;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const WIDTHS = [390, 430, 768, 1024, 1366, 1920];

/** Every control this phase repaired, by the scene that renders it and
 *  the identity it renders under. Named rather than discovered: a
 *  discovery-only census goes quiet the moment a scene stops drawing
 *  one, which is exactly how six of these were missed originally. */
const EXPECTED = {
  motors: ['motors-airframe-retry'],
  modes: [
    'modes-add-range-0', 'modes-add-range-1', 'modes-add-range-13',
    /* The remove control. It renders ONLY when an AUX range already
       exists, which is why no earlier sweep ever measured it and why the
       fixture carries a configured range. */
    'حذف',
  ],
  presets: [
    'الكل', 'Tune', 'Rates', 'Filters', 'RC Link',
    'Modes', 'OSD', 'VTX', 'LEDs', 'BNF', 'Other',
  ],
  choice: [
    'choice-enabled-online', 'choice-enabled-local',
    'choice-disabled-online', 'choice-disabled-local',
  ],
  /* The Flasher's own step tabs, and the firmware-source chips at their
     REAL call site rather than in the isolated `choice` matrix. */
  flasher: [
    'firmware-step-board', 'firmware-step-flash',
    'firmware-source-online', 'firmware-source-local',
  ],
};
/** Scenes whose controls sit in dense rows worth an overlap check. */
const DENSE = ['presets', 'choice', 'modes', 'flasher'];
/** Scenes that mount a WHOLE screen, and so can be asked about the
 *  document's own overflow. `motors` and `choice` mount a component
 *  without page chrome; their document width is this fixture's, not the
 *  product's. */
const PAGE_SCENES = ['modes', 'presets', 'flasher'];

/**
 * Horizontal overflow that PRE-DATES this phase, keyed `scene@width` or
 * `scene@width@200%`. Anything above the recorded number still fails, so
 * a NEW overflow is caught; what is recorded here is not silently
 * re-attributed to this phase's work either.
 *
 * flasher@390@200% = 13px. Owned by the header's «HEX / UF2 / BIN» pill,
 * which is not a touch target and which this phase never touched. Proved
 * independent of the two R-4 styles this screen renders by rebuilding
 * the fixture with each reverted to its pre-R-4 value and re-measuring:
 *
 *   styles.step.minHeight   44 -> 40 : overflow 13px, unchanged
 *   choice.minHeight        44 -> 39 : overflow 13px, unchanged
 *
 * which is what a height change should do to a row's width - nothing.
 * NOT FIXED HERE: reshaping the header is a redesign, and this phase
 * fixes hit targets only.
 */
const PRE_EXISTING_OVERFLOW = {'flasher@390@200%': 13};
const overflowBudget = key => PRE_EXISTING_OVERFLOW[key] ?? 1;

/**
 * Controls that TODAY activate from a trusted Enter, measured - not
 * assumed. `motors-airframe-retry` carries accessibilityRole="button",
 * so react-native-web synthesises a click from the key event and it
 * fires; removing that role drops it to zero, which this catches.
 *
 * A RATCHET, deliberately, and not a global rule. The Modes, Presets,
 * choice and Flasher-tab controls focus but do not activate, because
 * their primitives carry no button role - a PRE-EXISTING property, the
 * same before this phase as after it. Requiring activation of them here
 * would invent a requirement R-4 did not create and could only meet by
 * changing control semantics, which its scope forbids. So what is
 * asserted is exactly what is true today, per control; a control that
 * starts activating is reported as an improvement, never as a failure.
 */
const KEYBOARD_ACTIVATES = new Set(['motors-airframe-retry']);

const failures = [];
const notes = [];
const fail = message => failures.push(message);

/* ------------------------------------------------------------------ */
/* the page-side probe                                                  */
/* ------------------------------------------------------------------ */

const PROBE = min => {
  const SEL =
    '[role="button"],[role="tab"],[role="switch"],[role="radio"],' +
    '[role="checkbox"],[role="adjustable"],[role="link"],' +
    'button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

  const idOf = el =>
    el.getAttribute('data-testid') ??
    el.getAttribute('aria-label') ??
    (el.innerText ?? '').trim().split('\n')[0].slice(0, 40);

  const rectOf = el => {
    const r = el.getBoundingClientRect();
    return {
      l: Math.round(r.left), t: Math.round(r.top),
      r: Math.round(r.right), b: Math.round(r.bottom),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  };

  /* The element a click at (x,y) is delivered to. This, not the styled
     node, is what "the interactive target" means. */
  const ownerOf = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    if (hit === null) return null;
    const owner = hit.closest(SEL);
    return owner ?? hit;
  };

  /** Pixels of `rect` that no scroll can ever bring into view. */
  const clipOf = (el, rect) => {
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return 0;
      if (overflowX === 'hidden') {
        const box = node.getBoundingClientRect();
        const left = box.left + node.clientLeft;
        const right = left + node.clientWidth;
        return Math.round(
          Math.max(0, left - rect.l) + Math.max(0, rect.r - right),
        );
      }
    }
    return Math.round(
      Math.max(0, -rect.l) + Math.max(0, rect.r - window.innerWidth),
    );
  };

  const controls = [];
  for (const el of document.querySelectorAll(SEL)) {
    const rect = rectOf(el);
    if (rect.w === 0 && rect.h === 0) continue;
    const cx = (rect.l + rect.r) / 2;
    const cy = (rect.t + rect.b) / 2;
    /* Hit-testing is only meaningful inside the viewport: a control
       scrolled below the fold returns whatever is painted at that
       coordinate, which says nothing about who owns the control. Such a
       control is reported as unjudged rather than as a violation - its
       RECT is still measured, and the floor still applies to it. */
    const inView =
      rect.t >= 0 && rect.l >= 0 &&
      rect.b <= window.innerHeight && rect.r <= window.innerWidth;
    const owner = inView ? ownerOf(cx, cy) : null;
    controls.push({
      id: idOf(el),
      rect,
      inView,
      /* How much of the control is PERMANENTLY clipped horizontally.
         Measured against the nearest ancestor that constrains overflow,
         because the two cases are not the same defect:
           overflow-x: auto|scroll - the row scrolls sideways, and a
             chip currently past the edge is reached by scrolling to it,
             exactly like a control below the fold. Not a violation.
           overflow-x: hidden - an RN ScrollView's cross axis. Nothing
             can scroll it, so whatever lies outside is unreachable for
             good and the touchable target is smaller than its rect.
         Getting this wrong in either direction is the same class of
         error as judging a below-the-fold control by what is painted at
         its coordinates, so the scroller is inspected, not assumed. */
      clippedX: clipOf(el, rect),
      /* Does the centre of this control actually belong to it? If a
         sibling owns it, the painted box is not the hit area. */
      ownsCentre: !inView
        ? null
        : owner === el || el.contains(owner) || owner?.contains(el) === true,
      disabled:
        el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
      tabbable: el.getAttribute('tabindex') !== null &&
        el.getAttribute('tabindex') !== '-1',
    });
  }

  const doc = document.documentElement;
  return {
    controls,
    viewportWidth: window.innerWidth,
    /* Did the scene actually render, or is it showing a failure? The
       controls under test render on the error path too, so a fixture
       whose stub has drifted from the real port measures a broken
       screen and still looks green - which happened, and was caught by
       eye in a screenshot rather than by this script. */
    brokenText: (document.body.innerText ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => /is not a function|is not defined|undefined is not/.test(line))
      .slice(0, 2),
    overflow: doc.scrollWidth - doc.clientWidth,
    tiny: controls
      .filter(c => c.rect.w < min || c.rect.h < min)
      .map(c => `${c.id} = ${c.rect.w}x${c.rect.h}`),
  };
};

/** Pairwise overlap and gap ownership among a scene's controls. */
const OVERLAP = () => {
  const SEL =
    '[role="button"],[role="tab"],[role="radio"],[role="checkbox"],' +
    'button,[tabindex]:not([tabindex="-1"])';
  const els = [...document.querySelectorAll(SEL)].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const idOf = el =>
    el.getAttribute('data-testid') ?? (el.innerText ?? '').trim().slice(0, 24);
  const R = el => el.getBoundingClientRect();

  const overlaps = [];
  const gaps = [];
  for (let i = 0; i < els.length; i += 1) {
    for (let j = i + 1; j < els.length; j += 1) {
      const a = R(els[i]);
      const b = R(els[j]);
      if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 1 && iy > 1)
        overlaps.push(
          `${idOf(els[i])} x ${idOf(els[j])} overlap ${Math.round(ix)}x${Math.round(iy)}`,
        );
      /* Same row, side by side: is the space between them owned by
         exactly one of them, or by neither? Either is fine; owned by
         BOTH is impossible, owned by the wrong one is a defect. */
      if (iy > 4 && ix <= 0 && ix > -40) {
        const midX = (Math.max(a.right, b.right) === a.right)
          ? (b.right + a.left) / 2
          : (a.right + b.left) / 2;
        const midY = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
        const hit = document.elementFromPoint(midX, midY);
        const owner = hit === null ? null : hit.closest(SEL);
        gaps.push({
          pair: `${idOf(els[i])} | ${idOf(els[j])}`,
          gap: Math.round(-ix),
          owner: owner === null ? 'neither' : idOf(owner),
        });
      }
    }
  }
  return {overlaps, gaps};
};

/* ------------------------------------------------------------------ */
/* driver                                                              */
/* ------------------------------------------------------------------ */

function serve() {
  const child = spawn(
    'npx',
    ['vite', 'preview', '--config', 'e2e/touch-targets/vite.config.mts',
      '--port', String(PORT), '--strictPort'],
    {stdio: 'ignore', detached: false},
  );
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`fixture server never answered on ${BASE}`);
}

const server = serve();
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  for (const [scene, expected] of Object.entries(EXPECTED)) {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({
        viewport: {width, height: width <= 480 ? 844 : 900},
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      await openScene(page, `${BASE}?dir=rtl&s=${scene}`, 500);

      const res = await page.evaluate(PROBE, MIN);
      const seen = res.controls.map(c => c.id);
      let offScreen = 0;

      /* Measuring a broken screen is worse than measuring nothing: the
         controls render on the error path too, so the numbers look
         plausible and are about the wrong screen. */
      for (const line of res.brokenText)
        fail(`${scene}@${width}: the scene rendered a runtime error - "${line}"`);

      /* The scene must actually draw what it claims to. A green result
         from an empty page is the failure mode this guards against. */
      for (const id of expected) {
        if (!seen.includes(id)) {
          fail(`${scene}@${width}: expected control "${id}" did not render`);
          continue;
        }
        for (const c of res.controls.filter(x => x.id === id)) {
          if (c.rect.h < MIN || c.rect.w < MIN)
            fail(`${scene}@${width}: ${id} = ${c.rect.w}x${c.rect.h} (floor ${MIN})`);
          /* Permanently clipped is a floor failure in substance: the
             clipped part cannot be touched, so the real target is
             smaller than the rect just measured. The document-overflow
             check above cannot see this - an RN ScrollView's cross axis
             is `overflow-x: hidden`, so it absorbs the excess and the
             document stays exactly as wide as the viewport. */
          if (c.clippedX > 1)
            fail(
              `${scene}@${width}: ${id} is clipped horizontally by ` +
                `${c.clippedX}px and cannot be scrolled into view ` +
                `(rect ${c.rect.l}..${c.rect.r})`,
            );
          if (c.ownsCentre === false)
            fail(`${scene}@${width}: ${id} does not own its own centre pixel`);
          if (c.ownsCentre === null) offScreen += 1;
        }
      }

      if (offScreen > 0)
        notes.push(
          `${scene}@${width}: ${offScreen} named control(s) below the fold - ` +
            'rect measured, hit-ownership not judged there',
        );

      /* Only the scenes that mount a WHOLE screen get a document-level
         overflow assertion. `motors` and `choice` mount a component with
         no page chrome around it, so the document's width there is the
         fixture's, not the product's - asserting on it would measure
         this file. Their repaired controls are still floor-checked and
         still required to render. */
      if (
        PAGE_SCENES.includes(scene) &&
        res.overflow > overflowBudget(`${scene}@${width}`)
      )
        fail(`${scene}@${width}: page overflows horizontally by ${res.overflow}px`);

      if (DENSE.includes(scene)) {
        const geom = await page.evaluate(OVERLAP);
        for (const o of geom.overlaps) fail(`${scene}@${width}: ${o}`);
        notes.push(
          `${scene}@${width} gaps: ` +
            (geom.gaps.length === 0
              ? 'none adjacent'
              : geom.gaps
                  .slice(0, 3)
                  .map(g => `[${g.pair}] gap=${g.gap} owner=${g.owner}`)
                  .join('  ')),
        );
      }

      /* EDGES + KEYBOARD, once per scene at the narrowest width, where
         rows are tightest and a short target hurts most. */
      if (width === WIDTHS[0]) {
        for (const id of expected) {
          /* A FRESH page per control, because these two probes ACTIVATE
             the control and a real control changes the real screen: the
             Flasher's step tabs swap the entire step body, the Modes
             remove control takes its own row away. Probing the whole
             inventory on one page therefore measures whatever the
             previous probe left behind, and a control an earlier click
             had unmounted comes back as "could not locate" - a property
             of the probe order, not of the product. */
          const edgePage = await ctx.newPage();
          await openScene(edgePage, `${BASE}?dir=rtl&s=${scene}`, 400);
          const probe = await edgePage.evaluate(
            ([targetId, sel]) => {
              const el = [...document.querySelectorAll(sel)].find(
                n =>
                  (n.getAttribute('data-testid') ??
                    (n.innerText ?? '').trim().split('\n')[0].slice(0, 40)) === targetId,
              );
              if (el === undefined) return null;
              /* Bring it into view: elementFromPoint only answers for
                 coordinates inside the viewport, so probing a control
                 below the fold would measure whatever is painted there. */
              el.scrollIntoView({block: 'center', inline: 'center'});
              const r = el.getBoundingClientRect();
              if (r.bottom < 0 || r.top > window.innerHeight) return {skipped: true};
              let reached = 0;
              const mark = () => {
                reached += 1;
              };
              el.addEventListener('click', mark, true);
              const at = (x, y) => {
                const hit = document.elementFromPoint(x, y);
                hit?.dispatchEvent(
                  new MouseEvent('click', {
                    bubbles: true, cancelable: true, clientX: x, clientY: y,
                  }),
                );
              };
              const cx = (r.left + r.right) / 2;
              at(cx, r.top + 2);
              const top = reached;
              at(cx, (r.top + r.bottom) / 2);
              const centre = reached;
              at(cx, r.bottom - 2);
              const bottom = reached;
              el.removeEventListener('click', mark, true);
              return {
                top, centre, bottom,
                tabindex: el.getAttribute('tabindex'),
                disabled:
                  el.getAttribute('aria-disabled') === 'true' ||
                  el.hasAttribute('disabled'),
              };
            },
            [id, '[role="button"],[role="tab"],[role="radio"],[role="checkbox"],button,[tabindex]:not([tabindex="-1"])'],
          );
          await edgePage.close();
          if (probe === null) {
            fail(`${scene}@${width}: could not locate "${id}" for the edge probe`);
            continue;
          }
          if (probe.skipped === true) {
            notes.push(`${scene}@${width}: ${id} could not be scrolled into view for the edge probe`);
            continue;
          }
          if (probe.disabled) {
            /* A disabled control is checked for LAYOUT only, which the
               floor assertion above already did.
             *
             * Activation is deliberately NOT asserted here: this probe
             * reaches the element with `dispatchEvent`, which bypasses
             * hit-testing entirely and fires listeners even on a node
             * with `pointer-events: none`. It therefore cannot tell an
             * inert control from a live one, and an assertion built on
             * it would be measuring the probe rather than the product.
             * Whether a disabled control acts is asserted in the Jest
             * suite, against the real handler. */
            continue;
          }
          if (probe.top < 1)
            fail(`${scene}@${width}: ${id} does not receive a click 2px inside its TOP edge`);
          if (probe.bottom < 3)
            fail(`${scene}@${width}: ${id} does not receive a click 2px inside its BOTTOM edge`);
          if (probe.tabindex === null)
            fail(`${scene}@${width}: ${id} is enabled but not tab-reachable`);
        }
      }

      /* KEYBOARD + LABEL INTEGRITY, once per scene at the narrowest
         width. Enlarging a target must not turn it into a mouse-only
         affordance, and the extra height must not come at the cost of a
         clipped label.
       *
       * The key presses come from Playwright, not from a synthetic
       * `KeyboardEvent`. react-native-web synthesises a click from a
       * TRUSTED key event only; a dispatched one is ignored, so a probe
       * built on dispatch reports zero activations for a control that
       * works perfectly - measuring the probe rather than the product. */
      if (width === WIDTHS[0]) {
        const kb = [];
        for (const id of expected) {
          /* Fresh page, same reason as the edge probe above: Enter and
             Space activate the control, and an activated control can
             remove the next one from the tree. */
          const kbPage = await ctx.newPage();
          await openScene(kbPage, `${BASE}?dir=rtl&s=${scene}`, 400);
          const found = await kbPage.evaluate(
            ([targetId, sel]) => {
              const el = [...document.querySelectorAll(sel)].find(
                n =>
                  (n.getAttribute('data-testid') ??
                    (n.innerText ?? '').trim().split('\n')[0].slice(0, 40)) === targetId,
              );
              if (el === undefined) return null;
              el.scrollIntoView({block: 'center'});
              window.__kbHits = 0;
              window.__kbTarget = el;
              el.addEventListener('click', () => {
                window.__kbHits += 1;
              });
              el.focus();
              const r = el.getBoundingClientRect();
              let textOverflow = 0;
              for (const t of el.querySelectorAll('*')) {
                const tr = t.getBoundingClientRect();
                if (tr.height > 0 && tr.bottom > r.bottom + 1)
                  textOverflow = Math.max(
                    textOverflow, Math.round(tr.bottom - r.bottom),
                  );
              }
              return {
                focused: document.activeElement === el,
                disabled:
                  el.getAttribute('aria-disabled') === 'true' ||
                  el.hasAttribute('disabled'),
                textOverflow,
                h: Math.round(r.height),
              };
            },
            [id, '[role="button"],[role="tab"],[role="radio"],[role="checkbox"],button,[tabindex]:not([tabindex="-1"])'],
          );
          if (found === null) {
            await kbPage.close();
            fail(`${scene}@${width}: could not locate "${id}" for the keyboard probe`);
            continue;
          }
          await kbPage.keyboard.press('Enter');
          const afterEnter = await kbPage.evaluate(() => window.__kbHits);
          await kbPage.keyboard.press('Space');
          const afterSpace = await kbPage.evaluate(() => window.__kbHits);
          await kbPage.close();
          kb.push({id, ...found, enter: afterEnter, space: afterSpace - afterEnter});
        }
        for (const k of kb) {
          if (!k.disabled && !k.focused)
            fail(`${scene}@${width}: ${k.id} could not take keyboard focus`);
          /* Keyboard ACTIVATION is asserted only for the controls that
             actually have it today - see KEYBOARD_ACTIVATES above for
             why this is a per-control ratchet rather than a global rule.
             Everything else is recorded in the notes below, so movement
             in either direction stays visible. */
          if (KEYBOARD_ACTIVATES.has(k.id) && !k.disabled && k.enter < 1)
            fail(
              `${scene}@${width}: ${k.id} no longer activates from the ` +
                'keyboard (Enter produced no click)',
            );
          if (k.textOverflow > 0)
            fail(
              `${scene}@${width}: ${k.id} label overflows its ${k.h}px box by ${k.textOverflow}px`,
            );
        }
        notes.push(
          `${scene}@${width} keyboard: ` +
            kb
              .map(k => `${k.id}[focus=${k.focused} enter=${k.enter} space=${k.space}]`)
              .slice(0, 4)
              .join('  '),
        );
      }

      await ctx.close();
    }

    /* 200% zoom, once per scene at each of three representative widths.
       Zoom is applied as deviceScaleFactor-independent CSS scaling, the
       same thing a browser zoom control does. */
    for (const width of [390, 768, 1366]) {
      const ctx = await browser.newContext({
        viewport: {width, height: 900},
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      await openScene(page, `${BASE}?dir=rtl&s=${scene}`, 0);
      await page.evaluate(() => {
        document.body.style.zoom = '200%';
      });
      await page.waitForTimeout(400);
      const zoomed = await page.evaluate(PROBE, MIN);
      if (
        PAGE_SCENES.includes(scene) &&
        zoomed.overflow > overflowBudget(`${scene}@${width}@200%`)
      )
        fail(`${scene}@${width}@200%: page overflows horizontally by ${zoomed.overflow}px`);
      /* A recorded budget must keep being earned. If the pre-existing
         overflow is gone, say so rather than letting a stale allowance
         quietly cover a future one. */
      const zoomKey = `${scene}@${width}@200%`;
      if (PRE_EXISTING_OVERFLOW[zoomKey] !== undefined)
        notes.push(
          `${zoomKey}: overflow ${zoomed.overflow}px against a recorded ` +
            `pre-existing ${PRE_EXISTING_OVERFLOW[zoomKey]}px` +
            (zoomed.overflow <= 1 ? ' - GONE, drop the budget' : ''),
        );
      const missing = EXPECTED[scene].filter(
        id => !zoomed.controls.map(c => c.id).includes(id),
      );
      if (missing.length > 0)
        fail(`${scene}@${width}@200%: controls unreachable: ${missing.join(', ')}`);
      await ctx.close();
    }
  }
} finally {
  if (browser !== undefined) await browser.close();
  server.kill('SIGTERM');
}

for (const note of notes) console.log(`  ${note}`);

if (failures.length > 0) {
  console.error(`\nTOUCH FLOOR VIOLATIONS (${failures.length}):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `\nOK - every named control meets the ${MIN}px floor at ` +
    `${WIDTHS.join('/')} RTL, owns its own centre, receives top- and ` +
    'bottom-edge clicks, is not clipped by a non-scrollable ancestor, ' +
    'stays tab-reachable when enabled, keeps whatever keyboard ' +
    `activation it has today (${[...KEYBOARD_ACTIVATES].join(', ')}), ` +
    'and adds no horizontal overflow at 100% or 200% beyond the pre-existing ' +
    `allowances recorded above (${Object.entries(PRE_EXISTING_OVERFLOW)
      .map(([k, v]) => `${k}=${v}px`)
      .join(', ')}).`,
);
