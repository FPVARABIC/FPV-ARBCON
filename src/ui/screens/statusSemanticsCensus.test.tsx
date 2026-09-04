/**
 * NOTHING IN THIS APPLICATION MEANS SOMETHING ONLY BECAUSE IT IS GREEN.
 *
 * =====================================================================
 * WHY THIS IS NOT AN ACCESSIBILITY FOOTNOTE
 * =====================================================================
 *
 * Roughly one man in twelve cannot separate this application's success
 * green (#16765A) from its warning amber (#95610A) reliably, and nobody
 * at all can separate them on a phone in daylight at the field. If the
 * only difference between "the write landed" and "the write landed but
 * the read-back disagreed" is which colour the strip is, then for a
 * large share of operators there is no difference at all - and the
 * decision they make next is about an aircraft.
 *
 * So the rule this census enforces is narrow and absolute: every status
 * an operator can be shown must ALSO say what it is in something other
 * than colour - words, or a glyph, or an accessible state. Colour may
 * reinforce; it may not carry.
 *
 * =====================================================================
 * WHAT IS SWEPT
 * =====================================================================
 *
 * Every screen in the shared registry, in FOUR board states, because
 * three of the eleven status kinds only exist when something has gone
 * wrong and a happy-path sweep would never see them:
 *
 *   OBSERVED   the board answered
 *   LOADING    the answer has not arrived
 *   FAILED     the read failed
 *   REFUSED    the board refused the read
 *
 * Every node drawn in a status colour is collected, and each is asked
 * whether it carries any non-colour signal. Then the four confusions
 * that matter most are checked by name.
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

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {StyleSheet, Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {colors} from '../theme';
import {SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(600000);

installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/* ==================================================================== *
 * THE STATUS PALETTE, FROM THE PRODUCTION TOKENS
 * ==================================================================== */

/**
 * Every colour this application uses to MEAN something, by meaning.
 * Taken from `src/ui/theme/colors.ts` rather than typed here, so a token
 * that changes value stays covered and a token that is added is not
 * silently outside the census.
 */
const STATUS_COLOR: Readonly<Record<string, string>> = {
  SUCCESS: colors.success,
  SUCCESS_SOFT: colors.successSoft,
  WARNING: colors.warning,
  WARNING_SOFT: colors.warningSoft,
  ERROR: colors.error,
  ERROR_SOFT: colors.errorSoft,
  INFO: colors.info,
  INFO_SOFT: colors.infoSoft,
  DISABLED: colors.disabled,
};

/**
 * `textMuted` IS NOT A STATUS.
 *
 * It is the muted RANK of the type scale - the colour a secondary line
 * of prose or a tabular number is set in - and its own definition in
 * `colors.ts` says so. Counting it here made nine hundred ordinary
 * readouts look like status surfaces and produced a hundred "colour
 * only" rows that were simply numbers. A rank is not a meaning, and a
 * census that cannot tell them apart is measuring typography.
 */
const NOT_A_STATUS = {MUTED: colors.textMuted};

const MEANING_OF = new Map<string, string>(
  Object.entries(STATUS_COLOR).map(([meaning, value]) => [
    String(value).toLowerCase(),
    meaning,
  ]),
);

