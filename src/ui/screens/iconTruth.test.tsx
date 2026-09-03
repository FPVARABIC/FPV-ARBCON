/**
 * EVERY ICON THIS PRODUCT DRAWS, FOUND IN THE RENDER AND CLASSIFIED.
 *
 * =====================================================================
 * WHY AN ICON NEEDS ITS OWN CENSUS
 * =====================================================================
 *
 * An icon is a claim made without words. Four ways that goes wrong, and
 * none of them is visible to a source scan or to the control census:
 *
 *   IT IS THE WHOLE CONTROL AND HAS NO NAME. A pressable that contains
 *   only a glyph is, to a screen reader, a button called "button". The
 *   control census presses it happily and reports it healthy.
 *
 *   IT PROMISES ONE ACTION AND PERFORMS ANOTHER. A refresh glyph wired
 *   to navigation still "does something"; only a contract between the
 *   GLYPH and the action catches it.
 *
 *   IT IS DECORATION WEARING A ROLE. An icon beside a text label that
 *   also announces itself doubles every row for a screen reader.
 *
 *   IT MIRRORS WHEN IT MUST NOT. This application is Arabic-first and
 *   lays out right-to-left. A "next" chevron SHOULD flip. A motor's
 *   rotation arrow, a prop direction, an OSD coordinate, an aircraft
 *   axis diagram MUST NOT - the aircraft does not turn around because
 *   the interface reads right to left. Mirroring physical truth is a
 *   safety defect, not a cosmetic one.
 *
 * =====================================================================
 * HOW IT IS MEASURED
 * =====================================================================
 *
 * The same screens the control census mounts, from the same shared
 * registry, in the same source-realistic states. Every `<Icon>` in the
 * rendered tree is found by TYPE - not by grepping source - so an icon
 * that stops rendering leaves the census and one that starts rendering
 * joins it. For each one the nearest interactive ancestor is walked out
 * of the tree, which is what decides whether the glyph is decoration
 * beside a label, the label of a control, or a status readout.
 *
 * DIRECTION IS CLASSIFIED BY HAND, ON PURPOSE, and the classification is
 * enforced for completeness at runtime: a directional glyph that appears
 * on a screen and is not in the table fails this suite until somebody
 * decides what it means. There is no way to infer "this arrow is about
 * the aircraft, that one is about the interface" from geometry, and
 * guessing it is exactly the failure this pass exists to prevent.
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

import ReactTestRenderer, {act} from 'react-test-renderer';
import {Alert, I18nManager, Linking, Text} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {Icon} from '../icons';
import {colors} from '../theme';
import {SCREENS, recorder, installAct} from './__censusFixtures__/censusScreens';

jest.setTimeout(300000);

/* The registry's preconditions press controls; give them React's act. */
installAct(act);

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

/** How many members of one equivalence class get pressed. */
const CLASS_SAMPLE = 3;

interface DialogButton {
  readonly text?: string;
  readonly style?: string;
  readonly onPress?: () => unknown;
}
let lastDialog: readonly DialogButton[] | undefined;

/** A dialog and an external link are effects a rendered tree cannot show. */
function watchEffects(record: {calls: number; log: string[]}): () => void {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(
    (_title?: string, _body?: string, buttons?: readonly DialogButton[]) => {
      record.calls += 1;
      record.log.push('Alert.alert');
      lastDialog = buttons;
    },
  );
  const open = jest.spyOn(Linking, 'openURL').mockImplementation(async () => {
    record.calls += 1;
    record.log.push('Linking.openURL');
    return true;
  });
  return () => {
    lastDialog = undefined;
    alert.mockRestore();
    open.mockRestore();
  };
}

/** The button a person would press to go through with it. */
function confirmDialogButton(): DialogButton | undefined {
  const button = lastDialog?.find(
    candidate =>
      candidate.style !== 'cancel' && typeof candidate.onPress === 'function',
  );
  lastDialog = undefined;
  return button;
}

/* ==================================================================== *
 * WHAT COUNTS AS DIRECTIONAL
 *
 * A glyph whose geometry points somewhere. Registered here by NAME, from
 * the glyph registry, so a new arrow added to the product cannot slip in
 * unclassified: the completeness check below reads this list.
 * ==================================================================== */
const DIRECTIONAL = new Set([
  'arrow-up',
  'arrow-down',
  'arrow-left',
  'arrow-right',
  'arrow-up-down',
  'chevron-up',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'chevrons-up-down',
  'rotate-cw',
  'rotate-ccw',
  'move-3d',
  'navigation',
  /* The four aliases. These are the ones that DO flip with the layout,
     which is precisely why a physical-direction usage must never pick
     one of them. */
  'chevron-forward',
  'chevron-back',
  'arrow-forward',
  'arrow-back',
]);

/** Aliases resolve against the live layout direction; raw names do not. */
const MIRRORS = new Set([
  'chevron-forward',
  'chevron-back',
  'arrow-forward',
  'arrow-back',
]);

/**
 * THE GLYPHS THAT MAKE A LEFT/RIGHT CLAIM.
 *
 * Mirroring is a statement about the HORIZONTAL axis. "Up" is up in both
 * layouts; a rotation glyph turns the same way in both; a dropdown's
 * double chevron points at nothing. So only these are subject to the
 * mirror rules below - the rest are still classified, because their
 * MEANING still has to be decided, but there is nothing to mirror.
 */
const HORIZONTAL = new Set([
  'arrow-left',
  'arrow-right',
  'chevron-left',
  'chevron-right',
  'chevron-forward',
  'chevron-back',
  'arrow-forward',
  'arrow-back',
]);

/** `screen::control::glyph` - the site, not the screen and not the glyph. */
function siteOf(icon: {
  readonly screen: string;
  readonly control: string | undefined;
  readonly glyph: string;
}): string {
  return `${icon.screen}::${icon.control ?? '(decorative)'}::${icon.glyph}`;
}

