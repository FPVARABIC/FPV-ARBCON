/**
 * THE FIRST SCREENFUL AFTER CONNECTING.
 *
 * Battery, Receiver/RSSI, GPS and the detected sensors are what an
 * operator checks the instant a board comes up. Two earlier rounds fixed
 * the ORDER and then the CARD PADDING, and neither was enough: four
 * elevated cards, each with its own title, shadow and border, still
 * needed most of a viewport to report eleven numbers, so on a 1920px
 * desktop the battery landed at y=1403 and the sensor chips at y=1849.
 *
 * SETUP R9 replaced the cards outright. The facts now live in two
 * places, both dense and both near the model:
 *
 *   SetupStatusBar  - above the 3D: connection, board, firmware, API,
 *                     arming, battery, and every detected sensor.
 *   SetupInfoGrid   - below the 3D: Status / GPS / Build as three
 *                     columns of 22px label-and-value rows.
 *
 * These tests hold that density and that placement. They deliberately do
 * not assert what each surface REPORTS - the wire truth behind every
 * value is tested against the real MSP pipeline elsewhere.
 */

import * as fs from 'fs';
import * as path from 'path';

const UI = path.join(__dirname, '..');
const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(...parts), 'utf8');

const STATUS_BAR = read(UI, 'components', 'setup', 'SetupStatusBar.tsx');
const INFO_GRID = read(UI, 'components', 'setup', 'SetupInfoGrid.tsx');
const CHROME = read(UI, 'components', 'setup', 'SetupChromeBar.tsx');
const SETUP = read(__dirname, 'SetupScreen.tsx');

describe('the compact status area is a strip, not a stack of cards', () => {
  it('spends no more than the small spacing tokens on its own padding', () => {
    // spacing.lg (18) was what each deleted card used. Nothing in the
    // status strip may reach for it: seven sensor chips at card padding
    // is the 534px tower this round exists to remove.
    expect(STATUS_BAR).not.toContain('spacing.lg');
    expect(STATUS_BAR).not.toContain('spacing.xl');
  });

  it('carries no elevation, shadow or card geometry', () => {
    for (const cardism of ['shadowRadius', 'shadowOpacity', 'elevation:']) {
      expect(`${cardism} in SetupStatusBar`).toBe(
        `${cardism} in SetupStatusBar${STATUS_BAR.includes(cardism) ? ' (present)' : ''}`,
      );
    }
  });

  /**
   * THE SIZE CENSUS, ENFORCED. The round that produced this file
   * required that nothing be enlarged to fill a desktop. Every text
   * style in the status strip is caption (13px) or helper (12px) - the
   * two smallest tokens in the scale - so a later edit cannot quietly
   * promote a chip to title size and call it emphasis.
   */
  it('uses only the two smallest type tokens', () => {
    const used = [...STATUS_BAR.matchAll(/\.\.\.typography\.(\w+)/g)].map(
      match => match[1],
    );
    expect(used.length).toBeGreaterThan(0);
    expect([...new Set(used)].sort()).toEqual(['caption', 'helper']);
  });

  it('flows its chips horizontally rather than stacking them', () => {
    expect(STATUS_BAR).toMatch(/chipRow:\s*\{[\s\S]{0,200}flexWrap:\s*'wrap'/);
    expect(STATUS_BAR).toMatch(/sensorRow:\s*\{[\s\S]{0,200}flexWrap:\s*'wrap'/);
  });

  it('keeps every sensor chip on one line, so GYRO and OPTICALFLOW cannot break mid-word on a phone', () => {
    expect(STATUS_BAR).toMatch(/sensorToken[\s\S]{0,200}numberOfLines=\{1\}/);
  });
});

describe('the fixed chrome is a toolbar, not a masthead', () => {
  /**
   * THE MEASUREMENT THIS REPLACES: TopSystemBar was 139px at 1920, 1366
   * and 390 alike, in colors.accent, across the full width. A fixed row
   * is allowed to hold the two things that must survive scrolling - the
   * way back and the way to disconnect - and nothing else.
   */
  it('declares an explicit small height', () => {
    const height = /height:\s*(\d+)/.exec(CHROME);
    expect(height).not.toBeNull();
    expect(Number(height?.[1])).toBeLessThanOrEqual(56);
  });

  it('keeps the 44px touch target the controls always had', () => {
    expect(CHROME).toContain('minWidth: 44');
    expect(CHROME).toContain('minHeight: 44');
  });

  it('is not painted as a masthead', () => {
    expect(CHROME).not.toContain('backgroundColor: colors.accent');
  });

  it('holds only back, title, a connection dot and disconnect', () => {
    const testIDs = [...CHROME.matchAll(/testID="([^"]+)"/g)].map(m => m[1]);
    expect(testIDs.sort()).toEqual([
      'setup-chrome-back',
      'setup-chrome-bar',
      'setup-chrome-connection-dot',
      'setup-chrome-disconnect',
    ]);
  });
});

describe('the information grid uses width, not height', () => {
  it('is a wrapping row that becomes three columns on a desktop', () => {
    expect(INFO_GRID).toMatch(/grid:\s*\{[\s\S]{0,200}flexWrap:\s*'wrap'/);
    expect(INFO_GRID).toMatch(/columnThird:\s*\{flexBasis:\s*'3\d%'\}/);
    expect(INFO_GRID).toMatch(/columnHalf:\s*\{flexBasis:\s*'4\d%'\}/);
  });

  it('rows are a single dense line, not a card', () => {
    expect(INFO_GRID).toMatch(/row:\s*\{[\s\S]{0,300}minHeight:\s*22/);
    for (const cardism of ['shadowRadius', 'shadowOpacity', 'elevation:']) {
      expect(`${cardism} in SetupInfoGrid`).toBe(
        `${cardism} in SetupInfoGrid${INFO_GRID.includes(cardism) ? ' (present)' : ''}`,
      );
    }
  });

  it('never labels a column heading above the label token', () => {
    expect(INFO_GRID).toMatch(/columnTitle:\s*\{\s*\.\.\.typography\.label/);
    expect(INFO_GRID).not.toContain('...typography.title');
    expect(INFO_GRID).not.toContain('...typography.display');
    expect(INFO_GRID).not.toContain('...typography.sectionTitle');
  });
});

describe('the cards this round deleted cannot come back', () => {
  const GONE = [
    'TopSystemBar',
    'BatteryCard',
    'SensorsCard',
    'ReceiverCard',
    'GpsCard',
    'FlightControllerCard',
    'SetupSummaryLink',
    'TelemetryCardFrame',
  ];

  it.each(GONE.map(name => [name] as const))(
    '%s has no source file left',
    name => {
      const file = path.join(UI, 'components', 'setup', `${name}.tsx`);
      expect(`${name} exists: ${fs.existsSync(file)}`).toBe(
        `${name} exists: false`,
      );
    },
  );

  it('SetupScreen references none of them', () => {
    for (const name of GONE) {
      expect(`SetupScreen mentions ${name}`).toBe(
        `SetupScreen mentions ${name}${SETUP.includes(`<${name}`) ? ' (rendered)' : ''}`,
      );
    }
  });
});