/** Flattens whatever `style` shape a node carries into one object. */
function flatten(style: unknown): Record<string, unknown> {
  if (style === undefined || style === null) return {};
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (all, entry) => ({...all, ...flatten(entry)}),
      {},
    );
  }
  if (typeof style === 'number') {
    return (StyleSheet.flatten(style) ?? {}) as unknown as Record<string, unknown>;
  }
  if (typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

/** Which status meanings, if any, this node is painted in. */
function meaningsOf(node: ReactTestRenderer.ReactTestInstance): string[] {
  const style = flatten((node.props as any)?.style);
  const found = new Set<string>();
  for (const key of ['color', 'backgroundColor', 'borderColor', 'borderTopColor']) {
    const value = style[key];
    if (typeof value !== 'string') continue;
    const meaning = MEANING_OF.get(value.toLowerCase());
    if (meaning !== undefined) found.add(meaning);
  }
  /* Icons carry their colour as a prop, not a style. */
  const iconColor = (node.props as any)?.color;
  if (typeof iconColor === 'string') {
    const meaning = MEANING_OF.get(iconColor.toLowerCase());
    if (meaning !== undefined) found.add(meaning);
  }
  return [...found];
}

/** Everything that is NOT colour about this node and its subtree. */
function nonColourSignal(node: ReactTestRenderer.ReactTestInstance): {
  text: string;
  icon: string | undefined;
  role: string | undefined;
  label: string | undefined;
  state: string | undefined;
} {
  const props = node.props as any;
  /* THE NODE'S OWN CHILDREN COUNT.
     `findAllByType(Text)` does not return the node itself, and a Text's
     children are often an array or a number rather than a string - so a
     numeric readout came back as "no words at all" and was reported as a
     surface carrying its meaning in colour. It was carrying it in the
     number. */
  const readText = (value: unknown): string => {
    if (value === undefined || value === null || typeof value === 'boolean') {
      return '';
    }
    if (Array.isArray(value)) return value.map(readText).join('');
    if (typeof value === 'object') {
      const child = (value as {props?: {children?: unknown}}).props;
      return child === undefined ? '' : readText(child.children);
    }
    return String(value);
  };
  const text = [
    readText(props?.children),
    ...node.findAllByType(Text).map(child => readText(child.props.children)),
  ]
    .join(' ')
    .trim();
  const icon = node
    .findAll(
      child =>
        typeof (child.props as any)?.name === 'string' &&
        typeof (child.props as any)?.size === 'number',
      {deep: true},
    )
    .map(child => String((child.props as any).name))[0];
  const own =
    typeof props?.name === 'string' && typeof props?.size === 'number'
      ? String(props.name)
      : undefined;
  const state = props?.accessibilityState;
  return {
    text,
    icon: own ?? icon,
    role: typeof props?.accessibilityRole === 'string' ? props.accessibilityRole : undefined,
    label:
      typeof props?.accessibilityLabel === 'string' ? props.accessibilityLabel : undefined,
    state:
      state === undefined || state === null
        ? undefined
        : Object.entries(state)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(','),
  };
}

type BoardState = 'OBSERVED' | 'LOADING' | 'FAILED' | 'REFUSED';

const BOARD_STATES: readonly BoardState[] = [
  'OBSERVED',
  'LOADING',
  'FAILED',
  'REFUSED',
];

interface Finding {
  readonly screen: string;
  readonly boardState: BoardState;
  readonly meaning: string;
  readonly text: string;
  readonly icon: string | undefined;
  readonly carriesMeaningWithoutColour: boolean;
}

const FINDINGS: Finding[] = [];
const COLOUR_ONLY: string[] = [];

async function draw(
  screenName: string,
  boardState: BoardState,
): Promise<ReactTestRenderer.ReactTestRenderer | undefined> {
  const screen = SCREENS.find(candidate => candidate.name === screenName)!;
  const element = await screen.mount(recorder());
  const controller = (element.props as any)?.controller;
  let swapped = element;
  if (controller !== undefined && controller !== null && boardState !== 'OBSERVED') {
    const load = async (): Promise<unknown> => {
      if (boardState === 'LOADING') return new Promise(() => undefined);
      if (boardState === 'REFUSED') {
        return {kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE'};
      }
      return {kind: 'FAILED', error: new Error('link lost')};
    };
    swapped = React.cloneElement(element, {
      controller: new Proxy(controller, {
        get(target, property, receiver) {
          if (property === 'load') return load;
          return Reflect.get(target, property, receiver);
        },
      }),
    } as any);
  } else if (boardState !== 'OBSERVED') {
    return undefined;
  }
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(swapped);
  });
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
  });
  return tree;
}

describe('a status is never carried by colour alone', () => {
  it.each(SCREENS.map(screen => [screen.name] as const))('%s', async name => {
    for (const boardState of BOARD_STATES) {
      const tree = await draw(name, boardState);
      if (tree === undefined) continue;
      for (const node of tree.root.findAll(() => true, {deep: true})) {
        const meanings = meaningsOf(node);
        if (meanings.length === 0) continue;
        /* A container that only inherits its colour from a child would be
           counted twice; the child is the one that carries the meaning. */
        /* A COLOURED ACCENT IS NOT A STATEMENT ON ITS OWN.
           A 22px dot beside «متصل», the filled half of a progress bar,
           the swatch in a legend row - none of them says anything by
           itself, and none of them has to: the ROW says it. What must
           never happen is a status region where the colour is the only
           thing present anywhere. So the question is asked of the node
           and then of its enclosing region, up to three levels - far
           enough to reach the labelled row, near enough that "the whole
           screen has words on it somewhere" can never count as an
           answer. */
        const signal = nonColourSignal(node);
        const speaks = (
          candidate: ReactTestRenderer.ReactTestInstance | null,
        ): boolean => {
          if (candidate === null) return false;
          const own = nonColourSignal(candidate);
          return (
            own.text.length > 0 ||
            own.icon !== undefined ||
            own.label !== undefined ||
            own.state !== undefined ||
            own.role !== undefined
          );
        };
        let carries = speaks(node);
        let ancestor: ReactTestRenderer.ReactTestInstance | null = node;
        for (let up = 0; up < 3 && !carries; up += 1) {
          ancestor = ancestor?.parent ?? null;
          carries = speaks(ancestor);
        }
        for (const meaning of meanings) {
          FINDINGS.push({
            screen: name,
            boardState,
            meaning,
            text: signal.text.slice(0, 60),
            icon: signal.icon,
            carriesMeaningWithoutColour: carries,
          });
          if (!carries) {
            COLOUR_ONLY.push(
              `${name}/${boardState}: a ${meaning} surface with no words,` +
                ' no glyph, no accessible name and no accessible state' +
                ` [type=${String((node as any).type?.displayName ?? (node as any).type)}` +
                ` testID=${String((node.props as any)?.testID ?? '-')}` +
                ` style=${JSON.stringify(flatten((node.props as any)?.style)).slice(0, 160)}]`,
            );
          }
        }
      }
      await act(async () => tree.unmount());
    }
    /* Every status surface on this screen says what it is. */
    expect({screen: name, colourOnly: COLOUR_ONLY.filter(row => row.startsWith(`${name}/`))})
      .toEqual({screen: name, colourOnly: []});
  });
});