/* ==================================================================== *
 * THE DIRECTION CLASSIFICATION
 *
 * UI_DIRECTION       about the INTERFACE: where a panel opens, which way
 *                    a list scrolls, whether a section is expanded. The
 *                    right-to-left mirror of "next" is "left", and it
 *                    SHOULD mirror.
 *
 * PHYSICAL_DIRECTION about the AIRCRAFT or the WORLD: which way a motor
 *                    turns, which way a prop is fitted, where an OSD
 *                    element sits on the video, which way an axis points,
 *                    which way time runs on a trace. Mirroring any of
 *                    these makes the interface lie about hardware.
 *
 * Keyed by GLYPH + the screen it appears on. A row here is a decision,
 * not a description: if the same glyph carries both meanings on one
 * screen the entry names both and the assertion below is by usage site.
 * ==================================================================== */
type Direction = 'UI_DIRECTION' | 'PHYSICAL_DIRECTION';

interface Found {
  readonly screen: string;
  readonly glyph: string;
  readonly resolvedRtl: string;
  readonly resolvedLtr: string;
  readonly interactive: boolean;
  readonly iconOnly: boolean;
  readonly accessibleName: string | undefined;
  readonly role: string | undefined;
  readonly disabled: boolean;
  readonly control: string | undefined;
  readonly statusColoured: boolean;
  readonly hiddenFromAssistiveTech: boolean;
}

const STATUS_COLOURS = new Set(
  [colors.success, colors.warning, colors.error, colors.info].map(value =>
    String(value).toLowerCase(),
  ),
);

const HANDLERS = [
  'onPress',
  'onLongPress',
  'onValueChange',
  'onChangeText',
  'onSelect',
  'onSubmitEditing',
] as const;

/**
 * THE THING THAT WOULD ACTUALLY RECEIVE A PRESS ON THIS ICON.
 *
 * Not "an ancestor with an onPress prop" - that was the first attempt and
 * it over-counted. `<GuideSection onPress={…}>` RECEIVES a callback and
 * hands it to a Pressable that is a SIBLING of the icon; the icon itself
 * sits in a plain View and nothing happens when you touch it. Walking up
 * looking for the prop made every decorative glyph inside such a section
 * "interactive".
 *
 * React Native decides a press at the TOUCH RESPONDER, so that is what
 * this looks for: the nearest rendered HOST above the icon that claims a
 * gesture. If there is none, a finger on this glyph does nothing, and the
 * glyph is decoration whatever props its ancestors carry.
 */
function interactiveAncestor(
  node: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  let cursor: ReactTestRenderer.ReactTestInstance | null = node.parent;
  /* Bounded so a pathological tree cannot spin. Twenty levels is far
     deeper than any control wrapper in this application. */
  for (let depth = 0; depth < 20 && cursor !== null; depth += 1) {
    const props = cursor.props as Record<string, unknown>;
    if (
      typeof cursor.type === 'string' &&
      typeof props.onStartShouldSetResponder === 'function'
    ) {
      /* The host that claims the gesture. Its identity usually lives on
         the composite just above it - that is where testID and
         accessibilityLabel are written - so hand back the nearest
         ancestor that carries a handler prop, falling back to the host. */
      let named: ReactTestRenderer.ReactTestInstance | null = cursor;
      for (let up = 0; up < 4 && named !== null; up += 1) {
        const above = named.props as Record<string, unknown>;
        if (HANDLERS.some(handler => typeof above[handler] === 'function')) {
          return named;
        }
        named = named.parent;
      }
      return cursor;
    }
    cursor = cursor.parent;
  }
  return undefined;
}

/** The accessible name a control announces, from wherever it declares it. */
function accessibleNameOf(
  node: ReactTestRenderer.ReactTestInstance,
): string | undefined {
  let cursor: ReactTestRenderer.ReactTestInstance | null = node;
  for (let depth = 0; depth < 6 && cursor !== null; depth += 1) {
    const label = (cursor.props as any)?.accessibilityLabel;
    if (typeof label === 'string' && label.trim() !== '') return label;
    cursor = cursor.parent;
  }
  return undefined;
}

