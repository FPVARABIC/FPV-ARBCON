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
  ])('DROPS unsafe repository path %s, and never makes it downloadable', fullPath => {
    // Security still fails CLOSED. The path and the hash decide which file we
    // download and turn into CLI commands, so an entry that fails either is
    // removed from the catalogue entirely - it just no longer takes the other
    // ten thousand entries down with it.
    const parsed = parseFirmwarePresetIndex({
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
        {
          fullPath: 'presets/ok.txt',
          hash: HASH,
          title: 'OK',
          firmware_version: ['2025.12'],
          category: 'TUNE',
          status: 'OFFICIAL',
        },
      ],
    });
    expect(parsed.presets.map(item => item.fullPath)).toEqual(['presets/ok.txt']);
    expect(parsed.rejectedCount).toBe(1);
  });

  it('DROPS a malformed hash for the same reason', () => {
    const parsed = parseFirmwarePresetIndex({
      majorVersion: 1,
      minorVersion: 0,
      presets: [
        {fullPath: 'presets/x.txt', hash: 'not-a-hash', title: 'X',
         firmware_version: ['2025.12'], category: 'TUNE', status: 'OFFICIAL'},
      ],
    });
    expect(parsed.presets).toHaveLength(0);
    expect(parsed.rejectedCount).toBe(1);
  });

  it('a category or status this build has never seen does NOT empty the catalogue', () => {
    // This index is remote data on Betaflight's own release schedule, and the
    // pinned Configurator validates none of it - loadIndex is res.json()
    // straight into _index. Rejecting the document over one new word would
    // have shown an empty Presets screen the day a category was added
    // upstream, with nothing to tell the operator why.
    const parsed = parseFirmwarePresetIndex({
      majorVersion: 1,
      minorVersion: 0,
      presets: [
        {fullPath: 'presets/new.txt', hash: HASH, title: 'New',
         firmware_version: ['2025.12'], category: 'BLACKBOX', status: 'CURATED'},
      ],
    });
    expect(parsed.presets).toHaveLength(1);
    expect(parsed.rejectedCount).toBe(0);
    // The catalogue's own words are kept...
    expect(parsed.presets[0].rawCategory).toBe('BLACKBOX');
    expect(parsed.presets[0].rawStatus).toBe('CURATED');
    // ...and the typed fields take safe values. Never OFFICIAL, which would
    // overstate the provenance of something we did not recognize.
    expect(parsed.presets[0].category).toBe('OTHER');
    expect(parsed.presets[0].status).toBe('COMMUNITY');
  });

  it('an entry missing its title or firmware list is still usable', () => {
    const parsed = parseFirmwarePresetIndex({
      majorVersion: 1,
      minorVersion: 0,
      presets: [
        {fullPath: 'presets/tune/quiet.txt', hash: HASH, category: 'TUNE', status: 'OFFICIAL'},
      ],
    });
    expect(parsed.presets).toHaveLength(1);
    expect(parsed.presets[0].title).toBe('quiet.txt');
    expect(parsed.presets[0].firmwareVersions).toEqual([]);
  });

  it('matches a patch-level catalogue entry, as Betaflight prefix-matches', () => {
    // presets.preselectFilterFields is `currentVersion.startsWith(bfVersion)`.
    // Requiring equality on a derived major.minor hid every catalogue entry
    // that lists a patch-level version: "4.5.0" is not equal to the family
    // "4.5", so such an entry never appeared on a board running 4.5.0.
    const parsed = parseFirmwarePresetIndex({
      majorVersion: 1,
      minorVersion: 0,
      presets: [
        {fullPath: 'presets/p.txt', hash: HASH, title: 'Patch',
         firmware_version: ['4.5.0'], category: 'TUNE', status: 'OFFICIAL'},
      ],
    });
    expect(filterCompatiblePresets(parsed, '4.5.0').map(p => p.title)).toEqual(['Patch']);
    expect(filterCompatiblePresets(parsed, '4.5.1').map(p => p.title)).toEqual(['Patch']);
    expect(filterCompatiblePresets(parsed, '4.6.0')).toEqual([]);
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

  it('matches option names case-insensitively, exactly as Betaflight does', () => {
    // PresetParser.removeUncheckedOptions lowercases BOTH the checked list and
    // the name it reads from each OPTION BEGIN line. Comparing exactly meant a
    // preset whose option name differed only in case silently sent the wrong
    // set of commands - dropping lines the operator approved, or including
    // lines they had unticked - with nothing on screen to show it.
    const document = parseFirmwarePresetDocument(
      [
        '#$ OPTION BEGIN (UNCHECKED): RPM Filter',
        'set rpm_filter_harmonics = 3',
        '#$ OPTION END',
      ].join('\n'),
    );
    expect(commandsForPreset(document.lines, new Set(['rpm filter']))).toEqual([
      'set rpm_filter_harmonics = 3',
    ]);
    expect(commandsForPreset(document.lines, new Set(['RPM FILTER']))).toEqual([
      'set rpm_filter_harmonics = 3',
    ]);
    // An option the operator did not tick is still excluded.
    expect(commandsForPreset(document.lines, new Set(['something else']))).toEqual([]);
  });

  it('recognises an exclusive group written with a space as well as an underscore', () => {
    // Betaflight does not hardcode this vocabulary: PresetsRepoIndexed reads
    // it from the catalogue's own `settings` block. Accepting one spelling
    // only would mean that if the catalogue ever wrote the other, exclusive
    // groups stopped being recognised and the screen would let an operator
    // tick two mutually exclusive tunes and send both.
    for (const header of ['#$ OPTION_GROUP BEGIN: (EXCLUSIVE) Rates',
                          '#$ OPTION GROUP BEGIN: (EXCLUSIVE) Rates']) {
      const document = parseFirmwarePresetDocument(
        [header, '#$ OPTION BEGIN (CHECKED): Smooth', 'set a = 1', '#$ OPTION END'].join('\n'),
      );
      expect(document.options[0]).toEqual({
        name: 'Smooth', checkedByDefault: true, group: 'Rates', exclusive: true,
      });
    }
  });

  it('withholds save and exit from a preset body, and says why', () => {
    // The one deliberate divergence from Betaflight, which forwards whatever
    // the file contains. A stray `exit` mid-batch would close the CLI session
    // and send every remaining command into a closed channel while the
    // operator was told the batch had been applied. Both are issued by this
    // app explicitly, after the batch, under the operator's confirmation.
    const document = parseFirmwarePresetDocument(
      ['set a = 1', 'save', 'exit', 'set b = 2'].join('\n'),
    );
    expect(commandsForPreset(document.lines, new Set())).toEqual([
      'set a = 1', 'set b = 2',
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
