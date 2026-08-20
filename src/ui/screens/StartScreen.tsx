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
import type {IconName} from '../icons';
import {BrandLogo, BRAND_PRODUCT_NAME, BRAND_PRODUCT_TAGLINE} from '../brand';
import {Button} from '../components/controls';
import {readInteraction} from '../components/controls/interaction';
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

/**
 * HOME, AS BANDS RATHER THAN ONE CENTRED COLUMN.
 *
 * THE COMPLAINT THIS ANSWERS. On a 1920px window the whole page was a
 * 1164px card sitting in the middle with 378px of dead background on
 * either side - measured, not felt. It read as a settings dialog that
 * had been opened full-screen, not as a product's front page.
 *
 * THE FIX IS NOT A BIGGER `maxWidth`, and deliberately so: widening one
 * column would only stretch the paragraphs. Instead the page is now a
 * stack of FULL-BLEED BANDS, each with its own ground, and each capping
 * its INNER content at the width that content deserves:
 *
 *   identity + primary actions   the WORKSPACE envelope (1600)
 *   safety line, guide, support  the READING envelope   (1180)
 *
 * Both come from the design system's own helper, asked once per band:
 * `contentEnvelope(tier, splitsIntoColumns)`. No cap is written here as
 * a literal, and the helper's rule is followed rather than bent - the
 * wider envelope is granted only where the layout GENUINELY splits into
 * columns, which for this screen means the two primary cards side by
 * side from the desktop tier up. The identity lockup shares that rail so
 * the emblem's edge lines up with the cards' edge instead of floating on
 * a different margin; nothing in it is a paragraph, so no line gets
 * longer.
 *
 * Below the desktop tier the helper returns the reading envelope for
 * every band and the bands are simply the screen width, which is what a
 * phone wants.
 *
 * THE ORDER IS THE HIERARCHY, and it changed. It used to be three peer
 * cards with the flight-style guide first. The guide is reference
 * material; the two things an operator opens this application to DO are
 * configuring a board and flashing firmware. So:
 *
 *   1  identity
 *   2  the two primary actions, and the safety line that governs them
 *   3  the guide, its own band, visibly a companion rather than a peer
 *   4  support, last and quietest
 *
 * Nothing about where a button GOES changed - only what it looks like
 * and where it sits on the page.
 */

/**
 * THE OFFICIAL LOGO ON START - Android only. The document is RTL, so the
 * brand row's FIRST child sits at the RIGHT edge: exactly the top-right
 * placement the brand calls for. On web the logo lives in the persistent
 * top chrome instead (BrandTopChrome, rendered by App.web.tsx above every
 * route), and repeating it here would stack two identical marks within a
 * hundred pixels - so the web Start band carries the page's own title
 * only, and the chrome owns the identity.
 */
const SHOW_START_LOGO = Platform.OS !== 'web';

/**
 * Emblem height in the Android home lockup. Raised from 72 at the
 * owner's request - the web chrome's emblem moved by the same ratio
 * (BrandTopChrome: 56 -> 68) so the two platforms keep one identity.
 */
const HOME_LOGO_HEIGHT = 86;

type Props = NativeStackScreenProps<RootStackParamList, 'Start'>;

/* ------------------------------------------------------------- bands */

type BandTone = 'page' | 'raised' | 'surface';

type BandProps = {
  readonly tone: BandTone;
  /** Inner cap, from contentEnvelope(). Inert below the desktop tier. */
  readonly cap: number;
  readonly testID?: string;
  readonly children: React.ReactNode;
};

/**
 * A full-width strip whose GROUND reaches both screen edges while its
 * CONTENT stays inside a readable rail. This is what stops the page
 * looking like an island: the colour goes to the edge even though the
 * words do not.
 */
function Band({tone, cap, testID, children}: BandProps): React.JSX.Element {
  return (
    <View
      style={[
        styles.band,
        tone === 'raised' && styles.bandRaised,
        tone === 'surface' && styles.bandSurface,
      ]}
      testID={testID}>
      <View style={[styles.bandInner, {maxWidth: cap}]}>{children}</View>
    </View>
  );
}

/* --------------------------------------------------- primary actions */

