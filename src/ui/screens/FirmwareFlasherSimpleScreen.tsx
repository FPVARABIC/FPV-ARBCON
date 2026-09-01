/**
 * THE STANDARD FIRMWARE FLASHER - Betaflight capability, Arabic clarity.
 *
 * WHAT THIS SCREEN IS FOR. An Arabic-speaking operator should be able to
 * pick their board, pick a stable version, review the official build
 * configuration, and flash - in that order, without reading a wall of
 * warnings and without dropping into the full engineering surface. It is
 * the DEFAULT flasher route; the complete legacy screen is one press away
 * behind «متقدم» for recovery and specialist work.
 *
 * SIMPLER IS NOT SMALLER. A first pass reduced this flow to
 * target -> download -> flash and silently applied the API's default
 * build options. That removed real capability: radio, telemetry, OSD and
 * motor protocol, the release's other options and custom defines all
 * became unreachable without the legacy screen. They are back here, as
 * DATA rendered from GET /api/options/{release} (see
 * core/firmware-flasher/standardBuildConfiguration.ts) with the official
 * defaults pre-selected - so a beginner can still press through, and an
 * intermediate operator can change exactly what they care about.
 *
 * NOTHING IS INVENTED. Every option, value and default comes from the
 * official Build API for the SELECTED release. A feature a release does
 * not expose does not appear. There is no hardcoded protocol list and no
 * vendor allow-list anywhere in this file: the target catalogue is
 * whatever GET /api/targets returned.
 *
 * THE FLASH ENGINE IS UNTOUCHED. Completion truth (SUCCESS / FAILED /
 * UNCONFIRMED), bounded WebUSB transfers, poisoned-session refusal, the
 * no-automatic-retry rule and read-back verification all live below this
 * screen and are only RENDERED here.
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type {RootStackParamList} from '../../navigation/types';
import {
  CloudBuildCoordinator,
  applyCustomDefaultsToFirmware,
  betaflightBuildApi,
  createBuildRequest,
  filterAndSortTargets,
  parseBuildOptions,
  parseFirmwareFile,
  parseTargetDetail,
  parseTargetReleases,
  verifySelectedDfuDevice,
} from '../../core/firmware-flasher';
import type {
  BetaflightTarget,
  FirmwareBuildOption,
  FirmwareBuildOptions,
  FirmwareImage,
  FirmwareRelease,
  FirmwareReleaseChannel,
  FirmwareTargetDetail,
  PendingBootloaderFlash,
} from '../../core/firmware-flasher';
import {
  applyRadioTelemetryRule,
  availableChannels,
  defaultReleaseForChannel,
  defaultStandardChoices,
  hasConfigurableBuild,
  releasesForChannel,
  standardBuildCategories,
  toBuildSelection,
} from '../../core/firmware-flasher/standardBuildConfiguration';
import type {
  StandardBuildCategory,
  StandardBuildChoices,
} from '../../core/firmware-flasher/standardBuildConfiguration';
import {
  boardIdentityNames,
  describeFlightControllerHardware,
  resolveCatalogTarget,
} from '../../core';
import {
  isSupportedDevice,
  usbSerialTransportClient,
} from '../../platforms/react-native/transport';
import type {
  DfuDeviceDescriptor,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';
import {useTranslation} from 'react-i18next';
/* operatorDetail() is a PURE exported function with its own suite, so it
 * cannot take a hook's `t`. The singleton is the same catalogue the hook
 * reads; importing it here keeps the coded-error sentences reachable
 * from a non-component context. */
import i18n from '../../i18n';
import {
  classifyFlashRejection,
  flashNextActionLabelKey,
  flashReasonLabelKey,
} from '../../core/firmware-flasher/flashCompletionModel';
import {toFlashPhase} from '../../core/firmware-flasher/flashPhaseModel';
import type {FlashPhase} from '../../core/firmware-flasher/flashPhaseModel';
import {
  DfuPermissionRequiredError,
  FirmwareBootloaderController,
} from '../../platforms/react-native/protocol/FirmwareBootloaderController';
import {bytesToBase64} from '../../platforms/react-native/protocol/base64';
import {getLastConnectionTrace} from '../../core/protocol/msp/identification/connectionTrace';
import {FirmwareButton, FirmwareNotice, FirmwareProgress} from '../components/firmware';
import {PROSE_MEASURE, colors, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Icon} from '../icons';

/**
 * LAZY. A static import here pulled the entire advanced screen - and
 * with it the CLI backup service, the STM32 serial flasher, the ESP
 * flasher and esptool - into the standard route's chunk, defeating the
 * code splitting the bundle scan checks for. It is only rendered behind
 * «متقدم», so it is only fetched then.
 */
const FirmwareFlasherScreen = React.lazy(() => import('./FirmwareFlasherScreen'));

type Props = Partial<NativeStackScreenProps<RootStackParamList, 'FirmwareFlasher'>> & {
  readonly client?: UsbSerialTransportClient;
};

export type SimpleFlasherPhase =
  | 'idle'
  | 'detecting'
  | 'loading'
  | 'ready'
  | 'waiting-permission'
  | 'flashing'
  | 'success'
  | 'failed'
  | 'unconfirmed'
  /** A problem that is NOT a flash verdict - see FlasherProblemCategory. */
  | 'problem';

function errorText(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  // The transport client rejects with a plain {code, nativeMessage}
  // object (normalizeNativeError strips everything else); without this
  // read every DFU failure showed only the generic line below.
  const native = (reason as {nativeMessage?: unknown} | null)?.nativeMessage;
  if (typeof native === 'string' && native.trim().length > 0) {
    return native;
  }
  return 'حدث خطأ غير متوقع أثناء العملية.';
}

/**
 * WHAT WENT WRONG, AND WHETHER IT WAS THE FLASH AT ALL.
 *
 * Everything on this screen used to funnel through one presenter, so a
 * target-catalogue download that failed at mount announced «فشل التفليش»
 * on a board that had never been touched. These categories keep the
 * destructive verdict for the destructive operation, and give every
 * other failure its own honest heading.
 */
export type FlasherProblemCategory =
  | 'CATALOGUE'
  | 'RELEASES'
  | 'BUILD'
  | 'PREPARE'
  | 'SERIAL'
  | 'DFU_ACCESS'
  | 'DFU_ENTRY';

/**
 * The Arabic operator copy for a transport failure that CARRIES A CODE.
 *
 * The transports reject with structured codes - DEVICE_ALREADY_IN_USE,
 * PERMISSION_DENIED, DEVICE_CHANGED_DURING_OPEN, CONNECT_TIMEOUT - and
 * src/i18n already holds a precise Arabic sentence for every one of
 * them. Reading the CODE is what makes each of those sentences
 * reachable; the previous implementation looked only at the message
 * TEXT, found English, and replaced all of them with one category
 * fallback.
 *
 * That mattered most for the exact failure this round fixes: a port held
 * by another tab reported "This port already has an open session", which
 * became "أعد توصيل الكابل" - advice that cannot work, on a cable that
 * was never the problem.
 */
function codedTransportDetail(reason: unknown): string | undefined {
  const code = (reason as {code?: unknown} | null)?.code;
  if (typeof code !== 'string' || code.length === 0) return undefined;
  const sentence = i18n.t(`errors.${code}`, {defaultValue: ''});
  return typeof sentence === 'string' && sentence.length > 0 ? sentence : undefined;
}

/**
 * What the operator reads under a problem heading, in priority order:
 *
 *   1. a message the app itself wrote in Arabic - shown as-is
 *   2. the Arabic sentence for the transport's own error code
 *   3. the category's Arabic explanation
 *
 * An untranslated English fragment never reaches the operator: it tells
 * an Arabic reader nothing and reads as a defect in the product.
 */
export function operatorDetail(reason: unknown, category: FlasherProblemCategory): string {
  const raw = errorText(reason);
  if (/[\u0600-\u06FF]/.test(raw)) return raw;
  return codedTransportDetail(reason) ?? PROBLEM_FALLBACKS[category];
}

export const PROBLEM_FALLBACKS: Readonly<Record<FlasherProblemCategory, string>> = {
  CATALOGUE: 'تعذّر الوصول إلى خادم البناء. تحقّق من الاتصال بالإنترنت ثم أعد المحاولة.',
  RELEASES: 'تعذّر جلب إصدارات هذه اللوحة. تحقّق من الاتصال بالإنترنت ثم أعد المحاولة.',
  BUILD: 'تعذّر جلب خيارات البناء لهذا الإصدار.',
  PREPARE: 'تعذّر بناء أو تنزيل Firmware. تحقّق من الاتصال بالإنترنت ثم أعد المحاولة.',
  SERIAL: 'تعذّر فتح اتصال USB مع اللوحة. أعد توصيل الكابل ثم أعد المحاولة.',
  DFU_ACCESS: 'تعذّر الوصول إلى جهاز DFU. أعد توصيل اللوحة في وضع DFU ثم اخترها من جديد.',
  DFU_ENTRY: 'تعذّر تجهيز وضع DFU. أعد توصيل اللوحة ثم أعد المحاولة.',
};

/**
 * The failures whose recovery is a REPEAT OF THE SAME DOWNLOAD, and so
 * the only ones this screen can offer a retry for. A serial or DFU
 * failure is retried by the operator with the buttons that already sit
 * in steps ١ and ٥ - offering a second one beside the notice would put
 * two controls on the page for one action.
 */
export const RETRYABLE_PROBLEM_CATEGORIES: readonly FlasherProblemCategory[] =
  Object.freeze(['CATALOGUE', 'RELEASES', 'BUILD']);

