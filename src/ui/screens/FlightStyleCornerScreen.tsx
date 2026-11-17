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
  PixelRatio,
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
import {PROSE_MEASURE, colors, contentEnvelope, isDesktopTier, noticeSurface, radii, resolveLayoutTier, spacing, typography} from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'FlightStyleCorner'>;

/** A reading column. Wider than this and the prose lines get too long. */
const CORNER_MAX_WIDTH = 760;

const DECISION_LABEL: Readonly<Record<GuideDecisionKind, string>> = {
  STEP: "Stap",
  ACTION: "Actie",
  PILOT_PREFERENCE: "Voorkeur van de piloot",
  KEEP_DEFAULT: "Ongewijzigd laten",
  NOT_APPLICABLE: "Niet van toepassing",
};

/**
 * The step badge at the system's DEFAULT text size. A floor, not a fixed
 * size - see [stepBadgeSize].
 */
const STEP_BADGE_BASE_SIZE = 26;

/**
 * HOW BIG THE STEP BADGE HAS TO BE AT THIS TEXT SIZE.
 *
 * The badge was a fixed 26x26 circle wrapped around a typography.label
 * that grows with the operator's text-size setting, so at a large setting
 * the numeral was drawn taller than the box and its bottom was cut off
 * with nothing reporting it. Run 34653241507 measured every one of the six
 * steps on API 34 at font scale 2.0 on a 320px display:
 *
 *   FlightStyleCorner@2.0: "1" needs 36px and has 26px
 *   ... "2" ... "3" ... "4" ... "5" ... "6", all 36 against 26
 *
 * This is the same defect FirmwareFlasherSimpleScreen had, in a second
 * screen, and it is repaired the same way: the box grows with the text
 * rather than the text being made to fit the box. Shrinking the numeral,
 * pinning allowFontScaling to false, capping maxFontSizeMultiplier, adding
 * an ellipsis or hiding the number would each silence the measurement by
 * making the screen worse for the operator who asked for larger text.
 *
 * minWidth/minHeight rather than width/height, so a wider glyph still gets
 * the room it needs; borderRadius follows the size so the shape stays a
 * circle. At the default scale this computes exactly 26 and the badge is
 * pixel-identical to before.
 *
 * PixelRatio.getFontScale() is read during render, not once at module
 * load, so a setting the operator changes while the app is installed is
 * picked up the next time the screen is drawn.
 */
function stepBadgeSize(): number {
  return Math.ceil(STEP_BADGE_BASE_SIZE * Math.max(1, PixelRatio.getFontScale()));
}

