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
import {
  colors,
  contentEnvelope,
  isDesktopTier,
  radii,
  resolveLayoutTier,
  spacing,
  typography,
} from '../theme';

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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={button}
        testID={testID}
        onPress={onPress}
        style={({pressed}) => [
          styles.routeButton,
          accent === 'blue' && styles.routeButtonBlue,
          pressed && styles.pressed,
        ]}>
        <Text
          style={[
            styles.routeButtonText,
            accent === 'blue' && styles.routeButtonTextBlue,
          ]}>
          {button}
        </Text>
        <Text style={styles.arrow}>‹</Text>
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
        <View style={styles.brandBadge}>
          <View style={styles.brandCore} />
          <View style={[styles.brandArm, styles.brandArmOne]} />
          <View style={[styles.brandArm, styles.brandArmTwo]} />
        </View>
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
        <Text style={styles.heroTitle}>ابدأ بأمان، ثم نفّذ المهمة مباشرة</Text>
        <Text style={styles.heroBody}>
          يمكنك الاتصال بوحدة التحكم لإدارة الإعدادات، أو فتح أداة Firmware Flasher المستقلة حتى لو لم يتصل التطبيق بعد.
        </Text>
      </View>

      <View style={desktop ? styles.routeRow : styles.routeColumn} testID="start-route-group">
      <RouteCard
        eyebrow="المسار الأول"
        title="الاتصال بوحدة التحكم"
        description="اكتشاف USB، التحقق من توافق MSP، ثم الدخول إلى مساحة الضبط الكاملة."
        bullets={['Setup ومؤشرات الطيران', 'المحركات وفحوص الأمان', 'Ports والاستقبال وPID']}
        button="اكتشاف Flight Controller"
        testID="start-connection"
        accent="teal"
        onPress={() => navigation.navigate('Connection')}
      />

      <RouteCard
        eyebrow="المسار الثاني"
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
    maxWidth: 1180,
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  brandBadge: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  brandCore: {width: 15, height: 15, borderRadius: 4, backgroundColor: colors.accent, zIndex: 2},
  brandArm: {position: 'absolute', width: 36, height: 3, borderRadius: 3, backgroundColor: colors.accent},
  brandArmOne: {transform: [{rotate: '45deg'}]},
  brandArmTwo: {transform: [{rotate: '-45deg'}]},
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
  offlineText: {...typography.caption, color: colors.textSecondary, fontWeight: '700'},
  hero: {paddingVertical: spacing.lg, gap: spacing.sm},
  /* Peers, laid out in the product's RTL reading order: index 0 (connect)
     is the RIGHTMOST card, matching src/navigation/tabs.ts's convention.
     `alignItems: 'stretch'` keeps both cards the same height so the two
     call-to-action buttons sit on one line. */
  routeRow: {flexDirection: 'row-reverse', alignItems: 'stretch', gap: spacing.lg},
  routeColumn: {gap: spacing.lg},
  heroEyebrow: {...typography.eyebrow, color: colors.accentStrong},
  heroTitle: {...typography.display, color: colors.textPrimary},
  heroBody: {...typography.body, color: colors.textSecondary},
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
  routeCardBlue: {borderColor: '#B8D7E3'},
  routeMark: {position: 'absolute', right: 0, top: 0, bottom: 0, width: 4, backgroundColor: colors.accent},
  routeMarkBlue: {backgroundColor: colors.info},
  eyebrow: {...typography.eyebrow, color: colors.textMuted},
  routeTitle: {...typography.title, color: colors.textPrimary},
  routeDescription: {...typography.body, color: colors.textSecondary},
  bullets: {gap: 7, paddingVertical: spacing.sm},
  bulletRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  bulletDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent},
  bulletDotBlue: {backgroundColor: colors.info},
  bulletText: {...typography.caption, color: colors.textSecondary, flex: 1},
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
  routeButtonText: {...typography.sectionTitle, color: colors.accentText},
  routeButtonTextBlue: {color: colors.white},
  arrow: {fontSize: 28, color: colors.accentText, lineHeight: 30},
  pressed: {opacity: 0.75},
  safetyNote: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: '#E8F7F2',
    borderWidth: 1,
    borderColor: '#B8DED5',
    gap: 3,
  },
  safetyTitle: {...typography.sectionTitle, color: colors.success},
  safetyText: {...typography.caption, color: colors.textSecondary},
});
