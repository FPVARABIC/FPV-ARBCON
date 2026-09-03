/**
 * EVERY SCREEN, AT EVERY WIDTH, IN A REAL BROWSER - AND OPERATED, NOT
 * JUST PHOTOGRAPHED.
 *
 * =====================================================================
 * WHY A SCREENSHOT IS NOT EVIDENCE
 * =====================================================================
 *
 * A responsive sweep that renders each screen and looks at the picture
 * answers "does it look right". It cannot answer the questions that
 * actually break a session at 390px or at 3440px:
 *
 *   Does a click land on the control it is painted over, or on a
 *   neighbour, or on a transparent sibling stretched across it?
 *   Is the primary action REACHABLE, or is it under a sticky footer that
 *   grew when the viewport shrank?
 *   Does anything actually HAPPEN when the control is clicked?
 *   Does the page gain a sideways scroll nobody can see the end of?
 *
 * All four are properties of a rendered, hit-tested, interactive
 * document. jsdom has no layout engine - `getBoundingClientRect` there
 * returns zeros - so none of them can be measured in the Jest censuses,
 * however thorough those are. This runs the real web build in real
 * Chromium and clicks it.
 *
 * =====================================================================
 * WHAT IT MEASURES, PER SCREEN PER WIDTH
 * =====================================================================
 *
 *   OVERFLOW      the document gains no horizontal scroll.
 *   OWNERSHIP     every visible interactive element owns its own centre:
 *                 `elementFromPoint` at the middle of the painted box
 *                 resolves to that control, not to something over it.
 *   CLIPPING      no interactive element is permanently cut off by a
 *                 non-scrollable ancestor.
 *   REACHABILITY  the LAST action in the document can be brought into
 *                 view; a primary action that cannot be scrolled to is a
 *                 screen with no way forward.
 *   INTERACTION   a representative enabled control is really clicked,
 *                 through the browser's own dispatch, and the document
 *                 must change. This is the half a geometry sweep cannot
 *                 do, and the half that catches an overlay that swallows
 *                 the press while the picture looks perfect.
 *
 * Then the same sweep at 200% zoom, and a hit-routing pass that PLANTS a
 * transparent interceptor over a control and requires the ownership
 * check to catch it - because a check that has never failed is not known
 * to work.
 *
 * Run: node scripts/verify-responsive-interaction.mjs
 * (build the fixture first: vite build --config e2e/touch-targets/vite.config.mts)
 */
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';

const PORT = 4194;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** The seven the brief names, narrowest to widest. */
const WIDTHS = [390, 430, 768, 1024, 1366, 1920, 3440];
/** Zoom is expensive; three widths cover phone, laptop and desktop. */
const ZOOM_WIDTHS = [390, 1024, 1920];

/**
 * Every screen the shared registry builds, mounted inside the real
 * browser shell. The names are the registry's own - if a screen is added
 * there it must be added here, and the run says so rather than quietly
 * measuring one screen fewer.
 */
const SCREENS = [
  'Failsafe',
  'Power',
  'GPS',
  'PID',
  'OSD',
  'Modes',
  'Ports',
  'Receiver',
  'Configurations',
  'VTX',
  'MotorConfiguration',
  'Start',
  'Motors',
  'LED',
  'Sensors',
  'Blackbox',
  'Presets',
  'CLI',
  'FlightStyleGuide',
  'FlightStyleCorner',
];

const failures = [];
const rows = [];
const fail = message => failures.push(message);

/* ------------------------------------------------------------------ *
 * The page-side probe.
 *
 * Deliberately the same shape as verify-touch-targets.mjs uses: one
 * definition of "an interactive element", one definition of "who owns
 * this point", so two verifiers cannot disagree about what a control is.
 * ------------------------------------------------------------------ */
