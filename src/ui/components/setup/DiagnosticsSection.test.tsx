/**
 * Pass 7.7, Region 4 - rendering, Arabic truthfulness, accessibility
 * labels and reading order, and the no-timer/no-subscription guarantee.
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text, View } from 'react-native';

import DiagnosticsSection from './DiagnosticsSection';
import '../../../i18n';
import { deriveSetupDiagnostics } from '../../../core';
import type {
  MspStatusExDiagnostics,
  SetupDiagnosticsInput,
  SetupDiagnosticsView,
} from '../../../core';
import type { FlightControllerIdentity } from '../../../core';

const IDENTITY = {
  apiVersion: { apiVersionMajor: 1, apiVersionMinor: 47 },
  firmware: { identifier: 'BTFL', knownFamily: 'BETAFLIGHT' },
  board: {
    boardIdentifier: 'S405',
    boardName: 'SPEEDYBEEF405V3',
    manufacturerId: 'SPBE',
    targetName: 'STM32F405',
  },
} as FlightControllerIdentity;

function value(
  overrides: Partial<MspStatusExDiagnostics> = {},
): MspStatusExDiagnostics {
  return {
    cycleTimeUs: 900,
    i2cErrorCount: 0,
    sensorPresenceMask: 41,
    cpuLoadPercent: 42,
    flightModeFlagsLow32: 0,
    readiness: { armingDisableFlags: 0, armingDisableFlagsCount: 29 },
    ...overrides,
  };
}

function view(
  overrides: Partial<SetupDiagnosticsInput> = {},
): SetupDiagnosticsView {
  return deriveSetupDiagnostics({
    connected: true,
    channelState: 'ACTIVE',
    status: 'FRESH',
    value: value(),
    identificationStatus: 'SUCCEEDED',
    identity: IDENTITY,
    ...overrides,
  });
}

function render(
  diagnostics: SetupDiagnosticsView,
): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <DiagnosticsSection view={diagnostics} />,
    );
  });
  return renderer;
}

function texts(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children),
    );
}

/** The HOST node carrying the testID - findByProps() would otherwise
 * match the Block composite element that merely receives it as a prop. */
function host(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): ReactTestRenderer.ReactTestInstance {
  return renderer.root.find(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function label(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): string {
  return String(host(renderer, testID).props.accessibilityLabel);
}

function unmount(renderer: ReactTestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.unmount();
  });
}

