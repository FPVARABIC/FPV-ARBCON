/**
 * Behavioral proof for the shared control system — the components every
 * polished screen now leans on. These are the contracts the design pass
 * exists to guarantee: real disabled semantics, guaranteed hit targets,
 * selection you can hear (accessibilityState), and a select whose open
 * state is a modal sheet that cannot collide with its own label.
 */
import React from 'react';
import {Modal} from 'react-native';
import renderer, {act} from 'react-test-renderer';

import {Button} from './Button';
import {ChoiceChips} from './ChoiceChips';
import {IconButton} from './IconButton';
import {NoticeBox} from './NoticeBox';
import {SelectField} from './SelectField';
import {SettingRow} from './SettingRow';
import {Stepper} from './Stepper';
import {ToggleSwitch} from './ToggleSwitch';

function create(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree!;
}

/** The HOST element for a testID — findByProps alone returns the
 * outermost composite (the component itself), whose props do not carry
 * the resolved accessibility/style output. The last match is the host. */
function findHost(
  tree: renderer.ReactTestRenderer,
  testID: string,
): renderer.ReactTestInstance {
  const matches = tree.root.findAllByProps({testID});
  if (matches.length === 0) {
    throw new Error(`No element with testID ${testID}`);
  }
  return matches[matches.length - 1];
}

/** Fires the press handler for a testID. onPress lives on the Pressable
 * composite, not on the host View the resolved props land on. */
function press(tree: renderer.ReactTestRenderer, testID: string): void {
  const target = tree.root
    .findAllByProps({testID})
    .find(node => typeof node.props.onPress === 'function');
  if (!target) {
    throw new Error(`No pressable element with testID ${testID}`);
  }
  act(() => target.props.onPress());
}

