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
  isSupportedDevice,
  usbSerialTransportClient,
} from '../../platforms/react-native/transport';
import type {
  DfuDeviceDescriptor,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';
import {useTranslation} from 'react-i18next';
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
import {FirmwareButton, FirmwareNotice, FirmwareProgress} from '../components/firmware';
import {colors, radii, spacing, typography} from '../theme';
import {Icon} from '../icons';

import FirmwareFlasherScreen from './FirmwareFlasherScreen';

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
  | 'unconfirmed';

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
 * THE STANDARD SCREEN'S TERMINAL-FAILURE TRUTH, pure and exported for tests.
 *
 * Maps a settled rejection onto the SAME contract the classic screen and
 * the WebUSB engine share (flashCompletionModel): the engine's frozen-
 * attempt codes and Android's manifestation-window DFU_STATUS_TIMEOUT
 * become the honest UNCONFIRMED third result with a safe next action;
 * everything else is a FAILED with its real stated reason. Never SUCCESS:
 * a rejection carries no completion evidence.
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
}: {
  readonly title: string;
  readonly options: readonly FirmwareBuildOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly testIDPrefix: string;
  readonly lockedLabel?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  const summary = lockedLabel ?? selected?.name ?? 'بدون';
  const locked = lockedLabel !== undefined;
  return (
    <View style={styles.optionGroup} testID={`${testIDPrefix}-group`}>
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

  /** A board this session put into DFU after verifying its identity. */
  const [dfuReady, setDfuReady] = useState<DfuDeviceDescriptor | null>(null);
  const [dfuTargetVerified, setDfuTargetVerified] = useState(false);
  /** Set only when software bootloader entry is genuinely unavailable. */
  const [manualDfuReason, setManualDfuReason] = useState<string | null>(null);
  const [unverifiedDfuAccepted, setUnverifiedDfuAccepted] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  /** The last engine-reported phase - what classifyFlashRejection needs
   * to tell Android's manifestation-window timeout from an early one. */
  const lastFlashPhaseRef = useRef<FlashPhase | undefined>(undefined);
  const bootloader = useMemo(() => new FirmwareBootloaderController(client), [client]);
  const cloudBuild = useMemo(() => new CloudBuildCoordinator(betaflightBuildApi), []);
  const supportsSerialPicker = useMemo(() => client.supportsDevicePicker(), [client]);
  const isBusy = ['detecting', 'loading', 'flashing'].includes(phase);
  const navigationLocked = simpleFlasherNavigationLocked(phase);

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

  const fail = useCallback((reason: unknown) => {
    const presentation = simpleFailurePresentation(
      reason,
      lastFlashPhaseRef.current,
      t,
    );
    setPhase(presentation.phase);
    setStatus(presentation.text);
  }, [t]);

  /* ---- Catalogue: the official dataset, unfiltered ---- */
  useEffect(() => {
    const controller = new AbortController();
    setTargetsLoading(true);
    betaflightBuildApi.loadTargets(controller.signal)
      .then(items => {
        if (!controller.signal.aborted) setTargets(items);
      })
      .catch(reason => {
        if (!controller.signal.aborted) fail(reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setTargetsLoading(false);
      });
    return () => controller.abort();
  }, [fail]);

  /* ---- Releases for the chosen board ---- */
  useEffect(() => {
    if (!selectedTarget) {
      setReleases([]);
      setSelectedRelease('');
      setFirmware(null);
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
        if (!controller.signal.aborted) fail(reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReleasesLoading(false);
      });
    return () => controller.abort();
  }, [fail, selectedTarget]);

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
    })().catch(reason => {
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
      setBuildOptionsError(errorText(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setBuildOptionsLoading(false);
    });
    return () => controller.abort();
  }, [selectedRelease, selectedTarget]);

  /* ---- Live flash progress ---- */
  useEffect(() => client.onDfuFlashProgress(update => {
    if (phase !== 'flashing') return;
    lastFlashPhaseRef.current = toFlashPhase(update.phase);
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
  }), [client, phase]);

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
    setDfuReady(null);
    setDfuTargetVerified(false);
    setUnverifiedDfuAccepted(false);
    setProgress(0);
    setPhase('idle');
    setStatus('اختر الإصدار ثم راجع إعدادات البناء.');
  }, [navigationLocked]);

  /** Enumerates exactly one usable serial board, or says why not. */
  const requireSingleSerialDevice = useCallback(async () => {
    const devices = (await client.listDevices()).filter(isSupportedDevice);
    if (devices.length === 0) {
      throw new Error(
        supportsSerialPicker
          ? 'لم يُسمح للمتصفح بالوصول إلى اللوحة بعد. اضغط «اختيار جهاز USB» أولاً.'
          : 'لم يُعثر على Flight Controller متصل. وصّل اللوحة عبر USB ثم أعد المحاولة.',
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
        const target = identity.board.targetName ||
          identity.board.boardName ||
          identity.board.boardIdentifier;
        const match = targets.find(item => item.target.toUpperCase() === target.toUpperCase());
        if (!match) {
          // Honest, and still usable: the board answered, its identity is
          // simply not a catalogue target, so manual selection stands.
          setDetectedTarget(target);
          setPhase('idle');
          setDetectionNote(
            `تم التعرف على ${target}، لكنه غير موجود في قائمة Targets الرسمية. اختر Target يدويًا.`,
          );
          setStatus(`تم التعرف على ${target}. اختر Target يدويًا.`);
          return;
        }
        setDetectedTarget(match.target);
        setSelectedTarget(match.target);
        setPhase('idle');
        setStatus(`تم التعرف على اللوحة ${match.target}.`);
      } finally {
        await detected.release();
      }
    } catch (reason) {
      if (!controller.signal.aborted) fail(reason);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [bootloader, fail, navigationLocked, requireSingleSerialDevice, targets]);

  const chooseSerialAndDetect = useCallback(() => {
    if (navigationLocked) return;
    // Web Serial's chooser must be opened directly by this press.
    client.requestDevicePermission()
      .then(device => {
        if (device === null) return;
        setStatus('تم السماح بالوصول إلى USB. جارٍ التعرف على اللوحة…');
        autoDetect().catch(() => undefined);
      })
      .catch(fail);
  }, [autoDetect, client, fail, navigationLocked]);

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
      if (!controller.signal.aborted) fail(reason);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [
    choices,
    cloudBuild,
    fail,
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
    setProgress(0);
    // A stale phase from an earlier attempt must not classify this one.
    lastFlashPhaseRef.current = undefined;
    setStatus('بدء تفليش Firmware…');
    try {
      await client.flashDfuFirmware(dfu.deviceId, bytesToBase64(image.bytes), false);
      setProgress(100);
      setPhase('success');
      setStatus('تم تثبيت Firmware بنجاح.');
      setPendingFlash(null);
      setDfuReady(null);
      setDfuTargetVerified(false);
    } catch (reason) {
      fail(reason);
    }
  }, [client, fail]);

  /**
   * ENTER DFU. The operator should not have to know about the BOOT
   * button when the board can be rebooted in software. This verifies the
   * board first, sends the genuine MSP reboot-to-bootloader, then waits
   * for the DFU identity to appear. When the firmware family does not
   * support it, the screen says so instead of showing a button that
   * cannot work.
   */
  const enterDfuMode = useCallback(async () => {
    if (navigationLocked) return;
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
        const actual = detected.identity.board.targetName || detected.identity.board.boardName;
        await detected.release();
        throw new Error(`Target المحدد ${selectedTarget} لا يطابق اللوحة ${actual}. صحّح Target قبل المتابعة.`);
      }
      if (detected.identity.firmware.knownFamily !== 'BETAFLIGHT') {
        await detected.release();
        setPhase('idle');
        setManualDfuReason(
          'هذا Firmware لا يدعم إعادة التشغيل البرمجية إلى وضع DFU. ادخل وضع DFU يدويًا ثم اختر جهاز DFU.',
        );
        setStatus('يلزم الدخول اليدوي إلى وضع DFU.');
        return;
      }
      setDetectedTarget(
        detected.identity.board.targetName || detected.identity.board.boardName,
      );
      await detected.rebootToBootloader(selectedTarget, false);
      setStatus('أُرسل أمر إعادة التشغيل. انتظار ظهور وضع DFU…');
      try {
        const dfu = await bootloader.waitForOneDfuDevice(20_000, controller.signal);
        setDfuReady(dfu);
        setDfuTargetVerified(true);
        setPhase(firmware ? 'ready' : 'idle');
        setStatus('اللوحة الآن في وضع DFU وجاهزة للتفليش.');
      } catch (reason) {
        if (!(reason instanceof DfuPermissionRequiredError)) throw reason;
        // The board IS in DFU; the browser has simply never been told it
        // may talk to this identity. Ask once, from a real press.
        setPhase('idle');
        setDfuTargetVerified(true);
        setManualDfuReason(
          'اللوحة دخلت وضع DFU. اضغط «اختيار جهاز DFU» مرة واحدة للسماح للمتصفح بالتعامل معها.',
        );
        setStatus('اللوحة في وضع DFU وتنتظر إذن المتصفح.');
      }
    } catch (reason) {
      if (!controller.signal.aborted) fail(reason);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [
    bootloader,
    fail,
    firmware,
    navigationLocked,
    requireSingleSerialDevice,
    selectedTarget,
  ]);

  /** The browser's one-time WebUSB chooser, straight from the press. */
  const chooseDfuDevice = useCallback(() => {
    if (navigationLocked) return;
    client.requestDfuDevicePermission()
      .then(device => {
        if (device === null) return;
        setDfuReady(device);
        setManualDfuReason(null);
        setStatus('تم اختيار جهاز DFU. يمكنك الآن التفليش.');
      })
      .catch(fail);
  }, [client, fail, navigationLocked]);

  const flashPreparedFirmware = useCallback(async () => {
    if (!firmware || navigationLocked) return;
    if (firmware.kind !== 'HEX') {
      setPhase('failed');
      setStatus('الوضع القياسي مخصص لـ Betaflight HEX. استخدم «متقدم» للأنواع الأخرى.');
      return;
    }
    // Already in DFU from this session (or explicitly chosen): flash it.
    if (dfuReady !== null) {
      if (!dfuTargetVerified && !unverifiedDfuAccepted) {
        setPhase('failed');
        setStatus('اللوحة في وضع DFU ولا يمكن قراءة هويتها. أكّد مطابقة Target أولاً.');
        return;
      }
      await completeFlash(dfuReady, firmware);
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
        const actual = detected.identity.board.targetName || detected.identity.board.boardName;
        await detected.release();
        throw new Error(`تم إيقاف التفليش: Target ${selectedTarget} لا يطابق اللوحة ${actual}.`);
      }
      setDetectedTarget(selectedTarget);
      await detected.rebootToBootloader(selectedTarget, false);
      setStatus('انتظار وضع DFU…');
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
        setStatus('اللوحة دخلت وضع DFU. اختر جهاز DFU مرة واحدة للمتابعة.');
      }
    } catch (reason) {
      if (!controller.signal.aborted) fail(reason);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [
    bootloader,
    completeFlash,
    dfuReady,
    dfuTargetVerified,
    fail,
    firmware,
    navigationLocked,
    requireSingleSerialDevice,
    selectedTarget,
    unverifiedDfuAccepted,
  ]);

  const chooseDfuAndContinue = useCallback(() => {
    if (!pendingFlash || phase !== 'waiting-permission') return;
    client.requestDfuDevicePermission()
      .then(async device => {
        const verdict = verifySelectedDfuDevice(
          device,
          pendingFlash.pending,
          pendingFlash.pending.operationId,
        );
        if (!verdict.ok || device === null) {
          throw new Error('جهاز DFU المختار غير صالح لهذه العملية. اختر Flight Controller الصحيح.');
        }
        await completeFlash(device, pendingFlash.image);
      })
      .catch(fail);
  }, [client, completeFlash, fail, pendingFlash, phase]);

  const confirmFlash = useCallback(() => {
    if (!firmware || navigationLocked) return;
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
  }, [firmware, flashPreparedFirmware, navigationLocked, selectedRelease, selectedTarget]);

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
          <FirmwareButton
            title="العودة إلى الوضع القياسي"
            tone="secondary"
            onPress={() => setAdvanced(false)}
            testID="flasher-simple-mode"
          />
        </View>
        <View style={styles.advancedBody}>
          <FirmwareFlasherScreen navigation={navigation} />
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="العودة"
          onPress={() => navigation?.goBack()}
          disabled={navigationLocked}
          style={[styles.backButton, navigationLocked && styles.dimmed]}>
          <Icon name="chevron-back" size={24} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Firmware Flasher</Text>
          <Text style={styles.subtitle}>اللوحة · الإصدار · الإعدادات · التفليش</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setAdvanced(true)}
          disabled={navigationLocked}
          style={[styles.advancedLink, navigationLocked && styles.dimmed]}
          testID="flasher-advanced-mode">
          <Text style={styles.advancedLinkText}>متقدم</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        {/* 1 — the board */}
        <View style={styles.card}>
          <StepHeader number="١" title="اللوحة" />
          {supportsSerialPicker ? (
            <FirmwareButton
              title="اختيار جهاز USB"
              tone="secondary"
              onPress={chooseSerialAndDetect}
              disabled={navigationLocked}
              testID="simple-choose-serial"
            />
          ) : null}
          <FirmwareButton
            title={phase === 'detecting' ? 'جارٍ التعرف…' : 'التعرف على اللوحة المتصلة'}
            tone="secondary"
            onPress={() => autoDetect().catch(() => undefined)}
            disabled={navigationLocked || targetsLoading}
            testID="simple-auto-detect"
          />
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
              تعذّر تحميل خيارات البناء لهذا الإصدار؛ سيُستخدم البناء الأساسي (Core). {buildOptionsError}
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
          <FirmwareButton
            title={phase === 'loading'
              ? 'جارٍ التحضير…'
              : firmware
                ? 'إعادة تحضير Firmware'
                : 'تحضير Firmware'}
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

        {/* 5 — DFU + flash */}
        <View style={styles.card}>
          <StepHeader number="٥" title="التفليش" />
          {isBusy ? <FirmwareProgress percent={progress} label={status} /> : null}

          {phase === 'success' ? (
            <FirmwareNotice
              title="تم تثبيت Firmware بنجاح"
              text="اكتملت الكتابة والتحقق بالقراءة الراجعة، وأعادت اللوحة التشغيل."
              tone="success"
            />
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

          {dfuReady !== null ? (
            <Text style={styles.detected} testID="simple-dfu-ready">
              اللوحة في وضع DFU وجاهزة للتفليش.
            </Text>
          ) : (
            <FirmwareButton
              title="الدخول إلى وضع DFU"
              tone="secondary"
              onPress={() => enterDfuMode().catch(() => undefined)}
              disabled={navigationLocked}
              testID="simple-enter-dfu"
            />
          )}
          {manualDfuReason !== null ? (
            <View testID="simple-manual-dfu">
              <FirmwareNotice title="وضع DFU" text={manualDfuReason} tone="warning" />
              {supportsSerialPicker ? (
                <FirmwareButton
                  title="اختيار جهاز DFU"
                  tone="secondary"
                  onPress={chooseDfuDevice}
                  disabled={navigationLocked}
                  testID="simple-choose-dfu-device"
                />
              ) : null}
            </View>
          ) : null}
          {dfuReady !== null && !dfuTargetVerified ? (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{checked: unverifiedDfuAccepted, disabled: navigationLocked}}
              disabled={navigationLocked}
              onPress={() => setUnverifiedDfuAccepted(current => !current)}
              style={[styles.choice, unverifiedDfuAccepted && styles.choiceSelected]}
              testID="simple-accept-unverified-dfu">
              <Text style={styles.choiceText}>
                أؤكد أن Target مطابق (لا يمكن قراءة الهوية في وضع DFU)
              </Text>
            </Pressable>
          ) : null}

          {phase === 'waiting-permission' ? (
            <>
              <FirmwareNotice
                title="اختر جهاز DFU"
                text="اللوحة دخلت DFU ولم تبدأ الكتابة بعد. اخترها مرة واحدة لمتابعة نفس العملية."
              />
              <FirmwareButton
                title="اختيار جهاز DFU والمتابعة"
                onPress={chooseDfuAndContinue}
                testID="simple-choose-dfu"
              />
            </>
          ) : (
            <FirmwareButton
              title={phase === 'flashing' ? 'التفليش جارٍ…' : 'تفليش Firmware'}
              onPress={confirmFlash}
              disabled={navigationLocked || firmware === null}
              testID="simple-flash-firmware"
            />
          )}

          {isBusy || phase === 'waiting-permission' ? (
            <FirmwareButton
              title={phase === 'waiting-permission' ? 'إلغاء قبل بدء الكتابة' : 'إلغاء'}
              tone="secondary"
              onPress={cancel}
              testID="simple-cancel-flash"
            />
          ) : null}
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
  subtitle: {...typography.caption, color: colors.textSecondary},
  advancedLink: {minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm},
  advancedLinkText: {...typography.caption, color: colors.accentStrong, fontWeight: '700'},
  scroll: {flex: 1},
  content: {padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl},
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
  helper: {...typography.caption, color: colors.textSecondary},
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