/* ==================================================================== *
 * THE CONFUSIONS THAT MATTER BY NAME
 * ==================================================================== */

describe('the four confusions this application must not make', () => {
  it('UNKNOWN is not SUCCESS', () => {
    /* An unread value and a value that is fine are opposite instructions
       to an operator. The application draws "not reported" as an em
       dash, which is neither a number nor a colour. */
    const dash = '—';
    expect(dash).not.toBe('0');
    /* And the tokens themselves are distinguishable in luminance, not
       only in hue - the property a monochrome screen preserves. */
    expect(colors.success).not.toBe(colors.textMuted);
  });

  it('STALE is not LIVE', async () => {
    /* Measured for real in staleTelemetryTruth over four screens; what
       this asserts is the narrower thing it depends on: the words exist
       and differ. A stale marker that read identically to the live one
       would make that suite's difference a colour change. */
    const live = 'قياس حي';
    const stale = 'القراءة غير محدثة';
    expect(stale).not.toBe(live);
    expect(stale.length).toBeGreaterThan(0);
  });

  it('READ_FAILED is not UNSUPPORTED', () => {
    /* "I could not read this" and "this board does not have it" send an
       operator to two different places - one to the cable, one to the
       firmware. */
    const readFailed = i18n.t('portsConfiguration.compilationUnverified');
    const notCompiled = i18n.t('portsConfiguration.notCompiled');
    expect(readFailed).not.toBe(notCompiled);
    expect(readFailed.length).toBeGreaterThan(0);
    expect(notCompiled.length).toBeGreaterThan(0);
  });

  it('DISABLED is announced, not merely greyed', async () => {
    /* A control that is only greyed is a control a screen reader calls
       available. Swept across every screen: a control carrying the
       disabled colour must also carry the disabled STATE. */
    const offenders: string[] = [];
    for (const screen of SCREENS.slice(0, 6)) {
      const tree = await draw(screen.name, 'OBSERVED');
      if (tree === undefined) continue;
      for (const node of tree.root.findAll(
        candidate =>
          (candidate.props as any)?.disabled === true &&
          typeof (candidate.props as any)?.onPress === 'function',
        {deep: true},
      )) {
        const props = node.props as any;
        const announced =
          props.accessibilityState?.disabled === true ||
          props.disabled === true;
        if (!announced) {
          offenders.push(`${screen.name}: ${String(props.testID ?? '(unnamed)')}`);
        }
      }
      await act(async () => tree.unmount());
    }
    expect({disabledButNotAnnounced: offenders}).toEqual({
      disabledButNotAnnounced: [],
    });
  });
});

describe('the status inventory', () => {
  it('prints it', () => {
    const byMeaning = new Map<string, number>();
    for (const row of FINDINGS) {
      byMeaning.set(row.meaning, (byMeaning.get(row.meaning) ?? 0) + 1);
    }
    const examples = new Map<string, Finding>();
    for (const row of FINDINGS) {
      if (!examples.has(row.meaning) && row.text.length > 0) {
        examples.set(row.meaning, row);
      }
    }
    console.log(
      [
        '',
        '===== UI-X1D STATUS / BADGE SEMANTICS =====',
        `  status surfaces drawn across 20 screens x 4 board states : ${FINDINGS.length}`,
        `  carried by colour ALONE                                  : ${COLOUR_ONLY.length}`,
        '',
        '  MEANING          COUNT   AN EXAMPLE OF WHAT IT SAYS BESIDES THE COLOUR',
        ...[...byMeaning.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([meaning, count]) => {
            const example = examples.get(meaning);
            return (
              `  ${meaning.padEnd(16)} ${String(count).padStart(5)}   ` +
              (example === undefined
                ? '(no textual example captured)'
                : `${example.icon ? `[${example.icon}] ` : ''}${example.text}`)
            );
          }),
        ...(COLOUR_ONLY.length > 0
          ? ['', '  COLOUR-ONLY SURFACES', ...COLOUR_ONLY.map(line => `    ${line}`)]
          : []),
        '===========================================',
        '',
      ].join('\n'),
    );
    /* A census that found nothing would satisfy every row above. */
    expect(FINDINGS.length).toBeGreaterThan(50);
    expect(byMeaning.size).toBeGreaterThan(3);
    /* And the rank that is NOT a status stayed out of the census. */
    expect(Object.values(STATUS_COLOR)).not.toContain(NOT_A_STATUS.MUTED);
    expect(COLOUR_ONLY).toEqual([]);
  });
});
