/**
 * THE FIRST SCREENFUL AFTER CONNECTING.
 *
 * Battery, Receiver, GPS and Sensors are what an operator checks the
 * instant a board comes up. They were moved above the diagnostics in the
 * previous round, which fixed the ORDER but not the SIZE: four cards at
 * `spacing.lg` padding with section-title headings still filled the
 * screen, so the four facts could not be taken in together.
 *
 * These tests hold the density of the shared frame and the placement of
 * the cluster. They deliberately do not assert pixel values inside each
 * card - what each card REPORTS is not this file's business, and was not
 * changed.
 */

import * as fs from 'fs';
import * as path from 'path';

const UI = path.join(__dirname, '..');
const FRAME = fs.readFileSync(
  path.join(UI, 'components', 'setup', 'TelemetryCardFrame.tsx'),
  'utf8',
);
const SETUP = fs.readFileSync(path.join(__dirname, 'SetupScreen.tsx'), 'utf8');

describe('the shared telemetry frame is a status tile, not an article', () => {
  it('uses compact padding', () => {
    expect(FRAME).toContain('padding: spacing.md');
    expect(FRAME).not.toContain('padding: spacing.lg');
  });

  it('titles at label scale, not section-title scale', () => {
    expect(FRAME).toMatch(/title:\s*\{\s*\.\.\.typography\.label/);
  });

  it('does not spend a full line-height on the message gap', () => {
    expect(FRAME).not.toMatch(/messageText:[\s\S]{0,120}marginTop:\s*spacing\.sm/);
  });

  it('still renders the stale label - density is not a licence to hide state', () => {
    // Compacting a card must never quietly drop the fact that its
    // reading has aged.
    expect(FRAME).toContain('staleLabel');
    expect(FRAME).toContain('staleContent');
  });
});

describe('all four tiles sit in the opening cluster', () => {
  const clusterAt = SETUP.indexOf('testID="telemetry-card-grid"');

  it('the grid exists and precedes every diagnostic surface', () => {
    expect(clusterAt).toBeGreaterThan(-1);
    for (const later of [
      '<SetupSafetyNotices',
      '<LiveOrientationStabilityPanel',
      '<DiagnosticsSection',
      '<FcToolsSection',
    ]) {
      expect(SETUP.indexOf(later)).toBeGreaterThan(clusterAt);
    }
  });

  it('carries Battery, Receiver, GPS and Sensors', () => {
    for (const card of ['<BatteryCard', '<ReceiverCard', '<GpsCard', '<SensorsCard']) {
      expect(SETUP).toContain(card);
      expect(SETUP.indexOf(card)).toBeGreaterThan(clusterAt);
    }
  });

  it('keeps the model in the same cluster, above the tiles', () => {
    const hero = SETUP.indexOf('<LiveOrientationHero');
    expect(hero).toBeGreaterThan(-1);
    expect(hero).toBeLessThan(clusterAt);
  });

  it('lays the tiles out as a wrapping grid, so a wide window uses its width', () => {
    expect(SETUP).toMatch(/cardGrid:\s*\{[\s\S]{0,160}flexWrap:\s*'wrap'/);
    expect(SETUP).toMatch(/cardCell:\s*\{[\s\S]{0,80}width:\s*'50%'/);
  });
});
