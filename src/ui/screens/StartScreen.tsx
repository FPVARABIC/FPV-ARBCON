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
import {openSupportPage} from '../../platforms/supportLink';
import {Icon} from '../icons';
import {BrandLogo, BRAND_PRODUCT_NAME, BRAND_PRODUCT_TAGLINE} from '../brand';
import {Button} from '../components/controls';
import {readInteraction} from '../components/controls/interaction';
import {colors, contentEnvelope, isDesktopTier, noticeSurface, radii, resolveLayoutTier, spacing, typography} from '../theme';

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
  readonly accent: 'teal' | 'blue' | 'deep';
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
        accent === 'deep' && styles.routeCardDeep,
      ]}>
      <View
        style={[
          styles.routeMark,
          accent === 'blue' && styles.routeMarkBlue,
          accent === 'deep' && styles.routeMarkDeep,
        ]}
      />
      <Text style={styles.routeTitle}>{title}</Text>
      <Text style={styles.routeDescription}>{description}</Text>
      <View style={styles.bullets}>
        {bullets.map(item => (
          <View key={item} style={styles.bulletRow}>
            <View
              style={[
                styles.bulletDot,
                accent === 'blue' && styles.bulletDotBlue,
                accent === 'deep' && styles.bulletDotDeep,
              ]}
            />
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
            accent === 'deep' && styles.routeButtonDeep,
            hovered && styles.routeButtonHovered,
            pressed && styles.pressed,
          ];
        }}>
        <Text
          style={[
            styles.routeButtonText,
            accent !== 'teal' && styles.routeButtonTextOnDark,
          ]}>
          {button}
        </Text>
        <Icon
          name="chevron-forward"
          size={22}
          color={accent === 'teal' ? colors.accentText : colors.white}
        />
      </Pressable>
    </View>
  );
}

/**
 * SUPPORTING THE PROJECT IS A FOOTER, NOT A FOURTH DOOR.
 *
 * It sits below the safety line, at the very bottom of the scroll, and
 * it is built out of everything the route cards deliberately are NOT: no
 * fill, no accent rule down its edge, no card, no shadow - one hairline
 * separating it from the content above, muted type, and the shared
 * `secondary` button rather than the accent one the three real actions
 * carry. That ranking is the whole design. A reader scanning the page
 * sees three things to do and then, quietly, a way to help; nothing here
 * competes with a door, and nothing appears over the top of anything.
 *
 * WHAT IT IS NOT ALLOWED TO BECOME. It is not a modal, an interstitial,
 * a toast or a banner - it cannot appear unless the operator has already
 * scrolled past everything the app is actually for. It never repeats on
 * another screen. It carries no counter, no goal bar and no "X people
 * supported" line, because the app knows none of those things and would
 * be inventing them. And it gates nothing: no feature in this product
 * reads whether anyone gave, and supportUrl.ts is imported by this
 * screen and nowhere else.
 *
 * NO PAYMENT DETAILS LIVE IN THIS APPLICATION. There is no card field,
 * no account number, no IBAN and no name anywhere in this section. The
 * button hands one HTTPS address to the system browser and stops; the
 * caption under it says so and names the host, so the destination is
 * legible before the tap rather than a surprise after it.
 */