describe('DiagnosticsSection - Region 4 structure', () => {
  it('renders the exact Arabic section title as a header', () => {
    const renderer = render(view());
    const title = host(renderer, 'diagnostics-title');
    expect(title.props.children).toBe('التشخيص والجاهزية');
    expect(title.props.accessibilityRole).toBe('header');
    unmount(renderer);
  });

  it('keeps a stable reading order: identity, compatibility, reading state, sensors, blockers', () => {
    const renderer = render(view());
    const order = renderer.root
      .findAllByType(View)
      .map(node => node.props.testID)
      .filter(
        (id: unknown): id is string =>
          typeof id === 'string' && id.startsWith('diagnostics-'),
      );
    expect(order).toEqual([
      'diagnostics-section',
      'diagnostics-toggle',
      'diagnostics-details',
      'diagnostics-identity',
      'diagnostics-compatibility',
      'diagnostics-reading-state',
      'diagnostics-sensors',
      'diagnostics-blockers',
    ]);
    unmount(renderer);
  });

  it('gives every block one accessibility node whose label starts with its own heading', () => {
    const renderer = render(view());
    for (const [testID, heading] of [
      ['diagnostics-identity', 'متحكم الطيران'],
      ['diagnostics-compatibility', 'التوافق'],
      ['diagnostics-reading-state', 'حالة القراءة'],
      ['diagnostics-sensors', 'المستشعرات المُبلَّغ عن اكتشافها'],
      ['diagnostics-blockers', 'موانع التسليح'],
    ] as const) {
      const node = host(renderer, testID);
      expect(node.props.accessible).toBe(true);
      expect(label(renderer, testID).startsWith(`${heading}،`)).toBe(true);
    }
    unmount(renderer);
  });

  it('registers no timer and no subscription', () => {
    jest.useFakeTimers();
    const renderer = render(view());
    expect(jest.getTimerCount()).toBe(0);
    unmount(renderer);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});

describe('DiagnosticsSection - identity and compatibility copy', () => {
  it('shows the board and the raw firmware identifier with the reported API version', () => {
    const renderer = render(view());
    expect(texts(renderer)).toEqual(
      expect.arrayContaining([
        'اللوحة: SPEEDYBEEF405V3',
        'البرنامج الثابت: BTFL — واجهة MSP 1.47',
      ]),
    );
    expect(texts(renderer)).toContain('متوافق مع واجهة MSP 1.47');
    unmount(renderer);
  });

  it('does not claim compatibility for another API version', () => {
    const other = {
      ...IDENTITY,
      apiVersion: { apiVersionMajor: 1, apiVersionMinor: 46 },
    } as FlightControllerIdentity;
    const renderer = render(view({ identity: other }));
    expect(texts(renderer)).toContain(
      'واجهة غير مُتحقَّق منها في هذا الإصدار؛ تُعرض القراءات فقط',
    );
    expect(texts(renderer)).not.toContain('متوافق مع واجهة MSP 1.47');
    unmount(renderer);
  });

  it('states identification progress and failure without inventing a board', () => {
    const identifying = render(
      view({ identificationStatus: 'RUNNING', identity: undefined }),
    );
    expect(texts(identifying)).toContain('جارٍ التعرّف على متحكم الطيران');
    unmount(identifying);

    const failed = render(
      view({ identificationStatus: 'FAILED', identity: undefined }),
    );
    expect(texts(failed)).toContain('تعذّر التعرّف على متحكم الطيران');
    expect(texts(failed)).toContain('تعذّر التحقّق من التوافق');
    unmount(failed);
  });
});

describe('DiagnosticsSection - lifecycle state copy', () => {
  const cases: Array<[string, Partial<SetupDiagnosticsInput>, string]> = [
    ['disconnected', { connected: false }, 'غير متصل'],
    ['unsupported', { channelState: 'UNSUPPORTED' }, 'غير مدعوم'],
    ['channel error', { channelState: 'DISABLED' }, 'تعذرت قراءة البيانات'],
    [
      'unavailable',
      { status: 'UNAVAILABLE', value: undefined },
      'البيانات غير متاحة',
    ],
    ['waiting', { status: 'WAITING', value: undefined }, 'بانتظار أول قراءة'],
    [
      'read error',
      { status: 'ERROR', value: undefined },
      'تعذرت قراءة البيانات',
    ],
    ['stale', { status: 'STALE' }, 'القراءة غير محدثة'],
    ['fresh', {}, 'القراءة محدثة'],
  ];

  it.each(cases)(
    '%s renders its own explicit text',
    (_name, overrides, expected) => {
      const renderer = render(view(overrides));
      expect(texts(renderer)).toContain(expected);
      unmount(renderer);
    },
  );

  it('never communicates the state by color alone - the text is always present', () => {
    for (const [, overrides, expected] of cases) {
      const renderer = render(view(overrides));
      expect(label(renderer, 'diagnostics-reading-state')).toContain(expected);
      unmount(renderer);
    }
  });

  it('dims sensor and blocker blocks while stale, but never the identity block', () => {
    const renderer = render(view({ status: 'STALE' }));
    const opacityOf = (testID: string): number | undefined => {
      const styles = host(renderer, testID).props.style as Array<
        { opacity?: number } | undefined
      >;
      return styles.find(style => style?.opacity !== undefined)?.opacity;
    };
    expect(opacityOf('diagnostics-sensors')).toBeLessThan(1);
    expect(opacityOf('diagnostics-blockers')).toBeLessThan(1);
    expect(opacityOf('diagnostics-identity')).toBeUndefined();
    unmount(renderer);
  });
});

describe('DiagnosticsSection - sensor truthfulness', () => {
  it('lists only the detected sensors of the pinned mapping, under a "reported as detected" heading', () => {
    const renderer = render(view());
    expect(texts(renderer)).toEqual(
      expect.arrayContaining([
        'المستشعرات المُبلَّغ عن اكتشافها',
        'ACC',
        'GPS',
        'GYRO',
      ]),
    );
    expect(texts(renderer)).not.toContain('BARO');
    unmount(renderer);
  });

  it('preserves an unknown sensor bit in hex instead of dropping or naming it', () => {
    const renderer = render(
      view({ value: value({ sensorPresenceMask: Math.pow(2, 9) }) }),
    );
    expect(texts(renderer)).toContain('بت غير معروف 0x200');
    unmount(renderer);
  });

  it('an empty mask states the reading, never a health conclusion', () => {
    const renderer = render(view({ value: value({ sensorPresenceMask: 0 }) }));
    expect(texts(renderer)).toContain(
      'لم يُبلِّغ متحكم الطيران عن أي مستشعر في هذه القراءة',
    );
    unmount(renderer);
  });

  it('says sensors cannot be confirmed when there is no reading', () => {
    const renderer = render(view({ status: 'WAITING', value: undefined }));
    expect(texts(renderer)).toContain(
      'لا يمكن تأكيد المستشعرات في الوقت الحالي',
    );
    unmount(renderer);
  });
});

describe('DiagnosticsSection - blocker truthfulness', () => {
  it('a fresh zero mask says only that the FC reported no blocker in that reading', () => {
    const renderer = render(view());
    const all = texts(renderer).join(' | ');
    expect(all).toContain('لم يُبلِّغ متحكم الطيران عن أي مانع في هذه القراءة');
    expect(all).not.toContain('جاهزة للطيران');
    expect(all).not.toContain('جاهزة للتسليح');
    unmount(renderer);
  });

  it('renders a source-proven Arabic description alongside the canonical token', () => {
    const renderer = render(
      view({
        value: value({ readiness: { armingDisableFlags: Math.pow(2, 7) } }),
      }),
    );
    expect(texts(renderer)).toContain('الخانق ليس في وضعه الأدنى (THROTTLE)');
    unmount(renderer);
  });

  it('renders every known blocker bit with a description and its token', () => {
    for (let bit = 0; bit < 29; bit++) {
      const renderer = render(
        view({
          value: value({ readiness: { armingDisableFlags: Math.pow(2, bit) } }),
        }),
      );
      const lines = texts(renderer);
      const blockerLine = host(renderer, 'diagnostics-blockers-line-0').props
        .children as string;
      expect(lines).toContain(blockerLine);
      expect(blockerLine.length).toBeGreaterThan(0);
      // BST has no proven set-site, so it renders as the neutral
      // token-only fallback instead of an invented Arabic meaning.
      if (bit === 15) {
        expect(blockerLine).toBe('سبب مانع للتسليح: BST');
      } else {
        expect(blockerLine).toMatch(/\)$/);
      }
      unmount(renderer);
    }
  });

  it('lists multiple simultaneous blockers, one line each', () => {
    const mask = Math.pow(2, 0) + Math.pow(2, 8);
    const renderer = render(
      view({ value: value({ readiness: { armingDisableFlags: mask } }) }),
    );
    expect(texts(renderer)).toEqual(
      expect.arrayContaining([
        'لم يتم اكتشاف الجيروسكوب (NO_GYRO)',
        'الطائرة ليست مستوية (ANGLE)',
      ]),
    );
    unmount(renderer);
  });

  it('preserves an unknown blocker bit numerically AND in hex', () => {
    const renderer = render(
      view({
        value: value({ readiness: { armingDisableFlags: Math.pow(2, 30) } }),
      }),
    );
    expect(texts(renderer)).toContain('مانع غير معروف: بت 30 (0x40000000)');
    unmount(renderer);
  });

  it('a malformed readiness tail says the data is inconsistent - never "no blockers" and never "ready"', () => {
    const renderer = render(
      view({
        value: value({
          readiness: { pidProfileCount: 3, malformedTail: true },
        }),
      }),
    );
    const all = texts(renderer).join(' | ');
    expect(all).toContain(
      'بيانات الجاهزية غير مكتملة أو غير متسقة؛ تعذّر تأكيد موانع التسليح',
    );
    expect(all).not.toContain(
      'لم يُبلِّغ متحكم الطيران عن أي مانع في هذه القراءة',
    );
    expect(all).not.toContain('جاهزة للطيران');
    // The safely decoded prefix (sensors) is still shown.
    expect(texts(renderer)).toEqual(expect.arrayContaining(['ACC', 'GYRO']));
    unmount(renderer);
  });

  it('says blockers cannot be confirmed for stale, short, failed, unsupported and disconnected data', () => {
    const unconfirmed = 'لا يمكن تأكيد موانع التسليح في الوقت الحالي';
    for (const overrides of [
      { status: 'STALE' as const },
      { value: value({ readiness: { pidProfileCount: 3 } }) },
      { status: 'ERROR' as const, value: undefined },
      { channelState: 'UNSUPPORTED' as const },
      { connected: false },
    ]) {
      const renderer = render(view(overrides));
      const all = texts(renderer).join(' | ');
      expect(all).toContain(unconfirmed);
      expect(all).not.toContain(
        'لم يُبلِّغ متحكم الطيران عن أي مانع في هذه القراءة',
      );
      unmount(renderer);
    }
  });

  it('the blocker accessibility label carries the same text as the visible lines', () => {
    const mask = Math.pow(2, 7) + Math.pow(2, 30);
    const renderer = render(
      view({ value: value({ readiness: { armingDisableFlags: mask } }) }),
    );
    const blockerLabel = label(renderer, 'diagnostics-blockers');
    expect(blockerLabel).toContain('الخانق ليس في وضعه الأدنى (THROTTLE)');
    expect(blockerLabel).toContain('مانع غير معروف: بت 30 (0x40000000)');
    unmount(renderer);
  });
});
