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

/**
 * CLI FINAL: the terminal enters its session AUTOMATICALLY when mounted
 * active over a live sessionKey - there is no start screen. Mount, then
 * flush the auto-entry.
 */
async function renderStarted(cli: CliScreenPort) {
  const onBusy = jest.fn();
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <CliScreen
        sessionKey={SESSION_KEY}
        active
        onCliBusyChange={onBusy}
        cli={cli}
      />,
    );
    await Promise.resolve();
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
    // A file this application hands the operator carries OUR name, not
    // the name of the firmware project whose protocol it speaks.
    expect(cli.saveTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/^fpv-arbcon-cli-\d+\.txt$/),
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

  it('enters the CLI session automatically - exactly once - and shows the terminal immediately', async () => {
    const { cli } = harness();
    const { renderer } = await renderStarted(cli);
    expect(cli.begin).toHaveBeenCalledTimes(1);
    expect(cli.begin).toHaveBeenCalledWith(SESSION_KEY);
    // No start gate exists; the terminal surface is already present.
    expect(
      renderer.root.findAllByProps({ testID: 'cli-start' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'cli-output' }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: 'cli-command-input' }),
    ).toBeDefined();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('a failed entry shows the REAL reason with an explicit retry - and never loops', async () => {
    const { cli } = harness();
    let attempts = 0;
    (cli.begin as jest.Mock).mockImplementation(async () => {
      attempts += 1;
      throw new Error('جلسة MSP غير جاهزة لـCLI.');
    });
    const { renderer } = await renderStarted(cli);
    expect(attempts).toBe(1);
    // The real reason is rendered, with a retry action.
    const texts = renderer.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
    expect(texts.some(text => text.includes('جلسة MSP غير جاهزة'))).toBe(true);
    const retry = renderer.root.findByProps({ testID: 'cli-start' });
    // A re-render does not re-attempt on its own.
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
    });
    expect(attempts).toBe(1);
    // Explicit retry does.
    (cli.begin as jest.Mock).mockImplementation(async () => {
      attempts += 1;
    });
    await ReactTestRenderer.act(async () => {
      await retry.props.onPress();
    });
    expect(attempts).toBe(2);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('a dropped connection terminates the CLI state truthfully and frees the link', async () => {
    const { cli } = harness();
    const onBusy = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <CliScreen
          sessionKey={SESSION_KEY}
          active
          onCliBusyChange={onBusy}
          cli={cli}
        />,
      );
      await Promise.resolve();
    });
    expect(cli.begin).toHaveBeenCalledTimes(1);
    // The physical session ends: the parent clears sessionKey.
    await ReactTestRenderer.act(async () => {
      renderer.update(
        <CliScreen
          sessionKey={undefined}
          active
          onCliBusyChange={onBusy}
          cli={cli}
        />,
      );
      await Promise.resolve();
    });
    expect(cli.exitWithoutSave).toHaveBeenCalled();
    expect(onBusy).toHaveBeenLastCalledWith(false);
    const texts = renderer.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
    expect(texts.some(text => text.includes('انقطع اتصال'))).toBe(true);
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

  it('follows new output, and lets go the moment the operator scrolls up', async () => {
    // Betaflight scrolls its terminal to the bottom on every write. Ours did
    // not scroll at all, so a long answer landed below the fold. Following
    // blindly is the opposite mistake - it would yank the view away from
    // someone scrolled up reading an error - so the follow releases on scroll
    // up and re-arms on the way back down.
    const { cli } = harness();
    const { renderer } = await renderStarted(cli);
    const scroll = renderer.root.findByProps({ testID: 'cli-terminal-scroll' });
    const scrollToEnd = jest.fn();
    // The ref points at the host ScrollView; stand in for its imperative API.
    scroll.instance.scrollToEnd = scrollToEnd;

    // At the bottom: new content follows.
    ReactTestRenderer.act(() => scroll.props.onContentSizeChange(0, 100));
    expect(scrollToEnd).toHaveBeenCalled();

    // Operator scrolls up 400px into a 1000px log.
    scrollToEnd.mockClear();
    ReactTestRenderer.act(() =>
      scroll.props.onScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 200 },
          contentSize: { width: 0, height: 1000 },
          layoutMeasurement: { width: 0, height: 400 },
        },
      }),
    );
    ReactTestRenderer.act(() => scroll.props.onContentSizeChange(0, 1200));
    expect(scrollToEnd).not.toHaveBeenCalled();

    // Back at the bottom: following resumes.
    ReactTestRenderer.act(() =>
      scroll.props.onScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 600 },
          contentSize: { width: 0, height: 1000 },
          layoutMeasurement: { width: 0, height: 400 },
        },
      }),
    );
    ReactTestRenderer.act(() => scroll.props.onContentSizeChange(0, 1400));
    expect(scrollToEnd).toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
