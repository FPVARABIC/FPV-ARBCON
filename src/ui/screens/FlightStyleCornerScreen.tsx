/**
 * ONE FLIGHT STYLE'S CORNER - and only one, on purpose.
 *
 * The screen is parameterised by a style id and renders exactly that
 * style's content: its own numbered steps, its own captures showing its
 * own recommended values, its own verdict on every setting the steps do
 * not touch, and its own warnings. It never reads a second corner, never
 * compares two styles, and never renders a value that belongs to one
 * style inside a page about another.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS. Dshot300 is right for a 1S whoop
 * and wrong for a 6S racer; 4.45 V per cell is right for one and a fire
 * for the other. Every value in this package is only true next to the
 * aircraft it was written for, so a page that pooled them would be
 * actively dangerous rather than merely untidy. One component serving
 * five corners is code reuse; it is not shared guidance, because at any
 * moment the reader is inside exactly one corner.
 *
 * THE CAPTURES ARE EVIDENCE, NOT ILLUSTRATION. Each one was taken from a
 * real build of this app with the recommended values entered, and checked
 * against the STATE OF THE CONTROL ITSELF - the value inside the field,
 * the option actually selected, the switch actually on - rather than
 * against text appearing somewhere on screen. Each carries its true pixel
 * size so its frame reserves the exact aspect ratio: nothing here is
 * cropped or stretched, because a crop can hide the very number the
 * caption promises.
 */
import React from 'react';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import type {RootStackParamList} from '../../navigation/types';
import {
  FLIGHT_STYLE_HERO_FIT,
  FLIGHT_STYLE_HERO_IMAGES,
  GUIDE_STEP_IMAGES,
  GuideHeader,
  GuideText,
  StyleCover,
  findCorner,
} from '../flight-guides';
import type {GuideCorner, GuideDecisionKind, GuideStep} from '../flight-guides';
import {
  colors,
  contentEnvelope,
  isDesktopTier,
  noticeSurface,
  radii,
  resolveLayoutTier,
  spacing,
  typography,
} from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'FlightStyleCorner'>;

/** A reading column. Wider than this and the prose lines get too long. */
const CORNER_MAX_WIDTH = 760;

const DECISION_LABEL: Readonly<Record<GuideDecisionKind, string>> = {
  STEP: 'خطوة',
  ACTION: 'إجراء',
  PILOT_PREFERENCE: 'تفضيل الطيار',
  KEEP_DEFAULT: 'اتركه كما هو',
  NOT_APPLICABLE: 'لا ينطبق',
};

function StepBlock({
  corner,
  step,
}: {
  readonly corner: GuideCorner;
  readonly step: GuideStep;
}): React.JSX.Element {
  const image = GUIDE_STEP_IMAGES[`${corner.id}/${step.n}`];
  return (
    <View style={styles.step} testID={`guide-step-${corner.id}-${step.n}`}>
      <View style={styles.stepHead}>
        <View style={styles.stepBadge}>
          <Text style={styles.stepBadgeText}>{step.n}</Text>
        </View>
        <Text style={styles.stepTitle}>{step.titleAr}</Text>
      </View>

      <Text style={styles.stepWhere}>{step.screen}</Text>

      {step.recommended.length > 0 ? (
        <View style={styles.recommend}>
          <Text style={styles.recommendLabel}>الموصى به</Text>
          <View style={styles.recommendValues}>
            {step.recommended.map(value => (
              <View key={value} style={styles.valueChip}>
                <Text style={styles.valueChipText}>{value}</Text>
              </View>
            ))}
          </View>
          {step.sources.length > 0 ? (
            <Text style={styles.sources}>المصدر: {step.sources.join(' · ')}</Text>
          ) : null}
        </View>
      ) : null}

      {image === undefined ? null : (
        <Image
          source={image}
          /* The capture's OWN ratio, so the frame is exactly its shape:
             no crop, no letterbox, and no reflow when it decodes. */
          style={[styles.shot, {aspectRatio: step.width / step.height}]}
          resizeMode="contain"
          accessible
          accessibilityLabel={`لقطة الخطوة ${step.n}: ${step.titleAr}`}
        />
      )}

      {step.note === null ? null : (
        <GuideText style={styles.note}>{step.note}</GuideText>
      )}
    </View>
  );
}

