/**
 * WHAT AN OPERATOR SEES THE MOMENT THEY CONNECT.
 *
 * The Setup screen opened with a stack of safety notices and readiness
 * diagnostics. The aircraft's own state - the model, the battery, the
 * receiver, the GPS, which sensors were detected - was underneath all of
 * it, which is the wrong way round: the analysis of a thing cannot come
 * before the thing.
 *
 * This is a source-order test, deliberately. The component test next door
 * pins the RENDERED order for a connected session, which is the stronger
 * assertion; this one guards the structure that produces it, so a future
 * edit that moves a block back cannot pass merely because a session
 * happened not to render one of the sections.
 *
 * THE HALF THAT MATTERS MOST is the last assertion. "Put the warnings
 * later" is one keystroke away from "delete the warnings", and those are
 * completely different changes. Every safety surface that moved must
 * still be mounted, so the test fails if any of them stops being
 * rendered at all.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, 'SetupScreen.tsx'),
  'utf8',
);

/** Position of a component's first JSX use, comments stripped. */
function at(component: string): number {
  const executable = SOURCE.replace(/\{\/\*[\s\S]*?\*\/\}/g, match =>
    ' '.repeat(match.length),
  );
  const index = executable.indexOf(`<${component}`);
  if (index < 0) {
    throw new Error(`<${component}> is not rendered by SetupScreen at all.`);
  }
  return index;
}

describe('the aircraft comes before its diagnostics', () => {
  it('renders the model before the warning stack', () => {
    expect(at('LiveOrientationHero')).toBeLessThan(at('SetupSafetyNotices'));
  });

  it('renders Battery / Receiver / GPS / Sensors before the warning stack', () => {
    // They live in one grid, so the grid's position is theirs.
    const summary = SOURCE.indexOf('testID="telemetry-card-grid"');
    expect(summary).toBeGreaterThan(-1);
    expect(summary).toBeLessThan(at('SetupSafetyNotices'));
    expect(summary).toBeLessThan(at('DiagnosticsSection'));
  });

  it('keeps the summary next to the model, not after the analysis', () => {
    const summary = SOURCE.indexOf('testID="telemetry-card-grid"');
    expect(summary).toBeGreaterThan(at('LiveOrientationHero'));
    // The stability check is analysis, and no longer sits between the
    // model and the summary.
    expect(summary).toBeLessThan(at('LiveOrientationStabilityPanel'));
  });

  it('puts every diagnostic surface after the aircraft summary', () => {
    const summary = SOURCE.indexOf('testID="telemetry-card-grid"');
    for (const section of [
      'SetupSafetyNotices',
      'LiveOrientationStabilityPanel',
      'DiagnosticsSection',
      'FcToolsSection',
    ]) {
      expect(at(section)).toBeGreaterThan(summary);
    }
  });
});

describe('relocated, not deleted', () => {
  it('still renders every safety surface that moved', () => {
    // at() throws when a component is absent, so this fails loudly rather
    // than quietly passing on a screen that dropped a warning.
    expect(() => at('SetupSafetyNotices')).not.toThrow();
    expect(() => at('LiveOrientationStabilityPanel')).not.toThrow();
    expect(() => at('DiagnosticsSection')).not.toThrow();
    expect(() => at('SafetyStrip')).not.toThrow();
  });

  it('still leads with the compact readiness strip', () => {
    // The small "غير جاهز للتسليح" status stays at the top beside the
    // model; only the multi-line detail moved down. Arming state is never
    // something the operator has to go looking for.
    expect(at('SafetyStrip')).toBeLessThan(at('LiveOrientationHero'));
    expect(at('SafetyStrip')).toBeLessThan(at('SetupSafetyNotices'));
  });

  it('still passes the real warnings into the notices', () => {
    // A relocated component wired to nothing would render an empty box
    // and look like the warnings had been handled.
    expect(SOURCE).toMatch(/<SetupSafetyNotices\s+warnings=\{setupWarnings\}/);
  });
});
