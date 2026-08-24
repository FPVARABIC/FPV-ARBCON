/**
 * THE TIER'S LAYOUT AND ITS REFUSALS, WITHOUT A BOARD.
 *
 * The production-path matrix beside this proves the tier reaches the wire.
 * This proves the two things that are purely about the component: that a
 * wide viewport gets TWO INDEPENDENT COLUMNS rather than a wrapping row,
 * and that a generator-owned control is locked with its reason attached.
 */
import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import {createAdvancedFilterDraftFromRaw} from '../../../core/state/advancedFilterFields';
import {createAdvancedPidDraftFromRaw} from '../../../core/state/advancedPidFields';
import {ADVANCED_GROUPS} from '../../presentation/advancedTuningPresentation';
import AdvancedTuningGroups from './AdvancedTuningGroups';

const advanced = createAdvancedPidDraftFromRaw(new Uint8Array(61));
const filters = createAdvancedFilterDraftFromRaw(new Uint8Array(49));

function render(overrides: {wide?: boolean; ownedFields?: ReadonlySet<string>} = {}) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <AdvancedTuningGroups
        advanced={advanced}
        filters={filters}
        disabled={false}
        wide={overrides.wide ?? false}
        ownedFields={overrides.ownedFields ?? new Set<string>()}
        onChangeAdvanced={jest.fn()}
        onChangeFilter={jest.fn()}
      />,
    );
  });
  return renderer;
}
function press(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  const target = renderer.root.findAllByProps({testID}).find(node => typeof node.props?.onPress === 'function');
  if (target === undefined) throw new Error(`no pressable ${testID}`);
  act(() => target.props.onPress());
}
function text(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root.findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')))
    .join('\n');
}

describe('the advanced tier layout', () => {
  it('stacks in ONE column when the viewport is narrow', () => {
    const renderer = render({wide: false});
    expect(renderer.root.findAllByProps({testID: 'pid-advanced-groups-column-0'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('splits into TWO independent columns when the viewport can carry them', () => {
    // Independent, not wrapped: an open group must push only the groups
    // BELOW IT in its own column, never leave a blank cell beside it.
    const renderer = render({wide: true});
    const columns = [0, 1].map(index =>
      renderer.root.findAllByProps({testID: `pid-advanced-groups-column-${index}`})[0]);
    expect(columns[0]).toBeDefined();
    expect(columns[1]).toBeDefined();
    expect(renderer.root.findAllByProps({testID: 'pid-advanced-groups-column-2'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('puts every group in exactly one column, and none twice', () => {
    const renderer = render({wide: true});
    const inColumn = (index: number): string[] =>
      ADVANCED_GROUPS
        .map(group => group.key)
        .filter(key => renderer.root
          .findAllByProps({testID: `pid-advanced-groups-column-${index}`})[0]
          .findAllByProps({testID: `pid-advanced-groups-${key}`}).length > 0);
    const left = inColumn(0);
    const right = inColumn(1);
    expect([...left, ...right].sort()).toEqual(ADVANCED_GROUPS.map(group => group.key).sort());
    expect(left.filter(key => right.includes(key))).toEqual([]);
    // Balanced by count, which is the only balance available before the
    // operator decides which groups to open.
    expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(1);
    act(() => renderer.unmount());
  });
});

describe('the advanced tier refusals', () => {
  it('locks a generator-owned control and attaches the reason', () => {
    const renderer = render({ownedFields: new Set(['ROLL.D_MAX'])});
    press(renderer, 'pid-advanced-groups-D_MAX-toggle');
    const locked = renderer.root.findAllByProps({testID: 'pid-advanced-dMaxRoll-value'})
      .find(node => typeof node.props.editable === 'boolean');
    expect(locked?.props.editable).toBe(false);
    expect(renderer.root.findAllByProps({testID: 'pid-advanced-dMaxRoll-owned'}).length).toBeGreaterThan(0);
    expect(text(renderer)).toContain('سيُلغى عند الحفظ');
    act(() => renderer.unmount());
  });

  it('leaves an unowned control in the same group editable', () => {
    // The positive control: without it, a mutation that locks EVERYTHING
    // would still pass the test above.
    const renderer = render({ownedFields: new Set(['ROLL.D_MAX'])});
    press(renderer, 'pid-advanced-groups-D_MAX-toggle');
    const free = renderer.root.findAllByProps({testID: 'pid-advanced-dMaxGain-value'})
      .find(node => typeof node.props.editable === 'boolean');
    expect(free?.props.editable).toBe(true);
    expect(renderer.root.findAllByProps({testID: 'pid-advanced-dMaxGain-owned'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('locks every control while the page is busy, without claiming the generator owns them', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AdvancedTuningGroups
          advanced={advanced}
          filters={filters}
          disabled
          wide={false}
          ownedFields={new Set<string>()}
          onChangeAdvanced={jest.fn()}
          onChangeFilter={jest.fn()}
        />,
      );
    });
    press(renderer, 'pid-advanced-groups-D_MAX-toggle');
    const locked = renderer.root.findAllByProps({testID: 'pid-advanced-dMaxRoll-value'})
      .find(node => typeof node.props.editable === 'boolean');
    expect(locked?.props.editable).toBe(false);
    expect(renderer.root.findAllByProps({testID: 'pid-advanced-dMaxRoll-owned'})).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
