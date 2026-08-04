/**
 * The persistent save surface. The operator reported that changing a
 * UART role produced "no visible save action" - these pin the contract
 * that makes that impossible to repeat.
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

import StickyActionBar from './StickyActionBar';
import '../../../i18n';
import i18n from '../../../i18n';

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount();
    }
  });
});

function render(
  props: Partial<React.ComponentProps<typeof StickyActionBar>> = {},
): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <StickyActionBar
        visible
        summary="UART6: GPS"
        saveLabel="حفظ والتحقق"
        discardLabel="تجاهل التغييرات"
        onSave={() => undefined}
        onDiscard={() => undefined}
        {...props}
      />,
    );
  });
  mounted.push(renderer);
  return renderer;
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children),
    )
    .join(' | ');
}

describe('StickyActionBar', () => {
  it('renders NOTHING when there is no pending change, so it can never invite a save that would write nothing', () => {
    const renderer = render({ visible: false });
    expect(renderer.toJSON()).toBeNull();
  });

  it('names WHAT is pending, not just that something is', () => {
    const renderer = render({
      summary: 'UART6: GPS',
      details: ['UART6: GPS', 'UART1: MSP'],
    });
    const text = allText(renderer);
    expect(text).toContain('UART6: GPS');
    expect(text).toContain('UART1: MSP');
    expect(text).toContain('تغييرات غير محفوظة');
  });

  it('save and discard are both reachable and both fire', () => {
    const onSave = jest.fn();
    const onDiscard = jest.fn();
    const renderer = render({ onSave, onDiscard });
    act(() => {
      renderer.root
        .findAll(node => node.props.testID === 'sticky-action-bar-save', {
          deep: false,
        })[0]
        .props.onPress();
    });
    act(() => {
      renderer.root
        .findAll(node => node.props.testID === 'sticky-action-bar-discard', {
          deep: false,
        })[0]
        .props.onPress();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('a disabled save NAMES its reason in Arabic instead of being a dead grey button', () => {
    const renderer = render({ disabledReason: 'تعذّر الحفظ: توجد قيمة غير صالحة أعلاه.' });
    const save = renderer.root.findAll(
      node => node.props.testID === 'sticky-action-bar-save',
      { deep: false },
    )[0];
    expect(save.props.disabled).toBe(true);
    expect(allText(renderer)).toContain('تعذّر الحفظ');
  });

  it('an enabled save carries no reason text at all', () => {
    const renderer = render({});
    const save = renderer.root.findAll(
      node => node.props.testID === 'sticky-action-bar-save',
      { deep: false },
    )[0];
    expect(save.props.disabled).toBe(false);
    expect(
      renderer.root.findAll(
        node => node.props.testID === 'sticky-action-bar-disabled-reason',
      ),
    ).toHaveLength(0);
  });

  it('while busy it blocks BOTH actions and says it is saving', () => {
    const renderer = render({ busy: true, busyLabel: 'جارٍ الحفظ…' });
    const save = renderer.root.findAll(
      node => node.props.testID === 'sticky-action-bar-save',
      { deep: false },
    )[0];
    const discard = renderer.root.findAll(
      node => node.props.testID === 'sticky-action-bar-discard',
      { deep: false },
    )[0];
    expect(save.props.disabled).toBe(true);
    expect(discard.props.disabled).toBe(true);
    expect(allText(renderer)).toContain('جارٍ الحفظ…');
  });

  it('claims nothing about the outcome - no success or verification wording exists in the component', () => {
    const text = allText(render({}));
    expect(text).not.toContain('تم الحفظ');
    expect(text).not.toContain('نجح');
  });
});
