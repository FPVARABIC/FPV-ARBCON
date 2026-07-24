import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import SafetyStrip from './SafetyStrip';
import i18n from '../../../i18n';
import type {ArmingBlockReason, ArmingReadiness} from '../../../core';

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

function findByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAllByProps({testID});
  return matches.length > 0 ? matches[0] : null;
}

function reason(code: string, severity: ArmingBlockReason['severity'], message = `message-${code}`): ArmingBlockReason {
  return {code, message, severity};
}

function render(readiness: ArmingReadiness): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(<SafetyStrip readiness={readiness} />);
  });
  return renderer;
}

describe('SafetyStrip', () => {
  it('ARMED: renders the armed label, no reasons', () => {
    const renderer = render({status: 'ARMED'});
    expect(allText(renderer)).toContain(i18n.t('safetyStrip.armed'));
    expect(findByTestID(renderer, 'safety-strip-armed')).not.toBeNull();
  });

  it('READY: renders the compact ready label', () => {
    const renderer = render({status: 'READY'});
    expect(allText(renderer)).toContain(i18n.t('safetyStrip.ready'));
    expect(findByTestID(renderer, 'safety-strip-ready')).not.toBeNull();
  });

  it('UNKNOWN: renders "حالة التسليح غير مؤكدة" regardless of cause', () => {
    (['WAITING', 'STALE', 'ERROR', 'UNAVAILABLE'] as const).forEach(cause => {
      const renderer = render({status: 'UNKNOWN', cause});
      expect(allText(renderer)).toContain(i18n.t('safetyStrip.unknown'));
      expect(findByTestID(renderer, 'safety-strip-unknown')).not.toBeNull();
    });
  });

  describe('BLOCKED', () => {
    it('renders the blocked heading and every reason when there are 3 or fewer', () => {
      const readiness: ArmingReadiness = {
        status: 'BLOCKED',
        reasons: [reason('a', 'CRITICAL_DANGER', 'خطر حرج'), reason('b', 'WARNING', 'تحذير')],
      };
      const renderer = render(readiness);
      const text = allText(renderer);
      expect(text).toContain(i18n.t('safetyStrip.blockedHeading'));
      expect(text).toContain('خطر حرج');
      expect(text).toContain('تحذير');
      // Fits within the top-3 cap - no "show all" link.
      expect(findByTestID(renderer, 'safety-strip-show-all')).toBeNull();
    });

    it('auto-expands showing only the top 3 by priority when more than 3 reasons exist, with a show-all link', () => {
      const readiness: ArmingReadiness = {
        status: 'BLOCKED',
        reasons: [
          reason('info1', 'INFO', 'معلومة'),
          reason('crit1', 'CRITICAL_DANGER', 'خطر حرج 1'),
          reason('warn1', 'WARNING', 'تحذير 1'),
          reason('block1', 'ARMING_BLOCKER', 'مانع تسليح'),
          reason('crit2', 'CRITICAL_DANGER', 'خطر حرج 2'),
        ],
      };
      const renderer = render(readiness);
      const text = allText(renderer);
      // Top 3 by priority: crit1, crit2, block1.
      expect(text).toContain('خطر حرج 1');
      expect(text).toContain('خطر حرج 2');
      expect(text).toContain('مانع تسليح');
      // Not shown yet (rank 4 and 5).
      expect(text).not.toContain('تحذير 1');
      expect(text).not.toContain('معلومة');

      expect(findByTestID(renderer, 'safety-strip-show-all')).not.toBeNull();
    });

    it('tapping "عرض جميع الأسباب" reveals every remaining reason', async () => {
      const readiness: ArmingReadiness = {
        status: 'BLOCKED',
        reasons: [
          reason('info1', 'INFO', 'معلومة'),
          reason('crit1', 'CRITICAL_DANGER', 'خطر حرج 1'),
          reason('warn1', 'WARNING', 'تحذير 1'),
          reason('block1', 'ARMING_BLOCKER', 'مانع تسليح'),
        ],
      };
      const renderer = render(readiness);
      expect(allText(renderer)).not.toContain('معلومة');

      const showAll = findByTestID(renderer, 'safety-strip-show-all');
      await act(async () => {
        showAll!.props.onPress();
      });

      const text = allText(renderer);
      expect(text).toContain('معلومة');
      expect(text).toContain('تحذير 1');
      // Once fully expanded, the link disappears.
      expect(findByTestID(renderer, 'safety-strip-show-all')).toBeNull();
    });

    it('raw firmware codes never appear in the rendered text, only the Arabic message', () => {
      const readiness: ArmingReadiness = {
        status: 'BLOCKED',
        reasons: [reason('ARMING_DISABLED_THROTTLE_RAW_CODE', 'CRITICAL_DANGER', 'الخانق مرتفع جدًا للتسليح')],
      };
      const renderer = render(readiness);
      const text = allText(renderer);
      expect(text).toContain('الخانق مرتفع جدًا للتسليح');
      expect(text.join('')).not.toContain('ARMING_DISABLED_THROTTLE_RAW_CODE');
    });
  });
});
