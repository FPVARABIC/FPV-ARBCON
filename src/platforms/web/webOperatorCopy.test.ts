/**
 * WEB PRODUCT FRAMING - the browser build must speak to an operator, not
 * to the people building it.
 *
 * WHY THIS SUITE EXISTS. The operator opened the deployed Web app on a
 * phone and reported that it did not look like the product - it looked
 * like an internal development artefact. A local sweep of the REAL
 * production bundle at 360/390/412/768/1024/1366 then showed the layout
 * was fine (zero horizontal overflow, no desktop side rail at any phone
 * width, 16px body text, 48px smallest tap target, zero truncation) and
 * that the actual problem was the COPY: the first line rendered on every
 * width was
 *
 *     نسخة معاينة — مسارات العتاد ما زالت REQUIRES HARDWARE TEST
 *
 * `REQUIRES HARDWARE TEST` is our own review vocabulary. So is framing a
 * shipped capability as belonging to a "مرحلة" (phase/stage) of testing.
 * And telling every visitor to open the app "على سطح المكتب" reads as a
 * desktop-only product to someone holding a phone.
 *
 * The warnings themselves are correct and stay. What changed is that
 * they are now stated in the operator's language. These tests keep them
 * that way.
 */

import ar from '../../i18n/locales/ar.json';

/** Internal review/process vocabulary that must never reach the UI. */
const INTERNAL_TOKENS = [
  'REQUIRES HARDWARE TEST',
  'Phase 1',
  'Phase 2',
  'Pass 1',
  'Pass 2',
  'TODO',
  'FIXME',
];

/** Every string in the bundle, with its dotted key path. */
function* walk(node: unknown, path = ''): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path, node];
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      yield* walk(value, path === '' ? key : `${path}.${key}`);
    }
  }
}

const ALL = [...walk(ar)];

/**
 * THE BUILD-STATUS STRIP IS GONE, AND MAY NOT COME BACK.
 *
 * A yellow "نسخة معاينة قيد التحقق" bar used to sit above every route, so
 * the first thing an operator read on every screen was which build they
 * were running. Which build this is cannot change a single decision they
 * make at the aircraft; it is a developer fact, and it now lives in a
 * console diagnostic instead (App.web.tsx).
 *
 * This guards the surface rather than the words: the copy is deleted, so a
 * test asserting on its wording would have nothing to protect. What must
 * not return is a top-level strip announcing preview/beta/build status.
 */
describe('no build-status strip in the product surface', () => {
  it('has no preview banner copy left to render', () => {
    const web = ar.webPlatform as Record<string, unknown>;
    expect(web.previewNotice).toBeUndefined();
    expect(web.previewDetail).toBeUndefined();
  });

  it('no locale string announces the build as a preview or beta', () => {
    // ALL is every leaf string in the catalogue - see walk() above.
    const offenders = ALL.filter(
      ([, value]) =>
        /نسخة\s*(معاينة|تجريبية)/.test(value) || /قيد\s*التحقق/.test(value),
    ).map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('the web root renders no preview component', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const root = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'App.web.tsx'),
      'utf8',
    );
    expect(root).not.toContain('<PreviewNotice');
    // The flag may still be read - a console diagnostic is the point - but
    // it must not gate a rendered element.
    expect(root).not.toMatch(/IS_PREVIEW_BUILD\s*\?[^\n]*</);
  });
});

describe('browser capability guidance is not desktop-only advice', () => {
  it('does not send a phone user to a desktop', () => {
    expect(ar.webPlatform.guidance).not.toContain('على سطح المكتب');
    expect(ar.errors.WEB_SERIAL_UNSUPPORTED).not.toContain('على سطح المكتب');
  });

  it('still names the capability truthfully', () => {
    expect(ar.errors.WEB_SERIAL_UNSUPPORTED).toContain('Web Serial');
    expect(ar.webPlatform.guidance).toContain('HTTPS');
    // The secure-context message is a separate, still-accurate string.
    expect(ar.errors.INSECURE_CONTEXT).toContain('HTTPS');
    // WebUSB is named separately from Web Serial - two capabilities,
    // two truths, so a browser that has one and not the other is not
    // told a single blanket answer.
    expect(ar.errors.WEB_USB_UNSUPPORTED).toContain('WebUSB');
  });
});

describe('no development-lifecycle framing reaches the operator', () => {
  it('states product state, not a testing stage', () => {
    expect(ar.serialConfiguration.readOnlyNote).not.toContain('المرحلة');
    expect(ar.errors.NOT_IMPLEMENTED).not.toContain('المرحلة');
    // …while still saying the same thing.
    expect(ar.serialConfiguration.readOnlyNote).toContain('للعرض فقط');
    expect(ar.errors.NOT_IMPLEMENTED).toContain('غير متاحة');
  });

  it('contains no internal review token anywhere in the shipped strings', () => {
    const offenders = ALL.filter(([, value]) =>
      INTERNAL_TOKENS.some(token => value.includes(token)),
    ).map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  /**
   * A guard, not a style rule. "مرحلة" is ordinary Arabic and is correct
   * in the flashing progress model (a flash genuinely has phases), so
   * this pins only the two keys that used it for OUR development
   * lifecycle - and lists the legitimate users explicitly so a new
   * lifecycle leak has to be added here on purpose.
   */
  it('uses "مرحلة" only where it describes a real product process', () => {
    const users = ALL.filter(([, v]) => v.includes('مرحلة') || v.includes('المرحلة')).map(([p]) => p);
    for (const path of users) {
      expect(path.startsWith('flash') || path.startsWith('firmware')).toBe(true);
    }
  });
});
