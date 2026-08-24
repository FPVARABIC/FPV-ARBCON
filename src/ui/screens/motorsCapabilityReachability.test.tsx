/**
 * MOTORS CAPABILITY REACHABILITY + THE WEB CARET POLICY.
 *
 * Two operator-reported defects are pinned here.
 *
 * "قراءة ترتيب المخارج" LOOKED GREY AND DEAD. A browser probe found the
 * control rendered aria-disabled with pointer-events:none and NO reason
 * anywhere on screen whenever there was no motor-test session. Reading
 * the firmware's output order needs only a real configuration session
 * and a quiet link - never identification, never four observations,
 * never motor movement - so the enabled case must stay reachable and the
 * blocked case must SAY WHY.
 *
 * THE WORD-LIKE BLINKING CARET. The same probe found 0 contenteditable
 * elements and 0 inputs on ordinary screens, but 149 selectable text
 * nodes: all product chrome was `user-select: auto`, so a click left a
 * collapsed selection and a drag selected labels. The shell now makes
 * chrome non-selectable while naming the genuinely copyable surfaces as
 * explicit opt-outs; these tests hold that contract in place.
 */

import {readFileSync} from 'fs';
import path from 'path';

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import {
  MotorOutputMappingSection,
  type MotorOutputMappingSectionProps,
} from './MotorOutputMappingSection';
import {evaluateMotorDirectionCommandCapability} from '../../core/state/motorDirectionCapability';

const anyProps = (
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) => tree.root.findAllByProps({testID});

function mountMapping(props: Partial<MotorOutputMappingSectionProps>) {
  const merged: MotorOutputMappingSectionProps = {
    sessionId: undefined,
    motorCount: 4,
    verification: undefined as never,
    capability: {kind: 'SUPPORTED'} as never,
    onEndMotorTestSession: () => Promise.resolve(),
    onDirtyChange: () => undefined,
    onValuesChange: () => undefined,
    ...props,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(<MotorOutputMappingSection {...merged} />);
  });
  return tree;
}

describe('reading the output mapping is reachable, or it says why not', () => {
  it('a connected quiet session reads BY ITSELF on open, then leaves re-read enabled', async () => {
    /* M-F3 §13: opening the tool IS the read. The mount fires the load,
       and once it lands the button is the RE-read - enabled, with no
       blocked note anywhere. */
    const controller = {
      loadOutputOrder: jest.fn(async () => ({
        kind: 'LOADED' as const,
        values: [0, 1, 2, 3, 4, 5, 6, 7],
      })),
      saveOutputOrder: jest.fn(async () => ({
        kind: 'NO_CHANGES' as const,
        values: [] as number[],
      })),
    };
    const tree = mountMapping({
      sessionId: 'fc-session',
      blockedReason: undefined,
      controller: controller as never,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(controller.loadOutputOrder).toHaveBeenCalledTimes(1);
    expect(anyProps(tree, 'motor-output-mapping-rows').length).toBeGreaterThan(0);
    const read = anyProps(tree, 'motor-output-mapping-read')[0];
    expect(read).toBeDefined();
    expect(read.props.disabled).toBe(false);
    expect(read.props.accessibilityState?.disabled).toBe(false);
    // Nothing is claimed about identification or observations.
    expect(anyProps(tree, 'motor-output-mapping-blocked')).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('NO grey mystery control: every disabled state renders its causal reason', () => {
    // The exact state the operator hit - no motor-test session yet.
    const noSession = mountMapping({sessionId: undefined});
    const read = anyProps(noSession, 'motor-output-mapping-read')[0];
    expect(read.props.disabled).toBe(true);
    const reason = anyProps(noSession, 'motor-output-mapping-blocked')[0];
    expect(reason).toBeDefined();
    expect(JSON.stringify(reason.props.children)).toContain(
      i18n.t('motorsScreen.mappingBlockedNoSession'),
    );
    act(() => noSession.unmount());

    // A live motor command blocks the read - and states that too.
    const live = mountMapping({
      sessionId: 'fc-session',
      blockedReason: i18n.t('motorsScreen.mappingBlockedLiveCommand'),
    });
    expect(anyProps(live, 'motor-output-mapping-read')[0].props.disabled).toBe(true);
    expect(anyProps(live, 'motor-output-mapping-blocked').length).toBeGreaterThan(0);
    act(() => live.unmount());
  });
});

describe('direction authoring is offered in a safe state, and explained otherwise', () => {
  const scope = (over: Record<string, unknown> = {}) => ({
    motorCount: 4,
    motorProtocolRaw: 7,
    feature3dEnabled: false,
    ...over,
  });

  it('a valid disarmed DShot state exposes the command capability', () => {
    const capability = evaluateMotorDirectionCommandCapability({
      hasSession: true,
      motorNumber: 1,
      scope: scope() as never,
      activationAllowed: true,
    });
    expect(capability.kind).toBe('AVAILABLE');
  });

  const blocked: readonly [string, Parameters<typeof evaluateMotorDirectionCommandCapability>[0]][] = [
    ['no session', {hasSession: false, motorNumber: 1, activationAllowed: true, scope: scope() as never}],
    ['3D enabled', {hasSession: true, motorNumber: 1, activationAllowed: true, scope: scope({feature3dEnabled: true}) as never}],
    ['non-DShot protocol', {hasSession: true, motorNumber: 1, activationAllowed: true, scope: scope({motorProtocolRaw: 0}) as never}],
    ['activation withheld', {hasSession: true, motorNumber: 1, activationAllowed: false, scope: scope() as never}],
  ];

  it.each(blocked)('%s is unavailable WITH an exact reason', (_name, input) => {
    const capability = evaluateMotorDirectionCommandCapability(input);
    expect(capability.kind).not.toBe('AVAILABLE');
    // A reason token exists and resolves to real operator copy - never a
    // silent faded surface.
    const reason = (capability as {reason?: string}).reason;
    expect(typeof reason).toBe('string');
    expect(reason).not.toHaveLength(0);
  });
});

describe('the web shell caret policy', () => {
  const shell = readFileSync(
    path.join(__dirname, '..', '..', '..', 'index.html'),
    'utf8',
  );

  it('makes ordinary product chrome non-selectable with a default cursor', () => {
    expect(shell).toMatch(/#root\s*\{[^}]*user-select:\s*none/);
    expect(shell).toMatch(/#root\s*\{[^}]*cursor:\s*default/);
  });

  it('preserves real text entry and the genuinely copyable surfaces', () => {
    // Everything a person actually types into or copies out of.
    for (const selector of [
      '#root input',
      '#root textarea',
      '#root [contenteditable="true"]',
      '#root [data-selectable="true"]',
      '#root [data-testid="cli-output"]',
    ]) {
      expect(shell).toContain(selector);
    }
    // ...and that block re-enables selection rather than suppressing it.
    const optOut = shell.slice(shell.indexOf('#root input'));
    expect(optOut).toMatch(/user-select:\s*text/);
  });

  it('never disables keyboard focus indication', () => {
    // The focus ring is a separate, still-present contract: a
    // non-selectable UI must still be keyboard-navigable.
    expect(shell).toMatch(/:focus-visible\s*\{/);
    expect(shell).toMatch(/outline:\s*3px solid/);
  });
});