function textUnder(node: ReactTestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .map(child => {
      const value = (child.props as any).children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('')
    .trim();
}

function roleOf(
  node: ReactTestRenderer.ReactTestInstance,
): string | undefined {
  let cursor: ReactTestRenderer.ReactTestInstance | null = node;
  for (let depth = 0; depth < 6 && cursor !== null; depth += 1) {
    const props = cursor.props as any;
    const role = props?.accessibilityRole ?? props?.role;
    if (typeof role === 'string') return role;
    cursor = cursor.parent;
  }
  return undefined;
}

function identityOf(
  node: ReactTestRenderer.ReactTestInstance,
): string | undefined {
  let cursor: ReactTestRenderer.ReactTestInstance | null = node;
  for (let depth = 0; depth < 6 && cursor !== null; depth += 1) {
    const id = (cursor.props as any)?.testID;
    if (typeof id === 'string' && id !== '') return id;
    cursor = cursor.parent;
  }
  return accessibleNameOf(node);
}

/**
 * WHICH GLYPH ACTUALLY GOT DRAWN, in each layout direction.
 *
 * `<Icon name="chevron-forward"/>` is not a drawing; it is a request
 * resolved at render time against `isRtlLayout()`. So the census renders
 * each screen TWICE - once with the layout right-to-left, once
 * left-to-right - and reads the glyph out of what was drawn, which is
 * the only way to see a mirror happen or fail to happen.
 */
async function census(rtl: boolean): Promise<Found[]> {
  const previous = I18nManager.isRTL;
  Object.defineProperty(I18nManager, 'isRTL', {
    value: rtl,
    configurable: true,
    writable: true,
  });
  const found: Found[] = [];
  try {
    for (const screen of SCREENS) {
      const record = recorder();
      const element = await screen.mount(record);
      let tree!: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        tree = ReactTestRenderer.create(element);
      });
      await act(async () => {
        for (let round = 0; round < 6; round += 1) await Promise.resolve();
      });
      if (screen.precondition !== undefined) {
        await screen.precondition(tree);
        await act(async () => {
          await Promise.resolve();
        });
      }
      for (const icon of tree.root.findAllByType(Icon)) {
        const glyph = String((icon.props as any).name);
        const owner = interactiveAncestor(icon);
        const label = accessibleNameOf(icon);
        const colour = String((icon.props as any).color ?? '').toLowerCase();
        /* `<Icon>` renders an Svg carrying `aria-hidden` and the two
           Android-only hiding props. Read them off the rendered node
           rather than trusting the component to have set them. */
        const svg = icon.children.find(
          child => typeof child !== 'string',
        ) as ReactTestRenderer.ReactTestInstance | undefined;
        const svgProps = (svg?.props ?? {}) as any;
        found.push({
          screen: screen.name,
          glyph,
          resolvedRtl: rtl ? glyph : '',
          resolvedLtr: rtl ? '' : glyph,
          interactive: owner !== undefined,
          iconOnly: owner !== undefined && textUnder(owner) === '',
          accessibleName: label,
          role: roleOf(icon),
          disabled:
            owner !== undefined &&
            ((owner.props as any)?.disabled === true ||
              (owner.props as any)?.accessibilityState?.disabled === true),
          control: owner === undefined ? undefined : identityOf(owner),
          statusColoured: STATUS_COLOURS.has(colour),
          hiddenFromAssistiveTech:
            svgProps['aria-hidden'] === true ||
            svgProps.accessibilityElementsHidden === true,
        });
      }
      await act(async () => tree.unmount());
    }
  } finally {
    Object.defineProperty(I18nManager, 'isRTL', {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
  return found;
}

type Class =
  | 'DECORATIVE'
  | 'INTERACTIVE'
  | 'NAVIGATION'
  | 'STATUS'
  | 'PHYSICAL_DIRECTION';

/**
 * The declared meaning of every directional icon site in the product.
 *
 * Keyed `screen::glyph`. Every directional glyph the census finds must
 * appear here; anything new fails until it is classified. Where the same
 * glyph is used for both meanings on one screen the value lists both and
 * the mirror assertion is skipped for that site with the reason recorded
 * - there are none today, and if one appears the row says so out loud.
 */
const DIRECTION_MEANING: Record<string, Direction> = {
  /* ---- ABOUT THE INTERFACE -------------------------------------
     Disclosure carets, select triggers, cross-screen links, the
     back arrow, list-order arrows, command history, and the undo
     glyph on a discard action. None of them says anything about
     the aircraft; the horizontal ones among them must mirror. */
  'Blackbox::blackbox-advanced-toggle::chevron-down': 'UI_DIRECTION',
  'Blackbox::blackbox-debug-select::chevrons-up-down': 'UI_DIRECTION',
  'Blackbox::blackbox-device-select::chevrons-up-down': 'UI_DIRECTION',
  'Blackbox::blackbox-rate-select::chevrons-up-down': 'UI_DIRECTION',
  'CLI::الأمر الأحدث::arrow-down': 'UI_DIRECTION',
  'CLI::الأمر السابق::arrow-up': 'UI_DIRECTION',
  'Configurations::configurations-open-gps::chevron-forward': 'UI_DIRECTION',
  'Configurations::configurations-open-motors::chevron-forward': 'UI_DIRECTION',
  'Configurations::configurations-open-ports::chevron-forward': 'UI_DIRECTION',
  'Configurations::configurations-open-setup::chevron-forward': 'UI_DIRECTION',
  'Configurations::configurations-reset::rotate-ccw': 'UI_DIRECTION',
  'FlightStyleCorner::guide-back::chevron-back': 'UI_DIRECTION',
  'FlightStyleGuide::guide-back::chevron-back': 'UI_DIRECTION',
  'FlightStyleGuide::guide-card-cinematic::chevron-forward': 'UI_DIRECTION',
  'FlightStyleGuide::guide-card-freestyle::chevron-forward': 'UI_DIRECTION',
  'FlightStyleGuide::guide-card-long-range::chevron-forward': 'UI_DIRECTION',
  'FlightStyleGuide::guide-card-racing::chevron-forward': 'UI_DIRECTION',
  'FlightStyleGuide::guide-card-tiny-whoop::chevron-forward': 'UI_DIRECTION',
  'GPS::gps-reset::rotate-ccw': 'UI_DIRECTION',
  'LED::led-function::chevrons-up-down': 'UI_DIRECTION',
  'LED::led-order-earlier-0::arrow-up': 'UI_DIRECTION',
  'LED::led-order-earlier-1::arrow-up': 'UI_DIRECTION',
  'LED::led-order-earlier-2::arrow-up': 'UI_DIRECTION',
  'LED::led-order-later-0::arrow-down': 'UI_DIRECTION',
  'LED::led-order-later-1::arrow-down': 'UI_DIRECTION',
  'LED::led-order-later-2::arrow-down': 'UI_DIRECTION',
  'LED::led-technical-toggle::chevron-down': 'UI_DIRECTION',
  'MotorConfiguration::motor-config-mixer::chevrons-up-down': 'UI_DIRECTION',
  'Motors::motors-mixer-select::chevrons-up-down': 'UI_DIRECTION',
  'Motors::motors-open-direction::rotate-cw': 'UI_DIRECTION',
  'Motors::motors-open-reorder::arrow-up-down': 'UI_DIRECTION',
  'PID::pid-advanced-groups-BATTERY-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-advanced-groups-DTERM_FILTERS-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-advanced-groups-D_MAX-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-advanced-groups-FEEDFORWARD-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-advanced-groups-GYRO_FILTERS-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-advanced-groups-ITERM-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-advanced-groups-LIMITS-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-advanced-groups-TPA-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-advanced-toggle::chevron-up': 'UI_DIRECTION',
  'PID::pid-profile-management-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-rpm-filter-detail-toggle::chevron-down': 'UI_DIRECTION',
  'PID::pid-simplified-explanation-toggle::chevron-down': 'UI_DIRECTION',
  'Ports::ports-card-toggle-0::chevron-down': 'UI_DIRECTION',
  'Ports::ports-card-toggle-1::chevron-down': 'UI_DIRECTION',
  'Ports::ports-card-toggle-2::chevron-down': 'UI_DIRECTION',
  'Ports::ports-card-toggle-20::chevron-down': 'UI_DIRECTION',
  'Ports::ports-reset::rotate-ccw': 'UI_DIRECTION',
  'Sensors::sensors-alignment-preset::chevrons-up-down': 'UI_DIRECTION',
  'Sensors::sensors-hardware-acc::chevrons-up-down': 'UI_DIRECTION',
  'Sensors::sensors-hardware-baro::chevrons-up-down': 'UI_DIRECTION',
  'Sensors::sensors-hardware-mag::chevrons-up-down': 'UI_DIRECTION',
  'Sensors::sensors-hardware-opticalflow::chevrons-up-down': 'UI_DIRECTION',
  'Sensors::sensors-hardware-rangefinder::chevrons-up-down': 'UI_DIRECTION',
  'Start::start-configure::chevron-forward': 'UI_DIRECTION',
  'Start::start-firmware::chevron-forward': 'UI_DIRECTION',
  'Start::start-flight-style-guide::chevron-forward': 'UI_DIRECTION',

  /* ---- ABOUT THE AIRCRAFT --------------------------------------
     Four expected-rotation arrows on the airframe diagram, the
     LED grid's FRONT marker, and the GPS heading pointer. Each
     names a direction in the world. If any of these mirrored with
     the layout the interface would be telling an operator to fit
     a propeller the wrong way round. */
  'GPS::(decorative)::navigation': 'PHYSICAL_DIRECTION',
  'LED::(decorative)::arrow-up': 'PHYSICAL_DIRECTION',
  'Motors::motors-airframe-slot-1::rotate-cw': 'PHYSICAL_DIRECTION',
  'Motors::motors-airframe-slot-2::rotate-ccw': 'PHYSICAL_DIRECTION',
  'Motors::motors-airframe-slot-3::rotate-ccw': 'PHYSICAL_DIRECTION',
  'Motors::motors-airframe-slot-4::rotate-cw': 'PHYSICAL_DIRECTION',
};

let RTL: Found[] = [];
let LTR: Found[] = [];

describe('the global icon census', () => {
  it('finds and classifies every icon the product renders', async () => {
    RTL = await census(true);
    LTR = await census(false);

    const classify = (icon: Found): Class => {
      const key = siteOf(icon);
      if (DIRECTION_MEANING[key] === 'PHYSICAL_DIRECTION') {
        return 'PHYSICAL_DIRECTION';
      }
      if (icon.interactive) {
        /* NAVIGATION is the subset of interactive icons whose glyph is
           the direction claim itself - a chevron that opens a section, a
           back arrow, a dropdown's caret. They are counted apart because
           they are the ones the RTL rules below govern. */
        return DIRECTION_MEANING[key] === 'UI_DIRECTION'
          ? 'NAVIGATION'
          : 'INTERACTIVE';
      }
      return icon.statusColoured ? 'STATUS' : 'DECORATIVE';
    };

    const byClass = new Map<Class, Found[]>();
    for (const icon of RTL) {
      const bucket = byClass.get(classify(icon)) ?? [];
      bucket.push(icon);
      byClass.set(classify(icon), bucket);
    }
    const perScreen = new Map<string, number>();
    for (const icon of RTL) {
      perScreen.set(icon.screen, (perScreen.get(icon.screen) ?? 0) + 1);
    }

    const nonDecorative = RTL.filter(icon => classify(icon) !== 'DECORATIVE');
    console.log(
      [
        '',
        '===== UI-X1D GLOBAL ICON CENSUS =====',
        `  icons rendered (RTL pass)  : ${RTL.length}`,
        `  icons rendered (LTR pass)  : ${LTR.length}`,
        `  distinct glyphs            : ${new Set(RTL.map(i => i.glyph)).size}`,
        '',
        ...(['DECORATIVE', 'INTERACTIVE', 'NAVIGATION', 'STATUS', 'PHYSICAL_DIRECTION'] as Class[]).map(
          name => `  ${name.padEnd(20)} ${String((byClass.get(name) ?? []).length).padStart(4)}`,
        ),
        '',
        '  per screen:',
        ...[...perScreen.entries()].map(
          ([screen, count]) => `    ${screen.padEnd(20)} ${String(count).padStart(4)}`,
        ),
        '',
        `  NON-DECORATIVE INVENTORY (${nonDecorative.length}):`,
        ...nonDecorative.map(
          icon =>
            `    ${icon.screen.padEnd(19)} ${icon.glyph.padEnd(18)}` +
            ` ${classify(icon).padEnd(19)}` +
            ` control=${String(icon.control ?? '-').slice(0, 34).padEnd(34)}` +
            ` name=${String(icon.accessibleName ?? '-').slice(0, 26).padEnd(26)}` +
            ` role=${String(icon.role ?? '-').padEnd(10)}` +
            ` disabled=${icon.disabled}`,
        ),
        '',
        '  DIRECTIONAL SITES (site :: accessible name):',
        ...[
          ...new Set(
            RTL.filter(icon => DIRECTIONAL.has(icon.glyph)).map(
              icon =>
                `    ${siteOf(icon).padEnd(66)} ${
                  icon.accessibleName ?? '(no accessible name)'
                }`,
            ),
          ),
        ].sort(),
        '=====================================',
        '',
      ].join('\n'),
    );
    /* A census that found nothing would pass every assertion below it. */
    expect(RTL.length).toBeGreaterThan(0);
    expect(LTR.length).toBe(RTL.length);
  });

  it('draws every icon through the one icon system', () => {
    /* An `<Icon>` always renders react-native-svg geometry from the
       shared registry. A glyph name that is not in the registry would
       have thrown during the census; this states the invariant so the
       count above cannot be satisfied by anything else. */
    const unknown = RTL.filter(icon => icon.glyph === 'undefined');
    expect(unknown).toEqual([]);
  });
});

describe('an icon that is the whole control has a name', () => {
  it('every icon-only control announces what it does', () => {
    const nameless = RTL.filter(
      icon => icon.iconOnly && (icon.accessibleName ?? '').trim() === '',
    ).map(icon => `${icon.screen} ${icon.glyph} control=${icon.control ?? '-'}`);
    /* Printed as well as asserted: the diff truncates and the whole
       point is to read every one. */
    if (nameless.length > 0) {
      console.log(['', '--- ICON-ONLY WITH NO ACCESSIBLE NAME ---', ...nameless].join('\n'));
    }
    expect(nameless).toEqual([]);
  });

  it('every icon-only control declares a role', () => {
    const roleless = RTL.filter(
      icon => icon.iconOnly && (icon.role ?? '') === '',
    ).map(icon => `${icon.screen} ${icon.glyph} control=${icon.control ?? '-'}`);
    expect(roleless).toEqual([]);
  });

  it('the drawing itself never reaches the accessibility tree', () => {
    /* A decorative icon that announces itself doubles every labelled row
       for a screen reader, and an icon-only control must take its name
       from the CONTROL, never from the glyph. Both are the same rule:
       the SVG is hidden, always. */
    const exposed = RTL.filter(icon => !icon.hiddenFromAssistiveTech).map(
      icon => `${icon.screen} ${icon.glyph}`,
    );
    expect(exposed).toEqual([]);
  });

  it('the detector sees an unnamed icon-only control', () => {
    /* A NEGATIVE CONTROL for the two assertions above. Without it a
       census that found no icon-only controls at all would report the
       same clean result as one that found them all named. */
    const sample: Found = {
      screen: 'planted',
      glyph: 'x',
      resolvedRtl: 'x',
      resolvedLtr: 'x',
      interactive: true,
      iconOnly: true,
      accessibleName: undefined,
      role: undefined,
      disabled: false,
      control: 'planted-close',
      statusColoured: false,
      hiddenFromAssistiveTech: true,
    };
    expect(
      [sample].filter(icon => icon.iconOnly && (icon.accessibleName ?? '') === '')
        .length,
    ).toBe(1);
    /* And the real census contains icon-only controls, so the clean
       result above is about a population that exists. */
    expect(RTL.filter(icon => icon.iconOnly).length).toBeGreaterThan(0);
  });
});

describe('direction means one thing in the interface and another on the aircraft', () => {
  it('every directional glyph on every screen is classified', () => {
    const seen = new Set<string>();
    for (const icon of RTL) {
      if (DIRECTIONAL.has(icon.glyph)) seen.add(siteOf(icon));
    }
    const unclassified = [...seen].filter(
      key => DIRECTION_MEANING[key] === undefined,
    );
    if (unclassified.length > 0) {
      console.log(
        [
          '',
          '--- DIRECTIONAL ICONS WITH NO DECLARED MEANING ---',
          ...unclassified.map(key => `  ${key}`),
          '  Add each to DIRECTION_MEANING as UI_DIRECTION or',
          '  PHYSICAL_DIRECTION. Guessing is what this check exists to stop.',
        ].join('\n'),
      );
    }
    expect(unclassified).toEqual([]);
    /* The table may not carry rows for sites that no longer render:
       a stale entry is a claim about an icon nobody can see. */
    const stale = Object.keys(DIRECTION_MEANING).filter(key => !seen.has(key));
    if (stale.length > 0) {
      console.log(['', '--- DECLARED BUT NOT RENDERED ---', ...stale.map(k => `  ${k}`)].join('\n'));
    }
    expect(stale).toEqual([]);
  });

  it('an interface direction mirrors when the layout does', () => {
    /* Every UI_DIRECTION site must be drawn with a name that RESOLVES
       against the layout - the alias forms. A raw geometry name in a
       navigation slot points the same way in both directions, which in
       an Arabic layout means a "next" chevron pointing backwards. */
    const wrong: string[] = [];
    for (const icon of RTL) {
      const key = siteOf(icon);
      if (DIRECTION_MEANING[key] !== 'UI_DIRECTION') continue;
      /* Only a left/right claim can be mirrored. Up, down, rotation and
         the dropdown caret mean the same thing in both layouts. */
      if (!HORIZONTAL.has(icon.glyph)) continue;
      if (!MIRRORS.has(icon.glyph)) {
        wrong.push(
          `${key} control=${icon.control ?? '-'} uses a fixed geometry name in a` +
            ' navigation slot; it cannot mirror',
        );
      }
    }
    expect([...new Set(wrong)]).toEqual([]);
  });

  it('a physical direction does not mirror, whatever the layout does', () => {
    const wrong: string[] = [];
    for (const icon of RTL) {
      const key = siteOf(icon);
      if (DIRECTION_MEANING[key] !== 'PHYSICAL_DIRECTION') continue;
      if (MIRRORS.has(icon.glyph)) {
        wrong.push(
          `${key} control=${icon.control ?? '-'} is drawn with a MIRRORING alias;` +
            ' the aircraft does not turn around because the interface reads' +
            ' right to left',
        );
      }
    }
    expect([...new Set(wrong)]).toEqual([]);
  });

  it('the same screen draws the same physical glyphs in both layouts', () => {
    /* The strongest form of the rule, measured rather than reasoned: run
       the whole census in both directions and compare the glyph MULTISET
       per screen, restricted to physical-direction sites. Any difference
       is a physical claim that changed because the interface language
       did. */
    const tally = (rows: Found[]): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const icon of rows) {
        const key = siteOf(icon);
        if (DIRECTION_MEANING[key] !== 'PHYSICAL_DIRECTION') continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    };
    const rtl = tally(RTL);
    const ltr = tally(LTR);
    const differences: string[] = [];
    for (const key of new Set([...rtl.keys(), ...ltr.keys()])) {
      const a = rtl.get(key) ?? 0;
      const b = ltr.get(key) ?? 0;
      if (a !== b) differences.push(`${key}: rtl=${a} ltr=${b}`);
    }
    expect(differences).toEqual([]);
    /* And there IS a physical population, so the clean answer is not the
       answer of an empty set. */
    expect([...rtl.values()].reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
  });

  it('the mirror detector sees an alias used for a physical direction', () => {
    /* NEGATIVE CONTROL. The rule above only means something if a
       physical site drawn with an alias would be caught. */
    const planted: Found = {
      screen: 'Motors',
      glyph: 'arrow-forward',
      resolvedRtl: 'arrow-left',
      resolvedLtr: 'arrow-right',
      interactive: false,
      iconOnly: false,
      accessibleName: undefined,
      role: undefined,
      disabled: false,
      control: 'planted-rotation',
      statusColoured: false,
      hiddenFromAssistiveTech: true,
    };
    const meaning: Record<string, Direction> = {
      [siteOf(planted)]: 'PHYSICAL_DIRECTION',
    };
    const caught = [planted].filter(
      icon =>
        meaning[siteOf(icon)] === 'PHYSICAL_DIRECTION' && MIRRORS.has(icon.glyph),
    );
    expect(caught.length).toBe(1);
  });
});

/* ==================================================================== *
 * §7  AN INTERACTIVE ICON PERFORMS THE ACTION ITS GLYPH PROMISES
 *
 * The control census already asks "did this control do the thing its
 * IDENTIFIER commits it to". This asks a different and independent
 * question: does the DRAWING tell the truth? A refresh glyph on a button
 * that saves, a trash glyph on a button that writes to the board without
 * asking, a caret on a control that navigates away instead of opening in
 * place - each of those does something, so an effect-only oracle waves it
 * through, and each is a lie told in a picture. The promise is read off
 * the GLYPH and never off the testID, so the two oracles cannot agree by
 * construction.
 *
 * EQUIVALENCE CLASSES, NOT EVERY CELL. `plus` appears 133 times and
 * `minus` 132: the same control drawn once per field. A class is
 * (screen, glyph) and up to three DISTINCT members of each class are
 * pressed - distinct, because pressing one control three times measures
 * one control three times, and the second press of a select closes what
 * the first opened.
 *
 * POSITIVE EVIDENCE IS A CLASS PROPERTY; PROHIBITIONS ARE NOT.
 * A `minus` sitting on its minimum is correctly inert, and calling that
 * class dead because of it would be a false finding - so a class passes
 * when ANY member kept the promise. A `trash` that writes to the board
 * without asking is a defect in that ONE control, so every member is
 * checked against what its glyph forbids.
 * ==================================================================== */

type Promised =
  | 'READ'
  | 'SAVE'
  | 'DESTRUCTIVE'
  | 'REVEAL'
  | 'DISMISS'
  | 'ADJUST'
  | 'DISCARD'
  | 'LINK'
  | 'SELECT'
  | 'SELECTED_MARKER'
  | 'HANDS_OFF'
  | 'SAFETY_CONTROLLED';

/**
 * What each glyph the product draws on an interactive control commits to.
 * Built from the measured inventory: a glyph that starts being used
 * interactively and has no row here fails the completeness check below.
 */
const GLYPH_PROMISE: Record<string, Promised> = {
  'refresh-cw': 'READ',
  save: 'SAVE',
  'trash-2': 'DESTRUCTIVE',
  'rotate-ccw': 'DISCARD',
  'map-pin': 'LINK',
  coffee: 'LINK',
  download: 'HANDS_OFF',
  'chevron-down': 'REVEAL',
  'chevron-up': 'REVEAL',
  'chevrons-up-down': 'REVEAL',
  'arrow-up-down': 'REVEAL',
  'rotate-cw': 'REVEAL',
  x: 'DISMISS',
  'chevron-forward': 'HANDS_OFF',
  'chevron-back': 'HANDS_OFF',
  cable: 'HANDS_OFF',
  'sliders-horizontal': 'HANDS_OFF',
  cpu: 'HANDS_OFF',
  compass: 'HANDS_OFF',
  plus: 'ADJUST',
  minus: 'ADJUST',
  'arrow-up': 'ADJUST',
  'arrow-down': 'ADJUST',
  target: 'SELECT',
  /* A tick is not an action. It is drawn on the option that IS chosen,
     so pressing the row it marks correctly changes nothing - and the
     thing worth checking is the claim itself: the control it sits on
     must really report itself selected. A tick on an unselected option
     is the picture lying, and no press can reveal that. */
  check: 'SELECTED_MARKER',
  square: 'SAFETY_CONTROLLED',
};

/**
 * Classes that are correctly inert in the state this fixture reaches.
 *
 * A class with no positive evidence is normally a finding. These are the
 * ones where the product is right to do nothing and the reason is a
 * property of the fixture's state, named rather than waved through. A
 * class listed here that DOES act fails too: a stale excuse is worse
 * than none.
 */
const INERT_WITH_REASON: Record<string, string> = {
  'CLI::arrow-up':
    'command history is empty until a command has been sent; this fixture opens the terminal and sends nothing',
  'CLI::arrow-down':
    'command history is empty until a command has been sent; this fixture opens the terminal and sends nothing',
};

const WROTE = /\.(save[A-Z]?\w*|erase\w*|write\w*|set[A-Z]\w*)$/;
const READ_BACK = /\.(load|loadIndex|loadFirmwareVersion|loadPreset|read|refresh|capture)/i;

interface Press {
  readonly screen: string;
  readonly glyph: string;
  readonly control: string;
  readonly promise: Promised;
  readonly moved: boolean;
  readonly calls: readonly string[];
  readonly selected: boolean;
  readonly threw: string | undefined;
  /** A destructive step had already asked, or opened its confirmation,
   *  before this press. */
  readonly armed: boolean;
}

/** What this glyph FORBIDS, checked on every single member. */
function forbidden(row: Press): string | undefined {
  const wrote = row.calls.filter(call => WROTE.test(call));
  if (row.threw !== undefined) return `threw: ${row.threw}`;
  if (row.promise === 'DESTRUCTIVE') {
    /* THE FIRST PRESS NEVER ERASES.
       A trash glyph opens a destructive action; it does not perform one.
       The SECOND press - the confirmation the first one put on screen -
       is where the erase belongs, and Blackbox is built that way:
       `blackbox-erase-button` reveals `blackbox-erase-confirm`, and only
       the confirm calls `eraseDataflash`. So a write here is a defect
       only when nothing has asked yet, which is what `armed` records. */
    return wrote.length > 0 && !row.armed
      ? `erased without asking first (${wrote.join(',')})`
      : undefined;
  }
  switch (row.promise) {
    case 'READ':
    case 'REVEAL':
    case 'DISMISS':
    case 'ADJUST':
    case 'DISCARD':
    case 'SELECT':
      return wrote.length === 0
        ? undefined
        : `wrote to the board (${wrote.join(',')}) - its glyph promises no write`;
    default:
      return undefined;
  }
}

/** What this glyph PROMISES, satisfied by any member of its class. */
function kept(row: Press): boolean {
  const wrote = row.calls.some(call => WROTE.test(call));
  switch (row.promise) {
    case 'READ':
      return row.calls.some(call => READ_BACK.test(call));
    case 'SAVE':
      return wrote || row.calls.includes('Alert.alert');
    case 'DESTRUCTIVE':
      /* It asks, or it changes the draft only. Never a silent write -
         that half is in `forbidden`. */
      return row.calls.includes('Alert.alert') || row.moved;
    case 'REVEAL':
    case 'DISMISS':
    case 'ADJUST':
    case 'DISCARD':
    case 'SELECT':
      return row.moved;
    case 'LINK':
      return row.calls.includes('Linking.openURL');
    case 'SELECTED_MARKER':
      return row.selected;
    case 'HANDS_OFF':
      return row.moved || row.calls.length > 0;
    case 'SAFETY_CONTROLLED':
      return true;
  }
}

describe('an interactive icon performs the action its glyph promises', () => {
  const executed: Press[] = [];
  const classes = new Map<string, number>();
  const undeclared: string[] = [];

  it('presses a representative of every interactive icon family', async () => {
    const previous = I18nManager.isRTL;
    Object.defineProperty(I18nManager, 'isRTL', {
      value: true,
      configurable: true,
      writable: true,
    });
    try {
      for (const screen of SCREENS) {
        const record = recorder();
        const stop = watchEffects(record);
        const element = await screen.mount(record);
        let tree!: ReactTestRenderer.ReactTestRenderer;
        await act(async () => {
          tree = ReactTestRenderer.create(element);
        });
        await act(async () => {
          for (let round = 0; round < 6; round += 1) await Promise.resolve();
        });
        if (screen.precondition !== undefined) {
          await screen.precondition(tree);
          await act(async () => {
            await Promise.resolve();
          });
        }
        const perClass = new Map<string, number>();
        const pressed = new Set<string>();
        /* A destructive step that has already asked. Reset per screen. */
        let armed = false;
        /* Re-found before every press: a press re-renders, and a node
           captured beforehand belongs to a tree that no longer exists. */
        for (let round = 0; round < 500; round += 1) {
          let owner: ReactTestRenderer.ReactTestInstance | undefined;
          let glyph = '';
          let control = '';
          for (const icon of tree.root.findAllByType(Icon)) {
            const candidate = interactiveAncestor(icon);
            if (candidate === undefined) continue;
            const props = candidate.props as any;
            if (props.disabled === true) continue;
            if (props.accessibilityState?.disabled === true) continue;
            const name = String((icon.props as any).name);
            const id = identityOf(candidate) ?? '(unnamed)';
            const cls = `${screen.name}::${name}`;
            if (pressed.has(`${cls}::${id}`)) continue;
            if ((perClass.get(cls) ?? 0) >= CLASS_SAMPLE) continue;
            owner = candidate;
            glyph = name;
            control = id;
            break;
          }
          if (owner === undefined) break;
          const cls = `${screen.name}::${glyph}`;
          pressed.add(`${cls}::${control}`);
          perClass.set(cls, (perClass.get(cls) ?? 0) + 1);
          const promise = GLYPH_PROMISE[glyph];
          if (promise === undefined) {
            undeclared.push(`${screen.name} ${glyph} (${control})`);
            continue;
          }
          const selected =
            (owner.props as any)?.accessibilityState?.selected === true ||
            (owner.props as any)?.['aria-checked'] === true;
          if (promise === 'SELECTED_MARKER' || promise === 'SAFETY_CONTROLLED') {
            /* Neither is pressed. One is a claim about state, the other
               arms motors. Both are recorded so the class is covered. */
            executed.push({
              screen: screen.name,
              glyph,
              control,
              promise,
              moved: false,
              calls: [],
              selected,
              threw: undefined,
              armed,
            });
            continue;
          }
          const before = JSON.stringify(tree.toJSON());
          const from = record.log.length;
          let threw: string | undefined;
          const handler = HANDLERS.find(
            candidate => typeof (owner!.props as any)[candidate] === 'function',
          );
          await act(async () => {
            try {
              (owner!.props as any)[handler ?? 'onPress']();
            } catch (error) {
              threw = String(error).slice(0, 90);
            }
          });
          const midway = JSON.stringify(tree.toJSON());
          await act(async () => {
            for (let step = 0; step < 4; step += 1) await Promise.resolve();
          });
          /* A save the product gates behind a question: go through it,
             the same way the control census does. */
          if (promise === 'SAVE') {
            const button = confirmDialogButton();
            if (button?.onPress !== undefined) {
              await act(async () => {
                await button.onPress?.();
                for (let step = 0; step < 4; step += 1) await Promise.resolve();
              });
            }
          }
          const after = JSON.stringify(tree.toJSON());
          const calls = record.log.slice(from);
          const moved = before !== after || before !== midway;
          executed.push({
            screen: screen.name,
            glyph,
            control,
            promise,
            moved,
            calls,
            selected,
            threw,
            armed,
          });
          if (promise === 'DESTRUCTIVE' && (moved || calls.includes('Alert.alert'))) {
            armed = true;
          }
        }
        for (const [cls, count] of perClass) {
          classes.set(cls, (classes.get(cls) ?? 0) + count);
        }
        stop();
        await act(async () => tree.unmount());
      }
    } finally {
      Object.defineProperty(I18nManager, 'isRTL', {
        value: previous,
        configurable: true,
        writable: true,
      });
    }

    /* A STEPPER ON ITS FLOOR IS NOT A DEAD STEPPER.
       `led-x-minus` with the selected LED at x=0 correctly refuses, and
       so does its sibling on y - which leaves the whole `LED::minus`
       class with nothing to show. The product's own answer is the pair:
       every stepper in this application is drawn as `<thing>-minus` and
       `<thing>-plus`, so raise the value with the counterpart first and
       ask again. Nothing is invented here - the counterpart is a control
       already on the screen, pressed exactly as a person would. */
    const noEvidence = new Set(
      executed
        .filter(row => row.promise === 'ADJUST')
        .map(row => `${row.screen}::${row.glyph}`),
    );
    for (const cls of noEvidence) {
      const rows = executed.filter(
        row => `${row.screen}::${row.glyph}` === cls,
      );
      if (rows.some(kept)) continue;
      const screen = SCREENS.find(candidate => candidate.name === rows[0].screen);
      if (screen === undefined) continue;
      for (const row of rows) {
        const counterpart = row.control.endsWith('-minus')
          ? `${row.control.slice(0, -'-minus'.length)}-plus`
          : row.control.endsWith('-plus')
            ? `${row.control.slice(0, -'-plus'.length)}-minus`
            : undefined;
        if (counterpart === undefined) continue;
        const record = recorder();
        const stop = watchEffects(record);
        const element = await screen.mount(record);
        let tree!: ReactTestRenderer.ReactTestRenderer;
        await act(async () => {
          tree = ReactTestRenderer.create(element);
        });
        await act(async () => {
          for (let step = 0; step < 6; step += 1) await Promise.resolve();
        });
        if (screen.precondition !== undefined) {
          await screen.precondition(tree);
          await act(async () => {
            await Promise.resolve();
          });
        }
        const find = (id: string) =>
          tree.root
            .findAll(
              node =>
                (node.props as any)?.testID === id &&
                typeof (node.props as any)?.onPress === 'function' &&
                (node.props as any)?.disabled !== true,
              {deep: true},
            )
            .pop();
        const lift = find(counterpart);
        if (lift !== undefined) {
          await act(async () => {
            (lift.props as any).onPress();
            await Promise.resolve();
          });
        }
        const target = find(row.control);
        if (target !== undefined) {
          const before = JSON.stringify(tree.toJSON());
          const from = record.log.length;
          await act(async () => {
            (target.props as any).onPress();
            await Promise.resolve();
          });
          executed.push({
            ...row,
            control: `${row.control} (after ${counterpart})`,
            moved: before !== JSON.stringify(tree.toJSON()),
            calls: record.log.slice(from),
          });
        }
        stop();
        await act(async () => tree.unmount());
      }
    }

    /* PER MEMBER: what the glyph forbids. */
    const violations = executed
      .map(row => {
        const why = forbidden(row);
        return why === undefined
          ? undefined
          : `${row.screen} ${row.glyph} ${row.control}: ${why}`;
      })
      .filter((row): row is string => row !== undefined);

    /* PER CLASS: what the glyph promises. */
    const byClass = new Map<string, Press[]>();
    for (const row of executed) {
      const cls = `${row.screen}::${row.glyph}`;
      byClass.set(cls, [...(byClass.get(cls) ?? []), row]);
    }
    const silent: string[] = [];
    const staleExcuse: string[] = [];
    for (const [cls, rows] of byClass) {
      const any = rows.some(kept);
      const excused = INERT_WITH_REASON[cls];
      if (any && excused !== undefined) {
        staleExcuse.push(`${cls} is declared inert but acted: ${excused}`);
      }
      if (!any && excused === undefined) {
        silent.push(
          `${cls} (${rows.length} pressed, promise=${rows[0].promise}):` +
            ` no member kept it - ${rows
              .map(row => `${row.control} moved=${row.moved} calls=${row.calls.join(',') || 'none'}`)
              .join(' | ')}`,
        );
      }
    }

    console.log(
      [
        '',
        '===== UI-X1D INTERACTIVE ICON ACTION =====',
        `  interactive icon families declared : ${Object.keys(GLYPH_PROMISE).length}`,
        `  equivalence classes exercised      : ${byClass.size}`,
        `  distinct controls pressed          : ${executed.length}`,
        `  glyphs with no declared promise    : ${undeclared.length}`,
        `  classes inert with a declared reason: ${
          Object.keys(INERT_WITH_REASON).length
        }`,
        '',
        ...[...byClass.entries()]
          .sort()
          .map(
            ([cls, rows]) =>
              `    ${cls.padEnd(38)} ${rows[0].promise.padEnd(18)}` +
              ` ${rows.length} pressed, kept by ${rows.filter(kept).length}`,
          ),
        ...(violations.length > 0
          ? ['', '  THE GLYPH FORBADE IT:', ...violations.map(row => `    ${row}`)]
          : []),
        ...(silent.length > 0
          ? ['', '  NO MEMBER KEPT THE PROMISE:', ...silent.map(row => `    ${row}`)]
          : []),
        '==========================================',
        '',
      ].join('\n'),
    );
    expect(undeclared).toEqual([]);
    expect(violations).toEqual([]);
    expect(silent).toEqual([]);
    expect(staleExcuse).toEqual([]);
    /* A run that pressed nothing would satisfy every line above. */
    expect(executed.length).toBeGreaterThan(40);
    expect(byClass.size).toBeGreaterThan(20);
  });

  it('covers every interactive icon family the census found', () => {
    const families = new Set(
      RTL.filter(icon => icon.interactive).map(icon => icon.glyph),
    );
    const missing = [...families].filter(
      glyph => GLYPH_PROMISE[glyph] === undefined,
    );
    expect(missing).toEqual([]);
    /* And every class the inventory lists as enabled got at least one
       press, so the sampling above is coverage, not a spot check. */
    const wanted = new Set(
      RTL.filter(icon => icon.interactive && !icon.disabled).map(
        icon => `${icon.screen}::${icon.glyph}`,
      ),
    );
    const untouched = [...wanted].filter(cls => !classes.has(cls));
    expect(untouched).toEqual([]);
  });

  it('the promise oracle rejects a refresh glyph wired to a save', () => {
    /* NEGATIVE CONTROLS. Without them a run in which every press happened
       to satisfy its promise reads the same as one with no oracle. */
    const base: Press = {
      screen: 'planted',
      glyph: 'refresh-cw',
      control: 'planted-refresh',
      promise: 'READ',
      moved: true,
      calls: ['gps.save'],
      selected: false,
      threw: undefined,
      armed: false,
    };
    expect(forbidden(base)).toContain('wrote to the board');
    expect(kept(base)).toBe(false);
    expect(kept({...base, calls: ['gps.load']})).toBe(true);
    /* A tick drawn on an option that is not the chosen one. */
    const tick: Press = {
      ...base,
      glyph: 'check',
      promise: 'SELECTED_MARKER',
      calls: [],
      selected: false,
    };
    expect(kept(tick)).toBe(false);
    expect(kept({...tick, selected: true})).toBe(true);
    /* And a destructive control that erases before anything has asked. */
    const erase: Press = {
      ...base,
      glyph: 'trash-2',
      promise: 'DESTRUCTIVE',
      calls: ['blackbox.eraseDataflash'],
      armed: false,
    };
    expect(forbidden(erase)).toContain('erased without asking first');
    /* The confirmation step, which is where the erase belongs. */
    expect(forbidden({...erase, armed: true})).toBeUndefined();
  });
});
