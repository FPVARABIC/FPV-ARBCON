import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  MSP2_GET_LED_STRIP_CONFIG_VALUES,
  MSP2_SET_LED_STRIP_CONFIG_VALUES,
  MSP_LED_COLORS,
  MSP_LED_STRIP_CONFIG,
  MSP_LED_STRIP_MODECOLOR,
  MSP_SET_LED_COLORS,
  MSP_SET_LED_STRIP_CONFIG,
  MSP_SET_LED_STRIP_MODECOLOR,
} from './ledStripCommands';

describe('LED command ids', () => {
  it('are the eight the firmware headers declare', () => {
    expect(MSP_LED_COLORS).toBe(46);
    expect(MSP_SET_LED_COLORS).toBe(47);
    expect(MSP_LED_STRIP_CONFIG).toBe(48);
    expect(MSP_SET_LED_STRIP_CONFIG).toBe(49);
    expect(MSP_LED_STRIP_MODECOLOR).toBe(127);
    expect(MSP_SET_LED_STRIP_MODECOLOR).toBe(221);
    expect(MSP2_GET_LED_STRIP_CONFIG_VALUES).toBe(0x3008);
    expect(MSP2_SET_LED_STRIP_CONFIG_VALUES).toBe(0x3009);
  });

  it('are eight distinct values', () => {
    const ids = [
      MSP_LED_COLORS, MSP_SET_LED_COLORS, MSP_LED_STRIP_CONFIG, MSP_SET_LED_STRIP_CONFIG,
      MSP_LED_STRIP_MODECOLOR, MSP_SET_LED_STRIP_MODECOLOR,
      MSP2_GET_LED_STRIP_CONFIG_VALUES, MSP2_SET_LED_STRIP_CONFIG_VALUES,
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Two command names sharing one id is the kind of defect that produces a
   * response routed to the wrong decoder, and it is invisible in review.
   * Reading the whole registry keeps "no collision" a maintained fact rather
   * than a check somebody ran once.
   */
  it('collide with nothing else in the command registry', () => {
    const dir = __dirname;
    const byId = new Map<number, string[]>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      const source = readFileSync(join(dir, file), 'utf8');
      for (const match of source.matchAll(
        /^export const (MSP2?_[A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+|\d+);/gm,
      )) {
        const value = Number(match[2]);
        const names = byId.get(value) ?? [];
        names.push(`${match[1]} (${file})`);
        byId.set(value, names);
      }
    }
    const collisions = [...byId.entries()].filter(([, names]) => names.length > 1);
    expect(collisions).toEqual([]);
    /* A rule that matched nothing would pass vacuously. */
    expect(byId.size).toBeGreaterThan(100);
    for (const id of [46, 47, 48, 49, 127, 221, 0x3008, 0x3009]) {
      expect(byId.get(id)).toHaveLength(1);
    }
  });
});
