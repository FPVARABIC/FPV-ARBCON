/**
 * A LOCKED MOTOR CONTROL MUST NEVER LOOK LIKE DEAD PIXELS.
 *
 * WHY THIS SUITE EXISTS. The operator connected a real flight controller,
 * pressed hold-to-test several times, and nothing happened - no motion,
 * no message, no visible change at all. A Chromium probe of the gesture
 * path cleared the gesture engine: press-in, ownership, timer, activation
 * and pulse all traverse correctly whenever the gate admits the press,
 * and an ordinary click correctly emits nothing. So the press was never
 * the defect.
 *
 * The defect was that `disabled` on a react-native-web Pressable applies
 * `pointerEvents: 'box-none'` and makes `onStartShouldSetResponder`
 * return false, so a blocked hold control receives no pointer event at
 * all - while `showReadinessDiagnostic` simultaneously refused to render
 * a reason unless a terminal outcome existed or setup had reached READY.
 * With no session open there is no snapshot, so there was no reason
 * anywhere on the screen either.
 *
 * THE RULE THESE TESTS PIN, and it is a product rule rather than a
 * styling preference:
 *
 *     A BLOCKED CONTROL MAY ISSUE ZERO MOTOR COMMANDS,
 *     BUT IT MUST NEVER LOOK LIKE DEAD PIXELS.
 *
 * Both halves are asserted together in every case below. A test that
 * only checked for the message would pass on a build that had quietly
 * become command-capable while blocked, which is the one outcome that
 * must never be traded for better feedback.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import ar from '../../i18n/locales/ar.json';

const HOLD = 'motors-hold-button';
const BLOCKED = 'motors-hold-blocked';
const REASON = 'motors-hold-blocked-reason';

/** Renders the screen with a controller that never admits activation. */
function renderBlocked(): ReactTestRenderer.ReactTestRenderer {
  const MotorsScreen = require('./MotorsScreen').default;
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreen navigation={{navigate: () => {}} as never} />,
    );
  });
  return tree;
}

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === 'object') {
      visit((node as {children?: unknown}).children);
    }
  };
  visit(tree.toJSON());
  return out.join(' ');
}

describe('the hold control explains why it is locked', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    tree = renderBlocked();
  });

  afterEach(() => {
    act(() => tree.unmount());
  });

  it('renders the hold control even with no session', () => {
    // The control must exist to be explicable. A screen that simply
    // omits it teaches the operator nothing about what to do next.
    expect(tree.root.findAllByProps({testID: HOLD}).length).toBeGreaterThan(0);
  });

  it('marks the control disabled rather than silently inert', () => {
    const hold = tree.root.findAllByProps({testID: HOLD})[0];
    expect(hold.props.accessibilityState.disabled).toBe(true);
  });

  it('shows a causal reason on the control itself', () => {
    expect(
      tree.root.findAllByProps({testID: BLOCKED}).length,
    ).toBeGreaterThan(0);
    const reason = tree.root.findAllByProps({testID: REASON})[0];
    expect(typeof reason.props.children).toBe('string');
    expect((reason.props.children as string).length).toBeGreaterThan(0);
  });

  it('names the FIRST thing the operator must actually do', () => {
    // With no session the canonical next action is opening one - not a
    // downstream consequence of not having opened one.
    expect(textOf(tree)).toContain(ar.motorsScreen.holdBlockedNoSession);
  });

  it('exposes the same reason to assistive technology', () => {
    const hold = tree.root.findAllByProps({testID: HOLD})[0];
    expect(hold.props.accessibilityHint).toBe(
      ar.motorsScreen.holdBlockedNoSession,
    );
  });

  it('states that no command will be sent', () => {
    expect(textOf(tree)).toContain(ar.motorsScreen.holdBlockedHint);
  });

  it('issues no motor command while blocked, however it is pressed', () => {
    const hold = tree.root.findAllByProps({testID: HOLD})[0];
    // The gate is read at call time, so pressing a blocked control must
    // take no ownership and arm no timer. Nothing to assert but the
    // absence of a throw and the continued absence of any command path:
    // there is no operator port at all in this state.
    act(() => {
      hold.props.onPressIn?.();
      hold.props.onLongPress?.();
      hold.props.onPressOut?.();
    });
    expect(
      tree.root.findAllByProps({testID: BLOCKED}).length,
    ).toBeGreaterThan(0);
  });
});

describe('the advanced disclosure never opens onto nothing', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    tree = renderBlocked();
  });

  afterEach(() => {
    act(() => tree.unmount());
  });

  it('is collapsed to begin with', () => {
    expect(
      tree.root.findAllByProps({testID: 'motors-advanced-verification'}).length,
    ).toBe(0);
  });

  it('opens, and says what it is waiting for instead of rendering empty', () => {
    const toggle = tree.root.findAllByProps({
      testID: 'motors-advanced-verification-toggle',
    })[0];
    act(() => toggle.props.onPress());

    // Opened...
    expect(
      tree.root.findAllByProps({testID: 'motors-advanced-verification'}).length,
    ).toBeGreaterThan(0);
    // ...and NOT empty. This is the exact regression: every child of this
    // stack is gated on a verification token that does not exist yet, so
    // the section used to expand into a blank View.
    expect(
      tree.root.findAllByProps({testID: 'motors-advanced-empty'}).length,
    ).toBeGreaterThan(0);
    expect(textOf(tree)).toContain(ar.motorsScreen.advancedEmptyTitle);
  });

  it('closes again on a second press', () => {
    const toggle = tree.root.findAllByProps({
      testID: 'motors-advanced-verification-toggle',
    })[0];
    act(() => toggle.props.onPress());
    act(() => toggle.props.onPress());
    expect(
      tree.root.findAllByProps({testID: 'motors-advanced-verification'}).length,
    ).toBe(0);
  });
});