type PrimaryCardProps = {
  readonly title: string;
  readonly description: string;
  readonly bullets: readonly string[];
  readonly button: string;
  readonly testID: string;
  readonly icon: IconName;
  readonly accent: 'teal' | 'blue';
  /** True only where the two cards share a row - see primaryCardShare. */
  readonly sideBySide: boolean;
  readonly onPress: () => void;
};

function PrimaryCard({
  title,
  description,
  bullets,
  button,
  testID,
  icon,
  accent,
  sideBySide,
  onPress,
}: PrimaryCardProps): React.JSX.Element {
  const blue = accent === 'blue';
  return (
    <View
      style={[
        styles.primaryCard,
        sideBySide && styles.primaryCardShare,
        blue && styles.primaryCardBlue,
      ]}>
      <View style={[styles.primaryMark, blue && styles.primaryMarkBlue]} />
      <View style={styles.primaryHeading}>
        <View style={[styles.iconBadge, blue && styles.iconBadgeBlue]}>
          <Icon
            name={icon}
            size={26}
            color={blue ? colors.info : colors.accentStrong}
          />
        </View>
        <Text style={styles.primaryTitle}>{title}</Text>
      </View>
      <Text style={styles.primaryDescription}>{description}</Text>
      <View style={styles.bullets}>
        {bullets.map(item => (
          <View key={item} style={styles.bulletRow}>
            <View style={[styles.bulletDot, blue && styles.bulletDotBlue]} />
            <Text style={styles.bulletText}>{item}</Text>
          </View>
        ))}
      </View>
      {/* NOT the shared <Button>: this is a hero call to action, where
          the directional affordance must sit at the FAR END of the bar
          (space-between). Button centres a LEADING icon, which would put
          the chevron at the start and point it away from the direction
          of travel. Everything else - fill, radius, height, label weight,
          states - comes from the same tokens Button uses. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={button}
        testID={testID}
        onPress={onPress}
        style={state => {
          const {pressed, hovered} = readInteraction(state);
          return [
            styles.actionButton,
            blue && styles.actionButtonBlue,
            hovered && styles.actionButtonHovered,
            pressed && styles.pressed,
          ];
        }}>
        <Text style={[styles.actionButtonText, blue && styles.actionButtonTextOnDark]}>
          {button}
        </Text>
        <Icon
          name="chevron-forward"
          size={22}
          color={blue ? colors.white : colors.accentText}
        />
      </Pressable>
    </View>
  );
}

/* ------------------------------------------------------ guide corner */

/**
 * THE GUIDE IS A COMPANION, NOT A THIRD DOOR, and every difference from
 * the cards above says so: no fill of its own beyond the band, a
 * section-title heading rather than a card title, its styles listed on
 * one line instead of bulleted, and an outlined call to action instead
 * of an accent-filled one. It still opens the same index it always did.
 */
function GuideSection({
  desktop,
  cap,
  onPress,
}: {
  readonly desktop: boolean;
  readonly cap: number;
  readonly onPress: () => void;
}): React.JSX.Element {
  return (
    <Band tone="surface" cap={cap} testID="start-guide-section">
      <Text style={styles.eyebrow}>قبل الضبط</Text>
      <View style={desktop ? styles.guideRow : styles.guideColumn}>
        <View style={styles.guideCopy}>
          <View style={styles.guideHeading}>
            <Icon name="compass" size={22} color={colors.accentStrong} />
            <Text style={styles.guideTitle}>دليل أنماط الطيران</Text>
          </View>
          <Text style={styles.guideDescription}>
            خمسة أنماط، كل واحد بخطواته وقيمه وصوره.
          </Text>
          <Text style={styles.guideMeta}>
            سينمائي · حر · سباق · وووب داخلي · مدى طويل
          </Text>
          <Text style={styles.guideMeta}>أرقام رسمية بمصادرها</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="فتح دليل أنماط الطيران"
          testID="start-flight-style-guide"
          onPress={onPress}
          style={state => {
            const {pressed, hovered} = readInteraction(state);
            return [
              styles.actionButton,
              styles.actionButtonQuiet,
              hovered && styles.actionButtonQuietHovered,
              pressed && styles.pressed,
            ];
          }}>
          <Text style={styles.actionButtonQuietText}>فتح دليل أنماط الطيران</Text>
          <Icon name="chevron-forward" size={22} color={colors.accentStrong} />
        </Pressable>
      </View>
    </Band>
  );
}

/* ---------------------------------------------------- support footer */

/**
 * SUPPORTING THE PROJECT IS A FOOTER, NOT A FOURTH DOOR.
 *
 * It sits last, after the primary actions, the safety line and the
 * guide, and it is built out of everything the action cards are NOT: no
 * accent rule down its edge, no shadow, a smaller radius, a plain
 * neutral border where each card takes its own accent colour, muted
 * type, and the shared `secondary` button rather than the accent one the
 * real actions carry. A reader sees what to do, then how to learn, and
 * only then - quietly - a way to help.
 *
 * WHAT IT IS NOT ALLOWED TO BECOME. Not a modal, an interstitial, a
 * toast or a banner: it cannot appear until the operator has scrolled
 * past everything the app is actually for. It never repeats on another
 * screen. It carries no counter and no goal bar, because the app knows
 * no such numbers and would be inventing them. And it gates nothing: no
 * feature reads whether anyone gave, and supportUrl.ts is imported by
 * this screen and nowhere else.
 *
 * NO PAYMENT DETAILS LIVE IN THIS APPLICATION. No card field, no account
 * number, no IBAN, no name. The button hands one HTTPS address to the
 * system browser and stops; the caption says so and names the host, so
 * the destination is legible before the tap rather than after it.
 *
 * THE PANEL TONE WAS MEASURED, NOT PICKED BY EYE. Five palette tokens
 * were painted into it in Chromium and sampled back out of the captures,
 * against the page (#FAF8F3) and the safety note above it (successSoft
 * #E8F8F1):
 *
 *   backgroundRaised #F3F0E8   page d15   note d16   <- chosen
 *   surfaceAlt       #F2F0EA   page d14   note d15
 *   infoSoft         #E3F1F8   page d25   note d11
 *   accentSoft       #DDF8F3   page d29   note d11
 *   surfaceRaised    #E9F7F4   page d17   note d3
 *
 * surfaceRaised is disqualified outright: three points from the safety
 * note is a twin, and the footer would read as a second warning.
 * accentSoft is the most visible and still wrong - it is this app's
 * SELECTED state everywhere else (active rail item, chosen chip, picked
 * device row), and a panel that is never selected must not wear it.
 * infoSoft is the firmware door's blue. surfaceAlt is the DISABLED
 * surface. backgroundRaised is the one token that already means "a
 * container, one step up from the page, claiming nothing" - the chip
 * track, the stepper track, the device-list ground - and it is d30 from
 * the white cards, which is the contrast that matters for "not white".
 */
function SupportProjectSection(): React.JSX.Element {
  return (
    <View style={styles.support} testID="start-support">
      {/* The product's own name, read from the brand module rather than
          typed again here - Home already shows it in the identity band,
          and two spellings of one product on one page is the kind of
          drift a literal invites. */}
      <Text style={styles.supportTitle}>
        {`ساهم في تطوير ${BRAND_PRODUCT_NAME}`}
      </Text>
      <Text style={styles.supportBody}>
        إذا أفادك التطبيق، يمكنك دعم استمرار تطويره وتحسينه. دعمك اختياري
        ويساعدنا على إضافة ميزات جديدة وتحسين التجربة للجميع.
      </Text>
      {/* The shared Button, `secondary`, `sm`: narrower than an action
          card's bar but the same 44pt touch floor.

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

/* -------------------------------------------------------- the screen */

export default function StartScreen({navigation}: Props): React.JSX.Element {
  const {width, fontScale} = useWindowDimensions();
  const tier = resolveLayoutTier(width, fontScale);
  // The two primary cards are peers - one configures, one flashes - and
  // from the desktop tier up they genuinely sit side by side. That, and
  // only that, is what earns the wider workspace envelope.
  const desktop = isDesktopTier(tier);
  // Asked once per KIND of band rather than once per screen: the two
  // primary cards genuinely split into columns and earn the workspace
  // envelope, while a sentence, a guide strip and a footer are reading
  // content and keep the reading one.
  const columnsCap = contentEnvelope(tier, true);
  const readingCap = contentEnvelope(tier, false);

  return (
    <ScrollView
      testID="start-screen"
      style={styles.root}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled">
      {/* ---------------------------------------------- 1. identity */}
      <Band tone="raised" cap={columnsCap} testID="start-identity">
        {/* WEB CARRIES ITS IDENTITY IN THE PERSISTENT CHROME
            (BrandTopChrome, above every route), so repeating emblem and
            name here would stack the same identity twice within a
            hundred pixels. On Android there is no chrome strip, so this
            lockup IS the identity. */}
        {SHOW_START_LOGO ? (
          <View style={styles.brandRow}>
            {/* First child of an RTL row = the RIGHT edge. */}
            <BrandLogo height={HOME_LOGO_HEIGHT} testID="start-brand-logo" />
            {/* A hairline of accent between mark and word: the lockup
                reads as one designed object rather than an image that
                happens to have text beside it. */}
            <View style={styles.brandRule} />
            <View style={styles.brandCopy}>
              <Text style={styles.brandName}>{BRAND_PRODUCT_NAME}</Text>
              <Text style={styles.brandTagline}>{BRAND_PRODUCT_TAGLINE}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.hero}>
          <Text style={styles.heroTitle}>اختر ما تريد تنفيذه</Text>
        </View>
      </Band>

      {/* --------------------------------------- 2. primary actions */}
      <Band tone="page" cap={columnsCap}>
        <View
          style={desktop ? styles.actionRow : styles.actionColumn}
          testID="start-route-group">
          {/* Reading order in an RTL row runs right to left, so the first
              child is the RIGHTMOST card. Configuring the board leads,
              because it is what most sessions are for; flashing is the
              step before it, but only occasionally. */}
          <PrimaryCard
            title="إعداد الدرون"
            description="الاتصال باللوحة وضبط إعداداتها."
            bullets={[
              'الاتصال باللوحة',
              'Motors و Receiver و OSD',
              'GPS و Sensors و CLI',
            ]}
            button="فتح إعداد الدرون"
            testID="start-configure"
            icon="sliders-horizontal"
            accent="teal"
            sideBySide={desktop}
            /* 'Connect', not 'Setup': the configuration workspace is not
   registered in the navigator until a flight controller is
   verified, so this door opens the connection workspace and
   App.tsx moves the operator on once the wall comes down. */
            onPress={() => navigation.navigate('Connect')}
          />

          <PrimaryCard
            title="تحديث Firmware"
            description="تثبيت أو تحديث Firmware واختيار Target وإعدادات البناء."
            bullets={[
              'اختيار اللوحة والإصدار',
              'إعدادات البناء الرسمية',
              'تفليش عبر DFU مع تحقق كامل',
            ]}
            button="فتح تحديث Firmware"
            testID="start-firmware"
            icon="cpu"
            accent="blue"
            sideBySide={desktop}
            onPress={() => navigation.navigate('FirmwareFlasher')}
          />
        </View>

        {/* The safety line governs the two cards above it, so it stays
            in their band - and keeps the reading cap, because it is a
            sentence rather than a column. */}
        <View style={[styles.safetyWrap, {maxWidth: readingCap}]}>
          <View style={styles.safetyNote}>
            <Text style={styles.safetyText}>
              لن يبدأ أي مسح أو كتابة قبل التحقق من الملف واللوحة و Target.
            </Text>
          </View>
        </View>
      </Band>

      {/* ------------------------------------------------- 3. guide */}
      <GuideSection
        desktop={desktop}
        cap={readingCap}
        onPress={() => navigation.navigate('FlightStyleGuide')}
      />

      {/* ----------------------------------------------- 4. support */}
      <Band tone="page" cap={readingCap}>
        <SupportProjectSection />
      </Band>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  /* NO padding and NO cap here, deliberately. Both moved into the bands
     so a band's ground can reach the screen edge while its words stay
     inside a rail. Capping the scroll container instead is exactly what
     made the page an island. */
  page: {width: '100%', paddingBottom: spacing.xxl},
  band: {width: '100%', alignItems: 'center'},
  bandRaised: {
    backgroundColor: colors.backgroundRaised,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bandSurface: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderTopColor: colors.borderSoft,
    borderBottomColor: colors.borderSoft,
  },
  bandInner: {
    width: '100%',
    // maxWidth is applied inline, per band.
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.lg,
  },

  /* ------------------------------------------------------- identity */
  /* The old hand-drawn placeholder badge is GONE - the official logo
     asset renders in its place on Android, and the web top chrome
     carries it persistently there. */
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  brandRule: {
    width: 3,
    alignSelf: 'stretch',
    marginVertical: spacing.xs,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  /* NOT `flex: 1` - see BrandTopChrome for the defect that caused: given
     the whole rail, the block stretches and the Latin name drifts to the
     far edge, away from the emblem it is locked up with. */
  brandCopy: {flexShrink: 1, gap: 2},
  /* THE GREEN DOT AND "جاهز" ARE GONE. They sat here as though they were
     connection state, and they were not: both were hardcoded literals
     with no prop, no state and nothing behind them, so the app reported
     itself "ready" on a machine with no board attached and would have
     gone on saying it while a connection failed. A status indicator that
     cannot be anything but green is decoration wearing the costume of
     telemetry - worse than absent, because it invites the operator to
     trust it. Real connection state is shown where it is genuinely
     known: the Setup surface, driven by the session. */
  brandName: {
    ...typography.display,
    color: colors.textPrimary,
    letterSpacing: 0.6,
    // A Latin proper noun inside an RTL document: without this it
    // inherits the paragraph direction and the words reorder.
    // `textAlign` then puts it on the same edge as the Arabic line
    // beneath it.
    writingDirection: 'ltr',
    textAlign: 'right',
  },
  brandTagline: {
    ...typography.body,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  hero: {gap: spacing.sm},
  heroTitle: {...typography.display, color: colors.textPrimary},

  /* ------------------------------------------------ primary actions */
  /* Peers, laid out in the product's RTL reading order: index 0 is the
     RIGHTMOST card. `alignItems: 'stretch'` keeps both the same height
     so the two calls to action sit on one line.

     PLAIN 'row', NOT 'row-reverse'. Measured in a browser: the document
     carries dir="rtl", so a plain row ALREADY runs right-to-left and
     puts index 0 on the right. 'row-reverse' flipped it back and put the
     first card on the LEFT - the opposite of what is intended. (This was
     invisible for as long as it went unmeasured, because
     react-native-web's I18nManager reports LTR while the document lays
     out RTL.) */
  actionRow: {flexDirection: 'row', alignItems: 'stretch', gap: spacing.lg},
  actionColumn: {gap: spacing.lg},
  primaryCard: {
    position: 'relative',
    overflow: 'hidden',
    padding: spacing.xl,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.accentStrong,
    gap: spacing.sm,
  },
  /* EQUAL HALVES OF A ROW - and ONLY of a row.
     `flexBasis: 0` sizes the MAIN axis. In actionRow the main axis is
     horizontal, so this is the intended "two equal columns". These
     properties must NOT live on primaryCard itself: in a COLUMN the main
     axis is vertical, so flexBasis 0 would give every stacked card a
     hypothetical HEIGHT of zero and `overflow: hidden` would then cut the
     card off mid-title. Measured in Chromium against a deployed bundle
     when that was the case: at 360/390/412/768 the cards rendered ~50px
     tall with their titles sliced in half; at >=1024 they were correct,
     which is why a numeric width check never saw it. */
  primaryCardShare: {flexGrow: 1, flexShrink: 1, flexBasis: 0},
  primaryCardBlue: {borderColor: colors.info},
  primaryMark: {
    position: 'absolute',
    start: 0,
    top: 0,
    bottom: 0,
    width: 5,
    backgroundColor: colors.accent,
  },
  primaryMarkBlue: {backgroundColor: colors.info},
  /* A tinted square behind the icon. No border and no `overflow:
     hidden`, so it can never be mistaken for a card by the structural
     tests that identify cards by exactly that pair. */
  /* Beside the title, not stacked above it. Stacked, the badge added
     ~70px of vertical air to a card whose text is three words wide, and
     the card read as mostly empty. */
  primaryHeading: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  iconBadge: {
    width: 52,
    height: 52,
    borderRadius: radii.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadgeBlue: {backgroundColor: colors.infoSoft},
  primaryTitle: {...typography.title, color: colors.textPrimary},
  primaryDescription: {
    ...typography.body,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  bullets: {gap: 7, paddingVertical: spacing.sm},
  bulletRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  bulletDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent},
  bulletDotBlue: {backgroundColor: colors.info},
  bulletText: {
    ...typography.body,
    color: colors.textSecondary,
    flex: 1,
    /* LOAD-BEARING. Several bullets start with a Latin technical token
       ("Motors", "GPS", "DFU"), and without an explicit direction the
       paragraph inherits ITS direction - so an Arabic sentence was laid
       out left-to-right and the words came out in the wrong order.
       Measured in a real browser, not theorised. */
    writingDirection: 'rtl',
    textAlign: 'right',
  },

  /* --------------------------------------------- calls to action */
  actionButton: {
    // Sized to its label, not stretched across the card. A full-width
    // bar on a wide desktop card read as a banner rather than a button,
    // and two of them competed with each other instead of reading as two
    // choices.
    alignSelf: 'flex-start',
    minHeight: 48,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  actionButtonBlue: {backgroundColor: colors.info},
  actionButtonHovered: {opacity: 0.9},
  actionButtonText: {...typography.sectionTitle, color: colors.accentText},
  actionButtonTextOnDark: {color: colors.white},
  /* The guide's outlined variant: same geometry and the same 48pt bar,
     no fill. Rank is carried by weight, not by size, so the control is
     never harder to hit for being secondary. */
  actionButtonQuiet: {
    backgroundColor: colors.surface,
    borderColor: colors.accentStrong,
  },
  actionButtonQuietHovered: {backgroundColor: colors.surfaceHover},
  actionButtonQuietText: {
    ...typography.sectionTitle,
    color: colors.accentStrong,
  },
  pressed: {opacity: 0.75},

  /* ---------------------------------------------------- safety line */
  /* maxWidth comes from contentEnvelope() inline - the safety line is a
     sentence, so it keeps the reading envelope even inside the wider
     band its cards live in. */
  safetyWrap: {width: '100%'},
  safetyNote: {
    ...noticeSurface,
    backgroundColor: colors.successSoft,
    borderColor: colors.success,
    gap: 3,
  },
  safetyText: {
    ...typography.body,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },

  /* ---------------------------------------------------------- guide */
  eyebrow: {
    ...typography.eyebrow,
    color: colors.textMuted,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  /* NO `justifyContent: 'space-between'`. With it, the call to action
     was flung to the opposite end of a 1148px band and read as
     unrelated to the text it belongs to. Packed to the start with a
     generous gap, the pair reads as one object and the remaining space
     is deliberate air rather than a gulf. */
  guideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxl,
  },
  guideColumn: {gap: spacing.md},
  guideCopy: {flexShrink: 1, gap: spacing.xs},
  guideHeading: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  /* sectionTitle, one step below the action cards' `title`: this heading
     must never out-rank a primary action. */
  guideTitle: {...typography.sectionTitle, color: colors.textPrimary},
  guideDescription: {
    ...typography.body,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  guideMeta: {
    ...typography.caption,
    color: colors.textMuted,
    writingDirection: 'rtl',
    textAlign: 'right',
  },

  /* -------------------------------------------------------- support */
  /* A TINTED PANEL, AND STILL NOT A CARD. radii.sm where the action
     cards take radii.lg, a plain neutral border where each of them takes
     its own accent colour, and no accent rule down its edge. */
  support: {
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.lg,
    gap: spacing.sm,
    /* NO `alignItems: 'flex-start'` here, deliberately. It would be
       redundant for the button - Button already defaults to
       `alignSelf: 'flex-start'` and sizes itself to its label - and
       actively wrong for the two paragraphs, which would shrink-wrap to
       their longest line and make their `textAlign: 'right'` inert. */
  },
  supportTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    /* Ends with the product's Latin name. Without an explicit direction
       the paragraph would take its own from the first strong character
       and could lay the Arabic out left-to-right. */
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  supportBody: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  /* The smallest type on the screen, and still 12px - the floor the rest
     of the product holds to. It opens with a bare host name, so it needs
     the same explicit direction the title does. */
  supportFootnote: {
    ...typography.helper,
    color: colors.textMuted,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
});