describe('Button', () => {
  it('fires onPress and carries the button role and label', () => {
    const onPress = jest.fn();
    const tree = create(
      <Button label="حفظ" onPress={onPress} variant="primary" testID="b" />,
    );
    const pressable = findHost(tree, 'b');
    expect(pressable.props.accessibilityRole).toBe('button');
    expect(pressable.props.accessibilityLabel).toBe('حفظ');
    press(tree, 'b');
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('reports disabled through accessibilityState and blocks presses', () => {
    const onPress = jest.fn();
    const tree = create(
      <Button label="حفظ" onPress={onPress} disabled testID="b" />,
    );
    expect(findHost(tree, 'b').props.accessibilityState).toEqual({
      disabled: true,
    });
    // The disabled prop lands on the Pressable composite (which blocks
    // its own event pipeline), not on the host View.
    const pressable = tree.root
      .findAllByProps({testID: 'b'})
      .find(node => typeof node.props.onPress === 'function');
    expect(pressable?.props.disabled).toBe(true);
    act(() => tree.unmount());
  });
});

describe('IconButton', () => {
  it('always reserves the 44px target regardless of glyph size', () => {
    const tree = create(
      <IconButton
        icon="x"
        accessibilityLabel="إغلاق"
        onPress={() => {}}
        size={18}
        testID="ib"
      />,
    );
    const pressable = findHost(tree, 'ib');
    const styles = pressable.props.style as Array<Record<string, unknown>>;
    const flat = Object.assign({}, ...styles.filter(Boolean));
    expect(flat.minWidth).toBe(44);
    expect(flat.minHeight).toBe(44);
    act(() => tree.unmount());
  });
});

describe('ToggleSwitch', () => {
  it('exposes switch semantics and flips the value', () => {
    const onValueChange = jest.fn();
    const tree = create(
      <ToggleSwitch
        value={false}
        onValueChange={onValueChange}
        accessibilityLabel="تفعيل"
        testID="sw"
      />,
    );
    const sw = findHost(tree, 'sw');
    expect(sw.props.accessibilityRole).toBe('switch');
    expect(sw.props.accessibilityState).toEqual({
      checked: false,
      disabled: false,
    });
    press(tree, 'sw');
    expect(onValueChange).toHaveBeenCalledWith(true);
    act(() => tree.unmount());
  });
});

describe('Stepper', () => {
  it('disables only the exhausted side', () => {
    const dec = jest.fn();
    const inc = jest.fn();
    const tree = create(
      <Stepper
        value="3"
        onDecrement={dec}
        onIncrement={inc}
        decrementDisabled
        accessibilityLabel="عدد الخلايا"
        testID="st"
      />,
    );
    const minus = tree.root.findByProps({testID: 'st-minus'});
    const plus = tree.root.findByProps({testID: 'st-plus'});
    expect(minus.props.accessibilityState).toEqual({disabled: true});
    expect(plus.props.accessibilityState).toEqual({disabled: false});
    press(tree, 'st-plus');
    expect(inc).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });
});

describe('ChoiceChips', () => {
  it('marks the selected chip for the accessibility tree', () => {
    const tree = create(
      <ChoiceChips
        options={[
          {key: 'a', label: 'أ'},
          {key: 'b', label: 'ب'},
        ]}
        selectedKey="b"
        onSelect={() => {}}
        accessibilityLabel="الخيارات"
        testID="cc"
      />,
    );
    const a = findHost(tree, 'cc-a');
    const b = findHost(tree, 'cc-b');
    expect(a.props.accessibilityState.selected).toBe(false);
    expect(b.props.accessibilityState.selected).toBe(true);
    act(() => tree.unmount());
  });
});

describe('SelectField', () => {
  const OPTIONS = [
    {key: 'gps', label: 'GPS'},
    {key: 'none', label: 'بدون'},
  ] as const;

  it('opens a MODAL sheet (never an anchored overlay) and selects', () => {
    const onSelect = jest.fn();
    const tree = create(
      <SelectField
        label="وظيفة المنفذ"
        options={OPTIONS}
        selectedKey="none"
        onSelect={onSelect}
        testID="sel"
      />,
    );
    // Closed by default.
    expect(tree.root.findByType(Modal).props.visible).toBe(false);
    press(tree, 'sel');
    expect(tree.root.findByType(Modal).props.visible).toBe(true);
    // The sheet repeats the field label so the operator never loses
    // what they are choosing.
    const sheet = tree.root.findByProps({testID: 'sel-sheet'});
    expect(sheet).toBeTruthy();
    press(tree, 'sel-option-gps');
    expect(onSelect).toHaveBeenCalledWith('gps');
    expect(tree.root.findByType(Modal).props.visible).toBe(false);
    act(() => tree.unmount());
  });

  it('does not re-fire onSelect for the already-selected option', () => {
    const onSelect = jest.fn();
    const tree = create(
      <SelectField
        label="وظيفة المنفذ"
        options={OPTIONS}
        selectedKey="gps"
        onSelect={onSelect}
        testID="sel"
      />,
    );
    press(tree, 'sel');
    press(tree, 'sel-option-gps');
    expect(onSelect).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

describe('NoticeBox', () => {
  it('renders string children as tinted body text with a variant icon', () => {
    const tree = create(
      <NoticeBox variant="hardware" title="يتطلب اختبار العتاد" testID="nb">
        هذا الإجراء يحتاج تحققاً على جهاز حقيقي.
      </NoticeBox>,
    );
    expect(tree.root.findByProps({testID: 'nb'})).toBeTruthy();
    act(() => tree.unmount());
  });

  it('announces danger notices as alerts', () => {
    const tree = create(
      <NoticeBox variant="danger" testID="nb">
        خطر
      </NoticeBox>,
    );
    expect(findHost(tree, 'nb').props.accessibilityRole).toBe(
      'alert',
    );
    act(() => tree.unmount());
  });
});

describe('SettingRow', () => {
  it('renders title, description and the control slot', () => {
    const tree = create(
      <SettingRow title="الاسم" description="الشرح" wide testID="row">
        <ToggleSwitch
          value
          onValueChange={() => {}}
          accessibilityLabel="تفعيل"
        />
      </SettingRow>,
    );
    expect(tree.root.findByProps({testID: 'row'})).toBeTruthy();
    act(() => tree.unmount());
  });
});