export const PROBLEM_TITLES: Readonly<Record<FlasherProblemCategory, string>> = {
  CATALOGUE: 'تعذّر تحميل قائمة اللوحات',
  RELEASES: 'تعذّر تحميل قائمة الإصدارات',
  BUILD: 'تعذّر تحميل خيارات البناء',
  PREPARE: 'تعذّر تحضير Firmware',
  SERIAL: 'تعذّر الاتصال باللوحة',
  DFU_ACCESS: 'تعذّر الوصول إلى جهاز DFU',
  DFU_ENTRY: 'تعذّر الدخول إلى وضع DFU',
};

/**
 * THE STANDARD SCREEN'S TERMINAL-FAILURE TRUTH, pure and exported for tests.
 *
 * Maps a settled rejection onto the SAME contract the classic screen and
 * the WebUSB engine share (flashCompletionModel): the engine's frozen-
 * attempt codes and Android's manifestation-window DFU_STATUS_TIMEOUT
 * become the honest UNCONFIRMED third result with a safe next action;
 * everything else is a FAILED with its real stated reason. Never SUCCESS:
 * a rejection carries no completion evidence.
 *
 * It is reached ONLY from the flash engine's own rejection. Failures
 * before any destructive operation take the category path above.
 */
export function simpleFailurePresentation(
  reason: unknown,
  phaseAtFailure: FlashPhase | undefined,
  translate: (key: string, options?: {defaultValue: string}) => string,
): {readonly phase: 'failed' | 'unconfirmed'; readonly text: string} {
  const rawCode = (reason as {code?: unknown} | null)?.code;
  const code = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : undefined;
  const message = errorText(reason);
  const reasonLine =
    code === undefined ? message : translate(flashReasonLabelKey(code), {defaultValue: message});
  if (classifyFlashRejection(code, phaseAtFailure) === 'UNCONFIRMED') {
    return {
      phase: 'unconfirmed',
      text: `${reasonLine}\n${translate(flashNextActionLabelKey(code))}`,
    };
  }
  return {phase: 'failed', text: reasonLine};
}

/** Standard mode never silently falls from Stable to RC/Development. */
export function defaultStableRelease(releases: readonly FirmwareRelease[]): string {
  return defaultReleaseForChannel(releases, 'stable');
}

/** Waiting for the one-time DFU permission is part of the flash operation. */
export function simpleFlasherNavigationLocked(phase: SimpleFlasherPhase): boolean {
  return ['detecting', 'loading', 'waiting-permission', 'flashing'].includes(phase);
}

/** The Arabic heading for each official option category. */
export const BUILD_CATEGORY_TITLES: Readonly<Record<StandardBuildCategory['key'], string>> = {
  radio: 'بروتوكول الراديو',
  telemetry: 'بروتوكول Telemetry',
  osd: 'بروتوكول OSD',
  motor: 'بروتوكول المحركات',
  general: 'خيارات أخرى',
};

const CHANNEL_TITLES: Readonly<Record<FirmwareReleaseChannel, string>> = {
  stable: 'مستقر',
  candidate: 'مرشح',
  development: 'تطويري',
};

/* ------------------------------------------------------------------ *
 * Small presentation pieces
 * ------------------------------------------------------------------ */

function StepHeader({
  number,
  title,
}: {
  readonly number: string;
  readonly title: string;
}): React.JSX.Element {
  return (
    <View style={styles.stepHeader}>
      <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{number}</Text></View>
      <Text style={styles.stepTitle}>{title}</Text>
    </View>
  );
}

/**
 * One official single-choice category. Collapsed it shows the chosen
 * option, which is the only thing most operators need to read; expanded
 * it lists exactly the values the release returned. Long option names
 * wrap instead of clipping, which is what keeps this usable at 360px.
 */