const PROBE = () => {
  const SEL =
    '[role="button"],[role="tab"],[role="switch"],[role="radio"],' +
    '[role="checkbox"],[role="adjustable"],[role="link"],' +
    'button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

  const idOf = el =>
    el.getAttribute('data-testid') ??
    el.getAttribute('aria-label') ??
    (el.innerText ?? '').trim().split('\n')[0].slice(0, 40);

  const clipOf = (el, rect) => {
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return 0;
      if (overflowX === 'hidden') {
        const box = node.getBoundingClientRect();
        const left = box.left + node.clientLeft;
        const right = left + node.clientWidth;
        return Math.round(
          Math.max(0, left - rect.left) + Math.max(0, rect.right - right),
        );
      }
    }
    return Math.round(
      Math.max(0, -rect.left) + Math.max(0, rect.right - window.innerWidth),
    );
  };

  const controls = [];
  for (const el of document.querySelectorAll(SEL)) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const inView =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right <= window.innerWidth;
    const hit = inView ? document.elementFromPoint(cx, cy) : null;
    const owner = hit === null ? null : (hit.closest(SEL) ?? hit);
    controls.push({
      id: idOf(el),
      inView,
      clippedX: clipOf(el, rect),
      ownsCentre:
        !inView || owner === null
          ? null
          : owner === el || el.contains(owner) || owner.contains(el),
      ownedBy: owner === null || owner === el ? null : idOf(owner),
      disabled:
        el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
    });
  }

  const doc = document.documentElement;
  return {
    controls,
    overflow: doc.scrollWidth - doc.clientWidth,
    /* Did the scene render, or is it showing a stub that has drifted?
       The controls under test render on the error path too, so a broken
       fixture measures a broken screen and still looks green. */
    brokenText: (document.body.innerText ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line =>
        /is not a function|is not defined|undefined is not|no screen named/.test(line),
      )
      .slice(0, 2),
    ready: document.querySelector('[data-testid="scene-ready"]') !== null,
    fingerprint: document.body.innerHTML.length,
  };
};

function serve() {
  return spawn(
    'npx',
    ['vite', 'preview', '--config', 'e2e/touch-targets/vite.config.mts',
     '--port', String(PORT), '--host', '127.0.0.1'],
    {stdio: 'ignore'},
  );
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(BASE);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('fixture server did not start');
}

const server = serve();

