/**
 * WHAT AN OPERATOR SEES THE MOMENT THEY CONNECT.
 *
 * The Setup screen once opened with a stack of safety notices and
 * readiness diagnostics, with the aircraft's own state underneath all of
 * it - the analysis of a thing before the thing. That was fixed, and
 * then the fix was measured: on a 1920px desktop the model opened the
 * page at y=174 but the battery was still at y=1403 and the sensor chips
 * at y=1849, because "above the diagnostics" is not the same as "with
 * the model".
 *
 * SETUP R9 settles it. The order is:
 *
 *     SetupChromeBar        48px fixed: back, title, dot, disconnect
 *     SetupStatusBar        connection, board, firmware, API, arming,
 *                           battery, detected sensors
 *     SafetyStrip           only when ARMED or BLOCKED
 *     LiveOrientationHero   the 3D model with live heading/pitch/roll
 *     SetupInfoGrid         Status / GPS / Build
 *     BoardAlignmentCard    a feature, kept, after the live information
 *     ...advanced
 *
 * This is a source-order test, deliberately. The component tests next
 * door pin the RENDERED order for a connected session, which is the
 * stronger assertion; this one guards the structure that produces it, so
 * a future edit that moves a block back cannot pass merely because a
 * session happened not to render one of the sections.
 *
 * THE HALF THAT MATTERS MOST is the "relocated, not deleted" block.
 * "Put the warnings later" is one keystroke away from "delete the
 * warnings", and those are completely different changes.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, 'SetupScreen.tsx'),
  'utf8',
);

/** SetupScreen with every JSX comment blanked, so a component named in
 * prose cannot be mistaken for a component that is rendered. */
const EXECUTABLE = SOURCE.replace(/\{\/\*[\s\S]*?\*\/\}/g, match =>
  ' '.repeat(match.length),
);

/** Position of a component's first JSX use, comments stripped. */
function at(component: string): number {
  const index = EXECUTABLE.indexOf(`<${component}`);
  if (index < 0) {
    throw new Error(`<${component}> is not rendered by SetupScreen at all.`);
  }
  return index;
}

describe('the critical status comes before the 3D model', () => {
  it('renders the compact status area above the hero', () => {
    expect(at('SetupStatusBar')).toBeLessThan(at('LiveOrientationHero'));
  });

  /**
   * THE REQUIREMENT THIS ROUND WAS GIVEN, stated as an assertion: an
   * operator must see the battery and the detected sensors before the
   * model, not two screens after it. Both are props of the status bar,
   * so their position is its position.
   */
  it('feeds the status area the battery and the sensor summary', () => {
    expect(EXECUTABLE).toMatch(/<SetupStatusBar[\s\S]{0,400}battery=\{batterySummary\}/);
    expect(EXECUTABLE).toMatch(/<SetupStatusBar[\s\S]{0,400}sensors=\{sensorSummary\}/);
  });

  it('puts the fixed chrome above everything and keeps it tiny', () => {
    expect(at('SetupChromeBar')).toBeLessThan(at('ScrollView'));
    expect(at('SetupChromeBar')).toBeLessThan(at('SetupStatusBar'));
  });
});

describe('the measured values come immediately after the model', () => {
  it('renders the information grid after the hero and before every diagnostic surface', () => {
    expect(at('SetupInfoGrid')).toBeGreaterThan(at('LiveOrientationHero'));
    for (const later of [
      'BoardAlignmentCard',
      'SetupSafetyNotices',
      'LiveOrientationStabilityPanel',
      'DiagnosticsSection',
      'FcToolsSection',
    ]) {
      expect(at(later)).toBeGreaterThan(at('SetupInfoGrid'));
    }
  });

  /**
   * BOARD ALIGNMENT IS A FEATURE AND STAYS ONE. It moved below the live
   * information rather than being removed: it used to sit between the
   * model and everything measured, which put a configuration form in the
   * middle of a reading surface.
   */
  it('keeps board alignment mounted, after the live information', () => {
    expect(() => at('BoardAlignmentCard')).not.toThrow();
    expect(at('BoardAlignmentCard')).toBeGreaterThan(at('SetupInfoGrid'));
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

  it('still passes the real warnings into the notices', () => {
    // A relocated component wired to nothing would render an empty box
    // and look like the warnings had been handled.
    expect(SOURCE).toMatch(/<SetupSafetyNotices\s+warnings=\{setupWarnings\}/);
  });

  /**
   * THE STRIP BECAME AN ALERT. It used to render in all four readiness
   * states, so "arming state not confirmed" occupied a 74px full-width
   * warning on a board where nothing was wrong. It is now gated on
   * isSetupSafetyStripWarranted - ARMED or BLOCKED - and the steady-state
   * readiness reads as a chip in the status area instead.
   *
   * NOTHING WAS DOWNGRADED to achieve that: the same ArmingReadiness
   * object still drives the strip, the chip, the FC-tool gate and the
   * diagnostics list.
   */
  it('gates the strip on a real problem, and still hands it the canonical readiness', () => {
    expect(EXECUTABLE).toMatch(
      /isSetupSafetyStripWarranted\(armingReadiness\)[\s\S]{0,120}<SafetyStrip\s+readiness=\{armingReadiness\}/,
    );
  });

  it('still shows arming state above the model, in the status area', () => {
    expect(EXECUTABLE).toMatch(
      /<SetupStatusBar[\s\S]{0,400}armingReadiness=\{armingReadiness\}/,
    );
    expect(at('SetupStatusBar')).toBeLessThan(at('LiveOrientationHero'));
  });

  /**
   * The four screen shortcuts the deleted cards carried are still
   * reachable - as a compact link row under the grid rather than as four
   * card-sized touch targets.
   */
  it('keeps every owner-screen shortcut wired', () => {
    for (const callback of [
      'onOpenPower',
      'onOpenReceiver',
      'onOpenGps',
      'onOpenSensors',
    ]) {
      expect(EXECUTABLE).toMatch(
        new RegExp(`<SetupInfoGrid[\\s\\S]{0,600}${callback}=\\{${callback}\\}`),
      );
    }
  });
});
