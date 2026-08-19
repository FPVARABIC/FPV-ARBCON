/**
 * THE SUPPORT FOOTER ON HOME - what it must say, where it must point,
 * and everything it must never become.
 *
 * A donation prompt inside a tool that writes settings to a flight
 * controller is a place where small mistakes get expensive: a wrong URL
 * sends someone's money to a stranger, an in-app payment form teaches
 * them to type card numbers into an unverifiable window, and a support
 * ask wired to a feature turns an optional gift into a paywall. So the
 * tests below are not "the button renders". They press the real button
 * through the real screen and watch which address leaves the process.
 *
 * WHY `Linking.openURL` IS THE PROBE. It is the last thing this
 * application does before the operating system takes over. Asserting on
 * the exported constant would prove only that a constant exists;
 * asserting here proves that the button an operator can actually see is
 * wired to that constant and to nothing else.
 */

import * as fs from 'fs';
import * as path from 'path';

import React from 'react';
import {Linking, Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import StartScreen from './StartScreen';
import {SUPPORT_PROJECT_URL} from '../../platforms/supportUrl';

type Renderer = ReactTestRenderer.ReactTestRenderer;

const renderers: Renderer[] = [];

function renderHome(navigate: jest.Mock = jest.fn()): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <StartScreen
        navigation={{navigate} as never}
        route={{key: 'Start', name: 'Start'} as never}
      />,
    );
  });
  renderers.push(renderer);
  return renderer;
}

function screenText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

function pressable(renderer: Renderer, testID: string) {
  return renderer.root
    .findAllByProps({testID})
    .find(node => typeof node.props.onPress === 'function');
}

let openURL: jest.SpyInstance;

