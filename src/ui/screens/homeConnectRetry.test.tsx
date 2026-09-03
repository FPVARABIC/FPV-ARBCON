/**
 * "RETRY" HAS TO RETRY.
 *
 * When a connection attempt fails, Home draws a strip with the reason and
 * one action: try again. That button is the operator's only way forward
 * without leaving the screen, and it has a property no generic press-
 * everything sweep can check: pressing it must RE-RUN THE ATTEMPT.
 *
 * The interaction census cannot answer that, and the reason is worth
 * writing down rather than working around. Under Jest there is no USB
 * transport at all, so the first attempt fails, and so does the second,
 * with the same message. The screen therefore looks identical before and
 * after the press - and a census that decides "did this do anything" by
 * comparing renders scores a working button dead. Measured here instead,
 * where the question is not "did the screen change" but "did the
 * application go back to the transport and ask again".
 *
 * What this pins:
 *   1. a failed attempt puts the retry action on screen at all;
 *   2. pressing it calls the transport again - one more scan per press;
 *   3. it passes through the in-progress state on the way, so the
 *      operator sees that the press registered;
 *   4. when the second attempt finds what the first did not, the strip
 *      stops saying the first attempt's failure.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import StartScreen from './StartScreen';
import {usbSerialTransportClient} from '../../platforms/react-native/transport';

jest.setTimeout(60000);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

function has(tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean {
  return (
    tree.root.findAll(node => (node.props as any)?.testID === testID, {
      deep: true,
    }).length > 0
  );
}

async function pressById(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<boolean> {
  const nodes = tree.root.findAll(
    node =>
      (node.props as any)?.testID === testID &&
      typeof (node.props as any)?.onPress === 'function',
    {deep: true},
  );
  if (nodes.length === 0) return false;
  await act(async () => {
    (nodes[nodes.length - 1].props as any).onPress();
  });
  return true;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
  });
}

interface Harness {
  readonly tree: ReactTestRenderer.ReactTestRenderer;
  readonly scans: () => number;
}

/**
 * Home, over a transport that answers.
 *
 * `supportsDevicePicker` is answered false on purpose: that is the
 * Android branch, where `begin()` goes straight to a scan instead of
 * opening a browser chooser, and a scan is the thing a retry must repeat.
 */
async function open(devices: () => unknown[]): Promise<Harness> {
  const picker = jest
    .spyOn(usbSerialTransportClient, 'supportsDevicePicker')
    .mockReturnValue(false);
  let scans = 0;
  const list = jest
    .spyOn(usbSerialTransportClient, 'listDevices')
    .mockImplementation(async () => {
      scans += 1;
      return devices() as never;
    });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <StartScreen
        navigation={{navigate: () => undefined, goBack: () => undefined} as any}
        route={{params: {}} as any}
      />,
    );
  });
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
  });
  afterEachCleanup.push(() => {
    picker.mockRestore();
    list.mockRestore();
  });
  return {tree, scans: () => scans};
}

const afterEachCleanup: (() => void)[] = [];
afterEach(() => {
  while (afterEachCleanup.length > 0) afterEachCleanup.pop()?.();
});

describe('the retry on a failed connection', () => {
  it('appears only after an attempt has failed', async () => {
    const {tree} = await open(() => []);
    expect(has(tree, 'home-connect-retry')).toBe(false);

    await pressById(tree, 'start-configure');
    await settle();
    expect({
      failed: has(tree, 'home-connect-failed'),
      retry: has(tree, 'home-connect-retry'),
    }).toEqual({failed: true, retry: true});
    await act(async () => tree.unmount());
  });

  it('goes back to the transport and scans again', async () => {
    const {tree, scans} = await open(() => []);
    await pressById(tree, 'start-configure');
    await settle();
    const first = scans();
    /* The subject exists: the first attempt really did reach the
       transport. Without this the assertion below could pass on a screen
       that never scanned at all. */
    expect(first).toBeGreaterThanOrEqual(1);

    expect(await pressById(tree, 'home-connect-retry')).toBe(true);
    await settle();
    expect(scans()).toBe(first + 1);

    /* And again - a retry that works once and then latches is the same
       defect one press later. */
    await pressById(tree, 'home-connect-retry');
    await settle();
    expect(scans()).toBe(first + 2);
    await act(async () => tree.unmount());
  });

  it('shows that the press registered before the answer comes back', async () => {
    /* THE OPERATOR-VISIBLE HALF. A retry whose outcome is identical to
       the last one leaves the screen unchanged once it settles; what
       tells the operator it worked is the in-progress state on the way
       through. Held open here so it can be observed. */
    let release!: (value: unknown[]) => void;
    const held = new Promise<unknown[]>(resolve => {
      release = resolve;
    });
    let first = true;
    const {tree} = await open(() => {
      if (first) {
        first = false;
        return [];
      }
      return held as never as unknown[];
    });
    await pressById(tree, 'start-configure');
    await settle();
    expect(has(tree, 'home-connect-failed')).toBe(true);

    await pressById(tree, 'home-connect-retry');
    await act(async () => {
      await Promise.resolve();
    });
    expect({
      inProgress: has(tree, 'home-connect-progress'),
      stillShowingTheOldFailure: has(tree, 'home-connect-failed'),
    }).toEqual({inProgress: true, stillShowingTheOldFailure: false});

    await act(async () => {
      release([]);
      for (let round = 0; round < 10; round += 1) await Promise.resolve();
    });
    await act(async () => tree.unmount());
  });

  it('stops reporting the old failure when the retry finds a board', async () => {
    let attempt = 0;
    const {tree} = await open(() => {
      attempt += 1;
      return attempt === 1
        ? []
        : [
            /* The descriptor shape `connectOptions` actually reads:
               anything without a driver type and a port count is
               correctly not openable, and a device the flow skips would
               have made this test pass for the wrong reason. */
            {
              deviceId: 1,
              vendorId: 0x0483,
              productId: 0x5740,
              productName: 'Virtual FC',
              driverType: 'CdcAcmSerialDriver',
              portCount: 1,
            },
          ];
    });
    await pressById(tree, 'start-configure');
    await settle();
    const failure = textOf(tree);
    expect(has(tree, 'home-connect-failed')).toBe(true);

    await pressById(tree, 'home-connect-retry');
    await settle();
    /* Whatever the second attempt ends as - it opens, or it fails for a
       DIFFERENT reason once a device is there - it must not still be
       showing the answer to the first question. */
    expect(textOf(tree)).not.toBe(failure);
    await act(async () => tree.unmount());
  });
});
