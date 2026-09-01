/**
 * WHAT THE OPERATOR IS TOLD A RESET PROVED.
 *
 * «تحقّقنا من» used to be filled from a STATIC capability list, so a reset
 * whose profile-name read had failed still printed the profile name as one
 * of the things checked. These tests render the real screen, drive the real
 * reset control, and read the notice the pilot actually sees.
 *
 * They are behavioural on purpose: asserting on the source of the message
 * builder would pass just as well against a version that renders the static
 * list again, which is precisely the regression being guarded.
 */
import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import '../../i18n';
import {decodePidTuningSnapshot, type MspPidTuningSnapshot} from '../../core';
import type {
  PidProfileResetOutcome,
  PidResetResource,
} from '../../platforms/react-native/protocol';
import PidTuningScreen, {type PidControllerPort} from './PidTuningScreen';

function snapshot(): MspPidTuningSnapshot {
  const pid = Uint8Array.from([42, 85, 35, 46, 90, 38, 45, 80, 0, 50, 50, 75, 40, 0, 0]);
  const advanced = new Uint8Array(61);
  const view = new DataView(advanced.buffer);
  view.setUint16(32, 120, true); view.setUint16(34, 130, true); view.setUint16(36, 140, true);
  const rates = new Uint8Array(24);
  rates[0] = 100; rates[12] = 100; rates[11] = 100; rates[2] = 70; rates[3] = 70;
  rates[4] = 70; rates[6] = 50; rates[15] = 100; rates[23] = 50;
  const ratesView = new DataView(rates.buffer);
  ratesView.setUint16(16, 1998, true); ratesView.setUint16(18, 1998, true); ratesView.setUint16(20, 1998, true);
  const filters = new Uint8Array(49);
  new DataView(filters.buffer).setUint16(20, 0, true);
  return decodePidTuningSnapshot({
    contract: 'API_1_47', pid, advanced, rates, filters,
    gyroSampleRateHz: 8000, pidProcessDenom: 2,
    pidProfileIndex: 1, pidProfileCount: 3, controlRateProfileIndex: 2,
  });
}

async function render(controller: PidControllerPort) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <PidTuningScreen
        sessionKey={{sessionId: 'pid-reset-ui', generation: 1}}
        active
        onOpenMotors={jest.fn()}
        controller={controller}
      />,
    );
  });
  return renderer;
}

const screenText = (renderer: ReactTestRenderer.ReactTestRenderer): string =>
  renderer.root.findAllByType(Text)
    .map(node => (Array.isArray(node.props.children)
      ? node.props.children.join('')
      : String(node.props.children ?? '')))
    .join('\n');

/** Presses the profile-reset affordance the screen exposes to its child. */
async function pressReset(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  const target = renderer.root.findAll(node => typeof node.props?.onReset === 'function')[0];
  if (target === undefined) throw new Error('no onReset affordance rendered');
  await act(async () => { target.props.onReset(); });
}

/** A controller that loads normally and answers the reset with `outcome`. */
function controllerWith(outcome: PidProfileResetOutcome): PidControllerPort {
  const original = snapshot();
  return {
    load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})),
    save: jest.fn(async () => ({kind: 'NO_CHANGES' as const, snapshot: original})),
    resetPidProfile: jest.fn(async () => outcome),
  };
}

const partiallyVerified = (
  verifiedScope: readonly PidResetResource[],
  verificationGaps: readonly {resource: PidResetResource; reason: 'READ_FAILED'}[],
): PidProfileResetOutcome => ({
  kind: 'RESET_APPLIED_PARTIALLY_VERIFIED',
  snapshot: snapshot(),
  persists: false,
  verifiedScope,
  verificationGaps,
});

const CORE: readonly PidResetResource[] = ['PID', 'PID_ADVANCED', 'FILTER_CONFIG'];
/** The exact substring the screen uses to introduce verified resources. */
const VERIFIED_HEADING = 'تحقّقنا من:';
const GAP_HEADING = 'تعذّر التحقق من:';
const NAME_LABEL = 'اسم الملف';
const SIMPLIFIED_LABEL = 'وضع الضبط المبسّط';

/** The sentence fragment that follows «تحقّقنا من» up to the next full stop. */
function verifiedClause(text: string): string {
  const start = text.indexOf(VERIFIED_HEADING);
  if (start < 0) throw new Error('the screen printed no verified list');
  return text.slice(start + VERIFIED_HEADING.length).split('.')[0];
}

describe('PID reset presentation - a profile name that could not be verified', () => {
  it('lists the three core resources, and does NOT list the name as verified', async () => {
    const renderer = await render(controllerWith(
      partiallyVerified(CORE, [{resource: 'PROFILE_NAME', reason: 'READ_FAILED'}]),
    ));

    await pressReset(renderer);
    const text = screenText(renderer);

    /* The three that really were read back are named as verified. */
    expect(verifiedClause(text)).toContain('قيم P/I/D');
    expect(verifiedClause(text)).toContain('D Max');
    expect(verifiedClause(text)).toContain('D-term');
    /* The one that was not read is NOT among them - the whole defect. */
    expect(verifiedClause(text)).not.toContain(NAME_LABEL);
    /* And it is stated explicitly instead of vanishing. */
    expect(text).toContain(GAP_HEADING);
    expect(text.slice(text.indexOf(GAP_HEADING))).toContain(NAME_LABEL);
    /* RAM-only and not-persisted survive the change. */
    expect(text).toContain('الذاكرة العاملة');
    expect(text).toContain('لا يحفظ حفظًا دائمًا');

    act(() => renderer.unmount());
  });
});

describe('PID reset presentation - simplified tuning that could not be verified', () => {
  it('does NOT list the generator mode as verified and says so separately', async () => {
    const renderer = await render(controllerWith(
      partiallyVerified([...CORE, 'PROFILE_NAME'],
        [{resource: 'SIMPLIFIED_TUNING', reason: 'READ_FAILED'}]),
    ));

    await pressReset(renderer);
    const text = screenText(renderer);

    expect(verifiedClause(text)).toContain(NAME_LABEL);
    expect(verifiedClause(text)).not.toContain(SIMPLIFIED_LABEL);
    expect(text).toContain(GAP_HEADING);
    expect(text.slice(text.indexOf(GAP_HEADING))).toContain(SIMPLIFIED_LABEL);
    expect(text).toContain('الذاكرة العاملة');

    act(() => renderer.unmount());
  });
});

describe('PID reset presentation - a fully observed reset', () => {
  it('names all five resources and raises no verification warning', async () => {
    const renderer = await render(controllerWith(
      partiallyVerified([...CORE, 'PROFILE_NAME', 'SIMPLIFIED_TUNING'], []),
    ));

    await pressReset(renderer);
    const text = screenText(renderer);

    const clause = verifiedClause(text);
    expect(clause).toContain(NAME_LABEL);
    expect(clause).toContain(SIMPLIFIED_LABEL);
    /* Nothing failed, so no gap sentence is invented. */
    expect(text).not.toContain(GAP_HEADING);
    /* Still PARTIAL: the firmware rewrites more than this screen reads. */
    expect(text).toContain('بقية الحقول لم نقرأها');
    expect(text).toContain('لا يحفظ حفظًا دائمًا');

    act(() => renderer.unmount());
  });
});
