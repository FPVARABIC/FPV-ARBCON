/**
 * Phase 2I - the motor-test Arabic strings, behind the SAME `__DEV__` seam
 * the motor-test screens themselves use.
 *
 * WHY THEY ARE NOT IN ar.json. Translation resources are DATA: Metro
 * bundles the whole JSON regardless of which screens are reachable, so
 * leaving these strings in the shared catalogue put every unique token of
 * the motor-test flow - including the LiPo emergency text and the
 * observation disclaimer - into a production bundle whose screens are all
 * stripped. Verified against a real --dev false bundle, not assumed.
 *
 * A `__DEV__`-guarded require() is the only form Metro's dead-code
 * elimination can remove; a static import would be retained no matter what
 * runtime guard wrapped it. Same reasoning, same seam, as debugPanels.ts.
 */

/** The motor-test translation subtree, or undefined in production. */
export const motorTestStrings: Record<string, unknown> | undefined = __DEV__
  ? (require('./locales/ar.motorTest.json') as Record<string, unknown>)
  : undefined;
