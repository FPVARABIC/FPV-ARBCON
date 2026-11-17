import {readFileSync, readdirSync, statSync} from 'fs';
import {join} from 'path';
import * as ts from 'typescript';
import ar from './locales/ar.json';
import nl from './locales/nl.json';
import i18n from './index';

const root = join(__dirname, '../..');
function leaves(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return {[prefix]: value};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => Object.entries(leaves(child, prefix ? `${prefix}.${key}` : key))));
}
const source = leaves(ar);
const dutch = leaves(nl);
const slots = (text: string) => (text.match(/\{\{[^}]+\}\}/g) ?? []).sort();

test('Dutch covers the full reference catalogue and preserves every interpolation', () => {
  expect(Object.keys(dutch).sort()).toEqual(Object.keys(source).sort());
  for (const [key, value] of Object.entries(dutch)) {
    expect({key, empty: value.trim().length === 0}).toEqual({key, empty: false});
    expect({key, slots: slots(value)}).toEqual({key, slots: slots(source[key])});
    expect({key, arabic: /[\u0600-\u06ff]/u.test(value)}).toEqual({key, arabic: false});
    expect({key, marker: /ZXQ\d|⟦\d+⟧|⁇/u.test(value)}).toEqual({key, marker: false});
  }
});

test('Dutch is the startup and fallback language', () => {
  expect(i18n.language).toBe('nl');
  expect(i18n.options.fallbackLng).toEqual(['nl']);
  expect(i18n.t('motorsScreen.propellerWarning')).toBe('Verwijder de propellers voordat u de motoren test.');
  expect(i18n.t('motorsScreen.emergencyDisconnect')).toContain('koppel de LiPo-accu onmiddellijk los');
  expect(i18n.t('motorsScreen.batteryScopeWarning')).toContain('niet automatisch');
});

test('native and web decide LTR before the first surface', () => {
  for (const file of ['App.tsx', 'App.web.tsx']) {
    const text = readFileSync(join(root, file), 'utf8');
    expect(text).toContain('I18nManager.forceRTL(false)');
    expect(text).toContain('I18nManager.allowRTL(false)');
  }
  const bootstrap = readFileSync(join(root, 'android/app/src/main/java/com/fpvarbcon/RtlBootstrap.kt'), 'utf8');
  expect(bootstrap).toContain('allowRTL(context, false)');
  expect(bootstrap).toContain('forceRTL(context, false)');
  expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('<html lang="nl" dir="ltr">');
  const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
  expect([manifest.lang, manifest.dir]).toEqual(['nl', 'ltr']);
  expect(readFileSync(join(root, 'android/app/build.gradle'), 'utf8')).toContain('applicationId "com.fpvarbcon.nl"');
});

test('shipped source has no Arabic copy hidden outside the Dutch catalogue', () => {
  const failures: string[] = [];
  function scan(directory: string) {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      if (statSync(file).isDirectory()) {
        if (!/__test|__mock|__fixture/.test(name)) scan(file);
      } else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) {
        const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node) {
          if ((ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /[\u0600-\u06ff]/u.test(node.text)) {
            failures.push(`${file}:${node.text}`);
          }
          ts.forEachChild(node, visit);
        }
        visit(ast);
      }
    }
  }
  scan(join(root, 'src'));
  expect(failures).toEqual([]);
});

// A successful readback must remain distinct from volatile application.
test('Dutch preserves every explicit permanent-storage qualification', () => {
  for (const [key, text] of Object.entries(source)) {
    if (text.includes('الذاكرة الدائمة')) {
      expect({key, explicit: /permanent/i.test(dutch[key])}).toEqual({key, explicit: true});
    }
  }
});
