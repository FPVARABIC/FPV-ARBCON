import React from 'react';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import type {RootStackParamList} from '../../navigation/types';
import {Icon} from '../icons';
import {BrandLogo} from '../brand';
import {readInteraction} from '../components/controls/interaction';
import {
  colors,
  contentEnvelope,
  isDesktopTier,
  radii,
  resolveLayoutTier,
  spacing,
  typography,
} from '../theme';

/**
 * THE OFFICIAL LOGO ON START - Android only. The document is RTL, so the
 * brand row's FIRST child sits at the RIGHT edge: exactly the top-right
 * placement the brand calls for. On web the logo lives in the persistent
 * top chrome instead (BrandTopChrome, rendered by App.web.tsx above every
 * route), and repeating it here would stack two identical marks within a
 * hundred pixels - so the web Start row carries the name and tagline only.
 */
const SHOW_START_LOGO = Platform.OS !== 'web';

type Props = NativeStackScreenProps<RootStackParamList, 'Start'>;

type RouteCardProps = {
  readonly title: string;
  readonly description: string;
  readonly bullets: readonly string[];
  readonly button: string;
  readonly testID: string;
  readonly accent: 'teal' | 'blue';
  /** True only where the two cards share a row - see styles.routeCardShare. */
  readonly sideBySide: boolean;
  readonly onPress: () => void;
};

