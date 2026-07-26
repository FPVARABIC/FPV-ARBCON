/**
 * Pass 7.7 - the JS half of the debug-only isolation.
 *
 * BASELINE DEFECT: UsbConnectionScreen.tsx statically imported both debug
 * panels, and src/ui/screens/index.ts re-exported one of them, so a
 * production (dev=false) bundle statically retained the whole diagnostic
 * panel graph - including the `captureAppLog` native-module access and
 * its user-facing copy.
 *
 * FIX: the panels are reached ONLY through this module, and only behind
 * `__DEV__`. Metro inlines `__DEV__` as a literal `false` for a
 * production bundle, so the minifier removes the unreachable branch -
 * and with it the `require()` calls - meaning neither panel module is
 * ever pulled into the production import graph. A static `import` would
 * be retained regardless of any runtime guard, which is exactly why
 * these are require()s inside the guard rather than top-level imports.
 *
 * Debug builds keep both panels, unchanged.
 *
 * The two exported names are deliberately NEUTRAL (DevAppLogPanel /
 * DevSerialPanel): an export name survives minification as a property
 * key in the bundle, so exporting them under their real module names
 * would leave the forbidden token "UsbAppLogCapture" in a production
 * bundle even with the panel itself fully stripped - confirmed by the
 * scan in scripts/scan-production-bundle.js, not assumed.
 */

/** Type-only references: `typeof import(...)` is erased at compile time,
 * so it keeps full prop typing without adding anything to the bundle. */
type AppLogCapturePanel = typeof import('./UsbAppLogCapturePanel').default;
type SerialDebugPanel = typeof import('./UsbSerialDebugPanel').default;

// NOTE: a static import would keep the debug panels in the production
// import graph no matter what runtime guard wrapped it; a __DEV__-guarded
// require() is the only form Metro's dead-code elimination can strip.
export const DevAppLogPanel: AppLogCapturePanel | undefined = __DEV__
  ? (require('./UsbAppLogCapturePanel').default as AppLogCapturePanel)
  : undefined;

export const DevSerialPanel: SerialDebugPanel | undefined = __DEV__
  ? (require('./UsbSerialDebugPanel').default as SerialDebugPanel)
  : undefined;
