/**
 * THE TARGET CATALOG IS THE OFFICIAL DATASET - not a board list we wrote.
 *
 * THE CONCERN THIS ANSWERS. The flasher was exercised on a couple of
 * SpeedyBee boards and a Kakute, which is exactly the situation in which
 * a product quietly grows a two-board shape. These tests hold the
 * architecture open: whatever GET /api/targets returns is what the
 * selector offers, and identification matches against that same dataset.
 *
 * WHAT IS AND IS NOT PROVEN HERE. This proves the CATALOG PATH - no
 * vendor allow-list, no MCU allow-list, no name-shape assumption, no
 * silent truncation. It does not claim any physical board was flashed;
 * hardware truth needs a bench. The fixtures below mirror the official
 * response shape (target/group/manufacturer/mcu rows) and deliberately
 * mix vendor families with a deliberately unknown vendor: if the code
 * ever grew a whitelist, the unknown row would be the first to vanish.
 *
 * The container this runs in cannot reach build.betaflight.com (egress
 * policy), so these are fixtures rather than a live capture - which is
 * also what makes the test deterministic in CI.
 */

import {filterAndSortTargets} from './firmwareCatalog';
import type {BetaflightTarget} from './buildApi';
import {BetaflightBuildApi} from './buildApi';

/**
 * Representative rows spanning several vendor families plus an
 * intentionally unfamiliar one. The assertions never depend on any
 * particular board existing - only on every returned row surviving.
 */
const CATALOG: readonly BetaflightTarget[] = [
  {target: 'KAKUTEH7', group: 'supported', manufacturer: 'HBRO', mcu: 'STM32H743'},
  {target: 'KAKUTEF7', group: 'supported', manufacturer: 'HBRO', mcu: 'STM32F745'},
  {target: 'SPEEDYBEEF405V3', group: 'supported', manufacturer: 'SPBE', mcu: 'STM32F405'},
  {target: 'SPEEDYBEEF7V3', group: 'supported', manufacturer: 'SPBE', mcu: 'STM32F722'},
  {target: 'MATEKF405TE', group: 'supported', manufacturer: 'MTKS', mcu: 'STM32F405'},
  {target: 'MATEKH743', group: 'supported', manufacturer: 'MTKS', mcu: 'STM32H743'},
  {target: 'IFLIGHT_BLITZ_F7_PRO', group: 'supported', manufacturer: 'IFRC', mcu: 'STM32F722'},
  {target: 'MAMBAF722_2022B', group: 'supported', manufacturer: 'DIAT', mcu: 'STM32F722'},
  {target: 'BETAFLIGHTF4', group: 'legacy', manufacturer: '', mcu: 'STM32F405'},
  {target: 'STM32F411', group: 'unsupported', manufacturer: '', mcu: 'STM32F411'},
  // The row that would disappear first if anyone added an allow-list.
  {target: 'ZZZ_VENDOR_NOT_IN_ANY_LIST_H743', group: 'unsupported', manufacturer: 'ZZZQ', mcu: 'STM32H743'},
];