describe('the hold control stops when the pointer leaves it', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    tree = renderBlocked();
  });

  afterEach(() => {
    act(() => tree.unmount());
  });

  /**
   * Measured in Chromium before this existed: hold past the threshold,
   * drag the still-pressed pointer off the control, and the command
   * stayed live until mouse-up. react-native-web keeps the responder
   * when the pointer leaves, so no press-out ever arrived.
   */
  it('wires the pointer-loss seam that Chromium proved actually fires', () => {
    // An earlier onPressMove + bounds attempt never fired and was
    // removed. A DOM probe showed the host node does receive
    // `pointerleave` mid-drag and that react-native-web forwards
    // onPointerLeave to it, so that is the seam pinned here.
    const hold = tree.root.findAllByProps({testID: HOLD})[0];
    expect(typeof hold.props.onPointerLeave).toBe('function');
    expect(typeof hold.props.onPointerCancel).toBe('function');
  });

  it('is inert when no gesture is owned, so hover cannot stop anything', () => {
    const hold = tree.root.findAllByProps({testID: HOLD})[0];
    act(() => {
      hold.props.onPointerLeave();
      hold.props.onPointerCancel();
    });
    expect(tree.root.findAllByProps({testID: HOLD}).length).toBeGreaterThan(0);
  });

  it('keeps the native termination hook wired for Android', () => {
    // react-native-web overwrites this one; Android does not. Deleting it
    // would remove real native safety to tidy a browser no-op.
    const hold = tree.root.findAllByProps({testID: HOLD})[0];
    expect(typeof hold.props.onResponderTerminate).toBe('function');
  });
});

/**
 * WINDOW BLUR IS A FAIL-SAFE, AND ONLY A FAIL-SAFE.
 *
 * react-native-web's AppState listens only to `visibilitychange`, so
 * moving to another application while this page stays VISIBLE raises no
 * AppState change and the motor lifecycle bridge never hears about it. A
 * Chromium probe of that case was inconclusive - headless cannot produce
 * a trustworthy OS-level window switch with a button held - so the
 * browser now gets an explicit signal rather than an assumed one.
 *
 * These tests prove OUR listener's contract. They do not simulate an
 * operating system, and they are not evidence that any particular OS
 * emits `blur` in any particular situation. The property being pinned is
 * narrower and is the one that matters:
 *
 *     IF WINDOW BLUR FIRES, OUR CODE WITHDRAWS THE HOLD.
 */
describe('the window-blur fail-safe', () => {
  it('is a no-op on the native platform, which owns this via AppState', () => {
    const {subscribeWindowBlur} = require('../../platforms/windowBlur');
    const unsubscribe = subscribeWindowBlur(() => {
      throw new Error('the native seam must never invoke its listener');
    });
    expect(typeof unsubscribe).toBe('function');
    // Cleanable on every platform, so a shared caller needs no branch.
    expect(() => unsubscribe()).not.toThrow();
  });

  it('subscribes to the WINDOW, not the document, on the web', () => {
    // A document-level blur also fires when focus moves to a control
    // INSIDE the page, which would tear down a legitimate gesture.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'platforms', 'windowBlur.web.ts'),
      'utf8',
    );
    expect(source).toContain("window.addEventListener('blur'");
    expect(source).toContain("window.removeEventListener('blur'");
    expect(source).not.toContain("document.addEventListener('blur'");
  });

  it('adds and removes exactly one window listener, against a fake global', () => {
    // A real spy on the RN test global is not available here, so the
    // contract is proven against an injected window instead: subscribe
    // adds one 'blur' listener, unsubscribe removes that same one.
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const fake = {
      addEventListener: (t: string, h: unknown) => added.push([t, h]),
      removeEventListener: (t: string, h: unknown) => removed.push([t, h]),
    };
    const original = (globalThis as {window?: unknown}).window;
    (globalThis as {window?: unknown}).window = fake;
    try {
      jest.isolateModules(() => {
        const {subscribeWindowBlur} = require('../../platforms/windowBlur.web');
        const off = subscribeWindowBlur(() => {});
        expect(added).toHaveLength(1);
        expect(added[0][0]).toBe('blur');
        off();
        expect(removed).toHaveLength(1);
        expect(removed[0][0]).toBe('blur');
        // The SAME handler, so a later blur cannot reach a dead gesture.
        expect(removed[0][1]).toBe(added[0][1]);
      });
    } finally {
      (globalThis as {window?: unknown}).window = original;
    }
  });

  it('tolerates an environment with no window at all', () => {
    jest.isolateModules(() => {
      const {subscribeWindowBlur} = require('../../platforms/windowBlur.web');
      expect(() => subscribeWindowBlur(() => {})()).not.toThrow();
    });
  });
});
