import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { RawCliPhase } from '../../platforms/react-native/protocol';
import CliScreen, { type CliScreenPort } from './CliScreen';

const SESSION_KEY = { sessionId: 'cli-ui', generation: 11 } as const;

function harness() {
  let phase: RawCliPhase = 'IDLE';
  let output = '';
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  const cli: CliScreenPort = {
    getPhase: jest.fn(() => phase),
    getOutput: jest.fn(() => output),
    getIdentification: jest.fn(
      () =>
        ({
          status: 'SUCCEEDED',
          identity: {
            firmware: { knownFamily: 'BETAFLIGHT', identifier: 'BTFL' },
            apiVersion: { apiVersionMajor: 1, apiVersionMinor: 47 },
            board: { boardIdentifier: 'TEST' },
          },
        } as never),
    ),
    subscribe: jest.fn(listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    begin: jest.fn(async () => {
      phase = 'ACTIVE';
      output = 'Entering CLI Mode\n# ';
      publish();
    }),
    execute: jest.fn(async command => {
      phase = 'SENDING';
      publish();
      const error = command === 'bad';
      output += `\n${command}\n${error ? '###ERROR: invalid name' : 'ok'}\n# `;
      phase = 'ACTIVE';
      publish();
      return { command, response: output, error };
    }),
    saveTextFile: jest.fn(async () => true),
    clearOutput: jest.fn(() => {
      output = '';
      publish();
    }),
    saveAndClose: jest.fn(async () => {
      phase = 'IDLE';
      publish();
    }),
    exitWithoutSave: jest.fn(async () => {
      phase = 'IDLE';
      publish();
    }),
  };
  return { cli };
}

async function renderStarted(cli: CliScreenPort) {
  const onBusy = jest.fn();
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <CliScreen
        sessionKey={SESSION_KEY}
        active
        onCliBusyChange={onBusy}
        cli={cli}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {
    await renderer.root.findByProps({ testID: 'cli-start' }).props.onPress();
  });
  return { renderer, onBusy };
}

describe('CliScreen', () => {
  afterEach(() => jest.restoreAllMocks());

  it('owns one session, streams commands, exports output and saves explicitly', async () => {
    const { cli } = harness();
    const { renderer, onBusy } = await renderStarted(cli);
    expect(cli.begin).toHaveBeenCalledWith(SESSION_KEY);
    expect(onBusy).toHaveBeenCalledWith(true);

    ReactTestRenderer.act(() =>
      renderer.root
        .findByProps({ testID: 'cli-command-input' })
        .props.onChangeText('status'),
    );
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ testID: 'cli-send' }).props.onPress();
    });
    expect(cli.execute).toHaveBeenCalledWith('status');
    expect(
      renderer.root.findByProps({ testID: 'cli-output' }).props.children,
    ).toContain('status');

    await ReactTestRenderer.act(async () => {
      await renderer.root
        .findByProps({ testID: 'cli-download-output' })
        .props.onPress();
    });
    expect(cli.saveTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/^betaflight-cli-\d+\.txt$/),
      expect.stringContaining('status'),
    );

    ReactTestRenderer.act(() =>
      renderer.root.findByProps({ testID: 'cli-clear-output' }).props.onPress(),
    );
    expect(cli.clearOutput).toHaveBeenCalledTimes(1);

    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    ReactTestRenderer.act(() =>
      renderer.root.findByProps({ testID: 'cli-save' }).props.onPress(),
    );
    await ReactTestRenderer.act(async () => {
      alert.mock.calls[0]?.[2]?.[1]?.onPress?.();
      await Promise.resolve();
    });
    expect(cli.saveAndClose).toHaveBeenCalledTimes(1);
    expect(onBusy).toHaveBeenLastCalledWith(false);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('blocks save after a CLI error and preserves the discard path', async () => {
    const { cli } = harness();
    const { renderer } = await renderStarted(cli);
    ReactTestRenderer.act(() =>
      renderer.root
        .findByProps({ testID: 'cli-command-input' })
        .props.onChangeText('bad'),
    );
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ testID: 'cli-send' }).props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'cli-save' }).props.disabled,
    ).toBe(true);
    expect(cli.saveAndClose).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => {
      await renderer.root
        .findByProps({ testID: 'cli-discard' })
        .props.onPress();
    });
    expect(cli.exitWithoutSave).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('offers only non-saving quick commands', async () => {
    const { cli } = harness();
    const { renderer } = await renderStarted(cli);
    await ReactTestRenderer.act(async () => {
      await renderer.root
        .findByProps({ testID: 'cli-quick-diff all' })
        .props.onPress();
    });
    expect(cli.execute).toHaveBeenCalledWith('diff all');
    expect(cli.execute).not.toHaveBeenCalledWith('save');
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
