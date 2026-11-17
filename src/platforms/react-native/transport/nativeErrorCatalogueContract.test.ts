/**
 * THE NATIVE ERROR CODE -> ARABIC CATALOGUE CONTRACT.
 *
 * Every failure the Android Kotlin module rejects with crosses the bridge
 * as a bare code string. The operator never sees that code: the UI resolves
 * it through `resolveFlashReason()`, which tries
 *
 *     firmwareFlasher.reason.<CODE>   ->   errors.<CODE>   ->   errors.UNKNOWN
 *
 * and `errors.UNKNOWN` is the single sentence
 * «حدث خطأ غير متوقع أثناء الاتصال.» - "an unexpected error occurred DURING
 * CONNECTION". For a failure that happened while flashing firmware or while
 * reading a picked file, that sentence is not merely vague: it names the
 * wrong phase, and it tells an operator nothing they can act on.
 *
 * transportErrors.ts already states the rule this file enforces:
 *
 *   "the native-sourced entries must be updated by hand if the native side
 *    ever adds a new code"
 *
 * Nothing enforced it, so the two sides drifted. This test is the missing
 * enforcement: it reads the SHIPPED KOTLIN SOURCE, extracts every code the
 * module can reject with, and requires each one to own a dedicated Arabic
 * entry. It is deliberately source-driven rather than a hand-copied list,
 * because a hand-copied list is exactly what drifted.
 *
 * Scope note: only `src/main` is scanned. That is the code in the release
 * APK. The debug-only log-capture module ships in the debug variant only
 * and is asserted separately below, so a debug-only code can never silently
 * satisfy - or silently break - the release contract.
 *
 * NOTHING HERE IS A HARDWARE CLAIM.
 */

import fs from 'fs';
import path from 'path';

import ar from '../../../i18n/locales/nl.json';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const KOTLIN_MAIN = path.join(REPO_ROOT, 'android/app/src/main/java/com/fpvarbcon');
const KOTLIN_DEBUG = path.join(REPO_ROOT, 'android/app/src/debug/java/com/fpvarbcon');

/**
 * `UsbTransportException("CODE"` and `promise.reject("CODE"`, tolerating the
 * line breaks the formatter inserts between the paren and the literal.
 */
const EMIT = /(?:UsbTransportException|reject)\(\s*"([A-Z][A-Z0-9_]{2,})"/g;

function kotlinFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.kt')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function emittedCodes(root: string): string[] {
  const codes = new Set<string>();
  for (const file of kotlinFiles(root)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(EMIT)) codes.add(match[1]);
  }
  return [...codes].sort();
}

/** Where each code is emitted, so a failure names the file to look at. */
function emitSites(root: string, code: string): string[] {
  const sites: string[] = [];
  for (const file of kotlinFiles(root)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes(`"${code}"`)) {
        sites.push(`${path.relative(REPO_ROOT, file)}:${index + 1}`);
      }
    });
  }
  return sites;
}

const catalogue = ar as unknown as {
  errors?: Record<string, string>;
  firmwareFlasher?: {reason?: Record<string, string>};
};

/** Exactly the chain resolveFlashReason() walks, minus the UNKNOWN fallback. */
function dedicatedArabicEntry(code: string): string | undefined {
  const reason = catalogue.firmwareFlasher?.reason?.[code];
  if (typeof reason === 'string' && reason.length > 0) return reason;
  const shared = catalogue.errors?.[code];
  if (typeof shared === 'string' && shared.length > 0) return shared;
  return undefined;
}

describe('every Android error code owns a dedicated Arabic message', () => {
  it('finds the Kotlin sources it is supposed to be reading', () => {
    /* If this ever reads zero files the whole suite would pass vacuously
       and guard nothing at all. */
    expect(kotlinFiles(KOTLIN_MAIN).length).toBeGreaterThan(20);
    expect(emittedCodes(KOTLIN_MAIN).length).toBeGreaterThan(30);
  });

  it('resolves every release-shipped code to something other than errors.UNKNOWN', () => {
    const unresolved = emittedCodes(KOTLIN_MAIN)
      .filter(code => dedicatedArabicEntry(code) === undefined)
      .map(code => `${code}  (emitted at ${emitSites(KOTLIN_MAIN, code)[0]})`);

    expect(unresolved).toEqual([]);
  });

  it('never lets a dedicated entry be the generic sentence in disguise', () => {
    const generic = catalogue.errors?.UNKNOWN;
    expect(typeof generic).toBe('string');
    const impostors = emittedCodes(KOTLIN_MAIN).filter(
      code => dedicatedArabicEntry(code) === generic,
    );
    expect(impostors).toEqual([]);
  });

  it('gives the debug-only log-capture codes their own entries too', () => {
    /* The debug variant is what captures [FPV-BATT]/[FPV-TELEM] logs on
       real hardware, so its failures are read by an operator as well. */
    const unresolved = emittedCodes(KOTLIN_DEBUG).filter(
      code => dedicatedArabicEntry(code) === undefined,
    );
    expect(unresolved).toEqual([]);
  });
});
