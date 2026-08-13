/**
 * THE HARDWARE-VERIFICATION NOTICE, AS THE OPERATOR ACTUALLY READS IT.
 *
 * `src/ui/operatorVocabulary.test.ts` proves the English review token is
 * gone from shipped source. That is a source-level guarantee, and on its
 * own it would also be satisfied by simply deleting the warning. This
 * file mounts the nine screens that carried the token and asserts the
 * opposite half of the contract: the warning is still there, still says
 * the technically true thing, and now says it in Arabic.
 *
 * WHY THESE NINE. They are exactly the screens on which the operator
 * read `REQUIRES HARDWARE TEST` as product copy — an English phrase from
 * our own review vocabulary, rendered inside an Arabic-first interface,
 * on both Android and the browser because these are shared files.
 *
 * WHY NO SESSION IS OPENED. The notice is unconditional: it is part of
 * what the screen IS, not a state it can reach. Mounting with no session
 * key therefore renders it while touching no controller, no transport
 * and no port — which is also the only honest way to test it, since
 * there is no flight controller here to verify anything on.
 *
 * THE TWO TITLES ARE NOT INTERCHANGEABLE, and the split is asserted:
 *   - `title`          the operator must LOOK AT or MEASURE the result
 *                      (OSD in goggles, battery against a meter, VTX output)
 *   - `behaviourTitle` the operator must PHYSICALLY ACTUATE something and
 *                      watch what happens (TX switches, cutting the link,
 *                      moving each sensor axis, a bench or staged flight test)
 * Getting this backwards would tell an operator to look at a number when
 * the only real proof is moving a stick.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import ar from '../../i18n/locales/ar.json';

import CliScreen from './CliScreen';
import FailsafeScreen from './FailsafeScreen';
import ModesScreen from './ModesScreen';
import OsdScreen from './OsdScreen';
import PidTuningScreen from './PidTuningScreen';
import PowerBatteryScreen from './PowerBatteryScreen';
import PresetsScreen from './PresetsScreen';
import SensorsScreen from './SensorsScreen';
import VideoTransmitterScreen from './VideoTransmitterScreen';

const VERIFICATION_TITLE = ar.hardwareVerification.title;
const BEHAVIOUR_TITLE = ar.hardwareVerification.behaviourTitle;

/** Every string the tree renders, flattened. */
function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
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

const noop = (): void => {};

/**
 * `expected` is the title this screen's warning must carry; `evidence`
 * is a phrase from its body, pinned so a future edit cannot quietly
 * reduce a specific technical warning to a bare headline.
 */
const SCREENS: readonly {
  readonly name: string;
  readonly render: () => React.JSX.Element;
  readonly expected: string;
  readonly evidence: string;
}[] = [
  {
    name: 'CliScreen',
    render: () => <CliScreen active={false} onCliBusyChange={noop} />,
    expected: BEHAVIOUR_TITLE,
    evidence: 'اختبر على الطاولة بلا مراوح',
  },
  {
    name: 'FailsafeScreen',
    render: () => (
      <FailsafeScreen active={false} onOpenReceiver={noop} onOpenMotors={noop} />
    ),
    expected: BEHAVIOUR_TITLE,
    evidence: 'بقطع الإشارة فعليًا',
  },
  {
    name: 'ModesScreen',
    render: () => <ModesScreen active={false} onOpenMotors={noop} />,
    expected: BEHAVIOUR_TITLE,
    evidence: 'تحريك مفاتيح جهاز الإرسال',
  },
  {
    name: 'OsdScreen',
    render: () => <OsdScreen active={false} onOpenMotors={noop} />,
    expected: VERIFICATION_TITLE,
    evidence: 'في النظارة أو شاشة الفيديو',
  },
  {
    name: 'PidTuningScreen',
    render: () => <PidTuningScreen active={false} onOpenMotors={noop} />,
    expected: BEHAVIOUR_TITLE,
    evidence: 'اختبار متدرج آمن',
  },
  {
    name: 'PowerBatteryScreen',
    render: () => <PowerBatteryScreen active={false} onOpenMotors={noop} />,
    expected: VERIFICATION_TITLE,
    evidence: 'مقارنة بأداة قياس خارجية',
  },
  {
    name: 'PresetsScreen',
    render: () => <PresetsScreen active={false} onCliBusyChange={noop} />,
    expected: BEHAVIOUR_TITLE,
    evidence: 'اختبر على الطاولة بلا مراوح',
  },
  {
    name: 'SensorsScreen',
    render: () => <SensorsScreen active={false} onOpenSetup={noop} />,
    expected: BEHAVIOUR_TITLE,
    evidence: 'حرّك كل محور منفردًا',
  },
  {
    name: 'VideoTransmitterScreen',
    render: () => <VideoTransmitterScreen active={false} />,
    expected: VERIFICATION_TITLE,
    evidence: 'تحتاج قياس VTX/نظارة',
  },
];

describe('the two hardware-verification titles', () => {
  it('are Arabic, and carry no English review vocabulary', () => {
    for (const title of [VERIFICATION_TITLE, BEHAVIOUR_TITLE]) {
      expect(title).not.toContain('REQUIRES');
      expect(title).not.toContain('HARDWARE');
      expect(title).toContain('جهاز فعلي');
    }
  });

  it('remain two distinct statements, not one string used twice', () => {
    expect(VERIFICATION_TITLE).not.toBe(BEHAVIOUR_TITLE);
    expect(VERIFICATION_TITLE).toContain('التحقق');
    expect(BEHAVIOUR_TITLE).toContain('اختبارًا');
  });
});

describe.each(SCREENS.map(screen => [screen.name, screen] as const))(
  '%s',
  (_name, screen) => {
    let tree: ReactTestRenderer.ReactTestRenderer;
    let text: string;

    beforeAll(async () => {
      await ReactTestRenderer.act(async () => {
        tree = ReactTestRenderer.create(screen.render());
        await Promise.resolve();
      });
      text = renderedText(tree);
    });

    afterAll(() => {
      ReactTestRenderer.act(() => tree.unmount());
    });

    it('renders the localized hardware-verification title', () => {
      expect(text).toContain(screen.expected);
    });

    it('renders no English review token', () => {
      expect(text).not.toContain('REQUIRES HARDWARE TEST');
    });

    it('still states its specific technical warning', () => {
      expect(text).toContain(screen.evidence);
    });
  },
);
