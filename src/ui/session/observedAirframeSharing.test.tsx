/**
 * M-F3F §10/§15 - ONE AIRFRAME RECORD, AND SETUP DOES NOT GO THROUGH
 * MOTORS TO REACH IT.
 *
 * =====================================================================
 * THE TWO REQUIREMENTS THAT PULL AGAINST EACH OTHER
 * =====================================================================
 *
 * §10 wants ONE observed-airframe truth - not a copy in Motors and
 * another in Setup, because two copies is how the two screens ended up
 * describing the same aircraft differently.
 *
 * §15 wants Setup INDEPENDENT of Motors. Setup is the screen an operator
 * opens first; if it could only show the right aircraft after a visit to
 * Motors, it would be wrong for most of the sessions it is used in.
 *
 * The resolution is one shared record with more than one reader, and
 * that is what this file checks: that the first screen to need the
 * aircraft reads it, that the second one does NOT read it again, and
 * that neither of them keeps a private answer.
 *
 * Nothing here mounts MotorsScreen. That is deliberate and is itself
 * part of the claim.
 */

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import {useObservedAirframe} from './useObservedAirframe';
import type {ObservedAirframeReader} from './useObservedAirframe';
import {observedAirframeTruth} from '../../core/state/observedAirframeTruth';
import {sceneAirframeFor} from '../orientation3d/airframeSceneModel';

const MIXER_QUADX = 3;
const MIXER_Y6 = 6;

/** A board that answers the narrow airframe read, and counts how often
 *  it is asked. The count IS the §15 evidence in one direction and the
 *  §10 evidence in the other. */
function board(mixerModeRaw: number, motorCount: number) {
  const loads: string[] = [];
  const reader: ObservedAirframeReader = {
    readObservedAirframe: async (sessionId: string) => {
      loads.push(sessionId);
      return {mixerModeRaw, motorCount};
    },
  };
  return {reader, loads};
}

/** A screen-shaped consumer: it asks for the aircraft and reports the
 *  rotor count it would draw, exactly as Setup's hero does. */
function Consumer({
  sessionId,
  reader,
}: {
  sessionId: string | undefined;
  reader: ObservedAirframeReader;
}): React.JSX.Element {
  const observed = useObservedAirframe(sessionId, reader);
  const airframe = sceneAirframeFor(observed);
  return (
    <Text testID="rotors">
      {airframe === undefined ? 'none' : String(airframe.rotors.length)}
    </Text>
  );
}

const renderers: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  while (renderers.length > 0) {
    const renderer = renderers.pop();
    ReactTestRenderer.act(() => renderer?.unmount());
  }
  observedAirframeTruth.clear();
});

function mount(sessionId: string | undefined, reader: ObservedAirframeReader) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <Consumer sessionId={sessionId} reader={reader} />,
    );
  });
  renderers.push(renderer);
  return {
    renderer,
    /* `findAll` returns the composite Text AND its host element, so a
       naive join reports every value twice. The first match is the one
       the consumer rendered. */
    rotors: () => {
      const [node] = renderer.root.findAll(
        candidate => candidate.props?.testID === 'rotors',
      );
      return node === undefined ? '' : String(node.props.children);
    },
    update: (nextSessionId: string | undefined) =>
      ReactTestRenderer.act(() => {
        renderer.update(<Consumer sessionId={nextSessionId} reader={reader} />);
      }),
  };
}

async function flush() {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 1));
  });
}

describe('M-F3F §15 - a screen that needs the aircraft reads the aircraft', () => {
  it('with nothing published, the consumer performs the read itself and draws the Y6', async () => {
    const y6 = board(MIXER_Y6, 6);
    const view = mount('session-a', y6.reader);
    // Before the read lands there is no aircraft, and none is invented.
    expect(view.rotors()).toBe('none');
    await flush();
    expect(y6.loads).toEqual(['session-a']);
    expect(view.rotors()).toBe('6');
  });

  it('§10 - a record another screen already published is USED, not re-read', async () => {
    /* Motors reads the configuration for its own editor and publishes
       what it read. Setup then needs nothing from the link at all. */
    observedAirframeTruth.publish({
      mixerModeRaw: MIXER_Y6,
      motorCount: 6,
      sessionId: 'session-a',
    });
    const quad = board(MIXER_QUADX, 4);
    const view = mount('session-a', quad.reader);
    await flush();
    // No read was issued...
    expect(quad.loads).toEqual([]);
    // ...and the aircraft shown is the published one, not this reader's.
    expect(view.rotors()).toBe('6');
  });

  it('a record from a PREVIOUS session is not an answer about this one', async () => {
    observedAirframeTruth.publish({
      mixerModeRaw: MIXER_Y6,
      motorCount: 6,
      sessionId: 'session-old',
    });
    const quad = board(MIXER_QUADX, 4);
    const view = mount('session-new', quad.reader);
    // The stale record must not be drawn even for one frame.
    expect(view.rotors()).toBe('none');
    await flush();
    expect(quad.loads).toEqual(['session-new']);
    expect(view.rotors()).toBe('4');
  });

  it('a disconnected board has no aircraft, and the record is cleared', async () => {
    const y6 = board(MIXER_Y6, 6);
    const view = mount('session-a', y6.reader);
    await flush();
    expect(view.rotors()).toBe('6');

    view.update(undefined);
    await flush();
    expect(view.rotors()).toBe('none');
    expect(observedAirframeTruth.get()).toBeUndefined();
  });

  it('a read that fails leaves no aircraft rather than a plausible one', async () => {
    const loads: string[] = [];
    const failing: ObservedAirframeReader = {
      readObservedAirframe: async (sessionId: string) => {
        loads.push(sessionId);
        throw new Error('link went away mid-read');
      },
    };
    const view = mount('session-a', failing);
    await flush();
    expect(loads).toEqual(['session-a']);
    expect(view.rotors()).toBe('none');
  });

  it('re-rendering does not issue a second read for the same session', async () => {
    const y6 = board(MIXER_Y6, 6);
    const view = mount('session-a', y6.reader);
    await flush();
    view.update('session-a');
    view.update('session-a');
    await flush();
    expect(y6.loads).toEqual(['session-a']);
  });
});
