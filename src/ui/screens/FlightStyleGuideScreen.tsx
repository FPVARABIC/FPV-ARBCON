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
  FLIGHT_STYLE_HERO_IMAGES,
  GuideHeader,
  StyleCover,
} from '../flight-guides';
import type {GuideCorner} from '../flight-guides';
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

type Props = NativeStackScreenProps<RootStackParamList, 'FlightStyleGuide'>;

/** Wide enough for two cards; a third column made each one a thumbnail. */
const GUIDE_MAX_WIDTH = 1100;

function StyleCard({
  corner,
  sideBySide,
  onPress,
}: {
  readonly corner: GuideCorner;
  readonly sideBySide: boolean;
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
        return [
          styles.card,
          sideBySide && styles.cardShare,
          hovered && styles.cardHovered,
          pressed && styles.cardPressed,
        ];
      }}>
      <StyleCover
        source={FLIGHT_STYLE_HERO_IMAGES[corner.id]}
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

        <View
          style={desktop ? styles.grid : styles.column}
          testID="guide-card-group">
          {FLIGHT_STYLES.map(corner => (
            <StyleCard
              key={corner.id}
              corner={corner}
              sideBySide={desktop}
              onPress={() =>
                navigation.navigate('FlightStyleCorner', {styleId: corner.id})
              }
            />
          ))}
        </View>

        <View style={styles.verification}>
          <Text style={styles.verificationTitle}>ما تعنيه أرقام هذا الدليل</Text>
          <Text style={styles.verificationText}>
            كل رقم مأخوذ من مصادر Betaflight الرسمية ومذكور مصدره بجانبه،
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
    writingDirection: 'rtl',
  },
  /* Two columns on a desktop tier; the fifth card simply wraps onto its
     own row rather than being squeezed into a third narrow column. */
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    gap: spacing.lg,
  },
  column: {gap: spacing.lg},
  card: {
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  /* Half a row minus the gap. flexBasis sizes the MAIN axis, so this is
     applied ONLY inside `grid`, where the main axis is horizontal - in
     `column` it would give every card a hypothetical height of zero. */
  cardShare: {flexGrow: 1, flexShrink: 1, flexBasis: 320},
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
    writingDirection: 'rtl',
  },
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
    paddingTop: 2,
  },
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
    writingDirection: 'rtl',
  },
});
