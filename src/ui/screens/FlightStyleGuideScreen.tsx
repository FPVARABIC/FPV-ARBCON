/**
 * THE DIRECTORY OF FLIGHT STYLES - five cards, and nothing else.
 *
 * This screen exists to answer one question: which of these is the
 * aircraft in front of you? It therefore shows each style's cover
 * photograph, its name, who it is for and how many steps it takes - and
 * NOT a single tuning value. Every number lives inside the corner that
 * owns it, one tap away.
 *
 * THAT IS THE WHOLE POINT OF THE SPLIT. The package these cards open was
 * built on one rule: a reader inside one style must never be shown
 * another style's numbers, because "Dshot300 for a whoop" and "DSHOT600
 * for a 6S racer" are both correct and swapping them is a crash. A
 * directory that lists five doors is not a pooled guide; a page that
 * listed five styles' settings side by side would be, and this screen
 * deliberately is not that page.
 *
 * The firmware card is not here. It is not a flight style - it is what
 * must be true before any of them mean anything - and it has its own
 * entry on the home screen.
 */
import React from 'react';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import type {RootStackParamList} from '../../navigation/types';
import {Icon} from '../icons';
import {readInteraction} from '../components/controls/interaction';
import {
  FLIGHT_STYLES,
  FLIGHT_STYLE_HERO_FIT,
  FLIGHT_STYLE_HERO_IMAGES,
  GuideHeader,
  StyleCover,
} from '../flight-guides';
import type {GuideCorner} from '../flight-guides';
import {PROSE_MEASURE, colors, contentEnvelope, isDesktopTier, noticeSurface, radii, resolveLayoutTier, spacing, typography} from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'FlightStyleGuide'>;

/** Wide enough for three cards; beyond it each one becomes a thumbnail. */
const GUIDE_MAX_WIDTH = 1180;

/** Half the gutter between cards; each cell carries one half per side. */
const HALF_GUTTER = spacing.lg / 2;

/**
 * HOW MANY CARDS SHARE A ROW - decided by width, not by a flex guess.
 *
 * An earlier version let the cards flex-grow into whatever space was
 * left, and the last row was measured stretching to fill it: at 1024px
 * four cards sat at 485px each and the fifth spanned 988px; at 1366px
 * three sat at 343px and two at 523px. Five is not divisible by two or
 * three, so a wrapping row ALWAYS leaves a remainder - and letting the
 * remainder decide a card's size makes one aircraft look twice as
 * important as another for no reason. A fixed column count gives every
 * card the same width in every row, including the short last one.
 */
function columnsFor(width: number): number {
  if (width >= 1280) return 3;
  if (width >= 720) return 2;
  return 1;
}

function StyleCard({
  corner,
  onPress,
}: {
  readonly corner: GuideCorner;
  readonly onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`افتح دليل ${corner.titleAr}`}
      testID={`guide-card-${corner.id}`}
      onPress={onPress}
      style={state => {
        const {pressed, hovered} = readInteraction(state);
        return [styles.card, hovered && styles.cardHovered, pressed && styles.cardPressed];
      }}>
      <StyleCover
        source={FLIGHT_STYLE_HERO_IMAGES[corner.id]}
        fit={FLIGHT_STYLE_HERO_FIT[corner.id]}
        titleAr={corner.titleAr}
        titleEn={corner.titleEn}
        testID={`guide-cover-${corner.id}`}
      />
      <View style={styles.cardBody}>
        <Text style={styles.cardEn}>{corner.titleEn}</Text>
        <Text style={styles.cardTitle}>{corner.titleAr}</Text>
        <Text style={styles.cardDescription}>{corner.descriptionAr}</Text>

        <View style={styles.metaRow}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{corner.difficultyAr}</Text>
          </View>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{corner.steps.length} خطوات</Text>
          </View>
        </View>

        <Text style={styles.aircraft} numberOfLines={2}>
          {corner.aircraft.join(' · ')}
        </Text>

        <View style={styles.cta}>
          <Text style={styles.ctaText}>افتح الركن</Text>
          <Icon name="chevron-forward" size={20} color={colors.accentStrong} />
        </View>
      </View>
    </Pressable>
  );
}

export default function FlightStyleGuideScreen({
  navigation,
}: Props): React.JSX.Element {
  const {width, fontScale} = useWindowDimensions();
  const tier = resolveLayoutTier(width, fontScale);
  const desktop = isDesktopTier(tier);
  const columns = columnsFor(width);

  return (
    <View style={styles.root} testID="flight-style-guide-screen">
      <GuideHeader
        eyebrow="اختر النمط الذي تطيره"
        title="دليل أنماط الطيران"
        onBack={() => navigation.goBack()}
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {maxWidth: Math.min(contentEnvelope(tier, desktop), GUIDE_MAX_WIDTH)},
        ]}>
        <Text style={styles.intro}>
          كل نمط ركن مستقل: خطواته مرقّمة من الأولى إلى الأخيرة، وصوره
          بقيمه هو، وقرار مكتوب لكل إعداد لا تغيّره خطواته. لن تحتاج إلى
          فتح نمط آخر لتكمل نمطك.
        </Text>

        <View style={styles.grid} testID="guide-card-group">
          {FLIGHT_STYLES.map(corner => (
            <View
              key={corner.id}
              style={[styles.cell, {width: `${100 / columns}%`}]}>
              <StyleCard
                corner={corner}
                onPress={() =>
                  navigation.navigate('FlightStyleCorner', {styleId: corner.id})
                }
              />
            </View>
          ))}
        </View>

        <View style={styles.verification}>
          <Text style={styles.verificationTitle}>ما تعنيه أرقام هذا الدليل</Text>
          <Text style={styles.verificationText}>
            كل رقم مأخوذ من مصادر البرنامج الثابت الرسمية ومذكور مصدره بجانبه،
            وقدرة التطبيق على ضبطه مثبتة باختبارات. ليست قيمًا مجرّبة في
            رحلة، ولا مُثبتة على عتاد. كلها نقاط بداية.
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
    gap: spacing.lg,
  },
  intro: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  /* A real grid: the CELL owns the width (one, two or three per row) and
     the card fills it. Gutters come from cell padding rather than `gap`,
     because a percentage width and a gap cannot both be satisfied - that
     combination overflows the row by exactly the gap. */
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    marginHorizontal: -HALF_GUTTER,
  },
  cell: {padding: HALF_GUTTER},
  card: {
    /* Fills its cell and stretches to the tallest card in the row, so a
       row reads as one shelf rather than a ragged edge. */
    flex: 1,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHovered: {borderColor: colors.accentStrong},
  cardPressed: {opacity: 0.85},
  cardBody: {padding: spacing.lg, gap: 6},
  cardEn: {
    ...typography.eyebrow,
    color: colors.accentStrong,
    writingDirection: 'ltr',
    textAlign: 'right',
  },
  cardTitle: {...typography.title, color: colors.textPrimary, textAlign: 'right'},
  cardDescription: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  metaRow: {flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm},
  chip: {
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  chipText: {...typography.caption, color: colors.accentText, fontWeight: '600'},
  aircraft: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    writingDirection: 'rtl',
    paddingTop: 2, maxWidth: PROSE_MEASURE},
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: spacing.sm,
  },
  ctaText: {...typography.label, color: colors.accentStrong},
  verification: {...noticeSurface, backgroundColor: colors.infoSoft, borderColor: colors.info, gap: 4},
  verificationTitle: {...typography.label, color: colors.textPrimary, textAlign: 'right'},
  verificationText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
});
