/**
 * LOOKING AT THE OTHER MODE MUST NOT MOVE THE TRANSMITTER.
 *
 * The VTX screen offers two ways to set a frequency: pick a BAND and a
 * CHANNEL, or type a frequency in MHz directly. That choice is drawn as
 * a two-option chip group, «Band / Channel» and «تردد مباشر».
 *
 * It is not a field of its own. The protocol encodes "direct frequency"
 * as BAND 0, so the mode chips write to `draft.band` - and choosing
 * direct frequency therefore OVERWRITES the band number the operator
 * had. Choosing Band / Channel again cannot restore what was
 * overwritten, and the old code fell back to `Math.max(1, draft.band ||
 * 1)`, which is 1.
 *
 * So: an operator on band 5 taps direct frequency, looks, taps back -
 * and is now on band 1, with the save bar reporting "unsaved changes" as
 * though they had asked for that. Pressing Save moves the video
 * transmitter to a different frequency from the one they were flying on,
 * which in a group of pilots means transmitting over somebody else's
 * feed.
 *
 * The rule: the mode chips choose a MODE. Coming back to Band / Channel
 * returns the band the operator was on.
 *
 * Found by `controlTypeCensus`, which presses every selector away from
 * its group's selection and back and requires the screen to return to
 * exactly where it started.
 */

const IDENTITY = {
  status: 'SUCCEEDED',
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');
jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol/useMspSessionState'),
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => IDENTITY,
  useMspRecoveryState: () => 'READY',
}));

import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import {SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(120000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

async function openVtx(): Promise<ReactTestRenderer.ReactTestRenderer> {
  const screen = SCREENS.find(candidate => candidate.name === 'VTX')!;
  const element = await screen.mount(recorder());
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(element);
  });
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
  });
  return tree;
}

/** The band chip that reports itself selected, by its number. */
function selectedBand(
  tree: ReactTestRenderer.ReactTestRenderer,
): number | undefined {
  for (const node of tree.root.findAll(
    candidate =>
      typeof (candidate.props as any)?.testID === 'string' &&
      /^vtx-band-\d+$/.test((candidate.props as any).testID) &&
      (candidate.props as any)?.accessibilityState?.selected === true,
    {deep: true},
  )) {
    const id = String((node.props as any).testID);
    return Number(id.slice('vtx-band-'.length));
  }
  return undefined;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<boolean> {
  const node = tree.root
    .findAll(
      candidate =>
        (candidate.props as any)?.testID === testID &&
        typeof (candidate.props as any)?.onPress === 'function' &&
        (candidate.props as any)?.disabled !== true,
      {deep: true},
    )
    .pop();
  if (node === undefined) return false;
  await act(async () => {
    (node.props as any).onPress();
    for (let round = 0; round < 4; round += 1) await Promise.resolve();
  });
  return true;
}

describe('the VTX frequency-method chips choose a method, not a band', () => {
  it('the fixture really starts on a band other than 1', async () => {
    /* Without this the whole suite could pass on a board that was on
       band 1 all along, and prove nothing. */
    const tree = await openVtx();
    expect(selectedBand(tree)).toBeGreaterThan(1);
    await act(async () => tree.unmount());
  });

  it('going to direct frequency and back keeps the band', async () => {
    const tree = await openVtx();
    const before = selectedBand(tree);

    expect(await press(tree, 'vtx-mode-0')).toBe(true);
    /* In direct-frequency mode the band chips are correctly gone. */
    expect(selectedBand(tree)).toBeUndefined();

    expect(await press(tree, 'vtx-mode-1')).toBe(true);
    expect({returnedTo: selectedBand(tree)}).toEqual({returnedTo: before});
    await act(async () => tree.unmount());
  });

  it('and the screen does not report a change the operator did not make', async () => {
    const tree = await openVtx();
    const settled = JSON.stringify(tree.toJSON());
    await press(tree, 'vtx-mode-0');
    await press(tree, 'vtx-mode-1');
    expect(JSON.stringify(tree.toJSON())).toBe(settled);
    await act(async () => tree.unmount());
  });

  it('choosing a band explicitly still moves it', async () => {
    /* A NEGATIVE CONTROL for the repair: remembering the previous band
       must not make the band chips inert. */
    const tree = await openVtx();
    const before = selectedBand(tree)!;
    const other = before === 1 ? 2 : 1;
    expect(await press(tree, `vtx-band-${other}`)).toBe(true);
    expect(selectedBand(tree)).toBe(other);

    /* And the remembered band follows the operator, rather than
       resurrecting a band they have since left. */
    await press(tree, 'vtx-mode-0');
    await press(tree, 'vtx-mode-1');
    expect(selectedBand(tree)).toBe(other);
    await act(async () => tree.unmount());
  });
});
