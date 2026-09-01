/**
 * THE OSD SURFACE SHOWS NO READINGS, AND CANNOT START SHOWING THEM.
 *
 * =====================================================================
 * THE QUESTION THIS ANSWERS
 * =====================================================================
 *
 * "Is the voltage I see in my goggles real?" For this application the
 * honest answer is stronger than yes: this application never renders a
 * voltage at all. Every OSD VALUE - volts, amps, mAh, RSSI, link
 * quality, satellites, speed, altitude, distance to home - is computed
 * and drawn by the flight controller, from its own sensors, on its own
 * video output. What this application decides is which element is
 * switched on and which character cell it occupies.
 *
 * That distinction is the entire safety argument, so it is enforced
 * rather than asserted:
 *
 *   1. The preview draws element NAMES, never values. A preview showing
 *      "16.8V" would be fabricated telemetry from a board that has said
 *      nothing of the kind - and it would look exactly like the real
 *      thing to a pilot checking their layout.
 *
 *   2. The OSD module graph contains no telemetry source at all. Not
 *      "does not currently read one" - cannot, because nothing in the
 *      graph imports one.
 *
 *   3. The preview backdrop is a photograph and reaches no encoder.
 *
 * osdPreviewBackground.ts has claimed this file exists since it was
 * written. It did not. A comment asserting a guarantee that nothing
 * enforces is the same shape of defect as a deadline nobody arms.
 */

import {createHash} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  OSD_ELEMENT_TOKENS,
  osdElementToken,
} from '../../../core/state/osdConfigurationModel';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const read = (file: string): string =>
  fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Everything the OSD screen renders or draws with. */
const OSD_UI_FILES: readonly string[] = [
  'src/ui/screens/OsdScreen.tsx',
  'src/ui/screens/osd/OsdPreview.tsx',
  'src/ui/screens/osd/osdPreviewBackground.ts',
  'src/core/state/osdLayoutGeometry.ts',
  'src/core/state/osdConfigurationModel.ts',
];

/**
 * Modules that carry live flight data. If any OSD file reaches one of
 * these, the preview has gained the ability to show a reading - which is
 * the moment this test must fail.
 */
const TELEMETRY_SOURCES: readonly string[] = [
  'useTelemetryValue',
  'MspTelemetryScheduler',
  'telemetryTypes',
  'batteryTelemetry',
  'motorDiagnosticsTelemetry',
  'decodeSensorTelemetry',
  'decodeDetailedGps',
  'gpsPositionQuality',
  'MSP_ANALOG',
  'MSP_RAW_GPS',
  'MSP_BATTERY_STATE',
];

describe('the OSD preview cannot show a value the flight controller did not send', () => {
  it.each(OSD_UI_FILES.map(file => [file] as const))(
    '%s imports no telemetry source',
    file => {
      const source = read(file);
      const found = TELEMETRY_SOURCES.filter(name => source.includes(name));
      expect(`${file} telemetry imports`).toBe(
        `${file} telemetry imports${found.length > 0 ? `: ${found.join(', ')}` : ''}`,
      );
    },
  );

  /**
   * The preview's only text content is the element token. Asserted on
   * the source because it is a STRUCTURAL claim: there is one text node
   * in the element renderer and one expression inside it.
   */
  it('draws the element token and nothing else inside an element', () => {
    const preview = read('src/ui/screens/osd/OsdPreview.tsx');
    expect(preview).toContain('{osdElementToken(element.index)}');
    /* No number is ever FORMATTED here - formatting is the step that
       turns an internal figure into something that reads as a
       measurement. */
    expect(preview).not.toMatch(/toFixed\(/);
    expect(preview).not.toMatch(/toLocaleString\(/);
    /* And no physical unit appears anywhere in the file, so there is
       nothing for a number to be glued to. (CSS percentages are
       excluded deliberately: `${fraction.left}%` is a layout position,
       not a reading, and matching it would make this check cry wolf
       until somebody deleted it.) */
    const units = ['mAh', 'dBm', 'km/h', 'mph', ' V<', ' A<', 'volt', 'amp'];
    expect(units.filter(unit => preview.includes(unit))).toEqual([]);
  });

  /**
   * Every token must read as a NAME. A token that looked like a reading
   * - digits, a decimal point, a unit - would defeat the whole design
   * even with the element table perfectly correct.
   */
  it('gives no element a token that could be mistaken for a reading', () => {
    const looksLikeAReading = OSD_ELEMENT_TOKENS.filter(token =>
      /\d+[.,]\d/.test(token) || /^\d+\s*(V|A|%|m|km\/h|dBm)$/.test(token),
    );
    expect(looksLikeAReading).toEqual([]);
  });

  it('never invents a name for an element the firmware did not describe', () => {
    // Past the known table the answer is a neutral placeholder, not a
    // plausible-looking guess that an operator would trust.
    const beyond = OSD_ELEMENT_TOKENS.length + 5;
    expect(osdElementToken(beyond)).toBe(`EL${beyond + 1}`);
  });

  /**
   * The backdrop is a photograph. It must not reach any code that talks
   * to the flight controller - the comment in that module has promised
   * this from the start, and this is the promise being kept.
   */
  it('keeps the preview backdrop out of every encoder, decoder and MSP path', () => {
    const walk = (dir: string, hits: string[]): string[] => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full, hits);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const relative = path.relative(ROOT, full);
        if (relative.includes('osd/osdPreviewBackground')) continue;
        if (!fs.readFileSync(full, 'utf8').includes('osdPreviewBackground')) {
          continue;
        }
        hits.push(relative);
      }
      return hits;
    };
    const importers = walk(path.join(ROOT, 'src'), []).filter(
      file => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'),
    );
    // Exactly one production importer: the preview that draws it.
    expect(importers).toEqual(['src/ui/screens/osd/OsdPreview.tsx']);
  });

  /**
   * And the backdrop is a photograph, not a screenshot of somebody
   * else's OSD. A JPEG of a flight with the overlay already burned in
   * would put fabricated numbers on screen with no code involved at all.
   */
  it('carries the backdrop as the exact bytes it documents', () => {
    const source = read('src/ui/screens/osd/osdPreviewBackground.ts');
    const declared = /sha-256:\s*([0-9a-f]{64})/.exec(source);
    expect(declared).not.toBeNull();

    const base64 = [...source.matchAll(/'([A-Za-z0-9+/=]{20,})'/g)]
      .map(match => match[1])
      .join('')
      .replace(/^data:image\/jpeg;base64,/, '');
    const bytes = Buffer.from(base64, 'base64');
    // A real JPEG, of the documented size, with the documented hash.
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(bytes.length).toBe(64796);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(declared?.[1]);
  });
});