function SupportProjectSection(): React.JSX.Element {
  return (
    <View style={styles.support} testID="start-support">
      {/* The product's own name, read from the brand module rather than
          typed again here - Home already shows it in the chrome, and two
          spellings of one product a few hundred pixels apart is the kind
          of drift a literal invites. */}
      <Text style={styles.supportTitle}>
        {`ساهم في تطوير ${BRAND_PRODUCT_NAME}`}
      </Text>
      <Text style={styles.supportBody}>
        إذا أفادك التطبيق، يمكنك دعم استمرار تطويره وتحسينه. دعمك اختياري
        ويساعدنا على إضافة ميزات جديدة وتحسين التجربة للجميع.
      </Text>
      {/* The shared Button, `secondary`, `sm`: narrower than a door but
          the same 44pt touch floor.

          THE CUP IS THE ICON SYSTEM'S, NOT THE ☕ CHARACTER. This is not
          a style preference. U+2615 falls outside every `unicode-range`
          the three Cairo @font-face rules declare (src/web/cairo.css:
          Latin U+0000-00FF and U+2000-206F, Latin-ext, Arabic), so the
          browser would never render it in the product's typeface at all
          - it drops to whatever emoji font the device happens to carry,
          at that font's metrics and its own fixed colour. Measured in
          Chromium against this build: the cup takes a 16.6px advance
          where Cairo's own "A" takes 8.9px, i.e. a different font. The
          glyph registry bans emoji for exactly this reason, and Lucide's
          `coffee` draws in the app's stroke weight and text colour. */}
      <Button
        label="ادعم المشروع"
        icon="coffee"
        variant="secondary"
        size="sm"
        onPress={openSupportPage}
        testID="start-support-kofi"
        accessibilityHint="يفتح صفحة الدعم على Ko-fi في المتصفح خارج التطبيق"
      />
      <Text style={styles.supportFootnote}>
        يفتح ko-fi.com في المتصفح خارج التطبيق. لا يطلب التطبيق أي بيانات دفع،
        وكل الميزات تبقى متاحة بدونه.
      </Text>
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
      {/* WEB CARRIES ITS IDENTITY IN THE PERSISTENT CHROME (BrandTopChrome,
          above every route), so repeating emblem and name here would stack
          the same identity twice within a hundred pixels. On Android there
          is no chrome strip, so this row IS the identity. */}
      {SHOW_START_LOGO ? (
        <View style={styles.brandRow}>
          {/* First child of an RTL row = the RIGHT edge. */}
          <BrandLogo height={72} testID="start-brand-logo" />
          <View style={styles.brandCopy}>
            <Text style={styles.brandName}>{BRAND_PRODUCT_NAME}</Text>
            <Text style={styles.brandTagline}>{BRAND_PRODUCT_TAGLINE}</Text>
          </View>
        </View>
      ) : null}

      <View style={styles.hero}>
        <Text style={styles.heroTitle}>اختر ما تريد تنفيذه</Text>
      </View>

      <View style={desktop ? styles.routeRow : styles.routeColumn} testID="start-route-group">
      {/* Reading order in an RTL row runs right to left, so the first
          child is the RIGHTMOST card. The guide leads because it is the
          only door that answers "what should I even set?" - the other two
          assume you already know. */}
      <RouteCard
        title="دليل أنماط الطيران"
        description="خمسة أنماط، كل واحد بخطواته وقيمه وصوره."
        bullets={[
          'سينمائي · حر · سباق',
          'وووب داخلي · مدى طويل',
          'أرقام رسمية بمصادرها',
        ]}
        button="فتح دليل أنماط الطيران"
        testID="start-flight-style-guide"
        accent="deep"
        sideBySide={desktop}
        onPress={() => navigation.navigate('FlightStyleGuide')}
      />

      <RouteCard
        title="تحديث Firmware"
        description="تثبيت أو تحديث Firmware واختيار Target وإعدادات البناء."
        bullets={['اختيار اللوحة والإصدار', 'إعدادات البناء الرسمية', 'تفليش عبر DFU مع تحقق كامل']}
        button="فتح تحديث Firmware"
        testID="start-firmware"
        accent="blue"
        sideBySide={desktop}
        onPress={() => navigation.navigate('FirmwareFlasher')}
      />

      <RouteCard
        title="إعداد الدرون"
        description="الاتصال باللوحة وضبط إعداداتها."
        bullets={[
          'الاتصال باللوحة',
          'Motors و Receiver و OSD',
          'GPS و Sensors و CLI',
        ]}
        button="فتح إعداد الدرون"
        testID="start-configure"
        accent="teal"
        sideBySide={desktop}
        onPress={() => navigation.navigate('Setup')}
      />
      </View>

      <View style={styles.safetyNote}>
        <Text style={styles.safetyText}>
          لن يبدأ أي مسح أو كتابة قبل التحقق من الملف واللوحة و Target.
        </Text>
      </View>

      {/* Last on the page, after the doors and after the safety line -
          so it is reachable but never in the way of either. */}
      <SupportProjectSection />
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
  /* THE GREEN DOT AND "جاهز" ARE GONE. They sat here as though they were
     connection state, and they were not: both were hardcoded literals with
     no prop, no state and nothing behind them, so the app reported itself
     "ready" on a machine with no board attached and would have gone on
     saying it while a connection failed. A status indicator that cannot be
     anything but green is decoration wearing the costume of telemetry -
     worse than absent, because it invites the operator to trust it. Real
     connection state is shown where it is genuinely known: the Setup
     surface, driven by the session. */
  brandName: {
    ...typography.title,
    color: colors.textPrimary,
    letterSpacing: 0.4,
    writingDirection: 'ltr',
  },
  brandTagline: {...typography.caption, color: colors.textSecondary},
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
  routeCardDeep: {borderColor: colors.accentStrong},
  routeMark: {position: 'absolute', start: 0, top: 0, bottom: 0, width: 4, backgroundColor: colors.accent},
  routeMarkBlue: {backgroundColor: colors.info},
  routeMarkDeep: {backgroundColor: colors.accentStrong},
  routeTitle: {...typography.title, color: colors.textPrimary},
  routeDescription: {...typography.body, color: colors.textSecondary, writingDirection: 'rtl'},
  bullets: {gap: 7, paddingVertical: spacing.sm},
  bulletRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  bulletDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent},
  bulletDotBlue: {backgroundColor: colors.info},
  bulletDotDeep: {backgroundColor: colors.accentStrong},
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
  routeButtonDeep: {backgroundColor: colors.accentStrong},
  routeButtonHovered: {opacity: 0.9},
  routeButtonText: {...typography.sectionTitle, color: colors.accentText},
  routeButtonTextOnDark: {color: colors.white},
  pressed: {opacity: 0.75},
  safetyNote: {...noticeSurface, backgroundColor: colors.successSoft,
    borderColor: colors.success,
    gap: 3},
  safetyText: {...typography.body, color: colors.textSecondary, writingDirection: 'rtl'},
  /* A HAIRLINE, NOT A CARD. Every surface on this screen that carries a
     border, a fill or a radius is something to press; the support footer
     is not, so it takes none of them. One rule at the top marks it as a
     different kind of content, and the rest is spacing. */
  support: {
    marginTop: spacing.sm,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    gap: spacing.sm,
    /* NO `alignItems: 'flex-start'` here, deliberately. It would be
       redundant for the button - Button already defaults to
       `alignSelf: 'flex-start'` and sizes itself to its label - and
       actively wrong for the two paragraphs, which would shrink-wrap to
       their longest line and make their `textAlign: 'right'` inert. The
       text stretches to the column and aligns inside it; the button
       stays the width of its own label. */
  },
  /* sectionTitle, deliberately a step below the route cards' `title`:
     this heading must never out-rank a door. */
  supportTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    /* Ends with the product's Latin name. Without an explicit direction
       the paragraph would take its own from the first strong character
       and could lay the Arabic out left-to-right - the same defect the
       route bullets carry this line for. */
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  supportBody: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  /* The smallest type on the screen, and still 12px - the floor the
     rest of the product holds to. It opens with a bare host name, so it
     needs the same explicit direction the title does. */
  supportFootnote: {
    ...typography.helper,
    color: colors.textMuted,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
});
