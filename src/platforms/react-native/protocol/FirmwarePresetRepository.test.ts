import { sha256Hex } from '../../../core';
import { FirmwarePresetRepository } from './FirmwarePresetRepository';

const main = [
  '#$ DESCRIPTION: Test preset',
  '#$ INCLUDE: presets/2025.12/other/base.txt',
  '#$ OPTION BEGIN (CHECKED): Extra',
  'set extra = ON',
  '#$ OPTION END',
  'set root = 1',
].join('\n');
const index = JSON.stringify({
  majorVersion: 1,
  minorVersion: 0,
  presets: [
    {
      fullPath: 'presets/2025.12/tune/test.txt',
      hash: sha256Hex(main),
      title: 'Test',
      firmware_version: ['2025.12'],
      category: 'TUNE',
      status: 'OFFICIAL',
      keywords: ['test'],
      author: 'Betaflight',
    },
  ],
});

function repository(files: Record<string, string>) {
  const fetcher = jest.fn(async (url: string) => {
    const path = url.replace('https://example.test/', '');
    return {
      ok: files[path] !== undefined,
      status: files[path] !== undefined ? 200 : 404,
      text: async () => files[path] ?? '',
    };
  });
  return {
    repo: new FirmwarePresetRepository({
      fetcher,
      baseUrl: 'https://example.test/',
    }),
    fetcher,
  };
}

describe('FirmwarePresetRepository', () => {
  it('loads the official shape, verifies the main hash and expands includes', async () => {
    const { repo } = repository({
      'index.json': index,
      'presets/2025.12/tune/test.txt': main,
      'presets/2025.12/other/base.txt': 'set base = 2',
    });
    const catalog = await repo.loadIndex();
    const loaded = await repo.loadPreset(catalog.presets[0]);
    expect(loaded.expandedLines).toContain('set base = 2');
    expect(repo.commands(loaded, new Set(['Extra']))).toEqual([
      'set base = 2',
      'set extra = ON',
      'set root = 1',
    ]);
  });

  it('refuses a downloaded file whose content no longer matches the indexed hash', async () => {
    const { repo } = repository({
      'index.json': index,
      'presets/2025.12/tune/test.txt': `${main}\nset injected = 1`,
    });
    const catalog = await repo.loadIndex();
    await expect(repo.loadPreset(catalog.presets[0])).rejects.toThrow(/بصمة/);
  });

  it('checks HTTP status and response size instead of parsing an error page', async () => {
    const { repo } = repository({});
    await expect(repo.loadIndex()).rejects.toThrow(/HTTP 404/);
  });
});