function StepBlock({
  corner,
  step,
}: {
  readonly corner: GuideCorner;
  readonly step: GuideStep;
}): React.JSX.Element {
  const image = GUIDE_STEP_IMAGES[`${corner.id}/${step.n}`];
  const badge = stepBadgeSize();
  return (
    <View style={styles.step} testID={`guide-step-${corner.id}-${step.n}`}>
      <View style={styles.stepHead}>
        <View
          style={[
            styles.stepBadge,
            {minWidth: badge, minHeight: badge, borderRadius: badge / 2},
          ]}>
          <Text style={styles.stepBadgeText}>{step.n}</Text>
        </View>
        <Text style={styles.stepTitle}>{step.titleAr}</Text>
      </View>

      <Text style={styles.stepWhere}>{step.screen}</Text>

      {step.recommended.length > 0 ? (
        <View style={styles.recommend}>
          <Text style={styles.recommendLabel}>{"De aanbevolen."}</Text>
          <View style={styles.recommendValues}>
            {/* KEYED BY POSITION, NOT BY VALUE.
                A step can recommend the same number twice - Freestyle's
                receiver step is ['50','50'], one per smoothing field -
                and two children with the same key is a condition React
                documents as unsupported: it "may cause children to be
                duplicated and/or omitted". Measured on this renderer it
                currently draws both, so nothing is lost today; the key
                below removes the condition rather than relying on that
                staying true. Position IS the identity here: the list is
                static content and the nth chip is the nth field. */}
            {step.recommended.map((value, index) => (
              <View key={`${index}:${value}`} style={styles.valueChip}>
                <Text style={styles.valueChipText}>{value}</Text>
              </View>
            ))}
          </View>
          {step.sources.length > 0 ? (
            <Text style={styles.sources}>{"De bron:"}{step.sources.join(' · ')}</Text>
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
          accessibilityLabel={`${step.n}: ${step.titleAr}`}
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
  /**
   * WHERE THE HEADER SPLITS IN TWO. Not isDesktopTier: that starts at
   * 1024 and left 768 - a tablet, and one of the widths this is judged
   * at - with the old 407px poster and its first step below the fold.
   * The reading column at 'wide' is ~700px, which seats a 300px cover
   * beside ~380px of text comfortably.
   */
  const heroSideBySide = tier === 'wide' || isDesktopTier(tier);
  const corner = findCorner(route.params.styleId);

  if (corner === undefined) {
    // Unreachable through the index, which only offers ids that exist -
    // but a typed route can still be entered by a deep link, and a blank
    // screen would be the worst possible answer.
    return (
      <View style={styles.root} testID="flight-style-corner-screen">
        <GuideHeader
          eyebrow={"Vliegpatroon handleiding."}
          title={"Onbekend patroon."}
          onBack={() => navigation.goBack()}
        />
        <View style={styles.missing}>
          <Text style={styles.missingText}>
            {"Er is geen hoek met die naam. Ga terug naar de index en kies een stijl uit de lijst."}</Text>
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
            /* `?? Infinity` because a released envelope means "the
               shared policy imposes nothing here", and this screen's own
               CORNER_MAX_WIDTH is then the binding cap. A guide is
               reading material: it keeps its measure on any monitor. */
            maxWidth: Math.min(
              contentEnvelope(tier, isDesktopTier(tier)) ?? Infinity,
              CORNER_MAX_WIDTH,
            ),
          },
        ]}>
        {/*
          ONE COMPACT HEADER, not a poster followed by a caption.

          The cover used to be a full-column 16:9 band: at every desktop
          width that is 407px of a 900px viewport for a photograph, and
          it pushed the first setup step to y=683 - below the fold, on
          every desktop size. Beside the text instead, the same
          photograph reads as identification rather than decoration and
          the steps start where the operator is already looking.

          On a phone the column is too narrow to sit two things side by
          side, so it stays stacked - and it was never the problem
          there: the hero measured 182px of an 844px screen.
        */}
        <View style={[styles.hero, heroSideBySide && styles.heroWide]}>
          <View
            style={heroSideBySide ? styles.heroCoverWide : styles.heroCover}>
            <StyleCover
              source={FLIGHT_STYLE_HERO_IMAGES[corner.id]}
              fit={FLIGHT_STYLE_HERO_FIT[corner.id]}
              titleAr={corner.titleAr}
              titleEn={corner.titleEn}
              testID={`corner-cover-${corner.id}`}
            />
          </View>

          <View style={styles.heroCopy}>
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
          </View>
        </View>

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>{"De aanpassingsstappen in volgorde"}</Text>
          <Text style={styles.sectionHint}>
            {"Volg haar van het eerste tot het laatste. Elke foto van de bouw van de huidige app, Alleen de aanbevolen waarden in deze handleiding."}</Text>
        </View>

        {corner.steps.map(step => (
          <StepBlock key={step.n} corner={corner} step={step} />
        ))}

        {corner.decisions.length === 0 ? null : (
          <>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>
                {"De rest van de instellingen is een keuze voor iedereen."}</Text>
              <Text style={styles.sectionHint}>
                {"Alles wat de stappen hierboven niet veranderen, heeft een schriftelijk besluit, zodat je niet blijft. Je vraagt je af of we hem vergeten zijn. Beslissingen zijn alleen voor deze stijl."}</Text>
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
                    <Text style={styles.sources}>{"De bron:"}{decision.source}</Text>
                  )}
                </View>
              ))}
            </View>
          </>
        )}

        {corner.warnings.length === 0 ? null : (
          <View style={styles.warnings} testID="guide-warnings">
            <Text style={styles.warningsTitle}>{"Waarschuwingen"}</Text>
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
          <Text style={styles.statusTitle}>{"De status van de verificatie"}</Text>
          <Text style={styles.statusText}>
            {corner.verification} {"—  de waarden van officiële bronnen, en de mogelijkheid van toepassing op Ze is getest. Gewone toestand:"}{corner.hardwareStatus}.
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
    /* Tightened from spacing.md. Nine of these gaps sit between the
       reader and the last step; at the old size they alone were most of
       a screen of nothing. */
    gap: spacing.sm,
  },
  /* Stacked on a phone, side by side once there is room for it. */
  hero: {gap: spacing.sm},
  heroWide: {flexDirection: 'row', alignItems: 'center', gap: spacing.lg},
  heroCover: {width: '100%'},
  /* A fixed, modest column rather than the whole width: 300px at 16:9 is
     a 169px photograph, against 407px before. */
  heroCoverWide: {width: 300, flexShrink: 0},
  heroCopy: {flex: 1, gap: spacing.sm, justifyContent: 'center'},
  description: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'left',
    writingDirection: 'ltr', maxWidth: PROSE_MEASURE},
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
  /* Was spacing.lg. A section heading needs separation, not a gap
   the size of a paragraph. */
  sectionHead: {paddingTop: spacing.md, gap: 2},
  sectionTitle: {...typography.sectionTitle, color: colors.textPrimary, textAlign: 'left'},
  sectionHint: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'left',
    writingDirection: 'ltr', maxWidth: PROSE_MEASURE},
  step: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    /* Was spacing.lg all round with spacing.sm between rows. The card's
       own text is 108-228px; its padding was adding another 48. */
    padding: spacing.md,
    gap: 6,
  },
  stepHead: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  // The circle, the centring and the colour live here; the three
  // dimensions come per render from stepBadgeSize() - see its note. At the
  // default text size it computes 26, so this badge looks exactly as it
  // did.
  stepBadge: {
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
  /* Was typography.heading - the size a SCREEN title uses. A step
   inside a numbered list is one level down from that. */
  stepTitle: {...typography.bodyStrong, color: colors.textPrimary, flex: 1, textAlign: 'left'},
  stepWhere: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'left',
    writingDirection: 'ltr', maxWidth: PROSE_MEASURE},
  recommend: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    padding: spacing.sm,
    gap: 4,
  },
  recommendLabel: {...typography.label, color: colors.accentStrong, textAlign: 'left'},
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
    textAlign: 'left',
    writingDirection: 'ltr', maxWidth: PROSE_MEASURE},
  shot: {
    width: '100%',
    /*
      A PHONE CAPTURE, SHOWN AT PHONE SIZE.
      Every step capture is a screenshot of this app on a phone -
      708-780px of real pixels, taken at 2x, so its true CSS width is
      ~355-390. The column stretched it to ~700 on every desktop width,
      which is not extra detail (there is none to reveal) but the same
      picture at 1.8x, and the height goes up with it: one Long Range
      capture rendered 5,913px tall inside a 900px viewport.
      Capped at a real phone's width the whole capture is still there,
      uncropped and at or above native resolution - it simply stops
      being enlarged. Nothing is hidden and no caption loses its number.
    */
    maxWidth: 420,
    alignSelf: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.white,
  },
  note: {...typography.caption, color: colors.textSecondary, maxWidth: PROSE_MEASURE},
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
  decisionWhat: {...typography.bodyStrong, color: colors.textPrimary, flex: 1, textAlign: 'left'},
  verdict: {
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
  },
  verdictText: {...typography.caption, color: colors.textSecondary, fontWeight: '700'},
  decisionDetail: {...typography.caption, maxWidth: PROSE_MEASURE},
  warnings: {
    ...noticeSurface,
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
    gap: spacing.sm,
  },
  warningsTitle: {...typography.label, color: colors.warning, textAlign: 'left'},
  warningRow: {flexDirection: 'row', gap: spacing.sm},
  warningBar: {width: 3, borderRadius: 2, backgroundColor: colors.warning},
  warningBody: {flex: 1},
  warningText: {...typography.caption, color: colors.textSecondary, maxWidth: PROSE_MEASURE},
  status: {...noticeSurface, backgroundColor: colors.successSoft, borderColor: colors.success, gap: 4},
  statusTitle: {...typography.label, color: colors.textPrimary, textAlign: 'left'},
  statusText: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'left',
    writingDirection: 'ltr', maxWidth: PROSE_MEASURE},
  missing: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl},
  missingText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'ltr',
  },
});
