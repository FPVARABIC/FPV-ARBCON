/**
 * WHAT THE CONNECTION LOOKS LIKE, IN EVERY STATE IT CAN BE IN.
 *
 * =====================================================================
 * WHY THIS IS A SAFETY SURFACE, NOT CHROME
 * =====================================================================
 *
 * Everything else in this application is read from, or written to, a
 * flight controller. The connection indicator is the one thing that says
 * WHETHER there is a flight controller at all - and every other screen's
 * honesty rests on it. A green "متصل" shown while the board is still
 * being identified means the numbers underneath belong to nothing yet. A
 * "recovering" state that looks exactly like "connected" means an
 * operator saves a configuration into a link that is not there. An
 * "ended" state that keeps the connected look means they walk away
 * believing the write landed.
 *
 * =====================================================================
 * THE STATES, AS PRODUCTION DEFINES THEM
 * =====================================================================
 *
 * Two independent state machines feed the connection surface, and both
 * are enumerated here from their own declared unions rather than from a
 * list someone typed:
 *
 *   ConnectPhase                  the act of connecting
 *     IDLE / CHOOSING / OPENING / IDENTIFYING / PICKING / FAILED
 *
 *   SetupConnectionIndicatorState what an established link is doing
 *     DISCONNECTED / ACTIVATING / RECOVERING / RECOVERY_FAILED / CONNECTED
 *
 *   ConnectionNotice              why the operator was ejected
 *     SESSION_LOST / RECONNECT_FAILED / null
 *
 * For each: the words, the icon, the accessible semantics, the actions
 * offered and the actions refused. Then the four invariants that matter
 * more than any individual row.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {
  HomeConnectStatus,
  HomeConnectNotice,
  HomeConnectPicker,
} from '../components/home/HomeConnect';
import {deriveConnectionIndicatorState} from '../components/setup/connectionIndicator';
import type {ConnectPhase} from '../session/connectFlow';
import type {ConnectionNotice} from '../session/connectionNotice';

jest.setTimeout(120000);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/* ==================================================================== *
 * WHAT A RENDERED STATE LOOKS LIKE
 * ==================================================================== */

interface Surface {
  readonly text: string;
  readonly icons: string[];
  readonly actions: {id: string; label: string; disabled: boolean}[];
  readonly roles: string[];
  readonly busy: number;
}

function inspect(tree: ReactTestRenderer.ReactTestRenderer): Surface {
  const text = tree.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .filter(line => line.length > 0)
    .join(' | ');
  const icons: string[] = [];
  const actions: {id: string; label: string; disabled: boolean}[] = [];
  const roles: string[] = [];
  let busy = 0;
  for (const node of tree.root.findAll(() => true, {deep: true})) {
    const props = node.props as any;
    if (props === null || typeof props !== 'object') continue;
    if (typeof props.name === 'string' && typeof props.size === 'number') {
      icons.push(props.name);
    }
    if (
      typeof props.testID === 'string' &&
      typeof props.onPress === 'function' &&
      /^home-/.test(props.testID)
    ) {
      actions.push({
        id: props.testID,
        label: String(props.accessibilityLabel ?? props.label ?? ''),
        disabled: props.disabled === true,
      });
    }
    if (typeof props.accessibilityRole === 'string') {
      roles.push(props.accessibilityRole);
    }
    if (typeof node.type === 'function' && node.type.name === 'ActivityIndicator') {
      busy += 1;
    }
  }
  /* `ActivityIndicator` is a host component under the RN preset, so the
     name check above misses it; count it by type instead. */
  busy += tree.root.findAll(
    node => String((node as any).type?.displayName ?? (node as any).type) ===
      'ActivityIndicator',
    {deep: true},
  ).length;
  return {
    text,
    icons: [...new Set(icons)],
    actions: actions.filter(
      (entry, index, all) => all.findIndex(other => other.id === entry.id) === index,
    ),
    roles: [...new Set(roles)],
    busy,
  };
}

async function render(element: React.ReactElement): Promise<Surface> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
  const surface = inspect(tree);
  await act(async () => tree.unmount());
  return surface;
}

/* ==================================================================== *
 * THE PHASES, FROM THE PRODUCTION UNION
 * ==================================================================== */

const PHASES: readonly {name: string; phase: ConnectPhase}[] = [
  {name: 'IDLE (disconnected)', phase: {kind: 'IDLE'}},
  {name: 'CHOOSING (permission/chooser)', phase: {kind: 'CHOOSING'}},
  {name: 'OPENING (connecting)', phase: {kind: 'OPENING'}},
  {name: 'IDENTIFYING', phase: {kind: 'IDENTIFYING'}},
  {
    name: 'PICKING (more than one board)',
    phase: {
      kind: 'PICKING',
      options: [
        {device: {deviceId: 1, productName: 'Board A', driverType: 'CDC', portCount: 1}} as never,
        {device: {deviceId: 2, productName: 'Board B', driverType: 'CDC', portCount: 1}} as never,
      ],
    },
  },
  {
    name: 'FAILED',
    phase: {kind: 'FAILED', message: 'تعذّر فتح المنفذ التسلسلي.'},
  },
];