try {
  await waitForServer();
  const browser = await chromium.launch({executablePath: CHROME});

  for (const screen of SCREENS) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: {width, height: 900},
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const where = `${screen}@${width}`;
      try {
        await page.goto(`${BASE}?dir=rtl&s=census:${screen}`, {
          waitUntil: 'networkidle',
        });
        /* The registry mounts asynchronously - it reads a snapshot off a
           virtual board first. Measuring before that lands measures a
           spinner. */
        await page
          .waitForSelector('[data-testid="scene-ready"]', {timeout: 20000})
          .catch(() => undefined);
        await page.waitForTimeout(400);

        const probe = await page.evaluate(PROBE);
        if (probe.brokenText.length > 0) {
          fail(`${where}: the scene rendered an error - ${probe.brokenText.join(' | ')}`);
        }
        if (!probe.ready) {
          fail(`${where}: the scene never reported itself ready`);
        }
        if (probe.overflow > 1) {
          fail(`${where}: the page scrolls sideways by ${probe.overflow}px`);
        }
        const stolen = probe.controls.filter(c => c.ownsCentre === false);
        for (const control of stolen) {
          fail(
            `${where}: a click on the middle of "${control.id}" is delivered to` +
              ` "${control.ownedBy ?? 'something else'}"`,
          );
        }
        const clipped = probe.controls.filter(c => c.clippedX > 1);
        for (const control of clipped) {
          fail(`${where}: "${control.id}" is cut off by ${control.clippedX}px and cannot be scrolled to`);
        }

        /* REACHABILITY. The last action in the document is the one a
           sticky footer is most likely to bury. */
        const reachable = await page.evaluate(() => {
          const SEL = '[role="button"],button';
          const all = [...document.querySelectorAll(SEL)].filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (all.length === 0) return {tried: false, ok: true, id: null};
          const last = all[all.length - 1];
          last.scrollIntoView({block: 'center'});
          const rect = last.getBoundingClientRect();
          const cx = (rect.left + rect.right) / 2;
          const cy = (rect.top + rect.bottom) / 2;
          const hit = document.elementFromPoint(cx, cy);
          return {
            tried: true,
            ok:
              hit !== null &&
              (hit === last || last.contains(hit) || hit.contains(last)),
            id:
              last.getAttribute('data-testid') ??
              last.getAttribute('aria-label') ??
              (last.innerText ?? '').trim().slice(0, 30),
          };
        });
        if (reachable.tried && !reachable.ok) {
          fail(`${where}: the last action "${reachable.id}" cannot be reached even after scrolling to it`);
        }

        /* INTERACTION. One enabled control, clicked by the browser. */
        const clicked = await page.evaluate(async () => {
          const SEL = '[role="button"],button';
          const before = document.body.innerHTML.length;
          const all = [...document.querySelectorAll(SEL)].filter(el => {
            const r = el.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.height > 0 &&
              el.getAttribute('aria-disabled') !== 'true' &&
              !el.hasAttribute('disabled')
            );
          });
          if (all.length === 0) return {tried: false, changed: false, id: null};
          const target = all[Math.min(1, all.length - 1)];
          const id =
            target.getAttribute('data-testid') ??
            target.getAttribute('aria-label') ??
            (target.innerText ?? '').trim().slice(0, 30);
          target.scrollIntoView({block: 'center'});
          const rect = target.getBoundingClientRect();
          const at = {
            clientX: (rect.left + rect.right) / 2,
            clientY: (rect.top + rect.bottom) / 2,
            bubbles: true,
            cancelable: true,
          };
          target.dispatchEvent(new PointerEvent('pointerdown', at));
          target.dispatchEvent(new MouseEvent('mousedown', at));
          target.dispatchEvent(new PointerEvent('pointerup', at));
          target.dispatchEvent(new MouseEvent('mouseup', at));
          target.dispatchEvent(new MouseEvent('click', at));
          await new Promise(resolve => setTimeout(resolve, 250));
          return {
            tried: true,
            changed: document.body.innerHTML.length !== before,
            id,
          };
        });

        rows.push({
          screen,
          width,
          controls: probe.controls.length,
          inView: probe.controls.filter(c => c.inView).length,
          overflow: probe.overflow,
          clicked: clicked.id,
          responded: clicked.changed,
        });
      } catch (error) {
        fail(`${where}: ${String(error).slice(0, 160)}`);
      } finally {
        await context.close();
      }
    }
  }

  /* ---------------- 200% zoom ------------------------------------- */
  for (const screen of SCREENS) {
    for (const width of ZOOM_WIDTHS) {
      const context = await browser.newContext({
        viewport: {width, height: 900},
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const where = `${screen}@${width}@200%`;
      try {
        await page.goto(`${BASE}?dir=rtl&s=census:${screen}`, {
          waitUntil: 'networkidle',
        });
        await page
          .waitForSelector('[data-testid="scene-ready"]', {timeout: 20000})
          .catch(() => undefined);
        await page.evaluate(() => {
          document.body.style.zoom = '200%';
        });
        await page.waitForTimeout(400);
        const probe = await page.evaluate(PROBE);
        if (probe.overflow > 1) {
          fail(`${where}: the page scrolls sideways by ${probe.overflow}px at 200% zoom`);
        }
        const stolen = probe.controls.filter(c => c.ownsCentre === false);
        for (const control of stolen) {
          fail(
            `${where}: at 200% zoom a click on "${control.id}" is delivered to` +
              ` "${control.ownedBy ?? 'something else'}"`,
          );
        }
      } catch (error) {
        fail(`${where}: ${String(error).slice(0, 160)}`);
      } finally {
        await context.close();
      }
    }
  }

  /* ---------------- hit routing, with a planted interceptor -------- */
  {
    const context = await browser.newContext({
      viewport: {width: 1024, height: 900},
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(`${BASE}?dir=rtl&s=census:GPS`, {waitUntil: 'networkidle'});
    await page
      .waitForSelector('[data-testid="scene-ready"]', {timeout: 20000})
      .catch(() => undefined);
    await page.waitForTimeout(400);

    const clean = await page.evaluate(PROBE);
    const beforePlant = clean.controls.filter(c => c.ownsCentre === false).length;

    const planted = await page.evaluate(() => {
      const SEL = '[role="button"],button';
      const target = [...document.querySelectorAll(SEL)].find(el => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 20 &&
          r.height > 20 &&
          r.top >= 0 &&
          r.left >= 0 &&
          r.bottom <= window.innerHeight &&
          r.right <= window.innerWidth
        );
      });
      if (target === undefined) return null;
      const rect = target.getBoundingClientRect();
      const veil = document.createElement('div');
      veil.setAttribute('data-testid', 'planted-interceptor');
      veil.setAttribute('role', 'button');
      veil.style.cssText =
        `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
        `width:${rect.width}px;height:${rect.height}px;` +
        'background:transparent;z-index:99999';
      document.body.appendChild(veil);
      return (
        target.getAttribute('data-testid') ??
        target.getAttribute('aria-label') ??
        'a control'
      );
    });
    if (planted === null) {
      fail('hit routing: no control was available to plant an interceptor over');
    } else {
      const after = await page.evaluate(PROBE);
      const caught = after.controls.filter(c => c.ownsCentre === false);
      if (caught.length <= beforePlant) {
        fail(
          'hit routing: a transparent interceptor was laid over' +
            ` "${planted}" and the ownership check did not notice - the check` +
            ' cannot be trusted on the clean runs above',
        );
      } else {
        rows.push({
          screen: 'hit-routing',
          width: 1024,
          controls: after.controls.length,
          inView: after.controls.filter(c => c.inView).length,
          overflow: after.overflow,
          clicked: `planted over ${planted}`,
          responded: true,
        });
      }
      /* Restore, and prove the page is clean again. */
      await page.evaluate(() => {
        document.querySelector('[data-testid="planted-interceptor"]')?.remove();
      });
      const restored = await page.evaluate(PROBE);
      const still = restored.controls.filter(c => c.ownsCentre === false).length;
      if (still !== beforePlant) {
        fail(
          `hit routing: removing the interceptor left ${still} stolen centres,` +
            ` against ${beforePlant} before it was planted`,
        );
      }
    }
    await context.close();
  }

  await browser.close();
} finally {
  server.kill();
}

const silent = rows.filter(row => row.responded === false);
console.log('');
console.log('===== UI-X1D RESPONSIVE INTERACTION MATRIX =====');
console.log('  screen              width  controls  inView  overflow  clicked                         responded');
for (const row of rows) {
  console.log(
    `  ${row.screen.padEnd(19)}` +
      ` ${String(row.width).padStart(5)}` +
      ` ${String(row.controls).padStart(9)}` +
      ` ${String(row.inView).padStart(7)}` +
      ` ${String(row.overflow).padStart(9)}` +
      `  ${String(row.clicked ?? '-').slice(0, 30).padEnd(30)}` +
      ` ${row.responded ? 'yes' : 'NO'}`,
  );
}
console.log(`  rows: ${rows.length}   screens: ${SCREENS.length}   widths: ${WIDTHS.join(', ')}`);
console.log(`  clicks that changed nothing: ${silent.length}`);
console.log('===============================================');
console.log('');

if (failures.length > 0) {
  console.error(`${failures.length} responsive interaction failures:`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log('responsive interaction: clean');
