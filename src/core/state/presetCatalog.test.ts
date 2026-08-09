import {
  commandsForPreset,
  expandFirmwarePresetIncludes,
  filterCompatiblePresets,
  parseFirmwarePresetDocument,
  parseFirmwarePresetIndex,
  presetFirmwareFamily,
  sha256Hex,
} from './presetCatalog';

const HASH = 'a'.repeat(64);

function index() {
  return parseFirmwarePresetIndex({
    majorVersion: 1,
    minorVersion: 0,
    presets: [
      {
        fullPath: 'presets/2025.12/tune/a.txt',
        hash: HASH,
        title: 'A',
        firmware_version: ['2025.12'],
        category: 'TUNE',
        status: 'OFFICIAL',
        keywords: ['5in'],
        priority: 10,
      },
      {
        fullPath: 'presets/4.5/rates/b.txt',
        hash: HASH,
        title: 'B',
        firmware_version: ['4.5'],
        category: 'RATES',
        status: 'COMMUNITY',
        keywords: [],
      },
    ],
  });
}

describe('firmware preset catalog', () => {
  it('validates the official index shape and filters by the FC-reported family', () => {
    const parsed = index();
    expect(
      filterCompatiblePresets(parsed, '2025.12.5').map(item => item.title),
    ).toEqual(['A']);
    expect(
      filterCompatiblePresets(parsed, '4.5.1-RC1').map(item => item.title),
    ).toEqual(['B']);
    expect(presetFirmwareFamily('not-a-version')).toBeUndefined();
  });

  it.each([
    '../x.txt',
    'https://evil/x.txt',
    'presets//x.txt',
    '/presets/x.txt',
  ])('rejects unsafe repository path %s', fullPath => {
    expect(() =>
      parseFirmwarePresetIndex({
        majorVersion: 1,
        minorVersion: 0,
        presets: [
          {
            fullPath,
            hash: HASH,
            title: 'X',
            firmware_version: ['2025.12'],
            category: 'TUNE',
            status: 'OFFICIAL',
          },
        ],
      }),
    ).toThrow(/مسار/);
  });

  it('parses checked, unchecked and exclusive options, then removes unselected regions', () => {
    const document = parseFirmwarePresetDocument(
      [
        '#$ DESCRIPTION: tune',
        '#$ OPTION_GROUP BEGIN: (EXCLUSIVE) Rates',
        '#$ OPTION BEGIN (CHECKED): Smooth',
        'set rates_type = ACTUAL',
        '#$ OPTION END',
        '#$ OPTION BEGIN (UNCHECKED): Fast',
        'set rates_type = BETAFLIGHT',
        '#$ OPTION END',
        '#$ OPTION_GROUP END',
        'set dterm_lpf1_type = PT1',
        'save',
      ].join('\n'),
    );
    expect(document.options).toEqual([
      {
        name: 'Smooth',
        checkedByDefault: true,
        group: 'Rates',
        exclusive: true,
      },
      {
        name: 'Fast',
        checkedByDefault: false,
        group: 'Rates',
        exclusive: true,
      },
    ]);
    expect(commandsForPreset(document.lines, new Set(['Fast']))).toEqual([
      'set rates_type = BETAFLIGHT',
      'set dterm_lpf1_type = PT1',
    ]);
  });

  it('expands nested includes in position and rejects cycles', async () => {
    const files: Record<string, string> = {
      'presets/a.txt': 'set a = 1\n#$ INCLUDE: presets/b.txt',
      'presets/b.txt': 'set b = 2',
      'presets/cycle.txt': '#$ INCLUDE: presets/cycle.txt',
    };
    await expect(
      expandFirmwarePresetIncludes(
        ['before', '#$ INCLUDE: presets/a.txt', 'after'],
        async path => files[path],
      ),
    ).resolves.toEqual(['before', 'set a = 1', 'set b = 2', 'after']);
    await expect(
      expandFirmwarePresetIncludes(
        ['#$ INCLUDE: presets/cycle.txt'],
        async path => files[path],
      ),
    ).rejects.toThrow(/حلقة/);
  });

  it('matches published SHA-256 vectors without platform crypto APIs', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