function RouteCard({
  title,
  description,
  bullets,
  button,
  testID,
  accent,
  sideBySide,
  onPress,
}: RouteCardProps): React.JSX.Element {
  return (
    <View
      style={[
        styles.routeCard,
        sideBySide && styles.routeCardShare,
        accent === 'blue' && styles.routeCardBlue,
      ]}>
      <View style={[styles.routeMark, accent === 'blue' && styles.routeMarkBlue]} />
      <Text style={styles.routeTitle}>{title}</Text>
      <Text style={styles.routeDescription}>{description}</Text>
      <View style={styles.bullets}>
        {bullets.map(item => (
          <View key={item} style={styles.bulletRow}>
            <View style={[styles.bulletDot, accent === 'blue' && styles.bulletDotBlue]} />
            <Text style={styles.bulletText}>{item}</Text>
          </View>
        ))}
      </View>
      {/* NOT the shared <Button>: this is the screen's hero call to
          action, where the directional affordance must sit at the FAR
          END of a full-width bar (space-between). Button centres a
          LEADING icon, which would put the chevron at the start and
          point it away from the direction of travel. Everything else -
          fill, radius, height, label weight, states - comes from the
          same tokens Button uses, so nothing here is a new style. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={button}
        testID={testID}
        onPress={onPress}
        style={state => {
          const {pressed, hovered} = readInteraction(state);
          return [
            styles.routeButton,
            accent === 'blue' && styles.routeButtonBlue,
            hovered && styles.routeButtonHovered,
            pressed && styles.pressed,
          ];
        }}>
        <Text
          style={[
            styles.routeButtonText,
            accent === 'blue' && styles.routeButtonTextBlue,
          ]}>
          {button}
        </Text>
        <Icon
          name="chevron-forward"
          size={22}
          color={accent === 'blue' ? colors.white : colors.accentText}
        />
      </Pressable>
    </View>
  );
}

/**
 * The widest this screen's column may get. Two route cards side by side
 * stay cards at this width; beyond it a 1920px window gave two ~770px
 * slabs each holding a small button - the stretched-desktop look.
 */
const HOME_MAX_WIDTH = 1200;

export default function StartScreen({navigation}: Props): React.JSX.Element {
  const {width, fontScale} = useWindowDimensions();
  const tier = resolveLayoutTier(width, fontScale);
  // The two route cards are peers - one connects, one flashes - and they
  // are the whole point of this screen. Stacked vertically they made a
  // 1920px desktop show two ~1100px letterboxes with 786px of dead space
  // beside them (AUD-003). Side by side they read as the choice they are,
  // and the wider envelope is earned because the screen genuinely splits.
  const desktop = isDesktopTier(tier);

  return (
    <ScrollView
      testID="start-screen"
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        // Capped so the whole column - brand row, heading, cards and the
        // safety line - shares one edge instead of the note spanning
        // wider than the cards above it.
        {maxWidth: Math.min(contentEnvelope(tier, desktop), HOME_MAX_WIDTH)},
      ]}
      keyboardShouldPersistTaps="handled">
      <View style={styles.brandRow}>
        {SHOW_START_LOGO ? (
          /* First child of an RTL row = the RIGHT edge. 56dp of emblem:
             prominent on a phone without pushing the two route cards
             below the fold. */
          <BrandLogo height={56} testID="start-brand-logo" />
        ) : null}
        <View style={styles.brandCopy}>
          <Text style={styles.brandName}>FPV-ARBCON</Text>
          <Text style={styles.brandTagline}>مركز تحكم الطيران العربي</Text>
        </View>
        <View style={styles.offlinePill}>
          <View style={styles.offlineDot} />
          <Text style={styles.offlineText}>جاهز</Text>
        </View>
      </View>

      <View style={styles.hero}>
        <Text style={styles.heroTitle}>اختر ما تريد تنفيذه</Text>
      </View>

      <View style={desktop ? styles.routeRow : styles.routeColumn} testID="start-route-group">
      <RouteCard
        title="إعداد متحكم الطيران"
        description="الاتصال باللوحة وضبط إعداداتها."
        bullets={[
          'الاتصال باللوحة',
          'Setup والإعدادات',
          'Motors و Receiver',
          'OSD و GPS و Sensors',
          'CLI',
        ]}
        button="فتح إعدادات متحكم الطيران"
        testID="start-configure"
        accent="teal"
        sideBySide={desktop}
        onPress={() => navigation.navigate('Setup')}
      />

      <RouteCard
        title="Firmware Flasher"
        description="تثبيت أو تحديث Firmware واختيار Target وإعدادات البناء."
        bullets={['اختيار اللوحة والإصدار', 'إعدادات البناء الرسمية', 'تفليش عبر DFU مع تحقق كامل']}
        button="فتح Firmware Flasher"
        testID="start-firmware"
        accent="blue"
        sideBySide={desktop}
        onPress={() => navigation.navigate('FirmwareFlasher')}
      />
      </View>

      <View style={styles.safetyNote}>
        <Text style={styles.safetyText}>
          لن يبدأ أي مسح أو كتابة قبل التحقق من الملف واللوحة و Target.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  content: {
    width: '100%',
    // Cap comes from contentEnvelope(), applied inline.
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  /* The old hand-drawn placeholder badge (a square core with two rotated
     arms, standing in for a real mark) is GONE - the official logo asset
     renders in its place on Android, and the web top chrome carries it
     persistently there. */
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  brandCopy: {flex: 1},
  brandName: {...typography.sectionTitle, color: colors.textPrimary, letterSpacing: 0.6},
  brandTagline: {...typography.caption, color: colors.textSecondary},
  offlinePill: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
  },
  offlineDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success},
  offlineText: {...typography.label, color: colors.textSecondary},
  hero: {paddingVertical: spacing.lg, gap: spacing.sm},
  /* Peers, laid out in the product's RTL reading order: index 0 (connect)
     is the RIGHTMOST card, matching src/navigation/tabs.ts's convention.
     `alignItems: 'stretch'` keeps both cards the same height so the two
     call-to-action buttons sit on one line.

     PLAIN 'row', NOT 'row-reverse'. Measured in a browser: the document
     carries dir="rtl", so a plain row ALREADY runs right-to-left and puts
     index 0 on the right. 'row-reverse' flipped it back to left-to-right
     and put "المسار الأول" on the LEFT — the exact opposite of what the
     comment above promised. (This was invisible for as long as it went
     unmeasured, because react-native-web's I18nManager reports LTR while
     the document lays out RTL.) */
  routeRow: {flexDirection: 'row', alignItems: 'stretch', gap: spacing.lg},
  routeColumn: {gap: spacing.lg},
  heroTitle: {...typography.display, color: colors.textPrimary},
  heroBody: {...typography.body, color: colors.textSecondary, writingDirection: 'rtl'},
  routeCard: {
    position: 'relative',
    overflow: 'hidden',
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  /* EQUAL HALVES OF A ROW - and ONLY of a row.
     `flexBasis: 0` sizes the MAIN axis. In routeRow the main axis is
     horizontal, so this is the intended "two equal columns". These
     properties used to live on routeCard itself, described as "inert
     inside routeColumn where the parent is not a row" - which is exactly
     wrong: in a COLUMN the main axis is vertical, so flexBasis 0 gave
     every stacked card a hypothetical HEIGHT of zero, and `overflow:
     hidden` then cut the card off mid-title, taking the bullets and the
     call to action with it. Measured in Chromium against the deployed
     bundle: at 360/390/412/768 both cards rendered ~50px tall with their
     own titles sliced in half; at >=1024 (a genuine row) they were
     correct, which is why a numeric width check never saw it. */
  routeCardShare: {flexGrow: 1, flexShrink: 1, flexBasis: 0},
  routeCardBlue: {borderColor: colors.info},
  routeMark: {position: 'absolute', start: 0, top: 0, bottom: 0, width: 4, backgroundColor: colors.accent},
  routeMarkBlue: {backgroundColor: colors.info},
  routeTitle: {...typography.title, color: colors.textPrimary},
  routeDescription: {...typography.body, color: colors.textSecondary, writingDirection: 'rtl'},
  bullets: {gap: 7, paddingVertical: spacing.sm},
  bulletRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  bulletDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent},
  bulletDotBlue: {backgroundColor: colors.info},
  bulletText: {
    ...typography.body,
    color: colors.textSecondary,
    flex: 1,
    /* LOAD-BEARING. Every bullet starts with a Latin technical token
       ("Ports", "HEX", "BIN", "UF2"), and without an explicit direction
       the paragraph inherits ITS direction - so an Arabic sentence was
       laid out left-to-right and the words came out in the wrong order.
       Measured in a real browser, not theorised. */
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  routeButton: {
    // Sized to its label, not stretched across the card. A full-width
    // bar on a 1156px desktop card read as a banner rather than a
    // button, and two of them competed with each other instead of
    // reading as two choices.
    alignSelf: 'flex-start',
    minHeight: 48,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  routeButtonBlue: {backgroundColor: colors.info},
  routeButtonHovered: {opacity: 0.9},
  routeButtonText: {...typography.sectionTitle, color: colors.accentText},
  routeButtonTextBlue: {color: colors.white},
  pressed: {opacity: 0.75},
  safetyNote: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.successSoft,
    borderWidth: 1,
    borderColor: colors.success,
    gap: 3,
  },
  safetyText: {...typography.body, color: colors.textSecondary, writingDirection: 'rtl'},
});
