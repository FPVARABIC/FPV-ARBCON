/**
 * THE BOARD ALIGNMENT SURFACE.
 *
 * The controller suite proves the exchange with the board. This suite
 * proves the thing an operator can actually be misled by: what the card
 * SAYS, and when it stops saying it.
 *
 * The load-bearing assertions here are the negative ones -
 *
 *   - before a successful read, the card must say the angles are UNKNOWN
 *     and must not present any number as the board's setting. A live 3D
 *     model beside a confident-looking alignment panel is precisely the
 *     illusion that would let someone fly a board they never configured;
 *   - after an unverified or unconfirmed save, it must go BACK to
 *     unknown rather than keep showing the values it hoped it wrote;
 *   - save stays disabled while nothing changed or while a value is not
 *     a number the firmware would accept.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import BoardAlignmentCard from './BoardAlignmentCard';
import '../../../i18n';
import type {MspBoardAlignmentSnapshot} from '../../../core';
import type {
  BoardAlignmentController,
  BoardAlignmentLoadOutcome,
  BoardAlignmentSaveOutcome,
} from '../../../platforms/react-native/protocol';

const KEY = {sessionId: 'setup-1', generation: 3} as const;
const NEUTRAL: MspBoardAlignmentSnapshot = {
  rollDegrees: 0,
  pitchDegrees: 0,
  yawDegrees: 0,
};
const ROTATED: MspBoardAlignmentSnapshot = {
  rollDegrees: 2,
  pitchDegrees: 0,
  yawDegrees: 90,
};

interface FakeController {
  loads: BoardAlignmentLoadOutcome[];
  saves: BoardAlignmentSaveOutcome[];
  saveCalls: Array<{
    original: MspBoardAlignmentSnapshot;
    draft: MspBoardAlignmentSnapshot;
  }>;
  loadCount: number;
}

function makeController(
  loads: BoardAlignmentLoadOutcome[],
  saves: BoardAlignmentSaveOutcome[] = [],
) {
  const state: FakeController = {loads, saves, saveCalls: [], loadCount: 0};
  const controller = {
    state,
    load: async () => {
      state.loadCount += 1;
      return state.loads.shift() ?? {kind: 'FAILED' as const, error: undefined};
    },
    save: async (
      _key: unknown,
      original: MspBoardAlignmentSnapshot,
      draft: MspBoardAlignmentSnapshot,
    ) => {
      state.saveCalls.push({original, draft});
      return (
        state.saves.shift() ?? {kind: 'FAILED' as const, error: undefined}
      );
    },
  };
  return controller as unknown as BoardAlignmentController & typeof controller;
}

async function render(controller: BoardAlignmentController & FakeControllerHost) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <BoardAlignmentCard sessionKey={KEY} active controller={controller} />,
    );
  });
  return renderer;
}

type FakeControllerHost = {state: FakeController};

function node(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const found = renderer.root.findAll(
    candidate =>
      typeof candidate.type === 'string' && candidate.props.testID === testID,
  );
  return found.length > 0 ? found[0] : undefined;
}

function press(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const target = renderer.root
    .findAll(candidate => candidate.props.testID === testID)
    .find(candidate => typeof candidate.props.onPress === 'function');
  expect(target).toBeDefined();
  act(() => {
    target!.props.onPress();
  });
}

function type(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  value: string,
) {
  const target = renderer.root
    .findAll(candidate => candidate.props.testID === testID)
    .find(candidate => typeof candidate.props.onChangeText === 'function');
  expect(target).toBeDefined();
  act(() => {
    target!.props.onChangeText(value);
  });
}

/** Is a Button with this testID currently refusing presses? */
function disabled(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  const target = renderer.root
    .findAll(candidate => candidate.props.testID === testID)
    .find(candidate => candidate.props.accessibilityState !== undefined);
  expect(target).toBeDefined();
  return target!.props.accessibilityState.disabled === true;
}

function textOf(renderer: ReactTestRenderer.ReactTestRenderer): string {
  const chunks: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object' && 'children' in value) {
      walk((value as {children: unknown}).children);
    }
  };
  walk(renderer.toJSON());
  return chunks.join('\n');
}