function SingleChoiceGroup({
  title,
  options,
  value,
  onChange,
  disabled,
  testIDPrefix,
  lockedLabel,
  lockedReason,
}: {
  readonly title: string;
  readonly options: readonly FirmwareBuildOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly testIDPrefix: string;
  readonly lockedLabel?: string;
  readonly lockedReason?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  const summary = lockedLabel ?? selected?.name ?? 'بدون';
  const locked = lockedLabel !== undefined;
  return (
    <View style={styles.optionGroup} testID={`${testIDPrefix}-group`}>
      {/* A locked group is dimmed and chevron-less, which alone reads as
          a dead row. The reason - and where to change it - is stated. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${summary}`}
        accessibilityState={{disabled: disabled || locked, expanded: open}}
        disabled={disabled || locked}
        onPress={() => setOpen(current => !current)}
        style={[styles.optionHeader, (disabled || locked) && styles.dimmed]}
        testID={`${testIDPrefix}-selector`}>
        <View style={styles.optionCopy}>
          <Text style={styles.optionLabel}>{title}</Text>
          <Text style={styles.optionValue}>{summary}</Text>
        </View>
        {locked ? null : (
          <Icon
            name={open ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={colors.textSecondary}
          />
        )}
      </Pressable>
      {locked ? (
        <Text style={styles.lockedNote} testID={`${testIDPrefix}-locked-note`}>
          {lockedReason ?? 'محدد تلقائيًا حسب اختيارك في مجموعة أخرى.'}
        </Text>
      ) : null}
      {open && !locked ? (
        <View style={styles.optionChoices}>
          {options.map(option => {
            const isSelected = option.value === value;
            return (
              <Pressable
                key={option.value === '' ? '__none__' : option.value}
                accessibilityRole="radio"
                accessibilityState={{selected: isSelected, disabled}}
                disabled={disabled}
                onPress={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={[styles.choice, isSelected && styles.choiceSelected]}
                testID={`${testIDPrefix}-option-${option.value === '' ? 'none' : option.value}`}>
                <Text style={[styles.choiceText, isSelected && styles.choiceTextSelected]}>
                  {option.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** The release's other options: official values, multi-select. */
function MultiChoiceGroup({
  title,
  options,
  values,
  onToggle,
  disabled,
  testIDPrefix,
}: {
  readonly title: string;
  readonly options: readonly FirmwareBuildOption[];
  readonly values: readonly string[];
  readonly onToggle: (value: string) => void;
  readonly disabled: boolean;
  readonly testIDPrefix: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.optionGroup} testID={`${testIDPrefix}-group`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${values.length}`}
        accessibilityState={{disabled, expanded: open}}
        disabled={disabled}
        onPress={() => setOpen(current => !current)}
        style={[styles.optionHeader, disabled && styles.dimmed]}
        testID={`${testIDPrefix}-selector`}>
        <View style={styles.optionCopy}>
          <Text style={styles.optionLabel}>{title}</Text>
          <Text style={styles.optionValue}>
            {values.length === 0 ? 'بدون' : `${values.length} مُفعّل`}
          </Text>
        </View>
        <Icon
          name={open ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.textSecondary}
        />
      </Pressable>
      {open ? (
        <View style={styles.optionChoices}>
          {options.map(option => {
            const isSelected = values.includes(option.value);
            return (
              <Pressable
                key={option.value}
                accessibilityRole="checkbox"
                accessibilityState={{checked: isSelected, disabled}}
                disabled={disabled}
                onPress={() => onToggle(option.value)}
                style={[styles.choice, isSelected && styles.choiceSelected]}
                testID={`${testIDPrefix}-option-${option.value}`}>
                <Text style={[styles.choiceText, isSelected && styles.choiceTextSelected]}>
                  {option.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

export default function FirmwareFlasherSimpleScreen({
  navigation,
  client = usbSerialTransportClient,
}: Props): React.JSX.Element {
  const {t} = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  /** True while the embedded advanced screen owns a running operation. */
  const [advancedBusy, setAdvancedBusy] = useState(false);
  const [phase, setPhase] = useState<SimpleFlasherPhase>('idle');
  const [status, setStatus] = useState('اختر اللوحة والإصدار، ثم حضّر Firmware.');
  const [progress, setProgress] = useState(0);

  const [targets, setTargets] = useState<readonly BetaflightTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetQuery, setTargetQuery] = useState('');
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [releases, setReleases] = useState<readonly FirmwareRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [channel, setChannel] = useState<FirmwareReleaseChannel>('stable');
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [selectedRelease, setSelectedRelease] = useState('');

  /** The official build document + options for the CURRENT selection. */
  const [targetDetail, setTargetDetail] = useState<FirmwareTargetDetail | null>(null);
  const [buildOptions, setBuildOptions] = useState<FirmwareBuildOptions | null>(null);
  const [buildOptionsLoading, setBuildOptionsLoading] = useState(false);
  const [buildOptionsError, setBuildOptionsError] = useState<string | null>(null);
  const [choices, setChoices] = useState<StandardBuildChoices | null>(null);
  const [customDefinesOpen, setCustomDefinesOpen] = useState(false);

  const [firmware, setFirmware] = useState<FirmwareImage | null>(null);
  const [detectedTarget, setDetectedTarget] = useState<string | null>(null);
  /** A detection outcome the operator must read even though the screen is
   * idle - the progress line only exists while an operation is running. */
  const [detectionNote, setDetectionNote] = useState<string | null>(null);
  const [pendingFlash, setPendingFlash] = useState<{
    readonly pending: PendingBootloaderFlash;
    readonly image: Extract<FirmwareImage, {kind: 'HEX'}>;
  } | null>(null);

  /**
   * P0 REAL-HARDWARE CORRECTION. Normal MSP USB and DFU
   * bootloader USB are TWO PHASES of one workflow, and reboot-to-DFU
   * NECESSARILY destroys the first to produce the second. The state
   * below is what makes every guard phase-aware instead of demanding
   * the dead normal-mode device back:
   *
   *  - verifiedIdentity: the identity read over MSP THIS session,
   *    FROZEN across the re-enumeration that reboot causes. Whether the
   *    selected target is verified is DERIVED from it against the
   *    current selection - never invalidated by USB churn, only by a
   *    different board identity being read.
   *  - dfuPresent: a live watcher over listDfuDevices(), so a board
   *    that is ALREADY in DFU (manual BOOT entry, previous session,
   *    replug) is discovered without ever asking for the serial device
   *    that no longer exists. On the web this only sees authorized
   *    devices - the one-press chooser below covers the rest.
   */
  const [verifiedIdentity, setVerifiedIdentity] = useState<{
    readonly names: readonly string[];
  } | null>(null);
  /** A DFU device this session may flash (adopted or explicitly chosen). */
  const [dfuReady, setDfuReady] = useState<DfuDeviceDescriptor | null>(null);
  const [dfuPresent, setDfuPresent] = useState<DfuDeviceDescriptor | null>(null);
  /** Set only when software bootloader entry is genuinely unavailable. */
  const [manualDfuReason, setManualDfuReason] = useState<string | null>(null);
  /** A non-flash problem, kept apart from any flash verdict. */
  const [problem, setProblem] = useState<{
    readonly category: FlasherProblemCategory;
    readonly text: string;
  } | null>(null);
  /**
   * The board's own reset, as OBSERVED by the engine - the second truth
   * that must never rewrite the first. `undefined` until a flash
   * completes; the success notice reads it to decide whether it may say
   * the board came back.
   */
  const [resetConfirmed, setResetConfirmed] = useState<boolean | undefined>(undefined);

  const abortRef = useRef<AbortController | null>(null);
  /** The last engine-reported phase - what classifyFlashRejection needs
   * to tell Android's manifestation-window timeout from an early one. */
  const lastFlashPhaseRef = useRef<FlashPhase | undefined>(undefined);
  /** The engine's reset observation from the terminal progress event. */
  const resetConfirmedRef = useRef<boolean | undefined>(undefined);
  /** True from the moment a flash starts until it settles. */
  const flashingRef = useRef(false);
  const bootloader = useMemo(() => new FirmwareBootloaderController(client), [client]);
  const cloudBuild = useMemo(() => new CloudBuildCoordinator(betaflightBuildApi), []);
  const supportsSerialPicker = useMemo(() => client.supportsDevicePicker(), [client]);
  // The standard flasher is one column of steps, so it keeps the reading
  // column cap instead of stretching cards across a 1920px window.
  const {maxWidth: contentMaxWidth} = useContentEnvelope(false);
  const isBusy = ['detecting', 'loading', 'flashing'].includes(phase);
  const navigationLocked = simpleFlasherNavigationLocked(phase);
  /**
   * Whether the destructive action may be offered at all. The image kind
   * is part of this: standard mode writes Betaflight HEX, and a UF2/BIN
   * image used to leave the button live, open the confirmation dialog,
   * and only THEN dead-end. A control that cannot work is disabled
   * before it is pressed.
   */
  const flashable = firmware !== null && firmware.kind === 'HEX';

  /**
   * DERIVED, not stored: whether the frozen MSP identity matches the
   * CURRENT selection. Changing the selected target does not erase what
   * the board said about itself - it changes whether they agree.
   */
  const dfuTargetVerified = useMemo(
    () =>
      verifiedIdentity !== null &&
      selectedTarget.trim().length > 0 &&
      verifiedIdentity.names.includes(selectedTarget.trim().toUpperCase()),
    [selectedTarget, verifiedIdentity],
  );

  /** The board's own names, frozen for the DFU phase of this workflow. */
  const freezeIdentity = useCallback((identity: {
    readonly board: {
      readonly targetName: string;
      readonly boardName: string;
      readonly boardIdentifier: string;
    };
  }) => {
    // EVERY name the board answers to, board-name first - the shared,
    // vendor-neutral list (flightControllerNaming.ts). A modern unified
    // target answers "STM32F7X2" as its targetName, so a list that put
    // that first could never agree with a catalogue selection.
    setVerifiedIdentity({names: boardIdentityNames(identity.board)});
  }, []);

  /**
   * THE DFU PRESENCE WATCHER. Polls the AUTHORIZED DFU list whenever the
   * flash engine does not own the bus. This is what lets the flasher
   * meet a board that is already in DFU - at screen entry, after a
   * manual BOOT-button entry, after a replug, or after a bounded wait
   * elapsed - without ever demanding the normal serial device back.
   * listDfuDevices() resolves [] on a browser without WebUSB and lists
   * only already-authorized devices, so this can never raise a chooser
   * by itself; the explicit one-press chooser handles first-time
   * permission.
   */
  useEffect(() => {
    if (phase === 'flashing') return;
    let disposed = false;
    const probe = async () => {
      try {
        const devices = await client.listDfuDevices();
        if (disposed) return;
        setDfuPresent(devices.length === 1 ? devices[0] : null);
      } catch {
        // Android can reject transiently mid-enumeration; the next tick
        // answers. Absence of evidence here is never a workflow error.
      }
    };
    probe();
    const timer = setInterval(probe, 2_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, phase]);

  /**
   * ADOPTION. A visible DFU device IS the flash transport - bind to it
   * (and rebind to its latest enumeration after a replug). Releasing a
   * stale handle is CONFIRMATION-GATED: only a device the watcher has
   * positively observed may be declared gone by the watcher observing
   * nothing. Without that gate, a handle freshly bound by the reboot
   * flow or the chooser would be erased by the probe that simply had
   * not run yet.
   */
  const dfuConfirmedIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (phase === 'flashing') return;
    if (dfuPresent !== null) {
      dfuConfirmedIdRef.current = dfuPresent.deviceId;
      if (dfuReady === null || dfuReady.deviceId !== dfuPresent.deviceId) {
        setDfuReady(dfuPresent);
        setManualDfuReason(null);
      }
      return;
    }
    if (dfuReady !== null && dfuConfirmedIdRef.current === dfuReady.deviceId) {
      dfuConfirmedIdRef.current = null;
      setDfuReady(null);
    }
  }, [dfuPresent, dfuReady, phase]);

  const filteredTargets = useMemo(
    () => filterAndSortTargets(targets, targetQuery),
    [targetQuery, targets],
  );
  const channels = useMemo(() => availableChannels(releases), [releases]);
  const channelReleases = useMemo(
    () => releasesForChannel(releases, channel),
    [channel, releases],
  );
  const categories = useMemo(
    () => (buildOptions === null ? [] : standardBuildCategories(buildOptions)),
    [buildOptions],
  );
  const configurable = useMemo(
    () =>
      targetDetail !== null &&
      buildOptions !== null &&
      hasConfigurableBuild(targetDetail, buildOptions),
    [buildOptions, targetDetail],
  );
  const radioCarriesTelemetry = useMemo(() => {
    if (buildOptions === null || choices === null) return false;
    return (
      buildOptions.radioProtocols.find(option => option.value === choices.radioProtocol)
        ?.includesTelemetry === true
    );
  }, [buildOptions, choices]);

  /**
   * A FLASH verdict. Only the engine's own rejection may reach this - it
   * is the one path allowed to say «فشل التفليش».
   */
  const failFlash = useCallback((reason: unknown) => {
    const presentation = simpleFailurePresentation(
      reason,
      lastFlashPhaseRef.current,
      t,
    );
    setPhase(presentation.phase);
    setStatus(presentation.text);
  }, [t]);

  /**
   * Everything else: a catalogue download, a permission, a build, a
   * detection. The board was never written to, and the copy says so.
   */
  const failOperation = useCallback(
    (category: FlasherProblemCategory, reason: unknown) => {
      setProblem({category, text: operatorDetail(reason, category)});
      setPhase('problem');
      setStatus(PROBLEM_TITLES[category]);
      // DEVELOPER DIAGNOSTICS, NOT UI. A failed connection is exactly the
      // moment the stage-by-stage trace is worth having, and a hardware
      // test is a one-off - so it is emitted to the console (adb logcat on
      // Android, DevTools in a browser) whether or not anyone thought to
      // turn diagnostics on first. The operator sees only the Arabic
      // sentence above; nothing here reaches the interface.
      if (category === 'SERIAL') {
        const report = getLastConnectionTrace()?.toText();
        if (report !== undefined) {
          console.warn(report);
        }
      }
    },
    [],
  );

  /**
   * "أعد المحاولة" USED TO BE ADVICE WITH NOTHING BEHIND IT.
   *
   * The three catalogue reads - boards, releases, build options - each
   * run from a useEffect, and their failure copy ends "تحقّق من الاتصال
   * بالإنترنت ثم أعد المحاولة". But the boards effect had no dependency
   * that could ever change, so on a dropped connection the screen sat
   * there telling the operator to retry something the screen offered no
   * way to retry. Leaving the flasher and coming back was the only cure,
   * and nothing on the page said so.
   *
   * Bumping this re-runs whichever of the three reads is stale, which is
   * what the sentence already promised. It is not a poll: nothing
   * changes it but an operator pressing the button.
   */
  const [catalogueAttempt, setCatalogueAttempt] = useState(0);
  const retryCatalogue = useCallback(() => {
    setProblem(null);
    setPhase('idle');
    setStatus('إعادة المحاولة…');
    setCatalogueAttempt(current => current + 1);
  }, []);

  /* ---- Catalogue: the official dataset, unfiltered ---- */
  useEffect(() => {
    const controller = new AbortController();
    setTargetsLoading(true);
    betaflightBuildApi.loadTargets(controller.signal)
      .then(items => {
        if (!controller.signal.aborted) setTargets(items);
      })
      .catch(reason => {
        if (!controller.signal.aborted) failOperation('CATALOGUE', reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setTargetsLoading(false);
      });
    return () => controller.abort();
  }, [catalogueAttempt, failOperation]);

  /* ---- Releases for the chosen board ---- */
  useEffect(() => {
    if (!selectedTarget) {
      setReleases([]);
      setSelectedRelease('');
      setFirmware(null);
      // Nothing is in flight on this path, so nothing may claim to be.
      // See the note on the build-options effect below for the sequence
      // that made the sibling flag stick.
      setReleasesLoading(false);
      return;
    }
    const controller = new AbortController();
    setReleasesLoading(true);
    betaflightBuildApi.loadTargetReleases(selectedTarget, controller.signal)
      .then(parseTargetReleases)
      .then(items => {
        if (controller.signal.aborted) return;
        setReleases(items);
        // Stable is the standard choice. When a target publishes no
        // stable release the screen says so rather than quietly handing
        // the operator a release candidate.
        const preferred = availableChannels(items).includes('stable')
          ? 'stable'
          : (availableChannels(items)[0] ?? 'stable');
        setChannel(preferred);
        setSelectedRelease(defaultReleaseForChannel(items, preferred));
      })
      .catch(reason => {
        if (!controller.signal.aborted) failOperation('RELEASES', reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReleasesLoading(false);
      });
    return () => controller.abort();
  }, [catalogueAttempt, failOperation, selectedTarget]);

  /* ---- The official build document and its options ----
   *
   * This is what restores real Betaflight capability: the categories the
   * SELECTED release exposes, with the API's own defaults pre-selected. */
  useEffect(() => {
    setFirmware(null);
    setPendingFlash(null);
    setProgress(0);
    if (!selectedTarget || !selectedRelease) {
      setTargetDetail(null);
      setBuildOptions(null);
      setChoices(null);
      setBuildOptionsError(null);
      /*
       * A SPINNER THAT NEVER STOPPED, and the sequence that produced it.
       *
       * The flag was cleared only in `.finally()`, and that clause skips
       * the reset when the request was aborted - correct on unmount, but
       * this effect also aborts on every dependency change, and one of
       * those changes lands HERE, in the early return:
       *
       *   1. board A, release R: the effect starts a load and sets the
       *      flag true;
       *   2. the operator picks board B. The releases effect re-runs, and
       *      B publishes nothing in any channel, so
       *      defaultReleaseForChannel returns '' and selectedRelease
       *      becomes empty;
       *   3. this effect re-runs, aborts step 1 - whose `.finally` now
       *      declines to clear the flag - and returns right here, without
       *      clearing it either.
       *
       * Nothing was loading and nothing ever would, but the options card
       * kept its ActivityIndicator spinning for the rest of the session.
       *
       * Clearing it on the way out makes the flag mean what it says: it
       * is true only while THIS effect has a request outstanding.
       */
      setBuildOptionsLoading(false);
      return;
    }
    const controller = new AbortController();
    setBuildOptionsLoading(true);
    setBuildOptionsError(null);
    (async () => {
      const detailInput = await betaflightBuildApi.loadBuild(
        selectedTarget,
        selectedRelease,
        controller.signal,
      );
      const detail = parseTargetDetail(detailInput, selectedTarget, selectedRelease);
      if (controller.signal.aborted) return;
      setTargetDetail(detail);
      const optionInput = await betaflightBuildApi.loadOptions(
        selectedRelease,
        controller.signal,
      );
      const options = parseBuildOptions(optionInput);
      if (controller.signal.aborted) return;
      setBuildOptions(options);
      setChoices(defaultStandardChoices(detail, options));
    })().catch(() => {
      if (controller.signal.aborted) return;
      // A missing options document is not a dead end: the official core
      // build still works, and that is what the screen offers instead of
      // pretending the categories exist.
      setBuildOptions(null);
      setChoices({
        coreBuild: true,
        radioProtocol: '',
        telemetryProtocol: '',
        osdProtocol: '',
        motorProtocol: '',
        generalOptions: [],
        customDefines: '',
      });
      // The raw engine text stays out of the operator's view; the
      // helper line below says what it means for the build.
      setBuildOptionsError('CORE_ONLY');
    }).finally(() => {
      if (!controller.signal.aborted) setBuildOptionsLoading(false);
    });
    return () => controller.abort();
  }, [catalogueAttempt, selectedRelease, selectedTarget]);

  /* ---- Live flash progress ---- */
  useEffect(() => client.onDfuFlashProgress(update => {
    // Gated on a ref, not on the rendered phase: an engine that emits
    // its terminal event in the same tick the flash starts would
    // otherwise have it dropped by a stale closure - and with it the
    // reset observation the success line reads.
    if (!flashingRef.current) return;
    lastFlashPhaseRef.current = toFlashPhase(update.phase);
    if (typeof update.resetConfirmed === 'boolean') {
      // The terminal event's second truth. Held in a ref because the
      // resolved promise reads it in the same tick.
      resetConfirmedRef.current = update.resetConfirmed;
    }
    // 100 is reserved for the resolved flash promise. A progress event alone
    // is never allowed to visually claim success.
    setProgress(Math.max(0, Math.min(99, update.percent)));
    const label = update.phase === 'erasing'
      ? 'مسح الذاكرة…'
      : update.phase === 'writing'
        ? 'كتابة Firmware…'
        : update.phase === 'verifying'
          ? 'التحقق من الكتابة…'
          : update.phase === 'manifesting' ||
              update.phase === 'resetting' ||
              update.phase === 'finalizing'
            ? 'إنهاء التفليش وإعادة التشغيل…'
            : 'تفليش Firmware…';
    setStatus(label);
  }), [client]);

  const updateChoices = useCallback((next: StandardBuildChoices) => {
    setChoices(buildOptions === null ? next : applyRadioTelemetryRule(next, buildOptions));
    // The prepared image no longer matches the configuration.
    setFirmware(null);
  }, [buildOptions]);

  const selectTarget = useCallback((target: string) => {
    if (navigationLocked) return;
    setSelectedTarget(target);
    setTargetQuery('');
    setTargetPickerOpen(false);
    setDetectedTarget(null);
    setPendingFlash(null);
    /*
     * THE NOTE THAT OUTLIVED ITS OWN INSTRUCTION.
     *
     * A detection that reads a board the catalogue does not list leaves
     * "…اسم اللوحة غير موجود في قائمة Targets الرسمية. اختر Target يدويًا"
     * on screen. It was cleared only when a NEW detection started - so
     * the operator who did exactly what it asked, and picked a target by
     * hand, was still being told to pick a target by hand. Advice that
     * has already been followed is not advice any more.
     */
    setDetectionNote(null);
    // DELIBERATELY KEPT: dfuReady and verifiedIdentity. The board being
    // in DFU is a physical fact a catalogue choice cannot change, and
    // the frozen identity stays what the board said - whether it MATCHES
    // the new selection is derived (dfuTargetVerified). Clearing the
    // transport here was half of the real hardware-test trap: pick target
    // after entering DFU and the flasher demanded normal USB again.
    setProgress(0);
    setPhase('idle');
    setStatus('اختر الإصدار ثم راجع إعدادات البناء.');
  }, [navigationLocked]);

  /**
   * Enumerates exactly one usable serial board, or says why not. Callers
   * MUST try the DFU phase first (dfuReady/dfuPresent): this helper is
   * only for operations that genuinely need the NORMAL-mode device, and
   * its absence message therefore names both connection phases instead
   * of sending an operator whose board is in DFU back to "reconnect
   * normally" - the exact trap the real flight-controller test caught
   * (firmwareFlasherDfuTransition.test.tsx).
   */
  const requireSingleSerialDevice = useCallback(async () => {
    // STAGE TRUTH: an attached-but-undrivable device is not "no device".
    const attached = await client.listDevices();
    const devices = attached.filter(isSupportedDevice);
    if (devices.length === 0) {
      if (attached.length > 0) {
        throw new Error(
          'تم العثور على جهاز USB، لكنه لا يعرض منفذًا تسلسليًا يمكن فتحه. تأكد أن الكابل كابل بيانات وأن اللوحة في الوضع العادي وليست في وضع DFU.',
        );
      }
      throw new Error(
        supportsSerialPicker
          ? 'لا يوجد منفذ تسلسلي مسموح به. إن كانت اللوحة في الوضع العادي اضغط «اختيار جهاز USB»، وإن كانت في وضع DFU اضغط «اختيار جهاز DFU».'
          : 'لا يوجد أي جهاز USB متصل في الوضع العادي. إن كانت اللوحة في وضع DFU فسيكتشفها التطبيق تلقائياً خلال لحظات.',
      );
    }
    if (devices.length > 1) {
      throw new Error('يوجد أكثر من Flight Controller. اترك لوحة واحدة متصلة ثم أعد المحاولة.');
    }
    if (devices[0].portCount !== 1) {
      throw new Error('للوحة أكثر من منفذ USB serial. استخدم «متقدم» لاختيار المنفذ يدوياً.');
    }
    return devices[0];
  }, [client, supportsSerialPicker]);

  const autoDetect = useCallback(async () => {
    if (navigationLocked) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('detecting');
    setProblem(null);
    setManualDfuReason(null);
    setDetectionNote(null);
    setStatus('التعرف على Flight Controller…');
    try {
      const device = await requireSingleSerialDevice();
      const detected = await bootloader.detectFlightController(controller.signal, {
        deviceId: device.deviceId,
        portIndex: 0,
      });
      try {
        const identity = detected.identity;
        // THE BOARD, not the MCU family. Betaflight's unified targets
        // report targetName as the MCU family and boardName as the actual
        // board, so asking targetName first made every modern board look
        // like an unknown target - the real-hardware detection defect.
        // See flightControllerNaming.ts.
        const target = resolveCatalogTarget(identity.board);
        const hardware = describeFlightControllerHardware(identity.board);
        const match = targets.find(item => item.target.toUpperCase() === target);
        if (!match) {
          // Honest, and still usable: the board answered, its identity is
          // simply not a catalogue target, so manual selection stands.
          setDetectedTarget(hardware);
          setPhase('idle');
          setDetectionNote(
            `تم التعرف على ${hardware}، لكن اسم اللوحة غير موجود في قائمة Targets الرسمية. اختر Target يدويًا.`,
          );
          setStatus(`تم التعرف على ${hardware}. اختر Target يدويًا.`);
          return;
        }
        setDetectedTarget(match.target);
        setSelectedTarget(match.target);
        freezeIdentity(detected.identity);
        setPhase('idle');
        setStatus(`تم التعرف على اللوحة ${match.target}.`);
      } finally {
        await detected.release();
      }
    } catch (reason) {
      if (!controller.signal.aborted) failOperation('SERIAL', reason);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [bootloader, failOperation, freezeIdentity, navigationLocked, requireSingleSerialDevice, targets]);

  const chooseSerialAndDetect = useCallback(() => {
    if (navigationLocked) return;
    // Web Serial's chooser must be opened directly by this press.
    client.requestDevicePermission()
      .then(device => {
        if (device === null) return;
        setStatus('تم السماح بالوصول إلى USB. جارٍ التعرف على اللوحة…');
        autoDetect().catch(() => undefined);
      })
      .catch(reason => failOperation('SERIAL', reason));
  }, [autoDetect, client, failOperation, navigationLocked]);

  /**
   * PREPARE FIRMWARE. Sends exactly the configuration on screen - every
   * visible choice travels in the official request, nothing is added and
   * nothing is dropped.
   */
  const loadFirmware = useCallback(async () => {
    if (!selectedTarget || !selectedRelease || navigationLocked) return;
    if (targetDetail === null || choices === null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('loading');
    setProblem(null);
    setProgress(0);
    setStatus('تحضير Firmware الرسمي…');
    try {
      const request = createBuildRequest(targetDetail, toBuildSelection(choices));
      const result = await cloudBuild.buildAndDownload(
        request,
        update => {
          setProgress(update.percent);
          setStatus(update.message);
        },
        controller.signal,
      );
      let parsed = parseFirmwareFile(result.response.file, result.firmware);
      const configuration = result.configuration ?? targetDetail.configuration ?? null;
      if (parsed.kind === 'HEX' && configuration !== null) {
        parsed = applyCustomDefaultsToFirmware(parsed, configuration);
      }
      setFirmware(parsed);
      setProgress(0);
      setPhase('ready');
      setStatus(`Firmware ${selectedRelease} جاهز للتفليش.`);
    } catch (reason) {
      if (!controller.signal.aborted) failOperation('PREPARE', reason);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [
    choices,
    cloudBuild,
    failOperation,
    navigationLocked,
    selectedRelease,
    selectedTarget,
    targetDetail,
  ]);

  const completeFlash = useCallback(async (
    dfu: DfuDeviceDescriptor,
    image: Extract<FirmwareImage, {kind: 'HEX'}>,
  ) => {
    setPhase('flashing');
    flashingRef.current = true;
    setProgress(0);
    setProblem(null);
    // A stale phase - and a stale reset observation - from an earlier
    // attempt must not describe this one.
    lastFlashPhaseRef.current = undefined;
    resetConfirmedRef.current = undefined;
    setResetConfirmed(undefined);
    setStatus('بدء تفليش Firmware…');
    try {
      // Bind to the LIVE enumeration of the device, not a remembered
      // one: a replug between discovery and this press re-enumerates
      // under a new id, and opening the dead id is exactly the "USB is
      // no longer readable" dead end from the hardware report. One
      // visible device is the flash device; zero is an honest failure
      // to START (nothing was erased); the engine itself never guesses.
      let bound = dfu;
      try {
        const live = await client.listDfuDevices();
        if (live.length === 1) {
          bound = live[0];
        } else if (live.length === 0 && supportsSerialPicker) {
          throw new Error('جهاز DFU لم يعد ظاهراً. أعد توصيل اللوحة في وضع DFU ثم أعد المحاولة.');
        }
      } catch (probeError) {
        if (probeError instanceof Error && probeError.message.startsWith('جهاز DFU')) {
          throw probeError;
        }
        // A transient enumeration error must not veto a device we
        // already hold - the engine will report the truth either way.
      }
      await client.flashDfuFirmware(bound.deviceId, bytesToBase64(image.bytes), false);
      setProgress(100);
      // TWO TRUTHS, REPORTED SEPARATELY. The resolved promise means the
      // firmware was written and read back byte-for-byte. Whether the
      // board was SEEN coming back is the engine's separate observation,
      // and it only chooses which success sentence is honest.
      const observedReset = resetConfirmedRef.current;
      setResetConfirmed(observedReset);
      setPhase('success');
      setStatus(
        observedReset === true
          ? 'تمت كتابة Firmware والتحقق منه، وأعادت اللوحة الاتصال.'
          : 'تمت كتابة Firmware والتحقق منه بنجاح.',
      );
      setPendingFlash(null);
      setDfuReady(null);
      setDfuPresent(null);
    } catch (reason) {
      failFlash(reason);
    } finally {
      flashingRef.current = false;
    }
  }, [client, failFlash, supportsSerialPicker]);

  /**
   * ENTER DFU - phase-aware. Three legitimate starting points, none of
   * which may demand a device from another phase:
   *
   *   1. Board already in DFU (adopted by the watcher, or authorized a
   *      moment ago): nothing to enter - report ready.
   *   2. Board in NORMAL mode: verify identity over MSP, FREEZE it,
   *      send the genuine reboot-to-bootloader, then treat the
   *      disappearance of the serial device as the EXPECTED transition
   *      it is and wait for the DFU identity - never as a disconnect
   *      error, and never asking for the serial device again.
   *   3. Software entry impossible (non-Betaflight family): the
   *      shortest board-neutral manual instruction, plus the chooser.
   *
   * A bounded wait that elapses is NOT a terminal failure either: the
   * presence watcher keeps scanning, so a board that is slow to
   * re-enumerate (or needed a manual BOOT entry) is adopted the moment
   * it appears.
   */
  const enterDfuMode = useCallback(async () => {
    if (navigationLocked) return;
    if (dfuReady !== null || dfuPresent !== null) {
      if (dfuReady === null && dfuPresent !== null) setDfuReady(dfuPresent);
      setPhase(firmware ? 'ready' : 'idle');
      setStatus('اللوحة في وضع DFU بالفعل وجاهزة للتفليش.');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('detecting');
    setManualDfuReason(null);
    setStatus('التحقق من اللوحة قبل الدخول إلى وضع DFU…');
    try {
      const device = await requireSingleSerialDevice();
      const detected = await bootloader.detectFlightController(controller.signal, {
        deviceId: device.deviceId,
        portIndex: 0,
      });
      if (selectedTarget && !detected.targetMatches(selectedTarget)) {
        const actual = describeFlightControllerHardware(detected.identity.board);
        await detected.release();
        throw new Error(`Target المحدد ${selectedTarget} لا يطابق اللوحة ${actual}. صحّح Target قبل المتابعة.`);
      }
      if (detected.identity.firmware.knownFamily !== 'BETAFLIGHT') {
        await detected.release();
        setPhase('idle');
        setManualDfuReason(
          'هذا Firmware لا يدعم إعادة التشغيل البرمجية إلى وضع DFU. ادخل وضع DFU يدويًا (زر BOOT أثناء توصيل USB) وسيُكتشف الجهاز تلقائياً أو عبر «اختيار جهاز DFU».',
        );
        setStatus('يلزم الدخول اليدوي إلى وضع DFU.');
        return;
      }
      setDetectedTarget(describeFlightControllerHardware(detected.identity.board));
      freezeIdentity(detected.identity);
      setStatus('تم التعرف على اللوحة. جارٍ الانتقال إلى وضع DFU…');
      await detected.rebootToBootloader(selectedTarget, false);
      // From here the NORMAL device is gone BY DESIGN. Its session was
      // released cleanly inside rebootToBootloader; nothing below may
      // reference it again.
      setStatus('انتهى اتصال الإعدادات كما هو متوقع. بانتظار جهاز DFU…');
      try {
        const dfu = await bootloader.waitForOneDfuDevice(20_000, controller.signal);
        setDfuReady(dfu);
        setPhase(firmware ? 'ready' : 'idle');
        setStatus('اللوحة الآن في وضع DFU وجاهزة للتفليش.');
      } catch (reason) {
        if (!(reason instanceof DfuPermissionRequiredError)) throw reason;
        // No AUTHORIZED device appeared inside the bounded wait. On the
        // web that usually means the browser was never told about this
        // DFU identity - one real press opens the chooser. On Android
        // (no chooser) the same signal means the board has not
        // re-enumerated yet; the watcher keeps scanning either way, so
        // a late appearance still completes this workflow.
        setPhase(firmware ? 'ready' : 'idle');
        setManualDfuReason(
          supportsSerialPicker
            ? firmware !== null
              ? 'تم تجهيز Firmware. اختر جهاز DFU للمتابعة.'
              : 'اللوحة دخلت وضع DFU. اضغط «اختيار جهاز DFU» مرة واحدة للسماح للمتصفح بالتعامل معها.'
            : 'لم يظهر جهاز DFU بعد. إن لم تُعد اللوحة التشغيل تلقائياً، ادخل وضع DFU يدوياً (زر BOOT أثناء توصيل USB)؛ سيُكتشف الجهاز فور ظهوره.',
        );
        setStatus('بانتظار جهاز DFU…');
      }
    } catch (reason) {
      if (!controller.signal.aborted) failOperation('DFU_ENTRY', reason);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [
    bootloader,
    dfuPresent,
    dfuReady,
    failOperation,
    firmware,
    freezeIdentity,
    navigationLocked,
    requireSingleSerialDevice,
    selectedTarget,
    supportsSerialPicker,
  ]);

  /**
   * The browser's one-time WebUSB chooser, straight from the press. A
   * dismissed chooser is the operator changing their mind, not an error
   * - the prepared firmware, the frozen identity and the whole workflow
   * stay exactly where they were.
   */
  const chooseDfuDevice = useCallback(() => {
    if (navigationLocked) return;
    client.requestDfuDevicePermission()
      .then(device => {
        if (device === null) return;
        setDfuReady(device);
        setDfuPresent(device);
        setManualDfuReason(null);
        setStatus('تم اختيار جهاز DFU. يمكنك الآن التفليش.');
      })
      .catch(reason => failOperation('DFU_ACCESS', reason));
  }, [client, failOperation, navigationLocked]);

  const flashPreparedFirmware = useCallback(async () => {
    if (!firmware || navigationLocked) return;
    if (firmware.kind !== 'HEX') {
      // Defence in depth: the button is already disabled for this case
      // (see `flashable`), so this can only be reached programmatically.
      // It is a capability limit, not a flash failure.
      failOperation(
        'PREPARE',
        new Error('الوضع القياسي مخصص لملفات HEX الرسمية. استخدم «متقدم» للأنواع الأخرى.'),
      );
      return;
    }
    // THE DFU PHASE COMES FIRST. A board in DFU - put there by this
    // session, adopted by the watcher, or explicitly chosen - IS the
    // flash transport. Asking for the normal serial device at this
    // point was the core of the real hardware-test trap.
    const dfuNow = dfuReady ?? dfuPresent;
    if (dfuNow !== null) {
      // UNKNOWN IS NOT MISMATCH. A board in DFU cannot be asked who it
      // is - that is a property of the bootloader, not a reason to
      // refuse. The operator picked the Target and confirmed the
      // destructive dialog; a warning is shown beside the action and the
      // flash proceeds. (A board whose identity WAS read and does not
      // match is still blocked, below and in enterDfuMode.)
      await completeFlash(dfuNow, firmware);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('detecting');
    setProgress(0);
    setStatus('التحقق من اللوحة قبل التفليش…');
    try {
      const device = await requireSingleSerialDevice();
      const detected = await bootloader.detectFlightController(controller.signal, {
        deviceId: device.deviceId,
        portIndex: 0,
      });
      if (!detected.targetMatches(selectedTarget)) {
        const actual = describeFlightControllerHardware(detected.identity.board);
        await detected.release();
        throw new Error(`تم إيقاف التفليش: Target ${selectedTarget} لا يطابق اللوحة ${actual}.`);
      }
      setDetectedTarget(selectedTarget);
      freezeIdentity(detected.identity);
      setStatus('تم التعرف على اللوحة. جارٍ الانتقال إلى وضع DFU…');
      await detected.rebootToBootloader(selectedTarget, false);
      // The serial device is now gone BY DESIGN - the expected phase
      // transition, not a disconnect.
      setStatus('انتهى اتصال الإعدادات كما هو متوقع. بانتظار جهاز DFU…');
      try {
        const dfu = await bootloader.waitForOneDfuDevice(20_000, controller.signal);
        await completeFlash(dfu, firmware);
      } catch (reason) {
        if (!(reason instanceof DfuPermissionRequiredError)) throw reason;
        const pending: PendingBootloaderFlash = {
          operationId: `standard-flash-${Date.now()}`,
          expectedTarget: selectedTarget,
          rebootAlreadySent: true,
          writeAlreadyStarted: false,
        };
        setPendingFlash({pending, image: firmware});
        setPhase('waiting-permission');
        setStatus('تم تجهيز Firmware. اختر جهاز DFU للمتابعة.');
      }
    } catch (reason) {
      // Everything in this block happens BEFORE the first destructive
      // command: identify, verify the target, reboot into DFU. A failure
      // here is a preparation problem, not a flash verdict.
      if (!controller.signal.aborted) failOperation('DFU_ENTRY', reason);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [
    bootloader,
    completeFlash,
    dfuPresent,
    dfuReady,
    failOperation,
    firmware,
    freezeIdentity,
    navigationLocked,
    requireSingleSerialDevice,
    selectedTarget,
  ]);

  const chooseDfuAndContinue = useCallback(() => {
    if (!pendingFlash || phase !== 'waiting-permission') return;
    client.requestDfuDevicePermission()
      .then(async device => {
        if (device === null) {
          // A dismissed chooser is the operator changing their mind -
          // the prepared operation stays exactly where it is, ready for
          // the next press. Treating this as a failure was itself a
          // phase confusion: nothing about the workflow changed.
          return;
        }
        const verdict = verifySelectedDfuDevice(
          device,
          pendingFlash.pending,
          pendingFlash.pending.operationId,
        );
        if (!verdict.ok) {
          throw new Error('جهاز DFU المختار غير صالح لهذه العملية. اختر Flight Controller الصحيح.');
        }
        await completeFlash(device, pendingFlash.image);
      })
      .catch(reason => failOperation('DFU_ACCESS', reason));
  }, [client, completeFlash, failOperation, pendingFlash, phase]);

  const confirmFlash = useCallback(() => {
    if (!flashable || navigationLocked) return;
    Alert.alert(
      'تفليش Firmware',
      `سيتم تثبيت ${selectedRelease} على ${selectedTarget}. أزل المراوح واترك USB موصولاً حتى تظهر النتيجة النهائية.`,
      [
        {text: 'إلغاء', style: 'cancel'},
        {
          text: 'ابدأ التفليش',
          style: 'destructive',
          onPress: () => flashPreparedFirmware().catch(() => undefined),
        },
      ],
    );
  }, [flashPreparedFirmware, flashable, navigationLocked, selectedRelease, selectedTarget]);

  const cancel = useCallback(() => {
    if (phase === 'waiting-permission') {
      // Reboot happened, but writeAlreadyStarted is false. Dropping this
      // prepared operation is safe and releases the UI without lying.
      setPendingFlash(null);
      setProgress(0);
      setPhase(firmware ? 'ready' : 'idle');
      setStatus(firmware
        ? 'أُلغي التفليش قبل بدء الكتابة. Firmware ما زال جاهزاً.'
        : 'أُلغي التفليش قبل بدء الكتابة.');
      return;
    }

    abortRef.current?.abort();
    if (phase === 'flashing') {
      // WebUSB may still own one native transfer. Do not announce cancellation
      // as complete until the transport settles the actual terminal result.
      client.cancelDfuFlash().catch(() => undefined);
      setStatus('تم طلب الإيقاف. انتظار انتهاء الخطوة الحالية بأمان…');
      return;
    }

    setPhase(firmware ? 'ready' : 'idle');
    setProgress(0);
    setStatus('أُلغيت العملية.');
  }, [client, firmware, phase]);

  if (advanced) {
    return (
      <View style={styles.advancedRoot}>
        <View style={styles.advancedBar}>
          {/* GUARDED. This used to be unconditionally live: pressing it
              during an advanced flash unmounted the screen mid-write,
              which silently aborted the operation and showed no terminal
              result anywhere. A destructive operation in flight is
              finished or cancelled explicitly, never navigated away
              from. */}
          <FirmwareButton
            title="العودة إلى الوضع القياسي"
            tone="secondary"
            size="compact"
            onPress={() => setAdvanced(false)}
            disabled={advancedBusy}
            testID="flasher-simple-mode"
          />
        </View>
        <View style={styles.advancedBody}>
          <React.Suspense
            fallback={
              <View style={styles.advancedLoading}>
                <ActivityIndicator color={colors.accent} />
              </View>
            }>
            <FirmwareFlasherScreen
              navigation={navigation}
              client={client}
              onBusyChange={setAdvancedBusy}
            />
          </React.Suspense>
        </View>
      </View>
    );
  }

  const noStableForTarget =
    selectedTarget !== '' && !releasesLoading && !channels.includes('stable');

  return (
    <View style={styles.root} testID="firmware-flasher-simple-screen">
      <Modal
        visible={targetPickerOpen}
        animationType="slide"
        onRequestClose={() => {
          if (!navigationLocked) setTargetPickerOpen(false);
        }}>
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>اختيار Flight Controller</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="إغلاق"
              disabled={navigationLocked}
              onPress={() => setTargetPickerOpen(false)}
              style={[styles.closeButton, navigationLocked && styles.dimmed]}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
          <TextInput
            value={targetQuery}
            onChangeText={setTargetQuery}
            editable={!navigationLocked}
            placeholder="ابحث باسم Target أو الشركة أو MCU"
            placeholderTextColor={colors.textMuted}
            style={styles.search}
            autoFocus
            testID="simple-target-search"
          />
          <FlatList
            data={filteredTargets}
            keyExtractor={item => item.target}
            keyboardShouldPersistTaps="handled"
            renderItem={({item}) => (
              <Pressable
                disabled={navigationLocked}
                onPress={() => selectTarget(item.target)}
                style={styles.targetRow}
                testID={`simple-target-${item.target}`}>
                <Text style={styles.targetName}>{item.target}</Text>
                <Text style={styles.targetMeta}>
                  {[item.manufacturer, item.mcu].filter(Boolean).join(' • ')}
                </Text>
              </Pressable>
            )}
          />
        </View>
      </Modal>

      <View style={styles.header}>
        {/* Rendered only when there is somewhere to go back TO. It used
            to render unconditionally with an optional-chained handler,
            so in any host without a navigator it looked live and did
            nothing. */}
        {navigation !== undefined ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="العودة"
            /* Dimmed AND announced. A control that is visually dim but
               reports itself enabled tells a screen-reader user nothing
               about why pressing it does nothing. */
            accessibilityState={{disabled: navigationLocked}}
            onPress={() => navigation.goBack()}
            disabled={navigationLocked}
            style={[styles.backButton, navigationLocked && styles.dimmed]}
            testID="simple-back">
            <Icon name="chevron-back" size={24} color={colors.textPrimary} />
          </Pressable>
        ) : null}
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Firmware Flasher</Text>
          <Text style={styles.subtitle}>اللوحة · الإصدار · الإعدادات · التفليش</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{disabled: navigationLocked}}
          onPress={() => setAdvanced(true)}
          disabled={navigationLocked}
          style={[styles.advancedLink, navigationLocked && styles.dimmed]}
          testID="flasher-advanced-mode">
          <Text style={styles.advancedLinkText}>متقدم</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, {maxWidth: contentMaxWidth}]}
        keyboardShouldPersistTaps="handled">
        {/* A problem that is NOT a flash verdict: a catalogue download, a
            permission, a build, a detection. The board was never written
            to, and this notice never claims otherwise. */}
        {phase === 'problem' && problem !== null ? (
          /* THE CONNECTION REPORT IS NOT A USER-FACING CONTROL.
             It used to sit here as a "نسخ تقرير الاتصال" button after a
             failed detection: an engineering trace, offered to an
             operator who has no use for it, at the exact moment they are
             already looking at a problem. It gave them a second thing to
             fail at and told them nothing about their board.

             The TRACE ITSELF IS KEPT and still written on every failed
             detection - failOperation() emits it to the console
             (DevTools on the web, adb logcat on Android), where a
             developer investigating a hardware report can read it. What
             is gone is the button, not the diagnostics. */
          <View testID="simple-problem-notice">
            <FirmwareNotice
              title={PROBLEM_TITLES[problem.category]}
              text={problem.text}
              tone="warning"
            />
            {/* ONE control, and only where the sentence above promises
                one. A catalogue, release or build-options download is
                the only failure whose retry has no home elsewhere on the
                page; a serial or DFU failure is retried with the buttons
                in steps ١ and ٥, and a second copy of those here would
                be the clutter this notice is trying not to be. */}
            {RETRYABLE_PROBLEM_CATEGORIES.includes(problem.category) ? (
              <View style={styles.problemActionRow}>
                <FirmwareButton
                  title="أعد المحاولة"
                  tone="secondary"
                  size="compact"
                  onPress={retryCatalogue}
                  testID="simple-retry-catalogue"
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {/* 1 — the board */}
        <View style={styles.card}>
          <StepHeader number="١" title="اللوحة" />
          <View style={styles.actionRow}>
            {supportsSerialPicker ? (
              <FirmwareButton
                title="اختيار جهاز USB"
                tone="secondary"
                size="compact"
                onPress={chooseSerialAndDetect}
                disabled={navigationLocked}
                testID="simple-choose-serial"
              />
            ) : null}
            <FirmwareButton
              title={phase === 'detecting' ? 'جارٍ التعرف…' : 'التعرف على اللوحة المتصلة'}
              tone="secondary"
              size="compact"
              onPress={() => autoDetect().catch(() => undefined)}
              disabled={navigationLocked || targetsLoading}
              testID="simple-auto-detect"
            />
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setTargetPickerOpen(true)}
            disabled={navigationLocked}
            style={[styles.selector, navigationLocked && styles.dimmed]}
            testID="simple-target-selector">
            <Text style={styles.selectorLabel}>Target</Text>
            <Text style={styles.selectorValue}>{selectedTarget || 'اختر اللوحة'}</Text>
          </Pressable>
          {detectedTarget ? (
            <Text style={styles.detected} testID="simple-detected-target">
              تم التعرف على اللوحة {detectedTarget}
            </Text>
          ) : null}
          {detectionNote !== null ? (
            <Text style={styles.helper} testID="simple-detection-note">
              {detectionNote}
            </Text>
          ) : null}
        </View>

        {/* 2 — the version */}
        <View style={styles.card}>
          <StepHeader number="٢" title="الإصدار" />
          {releasesLoading ? <ActivityIndicator color={colors.accent} /> : null}
          {channels.length > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{expanded: channelPickerOpen, disabled: navigationLocked}}
              disabled={navigationLocked}
              onPress={() => setChannelPickerOpen(current => !current)}
              style={[styles.channelToggle, navigationLocked && styles.dimmed]}
              testID="simple-channel-toggle">
              <Text style={styles.channelToggleText}>
                القناة: {CHANNEL_TITLES[channel]}
              </Text>
              <Icon
                name={channelPickerOpen ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={colors.textSecondary}
              />
            </Pressable>
          ) : null}
          {channelPickerOpen ? (
            <View style={styles.optionChoices}>
              {channels.map(item => (
                <Pressable
                  key={item}
                  accessibilityRole="radio"
                  accessibilityState={{selected: item === channel, disabled: navigationLocked}}
                  disabled={navigationLocked}
                  onPress={() => {
                    setChannel(item);
                    setSelectedRelease(defaultReleaseForChannel(releases, item));
                    setChannelPickerOpen(false);
                  }}
                  style={[styles.choice, item === channel && styles.choiceSelected]}
                  testID={`simple-channel-${item}`}>
                  <Text style={[styles.choiceText, item === channel && styles.choiceTextSelected]}>
                    {CHANNEL_TITLES[item]}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {noStableForTarget ? (
            <Text style={styles.helper} testID="simple-no-stable">
              لا يوجد إصدار مستقر لهذه اللوحة. القناة المعروضة هي {CHANNEL_TITLES[channel]}.
            </Text>
          ) : null}
          {/* A NUMBERED STEP WITH NOTHING UNDER IT IS NOT A STEP.
              Before a board is chosen - and after a catalogue download
              fails - this card rendered its heading and an empty box:
              no releases, no channel toggle, no sentence. Every other
              step on this screen says what it is waiting for; this one
              silently looked broken. Measured in Chromium at 390 and
              1366 with the build server unreachable. */}
          {channelReleases.length === 0 && !releasesLoading ? (
            <Text style={styles.helper} testID="simple-release-placeholder">
              {selectedTarget
                ? 'لا توجد إصدارات معروضة لهذه اللوحة في القناة الحالية.'
                : 'اختر اللوحة أولًا لعرض الإصدارات المتاحة.'}
            </Text>
          ) : null}
          <View style={styles.releaseWrap}>
            {channelReleases.slice(0, 6).map(release => {
              const selected = release.release === selectedRelease;
              return (
                <Pressable
                  key={release.release}
                  accessibilityRole="radio"
                  accessibilityState={{selected, disabled: navigationLocked}}
                  onPress={() => setSelectedRelease(release.release)}
                  disabled={navigationLocked}
                  style={[
                    styles.choice,
                    selected && styles.choiceSelected,
                    navigationLocked && styles.dimmed,
                  ]}
                  testID={`simple-release-${release.release}`}>
                  <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
                    {release.release}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* 3 — the official build configuration */}
        <View style={styles.card} testID="simple-build-configuration">
          <StepHeader number="٣" title="إعدادات البناء" />
          {buildOptionsLoading ? <ActivityIndicator color={colors.accent} /> : null}
          {!selectedRelease ? (
            <Text style={styles.helper}>اختر اللوحة والإصدار لعرض خيارات البناء الرسمية.</Text>
          ) : null}
          {buildOptionsError !== null ? (
            <Text style={styles.helper} testID="simple-build-options-error">
              تعذّر تحميل خيارات البناء لهذا الإصدار؛ سيُستخدم البناء الأساسي (Core).
            </Text>
          ) : null}
          {selectedRelease && !buildOptionsLoading && buildOptionsError === null && !configurable ? (
            <Text style={styles.helper} testID="simple-core-build-only">
              هذا الإصدار يوفّر بناءً أساسياً (Core) فقط لهذه اللوحة؛ لا توجد خيارات قابلة للتغيير.
            </Text>
          ) : null}
          {configurable && choices !== null && buildOptions !== null ? (
            <>
              {categories.map(category =>
                category.kind === 'multi' ? (
                  <MultiChoiceGroup
                    key={category.key}
                    title={BUILD_CATEGORY_TITLES[category.key]}
                    options={category.options}
                    values={choices.generalOptions}
                    disabled={navigationLocked}
                    testIDPrefix={`simple-build-${category.key}`}
                    onToggle={value =>
                      updateChoices({
                        ...choices,
                        generalOptions: choices.generalOptions.includes(value)
                          ? choices.generalOptions.filter(item => item !== value)
                          : [...choices.generalOptions, value],
                      })
                    }
                  />
                ) : (
                  <SingleChoiceGroup
                    key={category.key}
                    title={BUILD_CATEGORY_TITLES[category.key]}
                    options={category.options}
                    value={
                      category.key === 'radio'
                        ? choices.radioProtocol
                        : category.key === 'telemetry'
                          ? choices.telemetryProtocol
                          : category.key === 'osd'
                            ? choices.osdProtocol
                            : choices.motorProtocol
                    }
                    disabled={navigationLocked}
                    testIDPrefix={`simple-build-${category.key}`}
                    lockedLabel={
                      category.key === 'telemetry' && radioCarriesTelemetry
                        ? 'مضمّن تلقائياً مع بروتوكول الراديو'
                        : undefined
                    }
                    lockedReason={
                      category.key === 'telemetry' && radioCarriesTelemetry
                        ? 'بروتوكول الراديو المحدد يوفّر Telemetry بنفسه. غيّر «بروتوكول الراديو» لفتح هذا الخيار.'
                        : undefined
                    }
                    onChange={value =>
                      updateChoices({
                        ...choices,
                        ...(category.key === 'radio'
                          ? {radioProtocol: value}
                          : category.key === 'telemetry'
                            ? {telemetryProtocol: value}
                            : category.key === 'osd'
                              ? {osdProtocol: value}
                              : {motorProtocol: value}),
                      })
                    }
                  />
                ),
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{expanded: customDefinesOpen, disabled: navigationLocked}}
                disabled={navigationLocked}
                onPress={() => setCustomDefinesOpen(current => !current)}
                style={[styles.optionHeader, navigationLocked && styles.dimmed]}
                testID="simple-custom-defines-toggle">
                <View style={styles.optionCopy}>
                  <Text style={styles.optionLabel}>Custom Defines</Text>
                  <Text style={styles.optionValue}>
                    {choices.customDefines.trim().length === 0 ? 'بدون' : choices.customDefines.trim()}
                  </Text>
                </View>
                <Icon
                  name={customDefinesOpen ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={colors.textSecondary}
                />
              </Pressable>
              {customDefinesOpen ? (
                <TextInput
                  value={choices.customDefines}
                  onChangeText={value => updateChoices({...choices, customDefines: value})}
                  editable={!navigationLocked}
                  placeholder="مثال: USE_SOMETHING USE_OTHER=1"
                  placeholderTextColor={colors.textMuted}
                  style={styles.definesInput}
                  autoCapitalize="characters"
                  testID="simple-custom-defines"
                />
              ) : null}
            </>
          ) : null}
        </View>

        {/* 4 — prepare */}
        <View style={styles.card}>
          <StepHeader number="٤" title="تحضير Firmware" />
          {/* Downloading a build is reversible and repeatable, so it is
              a normal action - deliberately NOT the same mint slab the
              irreversible write used to share with it. */}
          <FirmwareButton
            title={phase === 'loading'
              ? 'جارٍ التحضير…'
              : firmware
                ? 'إعادة تحضير Firmware'
                : 'تحضير Firmware'}
            tone="secondary"
            size="compact"
            onPress={() => loadFirmware().catch(() => undefined)}
            disabled={navigationLocked || !selectedTarget || !selectedRelease || choices === null}
            testID="simple-load-firmware"
          />
          {firmware ? (
            <Text style={styles.readyText} testID="simple-firmware-ready">
              جاهز: {firmware.filename}
            </Text>
          ) : null}
        </View>

        {/* 5 — DFU + flash.
            ONE readiness line, at most ONE warning, ONE dominant
            destructive action, and the result right next to it. The
            warning wall this used to render - readiness, manual-DFU
            notice, acknowledgement pill, safety line and footer, all at
            equal weight around the primary action - is what buried the
            thing the operator actually came here to press. */}
        <View style={styles.card}>
          <StepHeader number="٥" title="التفليش" />
          {isBusy ? <FirmwareProgress percent={progress} label={status} /> : null}

          {phase === 'success' ? (
            <View testID="simple-flash-success">
              <FirmwareNotice
                title="تمت كتابة Firmware والتحقق منه بنجاح"
                text={
                  resetConfirmed === true
                    ? 'أعادت اللوحة الاتصال بنجاح.'
                    : 'لم نتمكن من تأكيد عودة اللوحة تلقائيًا. إن لم تظهر خلال لحظات، افصل USB وأعد توصيله.'
                }
                tone="success"
              />
            </View>
          ) : null}
          {phase === 'failed' ? (
            <FirmwareNotice title="فشل التفليش" text={status} tone="error" />
          ) : null}
          {phase === 'unconfirmed' ? (
            <FirmwareNotice
              title="تعذر تأكيد اكتمال العملية"
              text={status}
              tone="warning"
            />
          ) : null}

          {/* The DFU phase in one line, with the identity caveat as a
              plain warning rather than a gate. */}
          {dfuReady !== null ? (
            <Text style={styles.detected} testID="simple-dfu-ready">
              {dfuTargetVerified
                ? 'اللوحة في وضع DFU وهويتها مطابقة للـ Target المحدد.'
                : 'اللوحة في وضع DFU. لا يمكن قراءة هويتها هناك، فتأكد أن Target صحيح.'}
            </Text>
          ) : null}

          <View style={styles.actionRow}>
            {dfuReady === null ? (
              <FirmwareButton
                title="الدخول إلى وضع DFU"
                tone="secondary"
                size="compact"
                onPress={() => enterDfuMode().catch(() => undefined)}
                disabled={navigationLocked}
                testID="simple-enter-dfu"
              />
            ) : null}
            {/* The one-press browser chooser is a FIRST-CLASS path, not an
                error remedy: a board already in DFU (manual BOOT entry, a
                previous session, a replug) has no serial device to detect.
                Android needs no chooser - the presence watcher adopts any
                DFU device automatically. */}
            {supportsSerialPicker && dfuReady === null && phase !== 'waiting-permission' ? (
              <FirmwareButton
                title="اختيار جهاز DFU"
                tone="secondary"
                size="compact"
                onPress={chooseDfuDevice}
                disabled={navigationLocked}
                testID="simple-choose-dfu-device"
              />
            ) : null}
            {isBusy || phase === 'waiting-permission' ? (
              <FirmwareButton
                title={phase === 'waiting-permission' ? 'إلغاء قبل بدء الكتابة' : 'إلغاء'}
                tone="secondary"
                size="compact"
                onPress={cancel}
                testID="simple-cancel-flash"
              />
            ) : null}
          </View>

          {manualDfuReason !== null ? (
            <View testID="simple-manual-dfu">
              <FirmwareNotice title="وضع DFU" text={manualDfuReason} tone="warning" />
            </View>
          ) : null}

          {phase === 'waiting-permission' ? (
            <>
              <FirmwareNotice
                title="اختر جهاز DFU"
                text="تم تجهيز Firmware واللوحة دخلت DFU ولم تبدأ الكتابة بعد. اختر جهاز DFU للمتابعة من نفس العملية."
              />
              <FirmwareButton
                title="اختيار جهاز DFU والمتابعة"
                onPress={chooseDfuAndContinue}
                testID="simple-choose-dfu"
              />
            </>
          ) : (
            /* THE destructive action: the only danger-toned control on
               the screen, and the only one that writes the board. */
            <FirmwareButton
              title={phase === 'flashing' ? 'التفليش جارٍ…' : 'تفليش Firmware'}
              tone="danger"
              onPress={confirmFlash}
              disabled={navigationLocked || !flashable}
              testID="simple-flash-firmware"
            />
          )}

          {firmware !== null && phase === 'ready' ? (
            <Text style={styles.helper} testID="simple-flash-safety">
              أزل المراوح قبل التفليش، واترك USB موصولاً حتى تظهر النتيجة النهائية.
            </Text>
          ) : null}
        </View>

        <Text style={styles.footerNote}>
          المسح الكامل و Baud اليدوي وأدوات الاسترداد وملفات Firmware المحلية في «متقدم».
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  header: {
    minHeight: 68,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.backgroundRaised,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  backButton: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  headerCopy: {flex: 1},
  title: {...typography.title, color: colors.textPrimary},
  subtitle: {...typography.caption, color: colors.textSecondary, maxWidth: PROSE_MEASURE},
  advancedLink: {minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm},
  advancedLinkText: {...typography.caption, color: colors.accentStrong, fontWeight: '700'},
  scroll: {flex: 1},
  content: {
    padding: spacing.md,
    gap: spacing.md,
    paddingBottom: spacing.xl,
    // Capped by useContentEnvelope at render time and centred, so cards
    // stop spanning the whole width of a desktop window.
    width: '100%',
    alignSelf: 'center',
  },
  /** Supporting actions sit on one wrapping row, sized to their labels. */
  actionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  /* Trails the notice rather than stretching under it: this is a
     secondary recovery, not the page's main action. */
  problemActionRow: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    paddingTop: spacing.sm,
  },
  lockedNote: {...typography.caption, color: colors.textSecondary, maxWidth: PROSE_MEASURE},
  advancedLoading: {paddingVertical: spacing.xl, alignItems: 'center'},
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.lg,
    gap: spacing.md,
  },
  stepHeader: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  stepNumberText: {...typography.caption, color: colors.accentStrong, fontWeight: '800'},
  stepTitle: {...typography.sectionTitle, color: colors.textPrimary},
  selector: {
    minHeight: 58,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
  },
  selectorLabel: {...typography.caption, color: colors.textMuted},
  selectorValue: {...typography.sectionTitle, color: colors.textPrimary},
  detected: {...typography.caption, color: colors.success},
  helper: {...typography.caption, color: colors.textSecondary, maxWidth: PROSE_MEASURE},
  channelToggle: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  channelToggleText: {...typography.caption, color: colors.textSecondary, fontWeight: '700'},
  optionGroup: {gap: spacing.sm},
  optionHeader: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  optionCopy: {flex: 1, gap: 2},
  optionLabel: {...typography.caption, color: colors.textMuted},
  optionValue: {...typography.bodyStrong, color: colors.textPrimary},
  optionChoices: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  releaseWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  choice: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  choiceSelected: {backgroundColor: colors.accentSoft, borderColor: colors.accent},
  choiceText: {...typography.caption, color: colors.textSecondary, fontWeight: '700'},
  choiceTextSelected: {color: colors.accentStrong},
  definesInput: {
    minHeight: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    fontFamily: 'Cairo',
    textAlign: 'left',
    writingDirection: 'ltr',
  },
  readyText: {...typography.caption, color: colors.success},
  footerNote: {...typography.caption, color: colors.textMuted, textAlign: 'center'},
  modal: {flex: 1, backgroundColor: colors.background, padding: spacing.md, gap: spacing.md},
  modalHeader: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  modalTitle: {...typography.title, color: colors.textPrimary, flex: 1},
  closeButton: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  closeText: {fontSize: 30, color: colors.textPrimary},
  search: {
    minHeight: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    fontFamily: 'Cairo',
    textAlign: 'right',
  },
  targetRow: {
    minHeight: 58,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  targetName: {...typography.sectionTitle, color: colors.textPrimary},
  targetMeta: {...typography.caption, color: colors.textSecondary},
  dimmed: {opacity: 0.5},
  advancedRoot: {flex: 1, backgroundColor: colors.background},
  advancedBar: {padding: spacing.sm, backgroundColor: colors.backgroundRaised},
  advancedBody: {flex: 1},
});
