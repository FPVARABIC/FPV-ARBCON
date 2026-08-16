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
  readonly eyebrow: string;
  readonly bullets: readonly string[];
  readonly button: string;
  readonly testID: string;
  readonly accent: 'teal' | 'blue';
  readonly onPress: () => void;
};

function RouteCard({
  title,
  description,
  eyebrow,
  bullets,
  button,
  testID,
  accent,
  onPress,
}: RouteCardProps): React.JSX.Element {
  return (
    <View style={[styles.routeCard, accent === 'blue' && styles.routeCardBlue]}>
      <View style={[styles.routeMark, accent === 'blue' && styles.routeMarkBlue]} />
      <Text style={styles.eyebrow}>{eyebrow}</Text>
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
        {maxWidth: contentEnvelope(tier, desktop)},
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
        <Text style={styles.heroEyebrow}>اختر مسار العمل</Text>
        <Text style={styles.heroTitle}>مهمتان، بابان مباشران</Text>
        <Text style={styles.heroBody}>
          افتح مساحة الإعداد مباشرة وتصل بوحدة التحكم من داخلها، أو افتح أداة Firmware للتثبيت والتحديث.
        </Text>
      </View>

      <View style={desktop ? styles.routeRow : styles.routeColumn} testID="start-route-group">
      <RouteCard
        eyebrow="إعداد الدرون"
        title="إعداد وحدة التحكم"
        description="تدخل مساحة الضبط الكاملة فورًا، والاتصال بوحدة التحكم يتم من داخلها عند الحاجة."
        bullets={['Setup ومؤشرات الطيران', 'المحركات وفحوص الأمان', 'OSD والاستقبال وضبط PID']}
        button="فتح مساحة الإعداد"
        testID="start-configure"
        accent="teal"
        onPress={() => navigation.navigate('Setup')}
      />

      <RouteCard
        eyebrow="تثبيت Firmware"
        title="Firmware Flasher"
        description="تنزيل أو اختيار Firmware محلي، التحقق منه، ثم التفليش أو الحفظ حسب نوع الملف."
        bullets={['HEX عبر DFU أو STM32 serial', 'BIN عبر ESP ROM bootloader', 'UF2 مع تحقق كامل وتعليمات نسخ واضحة']}
        button="فتح Firmware Flasher"
        testID="start-firmware"
        accent="blue"
        onPress={() => navigation.navigate('FirmwareFlasher')}
      />
      </View>

      <View style={styles.safetyNote}>
        <Text style={styles.safetyTitle}>سياسة أمان ثابتة</Text>
        <Text style={styles.safetyText}>
          لن يبدأ أي مسح أو كتابة قبل التحقق من الملف والجهاز والـ Target وإقرارات السلامة.
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
  heroEyebrow: {...typography.eyebrow, color: colors.accentStrong},
  heroTitle: {...typography.display, color: colors.textPrimary},
  heroBody: {...typography.body, color: colors.textSecondary, writingDirection: 'rtl'},
  routeCard: {
    /* flexBasis 0 + flexGrow 1: equal halves inside routeRow, and inert
       inside routeColumn where the parent is not a row. */
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    position: 'relative',
    overflow: 'hidden',
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  routeCardBlue: {borderColor: colors.info},
  routeMark: {position: 'absolute', start: 0, top: 0, bottom: 0, width: 4, backgroundColor: colors.accent},
  routeMarkBlue: {backgroundColor: colors.info},
  eyebrow: {...typography.eyebrow, color: colors.textMuted},
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
    minHeight: 48,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  routeButtonBlue: {backgroundColor: colors.info},
  routeButtonHovered: {opacity: 0.9},
  routeButtonText: {...typography.sectionTitle, color: colors.accentText, flex: 1},
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
  safetyTitle: {...typography.sectionTitle, color: colors.success},
  safetyText: {...typography.body, color: colors.textSecondary, writingDirection: 'rtl'},
});
