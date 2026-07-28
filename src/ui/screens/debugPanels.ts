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
/** Phase 2H - the motor-test screen. Gated through this SAME established
 * seam rather than a new feature-flag system: the motor flow is
 * incomplete until Phase 2I ships the verification wizard and report, so
 * it must not be reachable by an ordinary user in a production bundle. */
type DevBenchScreenComponent = typeof import('./MotorsScreen').default;
/** Phase 2I - the development-only entry control. Same seam, same reason:
 * the entry's JSX, testID and route literal must be absent from a
 * production bundle, not merely unrendered in it. */
type DevBenchEntryComponent = typeof import('./MotorsDevEntry').default;

// NOTE: a static import would keep the debug panels in the production
// import graph no matter what runtime guard wrapped it; a __DEV__-guarded
// require() is the only form Metro's dead-code elimination can strip.
export const DevAppLogPanel: AppLogCapturePanel | undefined = __DEV__
  ? (require('./UsbAppLogCapturePanel').default as AppLogCapturePanel)
  : undefined;

export const DevSerialPanel: SerialDebugPanel | undefined = __DEV__
  ? (require('./UsbSerialDebugPanel').default as SerialDebugPanel)
  : undefined;

export const DevBenchScreen: DevBenchScreenComponent | undefined = __DEV__
  ? (require('./MotorsScreen').default as DevBenchScreenComponent)
  : undefined;

export const DevBenchEntry: DevBenchEntryComponent | undefined = __DEV__
  ? (require('./MotorsDevEntry').default as DevBenchEntryComponent)
  : undefined;

/**
 * Phase 2I - the route NAME, resolved through the same seam.
 *
 * The name is data, so a literal written at the registration site in
 * App.tsx would survive into a production bundle even though the screen
 * itself is stripped and the route is never registered. Keeping it here
 * means the shipped bytes contain no motor-test route name at all.
 */
export const DEV_BENCH_ROUTE_NAME: 'Motors' | undefined = __DEV__
  ? (require('./MotorsDevEntry').MOTORS_ROUTE_NAME as 'Motors')
  : undefined;