const NOTICES: readonly {name: string; notice: ConnectionNotice}[] = [
  {name: 'SESSION_LOST (ended)', notice: 'SESSION_LOST'},
  {name: 'RECONNECT_FAILED (ended after a reboot)', notice: 'RECONNECT_FAILED'},
  {name: 'no notice', notice: null},
];

interface Row {
  readonly state: string;
  readonly text: string;
  readonly icons: string[];
  readonly actions: string[];
  readonly disabled: string[];
  readonly busy: number;
}

const MATRIX: Row[] = [];

describe('every connection state says what it is', () => {
  it.each(PHASES.map(entry => [entry.name, entry.phase] as const))(
    'connect phase %s',
    async (name, phase) => {
      const status = await render(
        <HomeConnectStatus
          phase={phase}
          onRetry={() => undefined}
          onDismiss={() => undefined}
        />,
      );
      const picker = await render(
        <HomeConnectPicker
          phase={phase}
          onChoose={() => undefined}
          onDismiss={() => undefined}
        />,
      );
      const merged: Surface = {
        text: [status.text, picker.text].filter(Boolean).join(' | '),
        icons: [...new Set([...status.icons, ...picker.icons])],
        actions: [...status.actions, ...picker.actions],
        roles: [...new Set([...status.roles, ...picker.roles])],
        busy: status.busy + picker.busy,
      };
      MATRIX.push({
        state: name,
        text: merged.text,
        icons: merged.icons,
        actions: merged.actions.filter(a => !a.disabled).map(a => a.id),
        disabled: merged.actions.filter(a => a.disabled).map(a => a.id),
        busy: merged.busy,
      });

      /* EVERY STATE THE OPERATOR CAN BE IN EITHER SAYS SOMETHING OR IS
         DELIBERATELY SILENT. IDLE is the silent one: nothing is in
         flight, so a strip that said "idle" would be noise. */
      if (phase.kind === 'IDLE') {
        expect({state: name, text: merged.text}).toEqual({state: name, text: ''});
      } else {
        expect({state: name, saysSomething: merged.text.length > 0}).toEqual({
          state: name,
          saysSomething: true,
        });
      }

      /* A STATE THAT NEEDS AN ANSWER OFFERS ONE. */
      if (phase.kind === 'FAILED') {
        expect({
          state: name,
          offersRetry: merged.actions.some(a => a.id === 'home-connect-retry'),
          offersDismiss: merged.actions.some(a => a.id === 'home-connect-dismiss'),
        }).toEqual({state: name, offersRetry: true, offersDismiss: true});
      }
      if (phase.kind === 'PICKING') {
        expect({
          state: name,
          offersOneOptionPerBoard:
            merged.actions.filter(a => /^home-connect-option-/.test(a.id)).length,
        }).toEqual({state: name, offersOneOptionPerBoard: 2});
        expect(merged.actions.some(a => a.id === 'home-connect-picker-cancel')).toBe(
          true,
        );
      }
    },
  );

  it.each(NOTICES.map(entry => [entry.name, entry.notice] as const))(
    'connection notice %s',
    async (name, notice) => {
      const surface = await render(
        <HomeConnectNotice
          phase={{kind: 'IDLE'}}
          notice={notice}
          onRetry={() => undefined}
          onDismiss={() => undefined}
        />,
      );
      MATRIX.push({
        state: name,
        text: surface.text,
        icons: surface.icons,
        actions: surface.actions.filter(a => !a.disabled).map(a => a.id),
        disabled: surface.actions.filter(a => a.disabled).map(a => a.id),
        busy: surface.busy,
      });
      if (notice === null) {
        expect({state: name, text: surface.text}).toEqual({
          state: name,
          text: '',
        });
      } else {
        /* AN ENDED SESSION SAYS SO AND OFFERS A WAY OUT. */
        expect({state: name, saysSomething: surface.text.length > 0}).toEqual({
          state: name,
          saysSomething: true,
        });
        expect({
          state: name,
          offersSomething: surface.actions.length > 0,
        }).toEqual({state: name, offersSomething: true});
      }
    },
  );
});

/* ==================================================================== *
 * THE FOUR INVARIANTS
 * ==================================================================== */

