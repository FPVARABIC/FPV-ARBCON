import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import SetupScreen from './SetupScreen';
import type {RootStackParamList} from '../../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

// Mirrors App.test.tsx's own queryByTestID(): findAllByProps({testID})
// also matches Text's own underlying host-component instance (which
// forwards the same testID prop through undisturbed), not just the
// logical <Text> element - filtering to node.type === Text is what
// actually disambiguates it.
function queryByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({testID}).filter(node => node.type === Text);
}

/** Only the fields SetupScreen itself reads (route.params) - cast, same
 * as this codebase's other fake-prop patterns (e.g.
 * UsbConnectionScreen.test.tsx's `as unknown as UsbSerialTransportClient`). */
function makeProps(params: RootStackParamList['Setup'] | undefined): Props {
  return {
    route: {params} as unknown as Props['route'],
    navigation: {} as unknown as Props['navigation'],
  };
}

describe('SetupScreen', () => {
  it('renders the received sessionKey when route.params is present', () => {
    const props = makeProps({sessionKey: {sessionId: 'session-1', generation: 3}});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });

    const match = queryByTestID(renderer, 'setup-screen-session-key')[0];
    expect(match.props.children).toBe('session-1:3');

    act(() => {
      renderer.unmount();
    });
  });

  it('does not throw and renders an honest fallback when route.params is missing (defense-in-depth)', () => {
    const props = makeProps(undefined);
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    expect(() => {
      act(() => {
        renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
      });
    }).not.toThrow();

    expect(queryByTestID(renderer, 'setup-screen-session-key')).toHaveLength(0);
    expect(queryByTestID(renderer, 'setup-screen-missing-session')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });
});
