/**
 * THE GPS POSITION CARD TELLS THE TRUTH, OR SAYS NOTHING.
 *
 * TWO REPORTED PROBLEMS, one of which turned out to be a real defect and
 * one a wording defect.
 *
 * 1. "«مركز الموقع الحالي» لا يعمل". There was never a control by that
 *    name. «مركز الموقع المحلي» was the position CARD'S TITLE - a noun
 *    phrase that reads like an imperative, so it invited exactly the press
 *    that did nothing. Renamed to describe what the card contains.
 *
 * 2. THE HOME ARROW POINTED NORTH WHEN NOTHING WAS KNOWN. It rotated by
 *    `home?.directionToHomeDegrees ?? 0`, so with no home reading at all
 *    it rendered a confident bearing of 0 degrees - indistinguishable
 *    from a real one, and a direction an operator could have walked in.
 *    The arrow now renders only when the flight controller has actually
 *    reported a direction.
 *
 * The map action was investigated and found already correct: a real
 * `geo:` intent on Android, a real OpenStreetMap HTTPS link in the
 * browser, disabled without a fix and never opening an empty URL. It is
 * pinned here so it cannot decay into a decorative control.
 */

import * as fs from 'fs';
import * as path from 'path';

import ar from '../../i18n/locales/ar.json';

const SCREEN = fs.readFileSync(path.join(__dirname, 'GpsScreen.tsx'), 'utf8');

/** Comments stripped, so prose about a defect is not mistaken for it. */
const EXECUTABLE = SCREEN.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the position card does not name itself like a button', () => {
  it('no longer titles itself with an action-shaped phrase', () => {
    // «مركز ...» reads as "centre the ...", which is why it was pressed.
    expect(ar.gpsSystem.positionTitle).not.toMatch(/^مركز\b/);
  });

  it('describes what it shows', () => {
    expect(ar.gpsSystem.positionTitle).toContain('الإحداثيات');
    expect(ar.gpsSystem.positionTitle).toContain('المنزل');
  });
});

describe('no fabricated bearing', () => {
  it('never falls back to zero degrees', () => {
    // The exact defect: `?? 0` inside the rotate transform rendered due
    // north as though the board had reported it.
    expect(EXECUTABLE).not.toMatch(/directionToHomeDegrees\s*\?\?\s*0/);
    expect(EXECUTABLE).not.toMatch(/rotate:\s*`\$\{home\?\./);
  });

  it('rotates only on a value the flight controller actually sent', () => {
    expect(EXECUTABLE).toContain('rotate: `${home.directionToHomeDegrees}deg`');
    // Guarded by an explicit absence branch, not by optional chaining.
    expect(EXECUTABLE).toContain('home === undefined ?');
  });

  it('still shows the dial in an unknown state rather than collapsing', () => {
    // Removing it entirely would reflow the card every time a fix
    // arrives or drops.
    expect(EXECUTABLE).toContain('gps-home-arrow-absent');
    expect(EXECUTABLE).toContain('gps-home-arrow');
  });

  it('explains the absence in words too', () => {
    expect(EXECUTABLE).toContain("t('gpsSystem.positionWaiting')");
    expect(ar.gpsSystem.positionWaiting).toContain('تثبيت');
  });
});

/**
 * LIVE, STALE AND UNAVAILABLE ARE THREE DIFFERENT THINGS.
 *
 * valueOf() returns the last value for STALE as well as FRESH, which is
 * right for most readings on this screen - an ageing satellite count is a
 * weaker fact, still worth showing with a label. A COORDINATE is the
 * exception: one that is merely old is not weaker, it is WRONG, because
 * it names a place the aircraft is no longer at.
 *
 * Before this, a link that went stale left the last known position on
 * screen rendered identically to a live one, with the map link still
 * enabled - one press from sending someone to where the aircraft used to
 * be.
 */
describe('a stale position is never presented as a live one', () => {
  it('derives liveness from FRESH, not from hasFix alone', () => {
    expect(EXECUTABLE).toContain(
      "const positionIsLive = rawTelemetry.status === 'FRESH' && raw?.hasFix === true",
    );
    expect(EXECUTABLE).toContain(
      "const homeIsLive = homeTelemetry.status === 'FRESH' && home !== undefined",
    );
  });

  it('withholds both coordinates unless the reading is live', () => {
    const gated = EXECUTABLE.match(
      /positionIsLive \? raw\.(latitude|longitude)Degrees\.toFixed\(7\) : '—'/g,
    );
    expect(gated?.length ?? 0).toBe(2);
  });

  it('disables the map link on a stale reading, not just on no fix', () => {
    expect(EXECUTABLE).toContain('disabled={!positionIsLive}');
    // And the handler refuses independently of the prop.
    expect(EXECUTABLE).toContain(
      "if (rawTelemetry.status !== 'FRESH' || raw?.hasFix !== true) return;",
    );
  });

  it('withholds the home bearing on a stale reading', () => {
    expect(EXECUTABLE).toContain('{!homeIsLive ? (');
  });

  it('says which of the three states it is in', () => {
    expect(EXECUTABLE).toContain("t('gpsSystem.positionStale')");
    expect(EXECUTABLE).toContain("t('gpsSystem.positionWaiting')");
    expect(EXECUTABLE).toContain("t('gpsSystem.positionReady')");
    // The stale wording must name the actual risk, not just say "old".
    expect(ar.gpsSystem.positionStale).toContain('متأخرة');
    expect(ar.gpsSystem.positionStale).toContain('موقع الطائرة');
  });
});

describe('the map action is real, and stays real', () => {
  it('is disabled without a usable position and refuses to build a URL', () => {
    // The gate got STRICTER: it was `hasFix` alone, which let a stale
    // reading through. `positionIsLive` requires a fix AND a fresh
    // reading - see the staleness block below.
    expect(EXECUTABLE).toContain('disabled={!positionIsLive}');
    // The handler re-checks rather than trusting the disabled prop.
    expect(EXECUTABLE).toContain(
      "if (rawTelemetry.status !== 'FRESH' || raw?.hasFix !== true) return;",
    );
  });

  it('calls the real platform opener with the real coordinates', () => {
    expect(EXECUTABLE).toContain('openMapLocation({');
    expect(EXECUTABLE).toContain('latitudeDegrees: raw.latitudeDegrees');
    expect(EXECUTABLE).toContain('longitudeDegrees: raw.longitudeDegrees');
  });

  it('has a platform implementation on both sides', () => {
    const platforms = path.join(__dirname, '..', '..', 'platforms');
    const android = fs.readFileSync(path.join(platforms, 'mapLink.ts'), 'utf8');
    const web = fs.readFileSync(path.join(platforms, 'mapLink.web.ts'), 'utf8');
    // Android hands the coordinate to whatever map app is installed.
    expect(android).toContain('geo:');
    expect(android).toContain('Linking.openURL');
    // The browser cannot handle geo:, so it opens a real HTTPS map.
    expect(web).toContain('https://www.openstreetmap.org/');
    expect(web).toContain('window.open');
    // The aircraft's position must not leak through the opened tab.
    expect(web).toContain('noopener,noreferrer');
  });
});
