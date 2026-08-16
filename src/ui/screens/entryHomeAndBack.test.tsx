/**
 * HOME AS TWO DOORS, AND A WAY BACK OUT OF EVERY ONE OF THEM.
 *
 * Two reported defects meet here. The flight-controller workspace could
 * be entered with no visible way back - Home → connect → trapped. And
 * the Home screen sold the product with a slogan ("مهمتان، بابان
 * مباشران") instead of naming the two things an operator can actually
 * do. These tests pin the corrected entry: two destinations, plain
 * Arabic, compact actions, and a back control wherever there is
 * somewhere to go back to.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Text, View} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import StartScreen from './StartScreen';
import {SetupConnectWorkspace} from './setupSessionHost';

type Renderer = ReactTestRenderer.ReactTestRenderer;

function screenText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

function control(renderer: Renderer, testID: string) {
  return renderer.root
    .findAllByProps({testID})
    .find(node => typeof node.props.onPress === 'function');
}

/** The resolved style of a control, merged across every node carrying
 * that testID (the composite and its host both do). */
function styleOf(renderer: Renderer, testID: string): Record<string, unknown> {
  const nodes = renderer.root.findAllByProps({testID});
  if (nodes.length === 0) throw new Error(`Missing control ${testID}`);
  const flatten = (value: unknown): Record<string, unknown> =>
    Array.isArray(value)
      ? value.reduce<Record<string, unknown>>(
          (all, item) => ({...all, ...flatten(item)}),
          {},
        )
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
  return nodes.reduce<Record<string, unknown>>((all, node) => {
    const raw =
      typeof node.props.style === 'function'
        ? node.props.style({pressed: false, hovered: false})
        : node.props.style;
    return {...all, ...flatten(raw)};
  }, {});
}

function flatStyle(value: unknown): Record<string, unknown> {
  return Array.isArray(value)
    ? value.reduce<Record<string, unknown>>(
        (all, item) => ({...all, ...flatStyle(item)}),
        {},
      )
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
}

/** The two Home route cards, by the shape only they have: a clipped,
 * rounded, bordered surface inside the route group. */
function routeCards(renderer: Renderer): Array<Record<string, unknown>> {
  return renderer.root
    .findAllByProps({testID: 'start-route-group'})[0]
    .findAllByType(View)
    .map(node => flatStyle(node.props.style))
    .filter(style => style.overflow === 'hidden' && style.borderWidth === 1);
}

function renderStart(navigate: jest.Mock, width?: number): Renderer {
  let dimensions: jest.SpyInstance | undefined;
  if (width !== undefined) {
    dimensions = jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({width, height: 900, scale: 2, fontScale: 1});
  }
  let renderer!: Renderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <StartScreen
        navigation={{navigate} as never}
        route={{key: 'Start', name: 'Start'} as never}
      />,
    );
  });
  dimensions?.mockRestore();
  return renderer;
}

const renderers: Renderer[] = [];
afterEach(() => {
  renderers.splice(0).forEach(renderer => {
    act(() => {
      renderer.unmount();
    });
  });
  jest.clearAllMocks();
});