export default function FlightStyleCornerScreen({
  navigation,
  route,
}: Props): React.JSX.Element {
  const {width, fontScale} = useWindowDimensions();
  const tier = resolveLayoutTier(width, fontScale);
  const corner = findCorner(route.params.styleId);

  if (corner === undefined) {
    // Unreachable through the index, which only offers ids that exist -
    // but a typed route can still be entered by a deep link, and a blank
    // screen would be the worst possible answer.
    return (
      <View style={styles.root} testID="flight-style-corner-screen">
        <GuideHeader
          eyebrow="دليل أنماط الطيران"
          title="نمط غير معروف"
          onBack={() => navigation.goBack()}
        />
        <View style={styles.missing}>
          <Text style={styles.missingText}>
            لا يوجد ركن بهذا الاسم. ارجع إلى الفهرس واختر نمطًا من القائمة.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root} testID="flight-style-corner-screen">
      <GuideHeader
        eyebrow={corner.titleEn}
        title={corner.titleAr}
        onBack={() => navigation.goBack()}
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            maxWidth: Math.min(
              contentEnvelope(tier, isDesktopTier(tier)),
              CORNER_MAX_WIDTH,
            ),
          },
        ]}>
        <StyleCover
          source={FLIGHT_STYLE_HERO_IMAGES[corner.id]}
          fit={FLIGHT_STYLE_HERO_FIT[corner.id]}
          titleAr={corner.titleAr}
          titleEn={corner.titleEn}
          testID={`corner-cover-${corner.id}`}
        />

        <Text style={styles.description}>{corner.descriptionAr}</Text>

        <View style={styles.metaRow}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{corner.difficultyAr}</Text>
          </View>
          {corner.aircraft.map(aircraft => (
            <View key={aircraft} style={styles.chipQuiet}>
              <Text style={styles.chipQuietText}>{aircraft}</Text>
            </View>
          ))}
        </View>

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>خطوات الضبط — بالترتيب</Text>
          <Text style={styles.sectionHint}>
            اتبعها من الأولى إلى الأخيرة. كل صورة من بناء التطبيق الحالي،
            بالقيم الموصى بها في هذا الدليل وحده.
          </Text>
        </View>

        {corner.steps.map(step => (
          <StepBlock key={step.n} corner={corner} step={step} />
        ))}

        {corner.decisions.length === 0 ? null : (
          <>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>
                بقية الإعدادات — قرار لكل واحد
              </Text>
              <Text style={styles.sectionHint}>
                كل ما لا تغيّره الخطوات أعلاه له قرار مكتوب، حتى لا تبقى
                تتساءل هل نسيناه. القرارات تخص هذا النمط وحده.
              </Text>
            </View>
            <View style={styles.decisions} testID="guide-decisions">
              {corner.decisions.map(decision => (
                <View key={decision.what} style={styles.decision}>
                  <View style={styles.decisionHead}>
                    <Text style={styles.decisionWhat}>{decision.what}</Text>
                    <View style={styles.verdict}>
                      <Text style={styles.verdictText}>
                        {DECISION_LABEL[decision.kind]}
                      </Text>
                    </View>
                  </View>
                  <GuideText style={styles.decisionDetail}>
                    {decision.detail}
                  </GuideText>
                  {decision.source === null ? null : (
                    <Text style={styles.sources}>المصدر: {decision.source}</Text>
                  )}
                </View>
              ))}
            </View>
          </>
        )}

        {corner.warnings.length === 0 ? null : (
          <View style={styles.warnings} testID="guide-warnings">
            <Text style={styles.warningsTitle}>تحذيرات</Text>
            {corner.warnings.map(warning => (
              <View key={warning.slice(0, 40)} style={styles.warningRow}>
                <View style={styles.warningBar} />
                <View style={styles.warningBody}>
                  <GuideText style={styles.warningText}>{warning}</GuideText>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={styles.status}>
          <Text style={styles.statusTitle}>حالة التحقق</Text>
          <Text style={styles.statusText}>
            {corner.verification} — القيم من مصادر رسمية، وقدرة التطبيق على
            ضبطها مثبتة باختبارات. حالة العتاد: {corner.hardwareStatus}.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  scroll: {flex: 1},
  content: {
    width: '100%',
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  description: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  metaRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  chip: {
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  chipText: {...typography.caption, color: colors.accentText, fontWeight: '600'},
  chipQuiet: {
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  chipQuietText: {...typography.caption, color: colors.textMuted},
  sectionHead: {paddingTop: spacing.lg, gap: 4},
  sectionTitle: {...typography.sectionTitle, color: colors.textPrimary, textAlign: 'right'},
  sectionHint: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  step: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  stepHead: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  stepBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* A numeral, so it declares its own direction rather than inheriting. */
  stepBadgeText: {
    ...typography.label,
    color: colors.white,
    writingDirection: 'ltr',
  },
  stepTitle: {...typography.heading, color: colors.textPrimary, flex: 1, textAlign: 'right'},
  stepWhere: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  recommend: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 6,
  },
  recommendLabel: {...typography.label, color: colors.accentStrong, textAlign: 'right'},
  recommendValues: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  valueChip: {
    borderRadius: radii.sm,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  /* A measured value with its unit - left to right, like everywhere else
     a number and its unit appear together in this app. */
  valueChipText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  sources: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  shot: {
    width: '100%',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.white,
  },
  note: {...typography.caption, color: colors.textSecondary},
  decisions: {gap: spacing.sm},
  decision: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.md,
    gap: 4,
  },
  decisionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  decisionWhat: {...typography.bodyStrong, color: colors.textPrimary, flex: 1, textAlign: 'right'},
  verdict: {
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
  },
  verdictText: {...typography.caption, color: colors.textSecondary, fontWeight: '700'},
  decisionDetail: {...typography.caption},
  warnings: {
    ...noticeSurface,
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
    gap: spacing.sm,
  },
  warningsTitle: {...typography.label, color: colors.warning, textAlign: 'right'},
  warningRow: {flexDirection: 'row', gap: spacing.sm},
  warningBar: {width: 3, borderRadius: 2, backgroundColor: colors.warning},
  warningBody: {flex: 1},
  warningText: {...typography.caption, color: colors.textSecondary},
  status: {...noticeSurface, backgroundColor: colors.successSoft, borderColor: colors.success, gap: 4},
  statusTitle: {...typography.label, color: colors.textPrimary, textAlign: 'right'},
  statusText: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  missing: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl},
  missingText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
});