describe('the selector accepts the entire official dataset', () => {
  it('returns EVERY row for an empty query - nothing is filtered by vendor', () => {
    const all = filterAndSortTargets(CATALOG, '');
    expect(all).toHaveLength(CATALOG.length);
    for (const row of CATALOG) {
      expect(all.map(item => item.target)).toContain(row.target);
    }
  });

  it('keeps an unknown vendor exactly like a familiar one', () => {
    const unknown = filterAndSortTargets(CATALOG, 'ZZZ_VENDOR');
    expect(unknown.map(item => item.target)).toEqual(['ZZZ_VENDOR_NOT_IN_ANY_LIST_H743']);
  });

  it.each([
    ['KAKUTE', ['KAKUTEF7', 'KAKUTEH7']],
    ['SPEEDYBEE', ['SPEEDYBEEF405V3', 'SPEEDYBEEF7V3']],
    ['MATEK', ['MATEKF405TE', 'MATEKH743']],
    ['IFLIGHT', ['IFLIGHT_BLITZ_F7_PRO']],
    ['MAMBA', ['MAMBAF722_2022B']],
  ])('finds the %s family by name', (query, expected) => {
    expect(filterAndSortTargets(CATALOG, query).map(item => item.target).sort()).toEqual(
      [...expected].sort(),
    );
  });

  it('searches the vendor and MCU metadata the API supplies, not just the name', () => {
    expect(filterAndSortTargets(CATALOG, 'MTKS').map(item => item.target).sort()).toEqual([
      'MATEKF405TE',
      'MATEKH743',
    ]);
    expect(filterAndSortTargets(CATALOG, 'STM32H743').map(item => item.target).sort()).toEqual([
      'KAKUTEH7',
      'MATEKH743',
      'ZZZ_VENDOR_NOT_IN_ANY_LIST_H743',
    ]);
  });

  it('orders supported first, then unsupported, then legacy - and never drops a group', () => {
    const ordered = filterAndSortTargets(CATALOG, '');
    const groups = ordered.map(item => item.group);
    expect(groups.indexOf('supported')).toBeLessThan(groups.indexOf('unsupported'));
    expect(groups.indexOf('unsupported')).toBeLessThan(groups.indexOf('legacy'));
    expect(new Set(groups)).toEqual(new Set(['supported', 'unsupported', 'legacy']));
  });

  it('accepts a catalog far larger than any hand-maintained list', () => {
    const many: BetaflightTarget[] = Array.from({length: 2000}, (_, index) => ({
      target: `GENERATED_TARGET_${String(index).padStart(4, '0')}`,
      group: index % 3 === 0 ? 'supported' : 'unsupported',
      manufacturer: `VEND${index % 37}`,
      mcu: index % 2 === 0 ? 'STM32F405' : 'STM32H743',
    }));
    expect(filterAndSortTargets(many, '')).toHaveLength(2000);
  });
});

describe('loadTargets passes the server dataset through untouched', () => {
  function apiReturning(payload: unknown): BetaflightBuildApi {
    return new BetaflightBuildApi(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
  }

  it('keeps every row the server sent, with its metadata intact', async () => {
    const targets = await apiReturning(CATALOG).loadTargets();
    expect(targets).toHaveLength(CATALOG.length);
    expect(targets.find(item => item.target === 'KAKUTEH7')).toMatchObject({
      manufacturer: 'HBRO',
      mcu: 'STM32H743',
      group: 'supported',
    });
    // Unknown-shaped extra fields are preserved rather than stripped, so a
    // future API field cannot be lost on the way to the screen.
    const extra = await apiReturning([{target: 'X', futureField: 42}]).loadTargets();
    expect((extra[0] as {futureField?: number}).futureField).toBe(42);
  });

  it('drops only rows that are not targets at all', async () => {
    const targets = await apiReturning([
      {target: 'KAKUTEH7'},
      {noTargetField: true},
      null,
      'not-an-object',
    ]).loadTargets();
    expect(targets.map(item => item.target)).toEqual(['KAKUTEH7']);
  });

  it('requests the official catalog endpoint, unfiltered', async () => {
    const seen: string[] = [];
    const api = new BetaflightBuildApi(async input => {
      seen.push(String(input));
      return new Response('[]', {status: 200});
    });
    await api.loadTargets();
    expect(seen[0]).toBe('https://build.betaflight.com/api/targets');
    // No query string, so no server-side narrowing either.
    expect(seen[0]).not.toContain('?');
  });
});

describe('no vendor-specific restriction exists in the flasher source', () => {
  it('names no board vendor as a gate in the catalog or screen code', () => {
    // A source-level guard: the catalog path must not learn a vendor name.
    const {readFileSync} = require('fs') as typeof import('fs');
    const {join} = require('path') as typeof import('path');
    const sources = [
      join(__dirname, 'firmwareCatalog.ts'),
      join(__dirname, 'buildApi.ts'),
      join(__dirname, 'standardBuildConfiguration.ts'),
      join(__dirname, '..', '..', 'ui', 'screens', 'FirmwareFlasherSimpleScreen.tsx'),
    ];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const vendor of ['SPEEDYBEE', 'KAKUTE', 'MATEK', 'IFLIGHT', 'MAMBA', 'HOLYBRO']) {
        expect(text.toUpperCase()).not.toContain(vendor);
      }
    }
  });
});