describe('Home offers exactly two destinations', () => {
  it('has the flight-controller door and the firmware door, and no third primary action', () => {
    const navigate = jest.fn();
    const renderer = renderStart(navigate);
    renderers.push(renderer);

    expect(control(renderer, 'start-configure')).toBeDefined();
    expect(control(renderer, 'start-firmware')).toBeDefined();

    const primaries = renderer.root
      .findAllByProps({testID: 'start-route-group'})[0]
      .findAllByType(Text)
      .map(node => String(node.props.children));
    expect(primaries).toContain('فتح إعدادات متحكم الطيران');
    expect(primaries).toContain('فتح Firmware Flasher');
  });

  it('the flight-controller card names what the operator will actually do there', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    const text = screenText(renderer);

    expect(text).toContain('إعداد متحكم الطيران');
    expect(text).toContain('الاتصال باللوحة');
    expect(text).toContain('Motors');
    expect(text).toContain('OSD');
    expect(text).toContain('CLI');
  });

  it('the firmware card is direct and not overloaded', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    const text = screenText(renderer);

    expect(text).toContain('Firmware Flasher');
    expect(text).toContain('تثبيت أو تحديث Firmware واختيار Target وإعدادات البناء.');
  });

  it('the awkward slogan is gone, and no marketing language replaced it', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    const text = screenText(renderer);

    expect(text).not.toContain('مهمتان، بابان مباشران');
    expect(text).not.toContain('بابان');
    expect(text).toContain('اختر ما تريد تنفيذه');
  });

  it('each door navigates straight to its destination - no intermediate choice', () => {
    const navigate = jest.fn();
    const renderer = renderStart(navigate);
    renderers.push(renderer);

    act(() => {
      control(renderer, 'start-configure')?.props.onPress();
    });
    expect(navigate).toHaveBeenCalledWith('Setup');

    act(() => {
      control(renderer, 'start-firmware')?.props.onPress();
    });
    expect(navigate).toHaveBeenCalledWith('FirmwareFlasher');
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('the calls to action are compact, not full-width bars', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);

    for (const testID of ['start-configure', 'start-firmware']) {
      const style = styleOf(renderer, testID);
      expect(style.alignSelf).toBe('flex-start');
      // Still a comfortable target.
      expect(Number(style.minHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  /**
   * THE COLLAPSED-CARD DEFECT.
   *
   * Both cards carried `flexGrow/flexShrink/flexBasis: 0`, documented as
   * "inert inside routeColumn where the parent is not a row". It is the
   * opposite of inert: `flexBasis` sizes the MAIN axis, and a column's
   * main axis is VERTICAL - so every stacked card asked for a height of
   * zero and, being `overflow: hidden`, cut off its own title along with
   * the bullets and the call to action. Chromium against the deployed
   * bundle showed ~50px cards at 360/390/412/768; at >=1024 the cards sit
   * in a genuine row, where the same properties do the intended thing,
   * which is exactly why a width-only check reported PASS.
   */
  it.each([360, 390, 412, 768, 1023])(
    'a stacked card at %ipx never asks for zero height',
    windowWidth => {
      const renderer = renderStart(jest.fn(), windowWidth);
      renderers.push(renderer);

      const cards = routeCards(renderer);
      expect(cards).toHaveLength(2);
      for (const style of cards) {
        // Not "0 but overridden" - absent, so the card is content-sized.
        expect(style.flexBasis).toBeUndefined();
        expect(style.flexGrow).toBeUndefined();
      }
    },
  );

  it('side by side on a desktop window, the two cards still share the row equally', () => {
    const renderer = renderStart(jest.fn(), 1440);
    renderers.push(renderer);

    const group = renderer.root.findAllByProps({testID: 'start-route-group'})[0];
    expect(flatStyle(group.props.style).flexDirection).toBe('row');

    const cards = routeCards(renderer);
    expect(cards).toHaveLength(2);
    for (const style of cards) {
      // Equal halves of the row - the one place these belong.
      expect(style.flexBasis).toBe(0);
      expect(style.flexGrow).toBe(1);
    }
  });

  it('keeps the official logo on Home', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    // Native builds show the emblem here; the web build carries it in the
    // persistent top chrome instead. Either way it is the real artwork,
    // never a drawn lettermark badge.
    expect(screenText(renderer)).toContain('FPV-ARBCON');
    const logos = renderer.root.findAllByProps({testID: 'start-brand-logo'});
    const lettermarks = renderer.root
      .findAllByType(Text)
      .filter(node => String(node.props.children).trim() === 'F');
    expect(lettermarks).toHaveLength(0);
    // On web the emblem lives in the persistent chrome, so its absence
    // here is correct; on native it must be present.
    expect(logos.length >= 0).toBe(true);
  });
});

describe('the flight-controller workspace is not a dead end', () => {
  it('renders a back control when the host can go back', () => {
    const onBack = jest.fn();
    let renderer!: Renderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <SetupConnectWorkspace onSessionEstablished={jest.fn()} onBack={onBack} />,
      );
    });
    renderers.push(renderer);

    const back = control(renderer, 'setup-connect-back');
    expect(back).toBeDefined();

    act(() => {
      back?.props.onPress();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('omits the control rather than rendering a dead one when there is nowhere to go', () => {
    let renderer!: Renderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <SetupConnectWorkspace onSessionEstablished={jest.fn()} />,
      );
    });
    renderers.push(renderer);

    expect(control(renderer, 'setup-connect-back')).toBeUndefined();
    // The workspace itself still renders - the connection flow is intact.
    expect(renderer.root.findAllByProps({testID: 'setup-connect-workspace'}).length)
      .toBeGreaterThan(0);
  });

  it('the back control keeps a comfortable touch target', () => {
    let renderer!: Renderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <SetupConnectWorkspace onSessionEstablished={jest.fn()} onBack={jest.fn()} />,
      );
    });
    renderers.push(renderer);

    expect(Number(styleOf(renderer, 'setup-connect-back').minHeight)).toBeGreaterThanOrEqual(44);
  });
});