describe('BoardAlignmentCard', () => {
  it('reads on open and shows what the board reported', async () => {
    const controller = makeController([{kind: 'LOADED', snapshot: ROTATED}]);
    const renderer = await render(controller);
    expect(controller.state.loadCount).toBe(1);
    expect(node(renderer, 'board-alignment-roll-current')).toBeDefined();
    const text = textOf(renderer);
    expect(text).toContain('2°');
    expect(text).toContain('90°');
    expect(text).toContain("Ingesteld");
  });

  it('says the alignment is unknown - and shows no values - when the read is refused', async () => {
    const controller = makeController([
      {kind: 'REJECTED', reason: 'DISCONNECTED'},
    ]);
    const renderer = await render(controller);
    expect(node(renderer, 'board-alignment-values')).toBeUndefined();
    expect(node(renderer, 'board-alignment-edit')).toBeUndefined();
    const text = textOf(renderer);
    expect(text).toContain("Onbekend.");
    // The sentence that stops the live 3D model from reading as proof.
    expect(text).toContain("De montagehoeken van deze controller zijn nog niet uitgelezen. Het 3D-model hierboven toont de huidige houding van het toestel; het bewijst niet dat de montageoriëntatie is ingesteld.");
    expect(text).toContain("Geen verbinding met de vluchtcontroller");
  });

  it('separates "standard" from "unknown" - 0/0/0 is a reading, not an absence', async () => {
    const controller = makeController([{kind: 'LOADED', snapshot: NEUTRAL}]);
    const renderer = await render(controller);
    const text = textOf(renderer);
    expect(text).toContain("Standaard");
    expect(text).not.toContain("Onbekend.");
  });

  it('keeps save disabled until a value actually changes', async () => {
    const controller = makeController([{kind: 'LOADED', snapshot: NEUTRAL}]);
    const renderer = await render(controller);
    press(renderer, 'board-alignment-edit');
    expect(disabled(renderer, 'board-alignment-save')).toBe(true);
    type(renderer, 'board-alignment-yaw', '90');
    expect(disabled(renderer, 'board-alignment-save')).toBe(false);
  });

  it('refuses a value the firmware would not accept, and says the range', async () => {
    const controller = makeController([{kind: 'LOADED', snapshot: NEUTRAL}]);
    const renderer = await render(controller);
    press(renderer, 'board-alignment-edit');
    type(renderer, 'board-alignment-roll', '400');
    expect(disabled(renderer, 'board-alignment-save')).toBe(true);
    expect(node(renderer, 'board-alignment-invalid')).toBeDefined();
    expect(textOf(renderer)).toContain('-180');
    // Half-typed text is not a number either, and must not be guessed at.
    type(renderer, 'board-alignment-roll', '-');
    expect(disabled(renderer, 'board-alignment-save')).toBe(true);
    type(renderer, 'board-alignment-roll', '-45');
    expect(disabled(renderer, 'board-alignment-save')).toBe(false);
  });

  it('sends the edited triple and adopts the verified readback', async () => {
    const controller = makeController(
      [{kind: 'LOADED', snapshot: NEUTRAL}],
      [{kind: 'SAVED_VERIFIED', snapshot: ROTATED, rebootAcknowledged: true}],
    );
    const renderer = await render(controller);
    press(renderer, 'board-alignment-edit');
    type(renderer, 'board-alignment-roll', '2');
    type(renderer, 'board-alignment-yaw', '90');
    await act(async () => {
      press(renderer, 'board-alignment-save');
    });
    expect(controller.state.saveCalls).toEqual([
      {original: NEUTRAL, draft: ROTATED},
    ]);
    const text = textOf(renderer);
    expect(text).toContain('2°');
    expect(text).toContain('90°');
    /* The restart is stated, not implied by a bare "saved" - and U-R2
       makes the assertion stricter than the old substring did: the copy
       must name the ACKNOWLEDGEMENT of the restart command, because this
       is the branch where `rebootAcknowledged` is true. A sentence that
       merely mentioned a restart would no longer be enough. */
    expect(text).toContain("Opgeslagen en door teruglezen geverifieerd. De herstartopdracht is bevestigd. Verbind opnieuw nadat de controller is opgestart.");
  });

  it('tells the operator the alignment is unknown again after an unverified save', async () => {
    const controller = makeController(
      [{kind: 'LOADED', snapshot: NEUTRAL}],
      [
        {
          kind: 'SAVED_UNVERIFIED',
          rebootAcknowledged: true,
          error: new Error('x'),
        },
      ],
    );
    const renderer = await render(controller);
    press(renderer, 'board-alignment-edit');
    type(renderer, 'board-alignment-yaw', '90');
    await act(async () => {
      press(renderer, 'board-alignment-save');
    });
    expect(node(renderer, 'board-alignment-values')).toBeUndefined();
    const text = textOf(renderer);
    expect(text).toContain("Onbekend.");
    expect(text).toContain("Opslaan en de herstartopdracht zijn bevestigd, maar teruglezen ter verificatie is mislukt. Verbind opnieuw en lees de montageoriëntatie uit vóór de vlucht.");
  });

  it('stops claiming to know the values after an unconfirmed write', async () => {
    const controller = makeController(
      [{kind: 'LOADED', snapshot: NEUTRAL}],
      [{kind: 'UNCONFIRMED', stage: 'BOARD_ALIGNMENT', confirmedStages: []}],
    );
    const renderer = await render(controller);
    press(renderer, 'board-alignment-edit');
    type(renderer, 'board-alignment-yaw', '90');
    await act(async () => {
      press(renderer, 'board-alignment-save');
    });
    expect(node(renderer, 'board-alignment-values')).toBeUndefined();
    expect(textOf(renderer)).toContain("De controller heeft het schrijven van de montageoriëntatie niet bevestigd. De uitkomst is onbekend en de opdracht is niet herhaald. Verbind opnieuw en lees de huidige waarden uit.");
  });

  it('reports an ARMED refusal in words, keeps the draft, and loses nothing', async () => {
    const controller = makeController(
      [{kind: 'LOADED', snapshot: NEUTRAL}],
      [{kind: 'REJECTED', reason: 'FC_ARMED'}],
    );
    const renderer = await render(controller);
    press(renderer, 'board-alignment-edit');
    type(renderer, 'board-alignment-yaw', '90');
    await act(async () => {
      press(renderer, 'board-alignment-save');
    });
    // A refusal means nothing was written and nothing became uncertain.
    // The operator stays in the editor with the value they typed, so
    // disarming and pressing save again is the whole recovery.
    expect(node(renderer, 'board-alignment-editor')).toBeDefined();
    expect(disabled(renderer, 'board-alignment-save')).toBe(false);
    expect(textOf(renderer)).toContain("De vluchtcontroller is ARMED. Schakel ARM uit voordat u instellingen opslaat.");
    // And the board's own values are still known - cancelling returns
    // to them rather than to "unknown".
    press(renderer, 'board-alignment-cancel');
    expect(node(renderer, 'board-alignment-values')).toBeDefined();
    expect(textOf(renderer)).toContain("Standaard");
  });

  it('restores the board’s values when an edit is cancelled', async () => {
    const controller = makeController([{kind: 'LOADED', snapshot: ROTATED}]);
    const renderer = await render(controller);
    press(renderer, 'board-alignment-edit');
    type(renderer, 'board-alignment-yaw', '270');
    press(renderer, 'board-alignment-cancel');
    expect(node(renderer, 'board-alignment-editor')).toBeUndefined();
    const text = textOf(renderer);
    expect(text).toContain('90°');
    expect(text).not.toContain('270°');
    expect(controller.state.saveCalls).toEqual([]);
  });

  it('offers a retry, and never sends a write, when there is nothing to edit', async () => {
    const controller = makeController([
      {kind: 'REJECTED', reason: 'LINK_RECOVERING'},
      {kind: 'LOADED', snapshot: ROTATED},
    ]);
    const renderer = await render(controller);
    expect(node(renderer, 'board-alignment-read')).toBeDefined();
    await act(async () => {
      press(renderer, 'board-alignment-read');
    });
    expect(controller.state.loadCount).toBe(2);
    expect(node(renderer, 'board-alignment-values')).toBeDefined();
    expect(controller.state.saveCalls).toEqual([]);
  });
});