beforeEach(() => {
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

afterEach(() => {
  renderers.splice(0).forEach(renderer => {
    act(() => {
      renderer.unmount();
    });
  });
  jest.restoreAllMocks();
});

describe('the support footer points at one address and no other', () => {
  it('presses through to exactly https://ko-fi.com/fpvarconf', () => {
    const renderer = renderHome();

    const support = pressable(renderer, 'start-support-kofi');
    expect(support).toBeDefined();

    act(() => {
      support?.props.onPress();
    });

    // The literal, spelled out here on purpose. If someone edits
    // supportUrl.ts, this line is what fails - a test that asserted
    // against the constant would happily follow it anywhere.
    expect(openURL).toHaveBeenCalledWith('https://ko-fi.com/fpvarconf');
    expect(openURL).toHaveBeenCalledTimes(1);
    // And the constant the app ships is that same address.
    expect(SUPPORT_PROJECT_URL).toBe('https://ko-fi.com/fpvarconf');
  });

  it('is the only outbound address anywhere on Home', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'StartScreen.tsx'),
      'utf8',
    ) as string;
    const linkSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'platforms', 'supportUrl.ts'),
      'utf8',
    ) as string;

    // Home itself hardcodes no address at all - it imports the one.
    expect(source).not.toMatch(/https?:\/\//);
    // And the module it imports declares that address once.
    const urls = linkSource.match(/https?:\/\/[^\s'"`]+/g) ?? [];
    expect(urls).toEqual(['https://ko-fi.com/fpvarconf']);
  });

  it('opens the browser instead of navigating inside the app', () => {
    const navigate = jest.fn();
    const renderer = renderHome(navigate);

    act(() => {
      pressable(renderer, 'start-support-kofi')?.props.onPress();
    });

    // No route, no modal, no in-app payment screen. The app hands the
    // address over and stops.
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('the footer asks for nothing the app has no business holding', () => {
  it('shows no account number, card, IBAN or personal detail', () => {
    const text = screenText(renderHome());

    for (const forbidden of ['IBAN', 'Visa', 'Mastercard', 'PayPal', 'حساب بنكي', 'رقم الحساب', 'بطاقة']) {
      expect(text).not.toContain(forbidden);
    }
    // Nothing that looks like an account or card number: no run of six
    // or more digits anywhere on Home. (Real copy here has none - the
    // longest number the screen shows is a firmware target name.)
    expect(text).not.toMatch(/\d{6,}/);
  });

  it('says plainly that it leaves the app, and names where it goes', () => {
    const text = screenText(renderHome());
    expect(text).toContain('ko-fi.com');
    expect(text).toContain('خارج التطبيق');
  });

  it('states that support is optional and unlocks nothing', () => {
    const text = screenText(renderHome());
    expect(text).toContain('دعمك اختياري');
    expect(text).toContain('كل الميزات تبقى متاحة بدونه');
    // No urgency, no guilt, no scarcity - this is a footer, not a pitch.
    for (const pitch of ['الآن فقط', 'عرض', 'اشترك', 'ترقية', 'نسخة مدفوعة', 'مجانًا لفترة']) {
      expect(text).not.toContain(pitch);
    }
  });
});

describe('the footer stays a footer', () => {
  it('sits after the three doors and after the safety line, not among them', () => {
    const renderer = renderHome();
    const order = screenText(renderer);

    const guide = order.indexOf('دليل أنماط الطيران');
    const configure = order.indexOf('فتح إعداد الدرون');
    const safety = order.indexOf('لن يبدأ أي مسح أو كتابة');
    const support = order.indexOf('ساهم في تطوير');

    expect(guide).toBeGreaterThanOrEqual(0);
    expect(support).toBeGreaterThan(configure);
    expect(support).toBeGreaterThan(safety);
  });

  it('is not one of the route cards', () => {
    const renderer = renderHome();
    const group = renderer.root.findAllByProps({testID: 'start-route-group'})[0];
    // The doors group holds three pressables and the support button is
    // not among them - it lives outside that container entirely.
    expect(
      group.findAllByProps({testID: 'start-support-kofi'}),
    ).toHaveLength(0);
  });

  it('leaves all three doors working exactly as before', () => {
    const navigate = jest.fn();
    const renderer = renderHome(navigate);

    act(() => {
      pressable(renderer, 'start-flight-style-guide')?.props.onPress();
    });
    act(() => {
      pressable(renderer, 'start-firmware')?.props.onPress();
    });
    act(() => {
      pressable(renderer, 'start-configure')?.props.onPress();
    });

    expect(navigate).toHaveBeenNthCalledWith(1, 'FlightStyleGuide');
    expect(navigate).toHaveBeenNthCalledWith(2, 'FirmwareFlasher');
    expect(navigate).toHaveBeenNthCalledWith(3, 'Setup');
    expect(navigate).toHaveBeenCalledTimes(3);
  });

  it('draws its cup from the icon system, not from an emoji character', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'StartScreen.tsx'),
      'utf8',
    ) as string;
    // The rendered LABEL carries no pictograph - the mark comes from the
    // Lucide `coffee` glyph, which renders in the app's own stroke
    // weight and colour instead of the platform's emoji font.
    const label = screenText(renderHome());
    expect(label).toContain('ادعم المشروع');
    expect(label).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(source).toContain('icon="coffee"');
  });

  it('never reaches a flight-controller surface', () => {
    // The support link is reachable from the home screen and from
    // nothing that talks to a board. If this list ever grows, a donation
    // prompt has appeared somewhere it does not belong - and the check
    // that matters most is the negative one below it: no screen that
    // writes to a flight controller may import this.
    const walk = (dir: string): readonly string[] =>
      fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)
          ? [full]
          : [];
      });

    const root = path.join(__dirname, '..', '..');
    const hits = walk(root)
      .filter(file => /\bsupport(Url|Link)\b/.test(fs.readFileSync(file, 'utf8')))
      .map(file => file.slice(root.length + 1).split(path.sep).join('/'))
      .sort();

    expect(hits).toEqual([
      'platforms/supportLink.ts',
      'platforms/supportLink.web.ts',
      'platforms/supportUrl.ts',
      'ui/screens/StartScreen.tsx',
    ]);
  });
});
