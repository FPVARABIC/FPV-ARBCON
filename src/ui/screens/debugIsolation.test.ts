/**
 * Pass 7.7 - the debug app-log capture must be completely absent from
 * the release build.
 *
 * Two independent things are checked here, both from real files on disk:
 *  1. NATIVE SOURCE-SET ISOLATION: every app-log-capture class lives only
 *     under android/app/src/debug/..., the main source set never names
 *     them, and the variant seam exists on both sides with the no-op half
 *     outside com.fpvarbcon.debug.
 *  2. JS IMPORT-GRAPH ISOLATION: no production module statically imports
 *     either debug panel; they are reached only through debugPanels.ts's
 *     __DEV__-guarded require().
 *
 * The dev=false BUNDLE token scan is a separate, heavier check
 * (scripts/scan-production-bundle.js) that generates the bundle into a
 * temporary directory OUTSIDE this repository; it is not run from Jest.
 * Release DEX/APK token proof needs Gradle and remains a CI check.
 */

import {execFileSync} from 'child_process';
import {existsSync, readFileSync, readdirSync, statSync} from 'fs';
import {join, resolve} from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');
const ANDROID_SRC = join(REPO_ROOT, 'android/app/src');

/** The exact classes the release build must not contain. */
const DEBUG_ONLY_CLASSES = [
  'UsbAppLogCapturePackage',
  'UsbAppLogCaptureModule',
  'UsbAppLogCaptureCore',
  'UsbBoundedProcessReader',
];

