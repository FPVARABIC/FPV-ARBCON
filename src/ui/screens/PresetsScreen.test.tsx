import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { FirmwarePresetIndex, FirmwarePresetSummary } from '../../core';
import type { LoadedFirmwarePreset } from '../../platforms/react-native/protocol';
import PresetsScreen, {
  type PresetsCliPort,
  type PresetsRepositoryPort,
} from './PresetsScreen';

const SESSION_KEY = { sessionId: 'preset-ui', generation: 8 } as const;
const SUMMARY: FirmwarePresetSummary = {
  fullPath: 'presets/2025.12/tune/test.txt',
  hash: 'a'.repeat(64),
  title: 'Verified tune',
  firmwareVersions: ['2025.12'],
  category: 'TUNE',
  status: 'OFFICIAL',
  keywords: ['five-inch'],
  author: 'Betaflight',
  forceOptionsReview: true,
  priority: 10,
};
const INDEX: FirmwarePresetIndex = {
  majorVersion: 1,
  minorVersion: 0,
  presets: [SUMMARY],
};
const LOADED: LoadedFirmwarePreset = {
  summary: SUMMARY,
  document: {
    lines: ['set rates_type = ACTUAL'],
    descriptions: ['ضبط موثق للاختبار'],
    includeWarnings: [],
    includeDisclaimers: [],
    options: [
      {
        name: 'Smooth',
        checkedByDefault: true,
        group: 'Rates',
        exclusive: true,
      },
    ],
  },
  expandedLines: ['set rates_type = ACTUAL'],
  completeWarning: 'راجع الطائرة قبل الطيران.',
};

function ports(
  errors: readonly { command: string; response: string; error: boolean }[] = [],
) {
  const repository: PresetsRepositoryPort = {
    loadIndex: jest.fn(async () => INDEX),
    loadFirmwareVersion: jest.fn(async () => ({
      yearOffsetRaw: 25,
      year: 2025,
      month: 12,
      patch: 5,
      versionString: '2025.12.5',
      suffix: null,
    })),
    loadPreset: jest.fn(async () => LOADED),
    commands: jest.fn(() => ['set rates_type = ACTUAL']),
  };
  const cli: PresetsCliPort = {
    getPhase: jest.fn(() => 'IDLE'),
    begin: jest.fn(async () => undefined),
    captureDiffAll: jest.fn(async () => '# diff all\n'),
    saveTextFile: jest.fn(async () => true),
    executeBatch: jest.fn(async (_commands, progress) => {
      progress?.(1, 1);
      return { commandCount: 1, errors };
    }),
    saveAndClose: jest.fn(async () => undefined),
    exitWithoutSave: jest.fn(async () => undefined),
  };
  return { repository, cli };
}

async function renderReady(
  repository: PresetsRepositoryPort,
  cli: PresetsCliPort,
  onBusy = jest.fn(),
) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <PresetsScreen
        sessionKey={SESSION_KEY}
        active
        repository={repository}
        cli={cli}
        onCliBusyChange={onBusy}
      />,
    );
    await Promise.resolve();
  });
  await ReactTestRenderer.act(async () => {
    renderer.root
      .findByProps({ testID: `preset-${SUMMARY.fullPath}` })
      .props.onPress();
    await Promise.resolve();
  });
  return { renderer, onBusy };
}

describe('PresetsScreen', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requires a saved diff, applies temporarily, then saves only after a clean CLI batch', async () => {
    const { repository, cli } = ports();
    const { renderer, onBusy } = await renderReady(repository, cli);
    expect(
      renderer.root.findByProps({ testID: 'presets-apply' }).props.disabled,
    ).toBe(true);

    await ReactTestRenderer.act(async () => {
      await renderer.root
        .findByProps({ testID: 'presets-backup' })
        .props.onPress();
    });
    expect(cli.captureDiffAll).toHaveBeenCalledTimes(1);
    expect(cli.saveTextFile).toHaveBeenCalledWith(
      'betaflight-backup-2025.12.5.txt',
      '# diff all\n',
    );

    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    ReactTestRenderer.act(() =>
      renderer.root.findByProps({ testID: 'presets-apply' }).props.onPress(),
    );
    const actions = alert.mock.calls[0]?.[2];
    await ReactTestRenderer.act(async () => {
      actions?.[1]?.onPress?.();
      await Promise.resolve();
    });
    expect(cli.executeBatch).toHaveBeenCalledWith(
      ['set rates_type = ACTUAL'],
      expect.any(Function),
    );
    expect(
      renderer.root.findByProps({ testID: 'presets-save' }).props.disabled,
    ).toBe(false);

    await ReactTestRenderer.act(async () => {
      await renderer.root
        .findByProps({ testID: 'presets-save' })
        .props.onPress();
    });
    expect(cli.saveAndClose).toHaveBeenCalledTimes(1);
    expect(onBusy).toHaveBeenCalledWith(true);
    expect(onBusy).toHaveBeenLastCalledWith(false);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('fails closed and disables save after any CLI error', async () => {
    const { repository, cli } = ports([
      {
        command: 'set bad = 1',
        response: '###ERROR: invalid name',
        error: true,
      },
    ]);
    const { renderer } = await renderReady(repository, cli);
    await ReactTestRenderer.act(async () => {
      await renderer.root
        .findByProps({ testID: 'presets-backup' })
        .props.onPress();
    });
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    ReactTestRenderer.act(() =>
      renderer.root.findByProps({ testID: 'presets-apply' }).props.onPress(),
    );
    await ReactTestRenderer.act(async () => {
      alert.mock.calls[0]?.[2]?.[1]?.onPress?.();
      await Promise.resolve();
    });
    expect(
      renderer.root.findByProps({ testID: 'presets-save' }).props.disabled,
    ).toBe(true);
    expect(cli.saveAndClose).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => {
      await renderer.root
        .findByProps({ testID: 'presets-discard' })
        .props.onPress();
    });
    expect(cli.exitWithoutSave).toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
