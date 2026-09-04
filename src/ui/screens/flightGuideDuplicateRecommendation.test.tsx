/**
 * A STEP MAY RECOMMEND THE SAME NUMBER TWICE, AND THE SCREEN MUST DRAW
 * BOTH CHIPS.
 *
 * =====================================================================
 * WHY THIS TEST EXISTS
 * =====================================================================
 *
 * `FlightStyleCornerScreen` draws one chip per recommended value:
 *
 *     step.recommended.map(value => <View key={value} …>)
 *
 * That is a duplicate React key the moment a step recommends one number
 * twice - and the shipped guide content does exactly that, in three
 * places, because the two chips are two FIELDS that happen to want the
 * same number:
 *
 *     freestyle  step 1  ['50', '50']
 *     racing     step 1  ['25', '25']
 *     tiny-whoop step 3  ['30', '65', '30']
 *
 * React documents duplicate sibling keys as unsupported: children "may
 * be duplicated and/or omitted", and the behaviour "could change in a
 * future version". A reader who is told two smoothing fields want 50 and
 * is shown one chip has been given the wrong instructions.
 *
 * This is NOT a defect an oracle invented. It is reachable from the
 * application's own static content, with no mutation of any kind, by
 * opening the Freestyle corner - which is what the first assertion
 * below proves before anything is rendered.
 *
 * The repair keys by POSITION, which is the real identity here: this is
 * static content and the nth chip is the nth field.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text, View} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import FlightStyleCornerScreen from './FlightStyleCornerScreen';
import {GUIDE_CORNERS} from '../flight-guides/guideContent';

jest.setTimeout(60000);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

interface Repeat {
  readonly corner: string;
  readonly step: number;
  readonly values: readonly string[];
  readonly repeated: readonly string[];
}

/** Every shipped step that recommends one value more than once. */
function repeatsInShippedContent(): Repeat[] {
  const found: Repeat[] = [];
  for (const corner of GUIDE_CORNERS) {
    for (const step of corner.steps) {
      const counts = new Map<string, number>();
      for (const value of step.recommended) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      const repeated = [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([value]) => value);
      if (repeated.length > 0) {
        found.push({
          corner: corner.id,
          step: step.n,
          values: step.recommended,
          repeated,
        });
      }
    }
  }
  return found;
}

function chipTextsFor(
  tree: ReactTestRenderer.ReactTestRenderer,
  stepNumber: number,
  cornerId: string,
): string[] {
  const block = tree.root.findAll(
    node => (node.props as any)?.testID === `guide-step-${cornerId}-${stepNumber}`,
    {deep: true},
  )[0];
  if (block === undefined) return [];
  return block
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .filter(text => text.length > 0);
}

async function openCorner(
  styleId: string,
): Promise<{tree: ReactTestRenderer.ReactTestRenderer; keyWarnings: string[]}> {
  const keyWarnings: string[] = [];
  const spy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      const first = String(args[0] ?? '');
      if (first.includes('same key')) keyWarnings.push(first);
    });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <FlightStyleCornerScreen
        navigation={{navigate: () => undefined, goBack: () => undefined} as any}
        route={{params: {styleId}} as any}
      />,
    );
  });
  await act(async () => {
    for (let round = 0; round < 6; round += 1) await Promise.resolve();
  });
  spy.mockRestore();
  return {tree, keyWarnings};
}

describe('a repeated recommended value is a real, shipped state', () => {
  it('the shipped guides really do repeat a recommendation', () => {
    /* THE SUBJECT EXISTS. Without this the rest of the suite could pass
       on content where no step repeats anything, and would then be
       proving nothing at all. If a content edit ever removes every
       repeat, this fails and says so rather than going quiet. */
    const repeats = repeatsInShippedContent();
    console.log(
      [
        '',
        '===== UI-X1D REPEATED RECOMMENDATION (SHIPPED CONTENT) =====',
        `  steps recommending one value more than once : ${repeats.length}`,
        ...repeats.map(
          row =>
            `  ${row.corner.padEnd(12)} step ${row.step}  ${JSON.stringify(
              row.values,
            )}  repeats ${JSON.stringify(row.repeated)}`,
        ),
        '===========================================================',
        '',
      ].join('\n'),
    );
    expect(repeats.length).toBeGreaterThan(0);
  });

  it.each(repeatsInShippedContent().map(row => [row.corner, row] as const))(
    '%s draws every chip and raises no duplicate-key condition',
    async (_corner, row) => {
      const {tree, keyWarnings} = await openCorner(row.corner);

      /* EVERY CHIP IS DRAWN. `['50','50']` must produce two chips
         reading 50, not one. Counted from the step's own block so a
         chip elsewhere on the screen cannot stand in for a missing
         one. */
      const texts = chipTextsFor(tree, row.step, row.corner);
      const drawn = row.values.map(
        value => texts.filter(text => text === value).length,
      );
      const expected = row.values.map(
        value => row.values.filter(other => other === value).length,
      );
      expect({corner: row.corner, step: row.step, drawn}).toEqual({
        corner: row.corner,
        step: row.step,
        drawn: expected,
      });

      /* AND THE CONDITION IS GONE. Not "React happened to render both
         anyway" - the keys are distinct, so there is nothing for React
         to resolve. */
      expect({corner: row.corner, duplicateKeyWarnings: keyWarnings}).toEqual({
        corner: row.corner,
        duplicateKeyWarnings: [],
      });

      await act(async () => tree.unmount());
    },
  );

  it('the detector sees a duplicate key when one is really there', async () => {
    /* NEGATIVE CONTROL. The assertion above is only worth anything if a
       duplicate key would actually be reported here, so one is built on
       purpose - in the harness, over the same values the shipped content
       carries - and must be seen. */
    const row = repeatsInShippedContent()[0];
    const seen: string[] = [];
    const spy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        const first = String(args[0] ?? '');
        if (first.includes('same key')) seen.push(first);
      });
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <View>
          {row.values.map(value => (
            <Text key={value}>{value}</Text>
          ))}
        </View>,
      );
    });
    spy.mockRestore();
    expect(seen.length).toBeGreaterThan(0);
    await act(async () => tree.unmount());
  });
});