/** Comments legitimately DISCUSS the isolated classes (that is the point
 * of the doc comments); only real code may name them, so every scan below
 * runs on comment-stripped source. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function codeOf(file: string): string {
  return stripComments(readFileSync(file, 'utf8'));
}

function listFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listFiles(full, extension));
    } else if (full.endsWith(extension)) {
      found.push(full);
    }
  }
  return found;
}

describe('debug app-log capture - native source-set isolation', () => {
  it('every app-log-capture class lives ONLY under android/app/src/debug', () => {
    for (const className of DEBUG_ONLY_CLASSES) {
      // Present in the debug source set - as a code token, or (for
      // UsbBoundedProcessReader, whose file declares top-level functions
      // rather than a class of that name) as the file itself.
      const debugMatches = listFiles(join(ANDROID_SRC, 'debug'), '.kt').filter(
        file => codeOf(file).includes(className) || file.endsWith(`${className}.kt`),
      );
      expect(debugMatches.length).toBeGreaterThan(0);

      const mainMatches = listFiles(join(ANDROID_SRC, 'main'), '.kt').filter(
        file => codeOf(file).includes(className) || file.endsWith(`${className}.kt`),
      );
      expect(mainMatches).toEqual([]);

      const releaseMatches = listFiles(join(ANDROID_SRC, 'release'), '.kt').filter(
        file => codeOf(file).includes(className) || file.endsWith(`${className}.kt`),
      );
      expect(releaseMatches).toEqual([]);
    }
  });

  it('the main source set names neither the debug package nor its classes', () => {
    for (const file of listFiles(join(ANDROID_SRC, 'main'), '.kt')) {
      const code = codeOf(file);
      expect(code).not.toContain('com.fpvarbcon.debug');
      expect(code).not.toContain('captureAppLog');
    }
  });

  it('MainApplication registers packages through the variant seam only', () => {
    const mainApplication = codeOf(join(ANDROID_SRC, 'main/java/com/fpvarbcon/MainApplication.kt'));
    expect(mainApplication).toContain('addAll(variantReactPackages())');
    expect(mainApplication).not.toContain('UsbAppLogCapturePackage');
  });

  it('both variant seams exist with the same function, and the release half is a no-op OUTSIDE com.fpvarbcon.debug', () => {
    const debugSeamPath = join(ANDROID_SRC, 'debug/java/com/fpvarbcon/VariantReactPackages.kt');
    const releaseSeamPath = join(ANDROID_SRC, 'release/java/com/fpvarbcon/VariantReactPackages.kt');
    expect(existsSync(debugSeamPath)).toBe(true);
    expect(existsSync(releaseSeamPath)).toBe(true);

    const debugSeam = codeOf(debugSeamPath);
    const releaseSeam = codeOf(releaseSeamPath);
    for (const seam of [debugSeam, releaseSeam]) {
      expect(seam).toContain('package com.fpvarbcon\n');
      expect(seam).toContain('fun variantReactPackages(): List<ReactPackage>');
    }
    // Debug registers the capture package; release registers nothing and
    // never mentions the debug package.
    expect(debugSeam).toContain('UsbAppLogCapturePackage()');
    expect(releaseSeam).toContain('emptyList()');
    expect(releaseSeam).not.toContain('com.fpvarbcon.debug');
  });

  it('the debug-only unit tests live in the debug-only unit-test source set', () => {
    const sharedTests = listFiles(join(ANDROID_SRC, 'test'), '.kt');
    for (const file of sharedTests) {
      const code = codeOf(file);
      for (const className of DEBUG_ONLY_CLASSES) {
        expect(code).not.toContain(className);
      }
    }
    const debugTests = listFiles(join(ANDROID_SRC, 'testDebug'), '.kt');
    expect(debugTests.length).toBeGreaterThan(0);
  });
});

describe('debug panels - JS import-graph isolation', () => {
  const PANEL_MODULES = ['./UsbAppLogCapturePanel', './UsbSerialDebugPanel', 'UsbAppLogCapturePanel', 'UsbSerialDebugPanel'];

  function productionSources(): string[] {
    const output = execFileSync(
      'git',
      ['ls-files', 'src', 'index.js', 'App.tsx'],
      {cwd: REPO_ROOT, encoding: 'utf8'},
    );
    return output
      .split('\n')
      .filter(Boolean)
      .filter(path => /\.(ts|tsx|js|jsx)$/.test(path))
      .filter(path => !path.includes('.test.'))
      .filter(path => !path.includes('__tests__'));
  }

  it('only debugPanels.ts references the panel modules, and only via a __DEV__-guarded require', () => {
    const offenders: string[] = [];
    for (const relative of productionSources()) {
      if (
        relative.endsWith('src/ui/screens/debugPanels.ts') ||
        relative.endsWith('src/ui/screens/UsbAppLogCapturePanel.tsx') ||
        relative.endsWith('src/ui/screens/UsbSerialDebugPanel.tsx')
      ) {
        continue;
      }
      const contents = readFileSync(join(REPO_ROOT, relative), 'utf8');
      for (const moduleName of PANEL_MODULES) {
        if (contents.includes(`from '${moduleName}'`) || contents.includes(`require('${moduleName}')`)) {
          offenders.push(`${relative} -> ${moduleName}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('debugPanels.ts resolves both panels behind __DEV__ and never statically imports them', () => {
    const seam = readFileSync(join(REPO_ROOT, 'src/ui/screens/debugPanels.ts'), 'utf8');
    expect(seam).not.toMatch(/^import .*UsbAppLogCapturePanel/m);
    expect(seam).not.toMatch(/^import .*UsbSerialDebugPanel/m);
    expect(seam).toContain("__DEV__\n  ? (require('./UsbAppLogCapturePanel')");
    expect(seam).toContain("__DEV__\n  ? (require('./UsbSerialDebugPanel')");
    // The EXPORT names must be neutral: an export name survives
    // minification as a bundle property key, so exporting the panels
    // under their real names would leave "UsbAppLogCapture" in a
    // production bundle even with the panel itself stripped.
    expect(seam).toContain('export const DevAppLogPanel');
    expect(seam).toContain('export const DevSerialPanel');
    expect(seam).not.toMatch(/export const Usb/);
  });

  it('the screens barrel no longer re-exports a debug panel', () => {
    const barrel = readFileSync(join(REPO_ROOT, 'src/ui/screens/index.ts'), 'utf8');
    expect(barrel).not.toContain("from './UsbSerialDebugPanel'");
    expect(barrel).not.toContain("from './UsbAppLogCapturePanel'");
  });

  it('nothing outside the panels themselves reaches the native capture module', () => {
    for (const relative of productionSources()) {
      if (relative.endsWith('src/ui/screens/UsbAppLogCapturePanel.tsx')) {
        continue;
      }
      const contents = readFileSync(join(REPO_ROOT, relative), 'utf8');
      expect(contents).not.toContain('NativeModules.UsbAppLogCapture');
    }
  });
});