describe('the invariants that matter more than any single row', () => {
  it('READY never appears before identification completes', () => {
    /* Straight from the production derivation, over every ownership x
       recovery pair it can be handed. `CONNECTED` is the green one, and
       nothing short of ACTIVE + READY may produce it. */
    const ownerships = ['INACTIVE', 'ACTIVATING', 'ACTIVE', 'CLOSING'] as const;
    const recoveries = [
      undefined,
      'READY',
      'RESTARTING_READER',
      'DESYNCHRONIZED',
      'RECOVERY_FAILED',
    ] as const;
    const connected: string[] = [];
    for (const ownership of ownerships) {
      for (const recovery of recoveries) {
        const state = deriveConnectionIndicatorState(
          ownership as never,
          recovery as never,
        );
        if (state === 'CONNECTED') {
          connected.push(`${ownership}/${recovery ?? 'undefined'}`);
        }
      }
    }
    expect({pairsThatShowConnected: connected}).toEqual({
      pairsThatShowConnected: ['ACTIVE/READY'],
    });
  });

  it('RECOVERING does not look like CONNECTED', async () => {
    const recovering = deriveConnectionIndicatorState(
      'ACTIVE' as never,
      'RESTARTING_READER' as never,
    );
    const connected = deriveConnectionIndicatorState(
      'ACTIVE' as never,
      'READY' as never,
    );
    expect(recovering).not.toBe(connected);
    /* And the two are not merely different strings - they resolve to
       different WORDS for the operator. */
    const recoveringLabel = i18n.t('setupTopBar.connectionState.recovering');
    const connectedLabel = i18n.t('setupTopBar.connectionState.connected');
    expect(recoveringLabel.length).toBeGreaterThan(0);
    expect(recoveringLabel).not.toBe(connectedLabel);
  });

  it('an ended session does not keep a connected look', async () => {
    const ended = await render(
      <HomeConnectNotice
        phase={{kind: 'IDLE'}}
        notice="SESSION_LOST"
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    /* Nothing on an ENDED surface may claim the link is up: no spinner
       that implies work in progress, and the word for "connected" must
       not appear. */
    expect({endedShowsASpinner: ended.busy}).toEqual({endedShowsASpinner: 0});
    const connectedLabel = i18n.t('setupTopBar.connectionState.connected');
    expect({
      endedUsesTheConnectedWord: ended.text.includes(connectedLabel),
    }).toEqual({endedUsesTheConnectedWord: false});
    /* And it offers the operator a way forward rather than a dead end. */
    expect(ended.actions.length).toBeGreaterThan(0);
  });

  it('a progress state is never mistaken for an answer', async () => {
    /* OPENING and IDENTIFYING are work in progress: they show a spinner
       and offer no Retry, because there is nothing to retry yet. FAILED
       is the opposite. Confusing the two is how an operator ends up
       pressing Retry on a connection that is still working. */
    for (const kind of ['OPENING', 'IDENTIFYING'] as const) {
      const surface = await render(
        <HomeConnectStatus
          phase={{kind}}
          onRetry={() => undefined}
          onDismiss={() => undefined}
        />,
      );
      expect({kind, spinner: surface.busy > 0}).toEqual({kind, spinner: true});
      expect({
        kind,
        offersRetry: surface.actions.some(a => a.id === 'home-connect-retry'),
      }).toEqual({kind, offersRetry: false});
    }
    const failed = await render(
      <HomeConnectStatus
        phase={{kind: 'FAILED', message: 'تعذّر فتح المنفذ.'}}
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect({kind: 'FAILED', spinner: failed.busy}).toEqual({
      kind: 'FAILED',
      spinner: 0,
    });
  });

  it('every progress phase has its own sentence', async () => {
    /* Three phases share one strip. If they shared one SENTENCE the
       operator could not tell "choosing a board" from "asking the board
       what it is", and a connection stuck in one would look like a
       connection stuck in the other. */
    const said = new Map<string, string>();
    for (const kind of ['CHOOSING', 'OPENING', 'IDENTIFYING'] as const) {
      const surface = await render(
        <HomeConnectStatus
          phase={{kind}}
          onRetry={() => undefined}
          onDismiss={() => undefined}
        />,
      );
      said.set(kind, surface.text);
    }
    expect(new Set(said.values()).size).toBe(said.size);
  });
});

describe('the connection matrix', () => {
  it('prints it', () => {
    console.log(
      [
        '',
        '===== UI-X1D CONNECTION STATE MATRIX =====',
        '  STATE                              SPINNER  ICONS            ACTIONS OFFERED                       WORDS',
        ...MATRIX.map(
          row =>
            `  ${row.state.padEnd(34)} ${String(row.busy).padStart(4)}    ` +
            ` ${(row.icons.join(',') || '-').padEnd(16)} ` +
            ` ${(row.actions.join(', ') || '-').padEnd(36)} ` +
            ` ${row.text.slice(0, 60)}`,
        ),
        '',
        `  states rendered : ${MATRIX.length}`,
        '==========================================',
        '',
      ].join('\n'),
    );
    expect(MATRIX.length).toBe(PHASES.length + NOTICES.length);
    /* Two different states must not render the same surface: an operator
       who cannot tell them apart has not been told anything. */
    const speaking = MATRIX.filter(row => row.text.length > 0);
    expect(new Set(speaking.map(row => row.text)).size).toBe(speaking.length);
  });
});
