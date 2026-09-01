/**
 * SETUP P1 - the safety-notice renderer.
 *
 * All condition logic lives in src/core/state/setupSafetyModel.ts and is
 * covered there; this suite covers only what the component itself
 * decides: nothing rendered when nothing is true, severity ordering, the
 * Arabic lookup, and the accessibility contract (§32 - status must be
 * understandable without colour).
 */

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import SetupSafetyNotices from './SetupSafetyNotices';
import '../../../i18n';
import i18n from '../../../i18n';
import type {SetupWarning} from '../../../core';

function warning(
  id: SetupWarning['id'],
  severity: SetupWarning['severity'],
  owner: SetupWarning['owner'] = 'SETUP',
): SetupWarning {
  return {id, severity, messageKey: `setupWarnings.${id}`, owner};
}

function render(warnings: readonly SetupWarning[]) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <SetupSafetyNotices warnings={warnings} />,
    );
  });
  return renderer;
}

function texts(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

function has(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({testID}).length > 0;
}

describe('SetupSafetyNotices', () => {
  it('renders NOTHING when nothing is true - no permanent wall of warnings', () => {
    const renderer = render([]);
    expect(renderer.toJSON()).toBeNull();
    act(() => renderer.unmount());
  });

  it('renders the Arabic sentence for each warning, from its own key', () => {
    const renderer = render([warning('ARMED', 'CRITICAL')]);
    expect(texts(renderer)).toContain(i18n.t('setupWarnings.ARMED'));
    expect(has(renderer, 'setup-safety-notice-ARMED')).toBe(true);
    act(() => renderer.unmount());
  });

  it('never renders a raw warning id or i18n key to the operator', () => {
    const renderer = render([warning('RX_LOSS', 'CRITICAL', 'RECEIVER')]);
    const joined = texts(renderer).join('|');
    expect(joined).not.toContain('setupWarnings.');
    expect(joined).not.toContain('RX_LOSS');
    act(() => renderer.unmount());
  });

  it('orders critical above warning above info, stably within a severity', () => {
    const renderer = render([
      warning('REBOOT_REQUIRED', 'WARNING'),
      warning('ARMED', 'CRITICAL'),
      warning('RECEIVER_SIGNAL_UNAVAILABLE', 'WARNING', 'RECEIVER'),
      warning('RX_LOSS', 'CRITICAL', 'RECEIVER'),
    ]);
    const rendered = texts(renderer);
    const at = (id: SetupWarning['id']) =>
      rendered.indexOf(i18n.t(`setupWarnings.${id}`));
    expect(at('ARMED')).toBeLessThan(at('REBOOT_REQUIRED'));
    expect(at('RX_LOSS')).toBeLessThan(at('REBOOT_REQUIRED'));
    // Stable within CRITICAL: ARMED was declared before RX_LOSS.
    expect(at('ARMED')).toBeLessThan(at('RX_LOSS'));
    // Stable within WARNING.
    expect(at('REBOOT_REQUIRED')).toBeLessThan(
      at('RECEIVER_SIGNAL_UNAVAILABLE'),
    );
    act(() => renderer.unmount());
  });

  it('announces itself as an alert and carries a heading', () => {
    const renderer = render([warning('FAILSAFE', 'CRITICAL', 'FAILSAFE')]);
    const container = renderer.root.findAllByProps({
      testID: 'setup-safety-notices',
    })[0];
    expect(container.props.accessibilityRole).toBe('alert');
    expect(texts(renderer)).toContain(i18n.t('setupWarnings.heading'));
    act(() => renderer.unmount());
  });

  it('conveys every state in TEXT - colour is only ever an addition', () => {
    const all: SetupWarning[] = [
      warning('ARMED', 'CRITICAL'),
      warning('REBOOT_REQUIRED', 'WARNING'),
      warning('BOX_FAILSAFE', 'CRITICAL', 'FAILSAFE'),
      warning('BATTERY_CRITICAL', 'CRITICAL', 'POWER'),
      warning('FC_RECOVERING', 'WARNING'),
    ];
    const renderer = render(all);
    const rendered = texts(renderer);
    for (const item of all) {
      expect(rendered).toContain(i18n.t(item.messageKey));
    }
    act(() => renderer.unmount());
  });

  it('keeps RXLOSS, FAILSAFE and BOXFAILSAFE as three distinct sentences', () => {
    const renderer = render([
      warning('RX_LOSS', 'CRITICAL', 'RECEIVER'),
      warning('FAILSAFE', 'CRITICAL', 'FAILSAFE'),
      warning('BOX_FAILSAFE', 'CRITICAL', 'FAILSAFE'),
    ]);
    const rendered = texts(renderer);
    const distinct = new Set([
      i18n.t('setupWarnings.RX_LOSS'),
      i18n.t('setupWarnings.FAILSAFE'),
      i18n.t('setupWarnings.BOX_FAILSAFE'),
    ]);
    expect(distinct.size).toBe(3);
    for (const sentence of distinct) {
      expect(rendered).toContain(sentence);
    }
    act(() => renderer.unmount());
  });
});
