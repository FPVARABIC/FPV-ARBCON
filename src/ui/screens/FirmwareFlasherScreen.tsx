import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  MAX_UNIFIED_CONFIG_BYTES,
  applyCustomDefaultsToFirmware,
  betaflightBuildApi,
  createBuildRequest,
  filterAndSortTargets,
  parseBuildOptions,
  parseCommits,
  parseFirmwareFile,
  parseTargetDetail,
  parseTargetReleases,
  parseUnifiedConfigText,
} from '../../core/firmware-flasher';
import type {
  BetaflightBuildApi,
  BetaflightTarget,
  FirmwareBuildOption,
  FirmwareBuildOptions,
  FirmwareCommit,
  FirmwareImage,
  FirmwareRelease,
  FirmwareTargetDetail,
} from '../../core/firmware-flasher';
import type {
  DfuDeviceDescriptor,
  UsbSerialDeviceDescriptor,
} from '../../platforms/react-native/transport';
import {
  isSupportedDevice,
  usbSerialTransportClient,
} from '../../platforms/react-native/transport';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import {
  FirmwareBootloaderController,
  FirmwareDetectionError,
} from '../../platforms/react-native/protocol/FirmwareBootloaderController';
import {CliBackupService, isPlausibleCliBackup} from '../../platforms/react-native/protocol/CliBackupService';
import {EspFirmwareFlasher} from '../../platforms/react-native/protocol/EspFirmwareFlasher';
import {ReactNativeSerialPort} from '../../platforms/react-native/protocol/ReactNativeSerialPort';
import {Stm32SerialFlasher} from '../../platforms/react-native/protocol/Stm32SerialFlasher';
import {
  base64ToBytesAsync,
  bytesToBase64,
} from '../../platforms/react-native/protocol/base64';
import {
  FirmwareButton,
  FirmwareChoice,
  FirmwareNotice,
  FirmwareProgress,
  FirmwareSection,
  FirmwareToggle,
} from '../components/firmware';
import {
  firmwareFamilyLabel,
  firmwareFilenameLabel,
  sanitizeUserVisibleText,
  usbProductLabel,
} from '../presentation/brandSafeText';
import {colors, radii, spacing, typography} from '../theme';
import {Icon} from '../icons';
import {useTranslation} from 'react-i18next';
import {copyPlainTextToClipboard} from '../../platforms/clipboard';
import {
  buildFlashReport,
  evaluateFlashStall,
  flashPhaseLabelKey,
  toFlashPhase,
} from '../../core/firmware-flasher/flashPhaseModel';
import {
  FLASH_CODE_NEVER_STARTED,
  FLASH_CODE_UI_BACKSTOP,
  classifyFlashRejection,
  flashNextActionLabelKey,
  flashReasonLabelKey,
} from '../../core/firmware-flasher/flashCompletionModel';
import type {FlashOutcomeKind} from '../../core/firmware-flasher/flashCompletionModel';
import {
  bootloaderStateLabelKey,
  canResumePendingFlash,
  dfuRejectionLabelKey,
  verifySelectedDfuDevice,
} from '../../core/firmware-flasher/bootloaderTransition';
import type {
  BootloaderTransitionState,
  DfuIdentity,
  PendingBootloaderFlash,
} from '../../core/firmware-flasher/bootloaderTransition';
import {DfuPermissionRequiredError} from '../../platforms/react-native/protocol/FirmwareBootloaderController';
import type {
  FlashMethod,
  FlashProgressSnapshot,
} from '../../core/firmware-flasher/flashPhaseModel';

type ScreenDependencies = {
  readonly client?: UsbSerialTransportClient;
  /**
   * Reports whether a destructive operation is in flight, so a host that
   * embeds this screen can refuse to unmount it mid-write instead of
   * silently aborting the flash.
   */
  readonly onBusyChange?: (busy: boolean) => void;
  readonly buildApi?: BetaflightBuildApi;
};
type Props = Partial<NativeStackScreenProps<RootStackParamList, 'FirmwareFlasher'>> & ScreenDependencies;

type Step = 'board' | 'flash';
type SourceMode = 'online' | 'local';
type HexMethod = 'dfu' | 'serial';
type BackupMode = 'ask' | 'always' | 'never';
type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type Operation =
  | 'idle'
  | 'loading'
  | 'detecting'
  | 'building'
  | 'saving'
  | 'backing-up'
  | 'flashing'
  | 'restoring'
  | 'success'
  | 'error'
  /** Terminal: the attempt was frozen without enough evidence to claim
   * SUCCESS or FAILED. Never silently pending - always says so. */
  | 'unconfirmed';

/** The restore half of the two separate truths a flash attempt records. */
type FlashRestoreTruth = {
  readonly kind: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  readonly detail?: string;
};

/**
 * THE VISIBLE RESULT CONTRACT. Exactly one of these is rendered when an
 * attempt ends, next to the progress bar: a real success, a real failure
 * with its stated reason, or an honest "could not confirm" with a safe
 * next step. `restore` is the SEPARATE post-flash settings-restore truth:
 * a restore failure never rewrites a verified flash into a failure.
 */
type FlashResultPresentation = {
  readonly kind: FlashOutcomeKind;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly restore?: FlashRestoreTruth;
};

/** What a flash method hands back to startFlash. `completed: false`
 * means the attempt was HELD (browser permission gate) - nothing was
 * flashed and nothing may be claimed. */
type FlashMethodOutcome = {
  readonly completed: boolean;
  readonly backup: string | null;
};

/** A held DfuSe operation now carries its CLI backup too, so a resumed
 * flash can still restore settings afterwards. */
type PendingFlashImage = {
  readonly bytes: Uint8Array;
  readonly fullErase: boolean;
  readonly backup: string | null;
};

/**
 * The screen's LAST-RESORT terminal backstop. The engines are the real
 * guarantee (WebUSB transfers are bounded observations now; Android's
 * every controlTransfer carries a 5s native timeout) - this only settles
 * the attempt truthfully if an engine itself fails to. 150s of total
 * progress silence sits far above the longest engine observation window
 * (60s) and every advisory stall threshold, so it can never race a
 * working flash. It settles to UNCONFIRMED or records a restore failure;
 * it never claims SUCCESS and never retries anything.
 */
const FLASH_TERMINAL_BACKSTOP_MS = 150_000;

const EMPTY_BUILD_OPTIONS: FirmwareBuildOptions = {
  radioProtocols: [],
  telemetryProtocols: [],
  osdProtocols: [],
  motorProtocols: [],
  generalOptions: [],
};
const MAX_LOG_LINES = 60;
const MAX_CLI_BACKUP_BYTES = 1024 * 1024;
const FLASH_BAUD_RATES = [57600, 115200, 230400, 256000, 460800, 921600] as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  // The transport client rejects with a plain {code, nativeMessage}
  // object (normalizeNativeError strips everything else). Before this
  // was read, every DFU failure displayed the generic fallback below -
  // "no real reason", exactly as the operator reported.
  const native = (error as {nativeMessage?: unknown} | null)?.nativeMessage;
  if (typeof native === 'string' && native.trim().length > 0) {
    return native;
  }
  return 'حدث خطأ غير متوقع في Firmware Flasher.';
}

/** The `code` a rejection carries, whether it is a DfuError (web engine),
 * a normalized TransportError (client boundary), or anything else. */
function errorCode(error: unknown): string | undefined {
  const code = (error as {code?: unknown} | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function firmwareDescription(image: FirmwareImage): string {
  switch (image.kind) {
    case 'HEX':
      return `${image.hex.totalBytes.toLocaleString('ar')} بايت • ${image.hex.segments.length} مناطق • 0x${image.hex.lowestAddress.toString(16)}–0x${image.hex.highestAddressExclusive.toString(16)}`;
    case 'UF2':
      return `${image.uf2.totalPayloadBytes.toLocaleString('ar')} بايت • ${image.uf2.blocks.length} كتل • Family ${image.uf2.familyId === undefined ? 'غير معلن' : `0x${image.uf2.familyId.toString(16)}`}`;
    case 'BIN':
      return `${image.esp.imageBytes.toLocaleString('ar')} بايت • ESP chip ID 0x${image.esp.chipId.toString(16)} • ${image.esp.segmentCount} مقاطع`;
  }
}

function groupLabel(group: string | undefined): string {
  switch (group) {
    case 'supported': return 'شريك موثّق';
    case 'legacy': return 'قديم / Legacy';
    default: return 'مجتمع المصنّع';
  }
}

function releaseLabel(release: FirmwareRelease): string {
  const channel = release.channel === 'stable'
    ? 'مستقر'
    : release.channel === 'candidate'
      ? 'مرشح'
      : 'تطويري';
  return `${release.release} • ${channel}`;
}

function deviceLabel(device: UsbSerialDeviceDescriptor): string {
  const name = usbProductLabel(
    device.productName ?? device.manufacturerName,
    device.driverType,
  );
  return `${name} • ${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
}

function dfuLabel(device: DfuDeviceDescriptor): string {
  const name = usbProductLabel(
    device.productName ?? device.manufacturerName,
    'STM32 DFU',
  );
  return `${name} • ${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
}

/**
 * Android USB device ids can change after a detach/reattach or driver
 * re-enumeration.  A stale id must not make the one physically attached
 * controller look absent.  Recovery is intentionally limited to exactly
 * one candidate; with two devices the operator must choose again.
 */
export function resolveSerialSelection(
  devices: readonly UsbSerialDeviceDescriptor[],
  selectedDeviceId: number | null,
): UsbSerialDeviceDescriptor | undefined {
  const exact =
    selectedDeviceId === null
      ? undefined
      : devices.find(device => device.deviceId === selectedDeviceId);
  return exact ?? (devices.length === 1 ? devices[0] : undefined);
}

export function resolveDfuSelection(
  devices: readonly DfuDeviceDescriptor[],
  selectedDeviceId: number | null,
): DfuDeviceDescriptor | undefined {
  const exact =
    selectedDeviceId === null
      ? undefined
      : devices.find(device => device.deviceId === selectedDeviceId);
  return exact ?? (devices.length === 1 ? devices[0] : undefined);
}

function defaultValue(options: readonly FirmwareBuildOption[]): string {
  return options.find(option => option.default)?.value ?? '';
}

function OptionGroup({
  title,
  options,
  selected,
  onChange,
  disabled = false,
  testIDPrefix,
}: {
  readonly title: string;
  readonly options: readonly FirmwareBuildOption[];
  readonly selected: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly testIDPrefix: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (options.length === 0) return null;
  const choices = [
    ...(options.some(option => option.value === '') ? [] : [{value: '', label: 'بدون'}]),
    ...options.map(option => ({value: option.value, label: option.name})),
  ].filter((choice, index, all) => all.findIndex(candidate => candidate.value === choice.value) === index);
  const selectedLabel = choices.find(choice => choice.value === selected)?.label ?? 'اختر';
  return (
    <View style={styles.optionGroup}>
      <Text style={styles.fieldLabel}>{title}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${selectedLabel}`}
        disabled={disabled}
        testID={`${testIDPrefix}-selector`}
        onPress={() => setOpen(value => !value)}
        accessibilityState={{disabled, expanded: open}}
        style={[styles.selectorButton, disabled && styles.dimmed]}>
        <View style={styles.selectorCopy}>
          <Text style={styles.selectorValue}>{selectedLabel}</Text>
          <Text style={styles.selectorHint}>{open ? 'إخفاء الخيارات' : 'اختيار أو تغيير'}</Text>
        </View>
        <Icon
          name={open ? 'chevron-up' : 'chevron-down'}
          size={20}
          color={colors.textSecondary}
        />
      </Pressable>
      {open ? (
        <FirmwareChoice
          value={selected}
          choices={choices}
          onChange={value => {
            onChange(value);
            setOpen(false);
          }}
          disabled={disabled}
          testIDPrefix={testIDPrefix}
        />
      ) : null}
    </View>
  );
}

function afterInteractions(): Promise<void> {
  return new Promise(resolve => {
    const scheduler = globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void, options?: {timeout: number}) => number;
    };
    if (typeof scheduler.requestIdleCallback === 'function') {
      scheduler.requestIdleCallback(() => resolve(), {timeout: 250});
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export default function FirmwareFlasherScreen({
  navigation,
  client = usbSerialTransportClient,
  buildApi = betaflightBuildApi,
  onBusyChange,
}: Props): React.JSX.Element {
  const {t} = useTranslation();
  const [step, setStep] = useState<Step>('board');
  const [sourceMode, setSourceMode] = useState<SourceMode>('online');
  const [targets, setTargets] = useState<readonly BetaflightTarget[]>([]);
  const [targetsLoadState, setTargetsLoadState] = useState<LoadState>('loading');
  const [targetsLoadError, setTargetsLoadError] = useState<string | null>(null);
  const [targetQuery, setTargetQuery] = useState('');
  const [targetListOpen, setTargetListOpen] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [releases, setReleases] = useState<readonly FirmwareRelease[]>([]);
  const [releasesLoadState, setReleasesLoadState] = useState<LoadState>('idle');
  const [releasesLoadError, setReleasesLoadError] = useState<string | null>(null);
  const [releaseChannel, setReleaseChannel] = useState<FirmwareRelease['channel']>('stable');
  const [releaseListOpen, setReleaseListOpen] = useState(false);
  const [selectedRelease, setSelectedRelease] = useState('');
  const [targetDetail, setTargetDetail] = useState<FirmwareTargetDetail | null>(null);
  const [detailLoadState, setDetailLoadState] = useState<LoadState>('idle');
  const [detailLoadError, setDetailLoadError] = useState<string | null>(null);
  const [buildOptions, setBuildOptions] = useState<FirmwareBuildOptions>(EMPTY_BUILD_OPTIONS);
  const [buildOptionsLoadState, setBuildOptionsLoadState] = useState<LoadState>('idle');
  const [buildOptionsLoadError, setBuildOptionsLoadError] = useState<string | null>(null);
  const [coreBuild, setCoreBuild] = useState(false);
  const [radioProtocol, setRadioProtocol] = useState('');
  const [telemetryProtocol, setTelemetryProtocol] = useState('');
  const [osdProtocol, setOsdProtocol] = useState('');
  const [motorProtocol, setMotorProtocol] = useState('');
  const [generalOptions, setGeneralOptions] = useState<readonly string[]>([]);
  const [generalOptionsExpanded, setGeneralOptionsExpanded] = useState(false);
  const [expertMode, setExpertMode] = useState(false);
  const [osdOmissionConfirmed, setOsdOmissionConfirmed] = useState(false);
  const [customDefines, setCustomDefines] = useState('');
  const [commit, setCommit] = useState('');
  const [commits, setCommits] = useState<readonly FirmwareCommit[]>([]);
  const [firmware, setFirmware] = useState<FirmwareImage | null>(null);
  const [hexMethod, setHexMethod] = useState<HexMethod>('dfu');
  const [configurationLines, setConfigurationLines] = useState<readonly string[] | null>(null);
  const [configurationLabel, setConfigurationLabel] = useState<string | null>(null);

  const [serialDevices, setSerialDevices] = useState<readonly UsbSerialDeviceDescriptor[]>([]);
  const [dfuDevices, setDfuDevices] = useState<readonly DfuDeviceDescriptor[]>([]);
  const [selectedSerialId, setSelectedSerialId] = useState<number | null>(null);
  const [selectedPortIndex, setSelectedPortIndex] = useState(0);
  const [selectedDfuId, setSelectedDfuId] = useState<number | null>(null);
  const [detectedSummary, setDetectedSummary] = useState<string | null>(null);
  const [detectedTarget, setDetectedTarget] = useState<string | null>(null);

  const [fullErase, setFullErase] = useState(false);
  const [noReboot, setNoReboot] = useState(false);
  const [flashOnConnect, setFlashOnConnect] = useState(false);
  const [manualBaud, setManualBaud] = useState(false);
  const [baudRate, setBaudRate] = useState<number>(256000);
  const [backupMode, setBackupMode] = useState<BackupMode>('ask');
  const [backupThisRun, setBackupThisRun] = useState(true);
  const [restoreAfterFlash, setRestoreAfterFlash] = useState(true);

  const [propsRemoved, setPropsRemoved] = useState(false);
  const [usbPowerOnly, setUsbPowerOnly] = useState(false);
  const [manualTargetConfirmed, setManualTargetConfirmed] = useState(false);
  const [targetMismatchOverride, setTargetMismatchOverride] = useState(false);
  const [unstableConfirmed, setUnstableConfirmed] = useState(false);
  const [readUnprotectConfirmed, setReadUnprotectConfirmed] = useState(false);

  const [operation, setOperation] = useState<Operation>('idle');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('اختر Target وإصداراً من الإنترنت أو حمّل ملفاً من الجهاز.');
  const [logLines, setLogLines] = useState<readonly string[]>([]);
  const [buildKey, setBuildKey] = useState<string | null>(null);
  const [buildLogText, setBuildLogText] = useState<string | null>(null);
  const [buildLogLoading, setBuildLogLoading] = useState(false);
  const [showFlashGuide, setShowFlashGuide] = useState(false);
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  const [advancedUsbRecoveryExpanded, setAdvancedUsbRecoveryExpanded] = useState(false);
  const [advancedFlashOptionsExpanded, setAdvancedFlashOptionsExpanded] = useState(false);
  const operationController = useRef<AbortController | null>(null);
  const lastProgressAt = useRef(0);
  const mounted = useRef(true);
  const startFlashRef = useRef<() => Promise<void>>(async () => undefined);
  /**
   * The attempt identity. Bumped when an attempt starts AND when one is
   * terminally settled by the backstop, so a promise that settles LATE -
   * after its attempt was already concluded - is recognized and ignored
   * instead of overwriting a newer attempt's truth.
   */
  const flashAttemptSerial = useRef(0);

  const bootloader = useMemo(() => new FirmwareBootloaderController(client), [client]);
  const cliBackup = useMemo(() => new CliBackupService(client), [client]);
  const cloudBuild = useMemo(() => new CloudBuildCoordinator(buildApi), [buildApi]);

  const appendLog = useCallback((line: string) => {
    const clean = sanitizeUserVisibleText(line.trim());
    if (!clean) return;
    setLogLines(previous => [`${new Date().toLocaleTimeString('ar')} — ${clean}`, ...previous].slice(0, MAX_LOG_LINES));
  }, []);

  const setFailure = useCallback((error: unknown) => {
    const message = sanitizeUserVisibleText(errorMessage(error));
    setOperation('error');
    setStatus(message);
    appendLog(`خطأ: ${message}`);
  }, [appendLog]);

  /**
   * `percent` is clamped to 99 while an operation is still running: 100
   * is reserved for the SETTLED terminal state, exactly as in standard
   * mode. A progress event alone must never paint a full bar for a flash
   * whose promise has not resolved - the operator reads a full bar as
   * "done", and that is a claim only the settlement can make.
   */
  /**
   * BUSY, as the host needs to know it. Anything that is writing to the
   * board, talking to it, or holding a prepared destructive operation
   * counts - an embedding screen must not be able to unmount this one in
   * the middle of it.
   */
  useEffect(() => {
    onBusyChange?.(
      ['detecting', 'building', 'saving', 'backing-up', 'flashing', 'restoring'].includes(
        operation,
      ),
    );
  }, [onBusyChange, operation]);

  const reportProgress = useCallback(
    (percent: number, message: string, force = false, terminal = false) => {
      const now = Date.now();
      if (!force && now - lastProgressAt.current < 80 && percent < 100) return;
      lastProgressAt.current = now;
      const ceiling = terminal ? 100 : 99;
      setProgress(Math.max(0, Math.min(ceiling, percent)));
      setStatus(sanitizeUserVisibleText(message));
    },
    [],
  );

  /**
   * THE ~98% STALL CORRECTION, UI half.
   *
   * The operator saw a bar freeze near 98% with no phase name. Every
   * method now reports through here, so the visible line always NAMES the
   * phase in Arabic (verification and manifestation are different
   * situations at the same percentage), and `flashSnapshot` keeps the
   * facts a stall report needs. Nothing here retries anything.
   */
  const [flashSnapshot, setFlashSnapshot] = useState<FlashProgressSnapshot | undefined>(
    undefined,
  );
  /** Mirror for callbacks that settle an attempt: they need the phase at
   * the moment of settlement, not the phase a stale closure rendered. */
  const flashSnapshotRef = useRef<FlashProgressSnapshot | undefined>(undefined);
  /** THE RESULT CONTRACT (P0-F): exactly one visible result per attempt. */
  const [flashResult, setFlashResult] = useState<FlashResultPresentation | undefined>(
    undefined,
  );
  const flashStartedAt = useRef(0);
  const reportPhaseProgress = useCallback(
    (
      method: FlashMethod,
      rawPhase: string,
      percent: number,
      bytesProcessed: number,
      totalBytes: number,
      detail?: {blockNumber?: number; targetIdentity?: string},
    ) => {
      const phase = toFlashPhase(rawPhase);
      const now = Date.now();
      if (flashStartedAt.current === 0) {
        flashStartedAt.current = now;
      }
      setFlashSnapshot(previous => {
        const next: FlashProgressSnapshot = {
          method,
          phase,
          percent,
          bytesProcessed,
          totalBytes,
          lastProgressAtMs: now,
          startedAtMs: flashStartedAt.current,
          blockNumber: detail?.blockNumber ?? previous?.blockNumber,
          targetIdentity: detail?.targetIdentity ?? previous?.targetIdentity,
          // The phase that just finished is the last one we can claim
          // completed; the one now reported is still running.
          lastCompletedOperation:
            previous !== undefined && previous.phase !== phase
              ? previous.phase
              : previous?.lastCompletedOperation,
          // Only the WebUSB path holds transfers that cannot be cancelled.
          transferMayBePending: method === 'DFU_WEBUSB',
        };
        flashSnapshotRef.current = next;
        return next;
      });
      reportProgress(
        percent,
        `${t(flashPhaseLabelKey(phase))} • ${bytesProcessed}/${totalBytes}`,
      );
    },
    [reportProgress, t],
  );

  const refreshDevices = useCallback(async () => {
    const [serial, dfu] = await Promise.all([client.listDevices(), client.listDfuDevices()]);
    const supported = serial.filter(isSupportedDevice);
    if (!mounted.current) return;
    setSerialDevices(supported);
    setDfuDevices(dfu);
    setSelectedSerialId(previous => supported.some(device => device.deviceId === previous)
      ? previous
      : supported.length === 1 ? supported[0].deviceId : null);
    setSelectedDfuId(previous => dfu.some(device => device.deviceId === previous)
      ? previous
      : dfu.length === 1 ? dfu[0].deviceId : null);
    appendLog(`اكتشاف USB: ${supported.length} serial و${dfu.length} DFU.`);
  }, [appendLog, client]);

  /**
   * THE BROWSER'S EXPLICIT DEVICE CHOOSERS - not offered on Android.
   *
   * A browser lists only ports and USB devices the operator has already
   * authorized, and the chooser that grants that authorization may only be
   * opened from a real user gesture. Without these two buttons the
   * flasher's own "تحديث أجهزة USB" scan legitimately finds nothing on a
   * first visit, and no board can ever be flashed from a browser.
   *
   * Both call the picker STRAIGHT from the press handler - any await
   * before it would end the user gesture and the browser would refuse.
   * A dismissed chooser resolves null, which is a cancellation and not an
   * error, so nothing is logged and no failure is raised.
   */
  // Probed defensively: `client` is an injected dependency and this
  // screen's tests supply minimal stand-ins. "Does this client offer a
  // picker?" is answered by whether the method exists at all.
  const supportsSerialPicker = useMemo(
    () => typeof client.supportsDevicePicker === 'function' && client.supportsDevicePicker(),
    [client],
  );
  const supportsDfuPicker = useMemo(
    () => typeof client.supportsDfuDevicePicker === 'function' && client.supportsDfuDevicePicker(),
    [client],
  );

  const chooseSerialDevice = useCallback(() => {
    client.requestDevicePermission()
      .then(device => {
        if (!mounted.current || device === null) return;
        // Re-enumerate rather than trusting the returned descriptor:
        // listDevices() stays the single source of truth for what is
        // authorized and connectable.
        return refreshDevices();
      })
      .catch(setFailure);
  }, [client, refreshDevices, setFailure]);

  const chooseDfuDevice = useCallback(() => {
    client.requestDfuDevicePermission()
      .then(device => {
        if (!mounted.current || device === null) return;
        return refreshDevices();
      })
      .catch(setFailure);
  }, [client, refreshDevices, setFailure]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setTargetsLoadState('loading');
    setTargetsLoadError(null);
    buildApi.loadTargets(controller.signal)
      .then(loadedTargets => {
        if (!mounted.current) return;
        setTargets(loadedTargets);
        setTargetsLoadState('ready');
        appendLog(`تم تحميل ${loadedTargets.length} Target من المصدر الرسمي.`);
      })
      .catch(error => {
        if (!mounted.current || controller.signal.aborted) return;
        // Online failure must never disable local firmware or USB discovery.
        const message = errorMessage(error);
        setTargetsLoadState('error');
        setTargetsLoadError(message);
        setStatus(`تعذر تحميل القائمة عبر الإنترنت؛ المسار المحلي ما زال متاحاً. ${message}`);
        appendLog(`تعذر تحديث قائمة Targets: ${message}`);
      });
    refreshDevices().catch(error => {
      if (mounted.current) appendLog(`تعذر اكتشاف USB: ${errorMessage(error)}`);
    });
    const unsubscribeAttach = client.onDeviceAttached(() => {
      refreshDevices().catch(error => appendLog(errorMessage(error)));
    });
    const unsubscribeDetach = client.onDeviceDetached(() => {
      refreshDevices().catch(error => appendLog(errorMessage(error)));
    });
    return () => {
      mounted.current = false;
      controller.abort();
      if (operationController.current !== null) {
        operationController.current.abort();
        // Native DFU runs on its own worker. Aborting the JS signal stops
        // cloud/serial/ESP work, while this explicit call guarantees an
        // unexpected route teardown cannot leave a native erase/write
        // continuing with no screen and no cancel control in front of the
        // operator. It is a harmless no-op when DFU is not the active path.
        client.cancelDfuFlash().catch(() => undefined);
      }
      unsubscribeAttach();
      unsubscribeDetach();
    };
  }, [appendLog, buildApi, client, refreshDevices]);

  useEffect(() => {
    if (!selectedTarget) {
      setReleases([]);
      setSelectedRelease('');
      setTargetDetail(null);
      setReleasesLoadState('idle');
      setReleasesLoadError(null);
      return;
    }
    const controller = new AbortController();
    setReleasesLoadState('loading');
    setReleasesLoadError(null);
    setSelectedRelease('');
    buildApi.loadTargetReleases(selectedTarget, controller.signal)
      .then(parseTargetReleases)
      .then(items => {
        if (controller.signal.aborted) return;
        setReleases(items);
        setReleasesLoadState('ready');
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        const message = errorMessage(error);
        setReleases([]);
        setReleasesLoadState('error');
        setReleasesLoadError(message);
        setStatus(`تعذر تحميل إصدارات ${selectedTarget}: ${message}`);
      });
    return () => controller.abort();
  }, [buildApi, selectedTarget]);

  useEffect(() => {
    if (releases.length === 0) {
      setSelectedRelease('');
      return;
    }
    const availableChannels = new Set(releases.map(release => release.channel));
    if (!availableChannels.has(releaseChannel)) {
      const fallback = (['stable', 'candidate', 'development'] as const)
        .find(channel => availableChannels.has(channel));
      if (fallback !== undefined) setReleaseChannel(fallback);
      return;
    }
    const channelReleases = releases.filter(release => release.channel === releaseChannel);
    setSelectedRelease(previous => channelReleases.some(release => release.release === previous)
      ? previous
      : channelReleases[0]?.release ?? '');
    setReleaseListOpen(false);
  }, [releaseChannel, releases]);

  useEffect(() => {
    if (!selectedTarget || !selectedRelease) {
      setTargetDetail(null);
      setBuildOptions(EMPTY_BUILD_OPTIONS);
      setDetailLoadState('idle');
      setDetailLoadError(null);
      setBuildOptionsLoadState('idle');
      setBuildOptionsLoadError(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoadState('loading');
    setDetailLoadError(null);
    setBuildOptionsLoadState('loading');
    setBuildOptionsLoadError(null);
    setTargetDetail(null);
    setBuildOptions(EMPTY_BUILD_OPTIONS);
    Promise.all([
      buildApi.loadBuild(selectedTarget, selectedRelease, controller.signal),
      buildApi.loadOptions(selectedRelease, controller.signal)
        .then(input => ({input, error: null as string | null}))
        .catch(error => ({input: null, error: errorMessage(error)})),
    ]).then(([detailInput, optionsResult]) => {
      if (controller.signal.aborted) return;
      const detail = parseTargetDetail(detailInput, selectedTarget, selectedRelease);
      setTargetDetail(detail);
      setDetailLoadState('ready');

      let options = EMPTY_BUILD_OPTIONS;
      let optionsError = optionsResult.error;
      if (optionsResult.input !== null) {
        try {
          options = parseBuildOptions(optionsResult.input);
        } catch (error) {
          optionsError = errorMessage(error);
        }
      }
      const hasCloudOptions = [
        options.radioProtocols,
        options.telemetryProtocols,
        options.osdProtocols,
        options.motorProtocols,
        options.generalOptions,
      ].some(items => items.length > 0);
      setBuildOptions(options);
      setBuildOptionsLoadState(optionsError === null ? 'ready' : 'error');
      setBuildOptionsLoadError(optionsError);
      if (optionsError !== null) {
        appendLog(`تعذر تحميل خيارات Cloud Build؛ Core Build ما زال متاحاً: ${optionsError}`);
      }
      setCoreBuild(!detail.cloudBuild || !hasCloudOptions);
      setRadioProtocol(defaultValue(options.radioProtocols));
      setTelemetryProtocol(defaultValue(options.telemetryProtocols));
      setOsdProtocol(defaultValue(options.osdProtocols));
      setMotorProtocol(defaultValue(options.motorProtocols));
      setGeneralOptions(options.generalOptions.filter(option => option.default).map(option => option.value));
      const configuration = detail.configuration !== undefined && detail.configuration.length > 0
        ? detail.configuration
        : null;
      setConfigurationLines(configuration);
      setConfigurationLabel(configuration ? `الإعداد الافتراضي لـ ${detail.target}` : null);
      setUnstableConfirmed(false);
      setExpertMode(false);
      setGeneralOptionsExpanded(false);
      appendLog(`تفاصيل ${selectedTarget} / ${selectedRelease} جاهزة.`);
    }).catch(error => {
      if (controller.signal.aborted) return;
      const message = errorMessage(error);
      setTargetDetail(null);
      setDetailLoadState('error');
      setDetailLoadError(message);
      setBuildOptionsLoadState('error');
      setBuildOptionsLoadError('لم تُحمّل الخيارات لأن تفاصيل الإصدار لم تكتمل.');
      setStatus(`تعذر تحميل تفاصيل البناء: ${message}`);
    });
    return () => controller.abort();
  }, [appendLog, buildApi, selectedRelease, selectedTarget]);

  useEffect(() => {
    if (targetDetail?.releaseType.toLowerCase() !== 'unstable') {
      setCommits([]);
      setCommit('');
      return;
    }
    const controller = new AbortController();
    buildApi.loadCommits(targetDetail.release, controller.signal)
      .then(parseCommits)
      .then(items => {
        if (controller.signal.aborted) return;
        setCommits(items);
        setCommit(previous => items.some(item => item.sha === previous) ? previous : '');
      })
      .catch(error => {
        if (!controller.signal.aborted) appendLog(`تعذر تحميل Commits: ${errorMessage(error)}`);
      });
    return () => controller.abort();
  }, [appendLog, buildApi, targetDetail]);

  const selectedRadioIncludesTelemetry = useMemo(
    () => buildOptions.radioProtocols.find(option => option.value === radioProtocol)?.includesTelemetry === true,
    [buildOptions.radioProtocols, radioProtocol],
  );
  const cloudOptionsAvailable = useMemo(() => [
    buildOptions.radioProtocols,
    buildOptions.telemetryProtocols,
    buildOptions.osdProtocols,
    buildOptions.motorProtocols,
    buildOptions.generalOptions,
  ].some(items => items.length > 0), [buildOptions]);

  useEffect(() => {
    if (selectedRadioIncludesTelemetry) {
      setTelemetryProtocol('-1');
    } else if (telemetryProtocol === '-1') {
      setTelemetryProtocol(defaultValue(buildOptions.telemetryProtocols));
    }
  }, [buildOptions.telemetryProtocols, selectedRadioIncludesTelemetry, telemetryProtocol]);

  useEffect(() => {
    if (osdProtocol) setOsdOmissionConfirmed(false);
  }, [osdProtocol]);

  const visibleReleases = useMemo(
    () => releases.filter(release => release.channel === releaseChannel),
    [releaseChannel, releases],
  );
  const releaseChannelChoices = useMemo(() => {
    const available = new Set(releases.map(release => release.channel));
    return ([
      {value: 'stable', label: 'Stable / مستقر'},
      {value: 'candidate', label: 'Release Candidate'},
      {value: 'development', label: 'Development / تطويري'},
    ] as const).filter(choice => available.has(choice.value));
  }, [releases]);
  const selectedReleaseInfo = useMemo(
    () => releases.find(release => release.release === selectedRelease),
    [releases, selectedRelease],
  );
  const selectedTargetInfo = useMemo(
    () => targets.find(target => target.target === selectedTarget),
    [selectedTarget, targets],
  );
  const filteredCommits = useMemo(() => {
    const query = commit.trim().toLowerCase();
    if (!query) return commits;
    return commits.filter(item => item.sha.toLowerCase().includes(query) || item.message.toLowerCase().includes(query));
  }, [commit, commits]);
  const filteredTargets = useMemo(
    () => filterAndSortTargets(targets, targetQuery),
    [targetQuery, targets],
  );
  const selectedSerial = useMemo(
    () => serialDevices.find(device => device.deviceId === selectedSerialId) ?? null,
    [selectedSerialId, serialDevices],
  );
  const loadFirmwareBytes = useCallback(async (filename: string, bytes: Uint8Array) => {
    setOperation('loading');
    setStatus('يجري التحقق البنيوي من ملف Firmware…');
    await afterInteractions();
    const parsed = parseFirmwareFile(filename, bytes);
    if (!mounted.current) return;
    setFirmware(parsed);
    setHexMethod(parsed.kind === 'HEX' ? 'dfu' : 'serial');
    setOperation('idle');
    setProgress(0);
    setStatus(`الملف صالح: ${firmwareFilenameLabel(parsed.filename)}`);
    appendLog(`نجح تحقق ${parsed.kind}: ${firmwareDescription(parsed)}.`);
    setStep('flash');
  }, [appendLog]);

  const pickLocalFirmware = useCallback(async () => {
    try {
      setSourceMode('local');
      const selection = await client.pickFirmwareFile();
      if (selection === null) return;
      setOperation('loading');
      setStatus('فك ترميز ملف Firmware والتحقق منه…');
      await afterInteractions();
      const bytes = await base64ToBytesAsync(selection.dataBase64);
      if (bytes.length !== selection.sizeBytes) throw new Error('حجم ملف Firmware لا يطابق بياناته المستلمة.');
      await loadFirmwareBytes(selection.name, bytes);
    } catch (error) {
      setFailure(error);
    }
  }, [client, loadFirmwareBytes, setFailure]);

  const pickLocalConfiguration = useCallback(async () => {
    try {
      const selection = await client.pickFirmwareFile();
      if (selection === null) return;
      if (selection.sizeBytes > MAX_UNIFIED_CONFIG_BYTES) {
        throw new Error('ملف Unified Config أكبر من الحد الآمن 256 KiB.');
      }
      setOperation('loading');
      setStatus('فك ترميز Unified Config والتحقق منه…');
      const bytes = await base64ToBytesAsync(selection.dataBase64);
      if (bytes.length !== selection.sizeBytes) throw new Error('حجم Unified Config لا يطابق بياناته المستلمة.');
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const lines = parseUnifiedConfigText(text);
      setConfigurationLines(lines);
      setConfigurationLabel(firmwareFilenameLabel(selection.name));
      setOperation('idle');
      setStatus(`Unified Config صالح: ${firmwareFilenameLabel(selection.name)}. سيُدخل في منطقة Custom Defaults عند تفليش HEX.`);
      appendLog(`تم تحميل Unified Config محلي (${lines.length} سطراً).`);
    } catch (error) {
      setFailure(error);
    }
  }, [appendLog, client, setFailure]);

  const clearConfiguration = useCallback(() => {
    setConfigurationLines(null);
    setConfigurationLabel(null);
    setStatus('أزيل Unified Config؛ سيُفلش Firmware دون Custom Defaults مضمّنة.');
  }, []);

  const buildRemoteFirmware = useCallback(async () => {
    if (targetDetail === null) return;
    if (!coreBuild && buildOptions.osdProtocols.length > 0 && !osdProtocol && !osdOmissionConfirmed) {
      setFailure(new Error('اختر بروتوكول OSD أو أكّد صراحة متابعة Cloud Build بدونه.'));
      return;
    }
    const controller = new AbortController();
    operationController.current = controller;
    setOperation('building');
    setBuildKey(null);
    setBuildLogText(null);
    setProgress(0);
    try {
      const request = createBuildRequest(targetDetail, {
        coreBuild,
        radioProtocol,
        telemetryProtocol,
        osdProtocol,
        motorProtocol,
        generalOptions,
        customDefines: customDefines.split(/\s+/),
        commit,
      });
      appendLog(`طلب Build: ${request.options.join(', ')}.`);
      const result = await cloudBuild.buildAndDownload(request, update => {
        if (!mounted.current) return;
        if (update.key) setBuildKey(update.key);
        reportProgress(update.percent, update.message);
      }, controller.signal);
      const resolvedConfiguration = result.configuration ?? targetDetail.configuration;
      setConfigurationLines(resolvedConfiguration ?? null);
      setConfigurationLabel(resolvedConfiguration ? `إعداد Build لـ ${targetDetail.target}` : null);
      await loadFirmwareBytes(result.response.file, result.firmware);
    } catch (error) {
      if (mounted.current) setFailure(error);
    } finally {
      if (operationController.current === controller) operationController.current = null;
    }
  }, [
    appendLog,
    buildOptions.osdProtocols.length,
    cloudBuild,
    commit,
    coreBuild,
    customDefines,
    generalOptions,
    loadFirmwareBytes,
    motorProtocol,
    osdProtocol,
    osdOmissionConfirmed,
    radioProtocol,
    reportProgress,
    setFailure,
    targetDetail,
    telemetryProtocol,
  ]);

  const autoDetect = useCallback(async () => {
    const controller = new AbortController();
    operationController.current = controller;
    setOperation('detecting');
    setStatus('التعرف على Flight Controller عبر MSP…');
    try {
      // Enumerate at the moment of the action. Android can assign a new
      // deviceId between the last rendered list and this press; reusing the
      // stale id is what previously produced "selected serial not found"
      // even while one controller was plainly visible on screen.
      const devices = (await client.listDevices()).filter(isSupportedDevice);
      const chosen = resolveSerialSelection(devices, selectedSerialId);
      if (!chosen) {
        throw new FirmwareDetectionError(
          devices.length > 1
            ? 'اختر جهاز USB واحداً يدوياً قبل التعرف التلقائي.'
            : 'لم يُعثر على Flight Controller تسلسلي مدعوم.',
        );
      }
      if (selectedPortIndex < 0 || selectedPortIndex >= chosen.portCount) {
        throw new FirmwareDetectionError('منفذ USB serial المحدد غير صالح؛ اختر المنفذ من القائمة ثم أعد المحاولة.');
      }
      if (chosen.deviceId !== selectedSerialId) {
        setSelectedSerialId(chosen.deviceId);
        appendLog('تغيّر معرّف USB؛ أُعيد ربط المتحكم الوحيد قبل التعرف التلقائي.');
      }
      const selection = {
        deviceId: chosen.deviceId,
        portIndex: selectedPortIndex,
      };
      const detected = await bootloader.detectFlightController(controller.signal, selection);
      try {
        const identity = detected.identity;
        const target = identity.board.targetName || identity.board.boardName || identity.board.boardIdentifier;
        setDetectedTarget(target);
        setDetectedSummary(
          `${firmwareFamilyLabel(identity.firmware.knownFamily)} • ${identity.board.boardName || identity.board.boardIdentifier} • Target ${target}`,
        );
        setSelectedSerialId(detected.device.deviceId);
        const catalogMatch = targets.find(item => item.target.toUpperCase() === target.toUpperCase());
        if (catalogMatch) {
          setSelectedTarget(catalogMatch.target);
          setSourceMode('online');
        }
        setStatus(catalogMatch
          ? `تم التعرف واختيار ${catalogMatch.target}.`
          : `تم التعرف على ${target}، لكنه غير موجود في القائمة المحمّلة.`);
        appendLog(`Auto detect: ${target} (${firmwareFamilyLabel(identity.firmware.knownFamily)}).`);
      } finally {
        await detected.release();
      }
      await refreshDevices();
      setOperation('idle');
    } catch (error) {
      setFailure(error);
    } finally {
      if (operationController.current === controller) operationController.current = null;
    }
  }, [
    appendLog,
    bootloader,
    client,
    refreshDevices,
    selectedPortIndex,
    selectedSerialId,
    setFailure,
    targets,
  ]);

  const loadBuildLogInsideApp = useCallback(async () => {
    if (!buildKey || buildLogLoading) return;
    setBuildLogLoading(true);
    try {
      const log = await buildApi.loadBuildLog(buildKey);
      setBuildLogText(
        sanitizeUserVisibleText(log.trim() || 'سجل Build فارغ.'),
      );
    } catch (error) {
      setBuildLogText(
        `تعذر تحميل سجل Build: ${sanitizeUserVisibleText(errorMessage(error))}`,
      );
    } finally {
      setBuildLogLoading(false);
    }
  }, [buildApi, buildKey, buildLogLoading]);

  const requireOneSerial = useCallback(async (): Promise<UsbSerialDeviceDescriptor> => {
    const devices = (await client.listDevices()).filter(isSupportedDevice);
    const chosen = resolveSerialSelection(devices, selectedSerialId);
    if (!chosen) {
      if (devices.length === 0) {
        const dfu = await client.listDfuDevices();
        if (dfu.length > 0) {
          throw new Error(
            'الجهاز متصل في وضع DFU بالفعل، وليس Serial. فعّل «بدون تسلسل إعادة تشغيل»، اختر جهاز DFU، وأكّد Target يدوياً.',
          );
        }
      }
      throw new Error(devices.length > 1
        ? 'اختر جهاز serial واحداً يدوياً قبل المتابعة.'
        : 'لم يُعثر على جهاز serial المحدد.');
    }
    if (selectedPortIndex < 0 || selectedPortIndex >= chosen.portCount) {
      throw new Error('رقم منفذ serial المحدد غير صالح.');
    }
    if (chosen.deviceId !== selectedSerialId) {
      setSelectedSerialId(chosen.deviceId);
      appendLog('تغيّر معرّف USB بعد إعادة التعداد؛ أُعيد ربط الجهاز الوحيد المتصل بأمان.');
    }
    return chosen;
  }, [appendLog, client, selectedPortIndex, selectedSerialId]);

  const saveCurrentFirmware = useCallback(async () => {
    if (!firmware) return;
    setOperation('saving');
    setStatus('اختر مكان حفظ Firmware…');
    try {
      const saved = await client.saveFirmwareFile(
        firmwareFilenameLabel(firmware.filename),
        'application/octet-stream',
        bytesToBase64(firmware.bytes),
      );
      setOperation(saved ? 'success' : 'idle');
      setStatus(saved ? 'تم حفظ Firmware بنجاح.' : 'أُلغيَ حفظ Firmware دون تغيير الملف.');
      if (saved) appendLog(`حُفظ ${firmwareFilenameLabel(firmware.filename)}.`);
    } catch (error) {
      setFailure(error);
    }
  }, [appendLog, client, firmware, setFailure]);

  const saveCliBackup = useCallback(async (
    device: UsbSerialDeviceDescriptor,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const shouldBackup = backupMode === 'always' || (backupMode === 'ask' && backupThisRun);
    if (!shouldBackup) return null;
    setOperation('backing-up');
    setStatus('إنشاء نسخة CLI بـ diff all قبل المسح…');
    const backup = await cliBackup.capture(device.deviceId, selectedPortIndex, signal);
    const filename = `fpv-arbcon-backup-${selectedTarget || 'fc'}-${Date.now()}.txt`;
    const saved = await cliBackup.saveBackup(filename, backup);
    if (!saved) throw new Error('أُلغيَ حفظ النسخة الاحتياطية؛ لن يبدأ المسح.');
    appendLog(`حُفظت نسخة CLI (${backup.length} حرفاً) قبل التفليش.`);
    return backup;
  }, [appendLog, backupMode, backupThisRun, cliBackup, selectedPortIndex, selectedTarget]);

  const validateSafety = useCallback(() => {
    if (!firmware) throw new Error('حمّل Firmware صالحاً أولاً.');
    if (!propsRemoved) throw new Error('أكّد إزالة المراوح قبل التفليش.');
    if (!usbPowerOnly) throw new Error('أكّد فصل البطارية والاعتماد على USB فقط.');
    if (selectedReleaseInfo?.channel === 'development' && !unstableConfirmed) {
      throw new Error('الإصدار التطويري يحتاج إقراراً صريحاً بالمخاطر.');
    }
    if (noReboot && !manualTargetConfirmed) {
      throw new Error('في وضع «بدون إعادة تشغيل» يجب تأكيد Target يدوياً.');
    }
  }, [firmware, manualTargetConfirmed, noReboot, propsRemoved, selectedReleaseInfo, unstableConfirmed, usbPowerOnly]);

  /**
   * POST-FLASH SETTINGS RESTORE - a separate truth from the flash itself
   * (P0-E). By the time this runs the firmware result is already
   * recorded; whatever happens here is reported as the RESTORE's own
   * outcome and can never rewrite a verified flash into "فشل التفليش".
   * Throws on failure; the caller records that as the restore truth.
   */
  const restoreBackupAfterFlash = useCallback(async (
    backup: string | null,
    signal: AbortSignal,
  ): Promise<Exclude<FlashRestoreTruth['kind'], 'FAILED'>> => {
    if (!backup || !restoreAfterFlash) return 'SKIPPED';
    setOperation('restoring');
    setStatus('انتظار عودة Flight Controller ثم استعادة إعدادات CLI…');
    const device = await bootloader.waitForOneSerialDevice(30_000, signal);
    const result = await cliBackup.restore(device.deviceId, 0, backup, signal, (done, total) => {
      reportProgress(total > 0 ? 95 + done * 4 / total : 95, `استعادة CLI: ${done}/${total}`);
    });
    if (result.errors.length > 0) {
      throw new Error(`لم تُرسل save لأن ${result.errors.length} أوامر CLI فشلت.`);
    }
    appendLog(`استُعيدت ${result.commandCount} أوامر CLI ثم أُرسلت save.`);
    return 'SUCCEEDED';
  }, [appendLog, bootloader, cliBackup, reportProgress, restoreAfterFlash]);

  const flashHexDfu = useCallback(async (
    image: Extract<FirmwareImage, {kind: 'HEX'}>,
    signal: AbortSignal,
  ): Promise<FlashMethodOutcome> => {
    const serial = noReboot ? null : await requireOneSerial();
    const backup = serial ? await saveCliBackup(serial, signal) : null;
    let dfu: DfuDeviceDescriptor;
    if (noReboot) {
      const devices = await client.listDfuDevices();
      const chosen = resolveDfuSelection(devices, selectedDfuId);
      if (!chosen) throw new Error('اختر جهاز DFU واحداً؛ لن يخمّن التطبيق جهاز التفليش.');
      if (chosen.deviceId !== selectedDfuId) setSelectedDfuId(chosen.deviceId);
      dfu = chosen;
    } else {
      if (serial === null) throw new Error('لم يُحدد جهاز serial لإعادة التشغيل إلى DFU.');
      const detected = await bootloader.detectFlightController(signal, {
        deviceId: serial.deviceId,
        portIndex: selectedPortIndex,
      });
      if (!targetMismatchOverride && !detected.targetMatches(selectedTarget)) {
        const actual = detected.identity.board.targetName || detected.identity.board.boardName;
        setDetectedTarget(actual);
        await detected.release();
        throw new Error(`Target المحدد ${selectedTarget} لا يطابق ${actual}. فعّل تجاوز عدم التطابق فقط بعد التحقق اليدوي.`);
      }
      await detected.rebootToBootloader(selectedTarget, targetMismatchOverride);
      setStatus('انتظار ظهور STM32 DFU…');
      try {
        dfu = await bootloader.waitForOneDfuDevice(20_000, signal);
      } catch (error) {
        if (error instanceof DfuPermissionRequiredError) {
          /**
           * The reboot SUCCEEDED and the board is in DFU - the browser
           * simply has not been told it may talk to this new identity.
           * Stop here without flashing and hold the prepared operation.
           * requestDevice() needs a user gesture, so the resume button
           * below calls it directly from the operator's press.
           *
           * `completed: false` is load-bearing: startFlash used to treat
           * this normal return as a finished flash and claimed 100% +
           * success while NOTHING had been flashed. A held attempt
           * claims nothing.
           */
          setPendingBootloaderFlash({
            operationId: `flash-${Date.now()}`,
            expectedTarget: selectedTarget,
            rebootAlreadySent: true,
            writeAlreadyStarted: false,
          });
          setPendingFlashImage({bytes: image.bytes, fullErase, backup});
          setBootloaderState('WAITING_FOR_PERMISSION');
          setOperation('idle');
          setStatus(t(bootloaderStateLabelKey('WAITING_FOR_PERMISSION')));
          return {completed: false, backup};
        }
        throw error;
      }
      setBootloaderState('COMPLETED');
    }
    setOperation('flashing');
    appendLog(`بدء DfuSe على deviceId ${dfu.deviceId}.`);
    await client.flashDfuFirmware(dfu.deviceId, bytesToBase64(image.bytes), fullErase);
    return {completed: true, backup};
  }, [
    t,
    appendLog,
    bootloader,
    client,
    fullErase,
    noReboot,
    requireOneSerial,
    saveCliBackup,
    selectedDfuId,
    selectedPortIndex,
    selectedTarget,
    targetMismatchOverride,
  ]);

  const flashHexSerial = useCallback(async (
    image: Extract<FirmwareImage, {kind: 'HEX'}>,
    signal: AbortSignal,
  ): Promise<FlashMethodOutcome> => {
    let device = await requireOneSerial();
    const backup = noReboot ? null : await saveCliBackup(device, signal);
    if (!noReboot) {
      const detected = await bootloader.detectFlightController(signal, {
        deviceId: device.deviceId,
        portIndex: selectedPortIndex,
      });
      if (!targetMismatchOverride && !detected.targetMatches(selectedTarget)) {
        const actual = detected.identity.board.targetName || detected.identity.board.boardName;
        setDetectedTarget(actual);
        await detected.release();
        throw new Error(`Target المحدد ${selectedTarget} لا يطابق ${actual}.`);
      }
      await detected.rebootToBootloader(selectedTarget, targetMismatchOverride);
      device = await bootloader.waitForOneSerialDevice(30_000, signal);
    }
    setOperation('flashing');
    const port = new ReactNativeSerialPort(client, device.deviceId, noReboot ? selectedPortIndex : 0, signal);
    const flasher = new Stm32SerialFlasher(port, signal, update => {
      reportPhaseProgress(
        'STM32_SERIAL',
        update.phase,
        update.percent,
        update.processedBytes,
        update.totalBytes,
      );
    });
    await flasher.flash(image.hex, {baudRate: manualBaud ? baudRate : 256000, fullErase});
    return {completed: true, backup};
  }, [
    reportPhaseProgress,
    baudRate,
    bootloader,
    client,
    fullErase,
    manualBaud,
    noReboot,
    requireOneSerial,
    saveCliBackup,
    selectedPortIndex,
    selectedTarget,
    targetMismatchOverride,
  ]);

  const flashEsp = useCallback(async (
    image: Extract<FirmwareImage, {kind: 'BIN'}>,
    signal: AbortSignal,
  ): Promise<FlashMethodOutcome> => {
    const device = await requireOneSerial();
    if (!noReboot && selectedTarget) {
      const detected = await bootloader.detectFlightController(signal, {
        deviceId: device.deviceId,
        portIndex: selectedPortIndex,
      });
      try {
        if (!targetMismatchOverride && !detected.targetMatches(selectedTarget)) {
          const actual = detected.identity.board.targetName || detected.identity.board.boardName;
          setDetectedTarget(actual);
          throw new Error(`Target المحدد ${selectedTarget} لا يطابق ${actual}.`);
        }
      } finally {
        await detected.release();
      }
    }
    const backup = await saveCliBackup(device, signal);
    setOperation('flashing');
    const port = new ReactNativeSerialPort(client, device.deviceId, selectedPortIndex, signal);
    const flasher = new EspFirmwareFlasher(port, signal, update => {
      reportPhaseProgress(
        'ESP_SERIAL',
        update.phase,
        update.percent,
        update.writtenBytes,
        update.totalBytes,
      );
    }, appendLog);
    await flasher.flash(image.bytes, {flashBaudRate: manualBaud ? baudRate : 460800, eraseAll: fullErase});
    return {completed: true, backup};
  }, [
    reportPhaseProgress,
    appendLog,
    baudRate,
    bootloader,
    client,
    fullErase,
    manualBaud,
    noReboot,
    requireOneSerial,
    saveCliBackup,
    selectedPortIndex,
    selectedTarget,
    targetMismatchOverride,
  ]);

  /**
   * Settles a flash attempt that ended in a rejection. The verdict comes
   * from the rejection CODE plus the phase at settlement
   * (classifyFlashRejection), so the WebUSB engine's frozen-attempt codes
   * and Android's manifestation-window DFU_STATUS_TIMEOUT both land on
   * the honest kind. Never SUCCESS: a rejection carries no completion
   * evidence.
   */
  const settleFlashFailure = useCallback((error: unknown) => {
    const code = errorCode(error);
    const kind = classifyFlashRejection(code, flashSnapshotRef.current?.phase);
    const fallback = sanitizeUserVisibleText(errorMessage(error));
    const reason =
      code === undefined
        ? fallback
        : t(flashReasonLabelKey(code), {defaultValue: fallback});
    lastFlashErrorCode.current = code;
    if (kind === 'UNCONFIRMED') {
      const nextAction = t(flashNextActionLabelKey(code));
      setFlashResult({kind: 'UNCONFIRMED', reason, nextAction});
      setOperation('unconfirmed');
      setStatus(reason);
      appendLog(`لم يتأكد اكتمال التفليش: ${reason}`);
    } else {
      setFlashResult({kind: 'FAILED', reason});
      setOperation('error');
      setStatus(reason);
      appendLog(`خطأ: ${reason}`);
    }
  }, [appendLog, t]);

  /**
   * Concludes a COMPLETED flash: the firmware truth is recorded first,
   * then the settings restore runs as its own truth (P0-E). A restore
   * failure after a verified flash reports two separate facts - the
   * flash succeeded AND the restore failed - never "فشل التفليش".
   */
  const concludeCompletedFlash = useCallback(async (
    backup: string | null,
    signal: AbortSignal,
    attempt: number,
  ) => {
    reportProgress(100, 'اكتملت الكتابة والتحقق بنجاح.', true, true);
    appendLog('اكتملت كتابة Firmware والتحقق بالقراءة الراجعة.');
    let restore: FlashRestoreTruth;
    try {
      restore = {kind: await restoreBackupAfterFlash(backup, signal)};
    } catch (restoreError) {
      // Same Arabic-first treatment the flash reasons get: a known code
      // becomes operator copy, and only a genuinely unmapped message
      // falls back - so a transport error can no longer surface its raw
      // English sentence inside the restore line.
      const restoreCode = (restoreError as {code?: unknown} | null)?.code;
      const rawDetail = sanitizeUserVisibleText(errorMessage(restoreError));
      restore = {
        kind: 'FAILED',
        detail:
          typeof restoreCode === 'string' && restoreCode.length > 0
            ? t(flashReasonLabelKey(restoreCode), {defaultValue: rawDetail})
            : rawDetail,
      };
      appendLog(`فشلت استعادة إعدادات CLI بعد تفليش ناجح: ${restore.detail}`);
    }
    if (!mounted.current || flashAttemptSerial.current !== attempt) return;
    setFlashResult({kind: 'SUCCESS', restore});
    setOperation('success');
    setStatus(
      restore.kind === 'FAILED'
        ? 'نجح تثبيت Firmware، لكن فشلت استعادة الإعدادات.'
        : 'تمت كتابة Firmware والتحقق منه بنجاح.',
    );
    await refreshDevices().catch(() => undefined);
  }, [appendLog, refreshDevices, reportProgress, restoreBackupAfterFlash, t]);

  const startFlash = useCallback(async () => {
    if (!['idle', 'success', 'error', 'unconfirmed'].includes(operation)) return;
    try {
      validateSafety();
    } catch (error) {
      setFailure(error);
      return;
    }
    if (!firmware) return;
    if (firmware.kind === 'UF2') {
      await saveCurrentFirmware();
      setStatus('UF2 صالح ومحفوظ. انقله إلى قرص bootloader الظاهر في Android Files؛ لا يمكن تفليشه كـ DfuSe.');
      return;
    }
    let selectedFirmware = firmware;
    if (firmware.kind === 'HEX' && configurationLines !== null) {
      try {
        selectedFirmware = applyCustomDefaultsToFirmware(firmware, configurationLines);
        appendLog(`أُدخل Unified Config (${configurationLines.length} سطراً) في منطقة Custom Defaults المعلنة.`);
      } catch (error) {
        setFailure(error);
        return;
      }
    }
    const controller = new AbortController();
    operationController.current = controller;
    const attempt = ++flashAttemptSerial.current;
    setFlashResult(undefined);
    setFlashSnapshot(undefined);
    flashSnapshotRef.current = undefined;
    flashStartedAt.current = 0;
    lastFlashErrorCode.current = undefined;
    // The backstop measures silence from here; a stale stamp from an
    // earlier operation must not count against this attempt.
    lastProgressAt.current = Date.now();
    setProgress(0);
    setOperation('flashing');
    setStatus('بدء عملية Firmware المتحقَّق منها…');
    try {
      let outcome: FlashMethodOutcome;
      if (selectedFirmware.kind === 'HEX') {
        outcome = hexMethod === 'dfu'
          ? await flashHexDfu(selectedFirmware, controller.signal)
          : await flashHexSerial(selectedFirmware, controller.signal);
      } else {
        outcome = await flashEsp(selectedFirmware, controller.signal);
      }
      if (!mounted.current || flashAttemptSerial.current !== attempt) return;
      if (!outcome.completed) {
        // Held for the browser's DFU permission gate: nothing was
        // flashed, so nothing is claimed. The resume button concludes
        // the attempt - or the operator abandons it. (This normal return
        // used to fall through to a 100% + success claim.)
        return;
      }
      await concludeCompletedFlash(outcome.backup, controller.signal, attempt);
    } catch (error) {
      // A settlement arriving after this attempt was already concluded
      // (backstop fired, or a newer attempt started) must not overwrite
      // the truth that is already on screen.
      if (mounted.current && flashAttemptSerial.current === attempt) {
        settleFlashFailure(error);
      }
    } finally {
      if (operationController.current === controller) operationController.current = null;
    }
  }, [
    appendLog,
    concludeCompletedFlash,
    configurationLines,
    firmware,
    flashEsp,
    flashHexDfu,
    flashHexSerial,
    hexMethod,
    operation,
    saveCurrentFirmware,
    setFailure,
    settleFlashFailure,
    validateSafety,
  ]);
  startFlashRef.current = startFlash;

  useEffect(() => {
    if (!flashOnConnect || !noReboot || !firmware || operation !== 'idle') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = client.onDeviceAttached(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        refreshDevices()
          .then(() => startFlashRef.current())
          .catch(setFailure);
      }, 500);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [client, firmware, flashOnConnect, noReboot, operation, refreshDevices, setFailure]);

  useEffect(() => client.onDfuFlashProgress(update => {
    if (operation !== 'flashing') return;
    reportPhaseProgress(
      'DFU_WEBUSB',
      update.phase,
      update.percent,
      update.bytesProcessed,
      update.totalBytes,
    );
  }), [client, operation, reportPhaseProgress]);

  /**
   * The stall watchdog. It ticks a clock so `evaluateFlashStall` can be
   * re-evaluated; it NEVER sends anything. Re-erasing or re-writing on a
   * stall could corrupt a half-written image and, on the WebUSB path,
   * would race a transfer the browser will not let us cancel.
   */
  const [stallClock, setStallClock] = useState(0);
  useEffect(() => {
    if (operation !== 'flashing' || flashSnapshot === undefined) {
      return;
    }
    const handle = setInterval(() => setStallClock(value => value + 1), 1000);
    return () => clearInterval(handle);
  }, [operation, flashSnapshot]);

  const stallVerdict = useMemo(() => {
    if (flashSnapshot === undefined) {
      return undefined;
    }
    // stallClock is read so this recomputes each tick.
    void stallClock;
    return evaluateFlashStall(flashSnapshot, Date.now());
  }, [flashSnapshot, stallClock]);

  /**
   * THE LAST-RESORT TERMINAL BACKSTOP (P0-B). The engines carry the real
   * guarantee - every WebUSB transfer is a bounded observation now, and
   * Android's every controlTransfer has a 5s native timeout - so in a
   * healthy build this never fires. It exists for the failure mode the
   * operator actually hit: an attempt whose promise can no longer settle.
   * After FLASH_TERMINAL_BACKSTOP_MS of total progress silence it FREEZES
   * the attempt: invalidates its identity (late settlements are ignored),
   * aborts what is abortable, and states the truth - UNCONFIRMED for a
   * web flash whose transfer may still be pending, FAILED for an attempt
   * that never produced a single transfer, and a restore-failure truth
   * (never a flash failure) when the firmware had already completed. It
   * NEVER claims SUCCESS and never retries anything. Serial and Android
   * flashes with live snapshots are deliberately exempt: their engines
   * are internally bounded, and a slow-but-valid erase must not be
   * overridden by an impatient UI.
   */
  useEffect(() => {
    if (operation !== 'flashing' && operation !== 'restoring') {
      return;
    }
    const attempt = flashAttemptSerial.current;
    const settledAs = operation;
    const interval = setInterval(() => {
      const silentForMs = Date.now() - lastProgressAt.current;
      if (silentForMs < FLASH_TERMINAL_BACKSTOP_MS) return;
      if (flashAttemptSerial.current !== attempt) return;
      const snapshot = flashSnapshotRef.current;
      if (
        settledAs === 'flashing' &&
        snapshot !== undefined &&
        snapshot.method !== 'DFU_WEBUSB'
      ) {
        return;
      }
      // Freeze: this attempt is over. Anything of it that settles later
      // meets a bumped serial and is ignored.
      flashAttemptSerial.current += 1;
      operationController.current?.abort();
      if (settledAs === 'restoring') {
        // The firmware truth was recorded before restore began; only the
        // restore is being settled here.
        appendLog('انقطع تقدّم استعادة الإعدادات نهائياً بعد تفليش ناجح؛ جُمّدت الاستعادة.');
        setFlashResult({
          kind: 'SUCCESS',
          restore: {kind: 'FAILED', detail: t('firmwareFlasher.restoreSilent')},
        });
        setOperation('success');
        setStatus('نجح تثبيت Firmware، لكن فشلت استعادة الإعدادات.');
        return;
      }
      client.cancelDfuFlash().catch(() => undefined);
      if (snapshot === undefined) {
        // Not one transfer ever started, so nothing destructive can be
        // pending: a plain, honest failure and a safe restart.
        lastFlashErrorCode.current = FLASH_CODE_NEVER_STARTED;
        const reason = t(flashReasonLabelKey(FLASH_CODE_NEVER_STARTED));
        appendLog(`خطأ: ${reason}`);
        setFlashResult({kind: 'FAILED', reason});
        setOperation('error');
        setStatus(reason);
        return;
      }
      lastFlashErrorCode.current = FLASH_CODE_UI_BACKSTOP;
      const reason = t(flashReasonLabelKey(FLASH_CODE_UI_BACKSTOP));
      appendLog(`لم يتأكد اكتمال التفليش: ${reason}`);
      setFlashResult({
        kind: 'UNCONFIRMED',
        reason,
        nextAction: t(flashNextActionLabelKey(FLASH_CODE_UI_BACKSTOP)),
      });
      setOperation('unconfirmed');
      setStatus(reason);
    }, 5_000);
    return () => clearInterval(interval);
  }, [appendLog, client, operation, t]);

  const [flashReportCopied, setFlashReportCopied] = useState<
    'idle' | 'copied' | 'failed'
  >('idle');
  const lastFlashErrorCode = useRef<string | undefined>(undefined);

  /**
   * THE HELD OPERATION. Set only when the reboot already succeeded and
   * the browser needs a gesture before it will expose the new DFU
   * identity. Holding it is what lets the resume continue the SAME
   * prepared flash instead of starting over.
   */
  const [pendingBootloaderFlash, setPendingBootloaderFlash] = useState<
    PendingBootloaderFlash | undefined
  >(undefined);
  const [pendingFlashImage, setPendingFlashImage] = useState<
    PendingFlashImage | undefined
  >(undefined);
  const [bootloaderState, setBootloaderState] = useState<
    BootloaderTransitionState | undefined
  >(undefined);

  /**
   * Called DIRECTLY from the operator's press, because WebUSB
   * requestDevice() requires a user gesture and browser security is never
   * bypassed here. It re-sends nothing: no MSP reboot, no erase, no
   * write. It verifies the chosen device and continues the held flash.
   */
  const chooseDfuAndContinue = useCallback(() => {
    const pending = pendingBootloaderFlash;
    const image = pendingFlashImage;
    if (pending === undefined || image === undefined) {
      return;
    }
    const resumable = canResumePendingFlash(pending);
    if (!resumable.resumable) {
      setBootloaderState('FAILED_SAFELY');
      setFailure(
        new Error('بدأت الكتابة بالفعل؛ لا يجوز استئنافها. افصل وأعد المحاولة من البداية.'),
      );
      return;
    }
    client
      .requestDfuDevicePermission()
      .then(async device => {
        if (!mounted.current) return;
        const verdict = verifySelectedDfuDevice(
          device as DfuIdentity | null,
          pending,
          pending.operationId,
        );
        if (!verdict.ok) {
          setBootloaderState('UNEXPECTED_DEVICE');
          setFailure(new Error(t(dfuRejectionLabelKey(verdict.reason))));
          return;
        }
        setBootloaderState('RESUMED_AFTER_PERMISSION');
        setPendingBootloaderFlash(undefined);
        setPendingFlashImage(undefined);
        /* The resumed attempt gets the SAME terminal contract as a
         * direct one. This chain used to end at the await below with no
         * success handling at all - operation stayed 'flashing' forever
         * even when the resumed flash completed perfectly. */
        const controller = new AbortController();
        operationController.current = controller;
        const attempt = ++flashAttemptSerial.current;
        setFlashResult(undefined);
        lastFlashErrorCode.current = undefined;
        lastProgressAt.current = Date.now();
        setOperation('flashing');
        appendLog('استُؤنفت العملية المعلّقة بعد منح إذن المتصفح؛ لم يُعَد إرسال أمر إعادة التشغيل.');
        try {
          await client.flashDfuFirmware(
            (device as DfuIdentity & {deviceId: number}).deviceId,
            bytesToBase64(image.bytes),
            image.fullErase,
          );
          if (!mounted.current || flashAttemptSerial.current !== attempt) return;
          await concludeCompletedFlash(image.backup, controller.signal, attempt);
        } catch (error) {
          if (!mounted.current || flashAttemptSerial.current !== attempt) return;
          setBootloaderState('FAILED_SAFELY');
          settleFlashFailure(error);
        } finally {
          if (operationController.current === controller) operationController.current = null;
        }
      })
      .catch(error => {
        if (!mounted.current) return;
        setBootloaderState('FAILED_SAFELY');
        setFailure(error);
      });
  }, [
    appendLog,
    client,
    concludeCompletedFlash,
    pendingBootloaderFlash,
    pendingFlashImage,
    setFailure,
    settleFlashFailure,
    t,
  ]);
  const copyFlashReport = useCallback(() => {
    if (flashSnapshot === undefined) {
      return;
    }
    const text = buildFlashReport(flashSnapshot, Date.now(), {
      lastErrorCode: lastFlashErrorCode.current,
    });
    copyPlainTextToClipboard(text)
      .then(copied => setFlashReportCopied(copied ? 'copied' : 'failed'))
      .catch(() => setFlashReportCopied('failed'));
  }, [flashSnapshot]);

  const cancelOperation = useCallback(() => {
    operationController.current?.abort();
    if (operation === 'flashing') client.cancelDfuFlash().catch(() => undefined);
    appendLog('طلب المستخدم إلغاء العملية الحالية.');
  }, [appendLog, client, operation]);

  const exitDfu = useCallback(async () => {
    try {
      const devices = await client.listDfuDevices();
      const chosen = resolveDfuSelection(devices, selectedDfuId);
      if (!chosen) throw new Error('اختر جهاز DFU واحداً للخروج الآمن.');
      if (chosen.deviceId !== selectedDfuId) setSelectedDfuId(chosen.deviceId);
      setOperation('flashing');
      setStatus('إرسال أمر الخروج من DFU…');
      await client.exitDfuMode(chosen.deviceId);
      setOperation('success');
      setStatus('تم إرسال أمر الخروج من DFU.');
      appendLog('Exit DFU مكتمل.');
      await refreshDevices();
    } catch (error) {
      setFailure(error);
    }
  }, [appendLog, client, refreshDevices, selectedDfuId, setFailure]);

  const unprotectDfu = useCallback(async () => {
    if (!readUnprotectConfirmed) {
      setFailure(new Error('أكّد أولاً أن إزالة Read Protection ستمسح Flash بالكامل.'));
      return;
    }
    try {
      const devices = await client.listDfuDevices();
      const chosen = resolveDfuSelection(devices, selectedDfuId);
      if (!chosen) throw new Error('اختر جهاز DFU واحداً لإزالة Read Protection.');
      if (chosen.deviceId !== selectedDfuId) setSelectedDfuId(chosen.deviceId);
      setOperation('flashing');
      setStatus('إزالة Read Protection؛ لا تفصل USB حتى يعيد الجهاز التشغيل…');
      appendLog('بدأ DFU read-unprotect؛ هذه العملية تمسح Flash بحكم STM32 ROM.');
      await client.unprotectDfuDevice(chosen.deviceId);
      setOperation('success');
      setReadUnprotectConfirmed(false);
      setStatus('أزيلت Read Protection. افصل اللوحة، أعد إدخال DFU، ثم نفّذ التفليش من جديد.');
      appendLog('اكتمل read-unprotect مع reset/disconnect متوقع.');
      await refreshDevices().catch(() => undefined);
    } catch (error) {
      setFailure(error);
    }
  }, [appendLog, client, readUnprotectConfirmed, refreshDevices, selectedDfuId, setFailure]);

  const restoreLocalBackup = useCallback(async () => {
    const controller = new AbortController();
    operationController.current = controller;
    try {
      const selection = await client.pickFirmwareFile();
      if (selection === null) return;
      if (selection.sizeBytes > MAX_CLI_BACKUP_BYTES) {
        throw new Error('ملف CLI أكبر من الحد الآمن 1 MiB.');
      }
      const bytes = await base64ToBytesAsync(selection.dataBase64);
      if (bytes.length !== selection.sizeBytes) throw new Error('حجم ملف CLI لا يطابق بياناته المستلمة.');
      let text = '';
      for (const byte of bytes) {
        if (byte > 127) throw new Error('ملف CLI يجب أن يكون ASCII.');
        text += String.fromCharCode(byte);
      }
      if (!isPlausibleCliBackup(text)) throw new Error('ملف CLI المختار غير صالح.');
      const device = await requireOneSerial();
      setOperation('restoring');
      const result = await cliBackup.restore(device.deviceId, selectedPortIndex, text, controller.signal, (done, total) => {
        reportProgress(total > 0 ? done * 100 / total : 0, `استعادة CLI: ${done}/${total}`);
      });
      if (result.errors.length > 0) throw new Error(`فشل ${result.errors.length} أوامر؛ لم يُرسل save.`);
      setOperation('success');
      setStatus(`استُعيد ${result.commandCount} أوامر CLI بنجاح.`);
    } catch (error) {
      setFailure(error);
    } finally {
      if (operationController.current === controller) operationController.current = null;
    }
  }, [cliBackup, client, reportProgress, requireOneSerial, selectedPortIndex, setFailure]);

  const isBusy = !['idle', 'success', 'error', 'unconfirmed'].includes(operation);
  const canCancel = ['building', 'detecting', 'backing-up', 'flashing', 'restoring'].includes(operation);
  const isDevelopment = selectedReleaseInfo?.channel === 'development';

  useEffect(() => {
    if (!isBusy) return;
    return navigation?.addListener('beforeRemove', event => {
      event.preventDefault();
      Alert.alert(
        'عملية Firmware قيد التنفيذ',
        'ألغِ العملية من زر «إلغاء» وانتظر توقفها قبل مغادرة الشاشة.',
        [{text: 'حسناً'}],
      );
    });
  }, [isBusy, navigation]);

  return (
    <View style={styles.root} testID="firmware-flasher-screen">
      <Modal
        visible={targetListOpen}
        animationType="slide"
        onRequestClose={() => setTargetListOpen(false)}>
        <View style={styles.modalRoot} testID="target-picker-modal">
          <View style={styles.modalHeader}>
            <View style={styles.flexOne}>
              <Text style={styles.modalTitle}>اختيار Flight Controller</Text>
              <Text style={styles.selectorHint}>ابحث باسم Target أو الشركة أو MCU</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="إغلاق قائمة اللوحات"
              onPress={() => setTargetListOpen(false)}
              style={styles.modalClose}>
              <Text style={styles.modalCloseText}>×</Text>
            </Pressable>
          </View>
          <TextInput
            value={targetQuery}
            onChangeText={setTargetQuery}
            autoFocus
            placeholder="مثال: SPEEDYBEEF405V4"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            testID="target-search"
          />
          {targetsLoadState === 'loading' ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.loadingText}>يجري تحميل قائمة اللوحات…</Text>
            </View>
          ) : null}
          {targetsLoadState === 'error' ? (
            <FirmwareNotice
              title="تعذر تحميل قائمة اللوحات"
              text={targetsLoadError ?? 'تحقق من الإنترنت أو استخدم ملف Firmware محلياً.'}
              tone="error"
            />
          ) : null}
          <FlatList
            data={filteredTargets}
            keyExtractor={item => item.target}
            style={styles.targetList}
            contentContainerStyle={styles.targetListContent}
            initialNumToRender={14}
            maxToRenderPerBatch={18}
            windowSize={7}
            removeClippedSubviews
            keyboardShouldPersistTaps="handled"
            renderItem={({item}) => (
              <Pressable
                testID={`target-${item.target}`}
                onPress={() => {
                  setSelectedTarget(item.target);
                  setTargetMismatchOverride(false);
                  setTargetListOpen(false);
                  setTargetQuery('');
                }}
                style={[styles.targetRow, selectedTarget === item.target && styles.targetRowSelected]}>
                <View style={styles.targetCopy}>
                  <Text style={styles.targetName}>{item.target}</Text>
                  <Text style={styles.targetMeta}>{item.manufacturer ?? 'مصنّع غير معلن'} • {item.mcu ?? 'MCU غير معلن'}</Text>
                </View>
                <Text style={styles.targetGroup}>{groupLabel(item.group)}</Text>
              </Pressable>
            )}
            ListEmptyComponent={targetsLoadState === 'ready'
              ? <Text style={styles.emptyText}>لا توجد Targets مطابقة.</Text>
              : null}
          />
        </View>
      </Modal>

      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="العودة"
          accessibilityState={{disabled: isBusy}}
          disabled={isBusy}
          onPress={() => navigation?.goBack()}
          style={[styles.backButton, isBusy && styles.dimmed]}>
          <Icon name="chevron-back" size={24} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerEyebrow}>أداة مستقلة وآمنة</Text>
          <Text style={styles.headerTitle}>Firmware Flasher</Text>
        </View>
        <View style={styles.formatPill}>
          <Text style={styles.formatPillText}>{firmware?.kind ?? 'HEX / UF2 / BIN'}</Text>
        </View>
      </View>

      <View style={styles.steps}>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{selected: step === 'board'}}
          disabled={isBusy}
          testID="firmware-step-board"
          onPress={() => setStep('board')}
          style={[styles.step, step === 'board' && styles.stepActive]}>
          <Text style={[styles.stepText, step === 'board' && styles.stepTextActive]}>1  اللوحة والبناء</Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{selected: step === 'flash'}}
          disabled={isBusy}
          testID="firmware-step-flash"
          onPress={() => setStep('flash')}
          style={[styles.step, step === 'flash' && styles.stepActive]}>
          <Text style={[styles.stepText, step === 'flash' && styles.stepTextActive]}>2  التحقق والتفليش</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled>
        {step === 'board' ? (
          <>
            <FirmwareSection title="مصدر Firmware" caption="المساران يمران عبر نفس التحقق الصارم قبل السماح بالتفليش.">
              <FirmwareChoice
                value={sourceMode}
                disabled={isBusy}
                testIDPrefix="firmware-source"
                choices={[{value: 'online', label: 'Firmware الرسمي عبر الإنترنت'}, {value: 'local', label: 'ملف من الجهاز'}]}
                onChange={setSourceMode}
              />
              {sourceMode === 'local' ? (
                <FirmwareButton title="اختيار HEX أو UF2 أو BIN" onPress={pickLocalFirmware} disabled={isBusy} testID="pick-local-firmware" />
              ) : null}
            </FirmwareSection>

            <FirmwareSection title="Unified Config / Custom Defaults" caption="تُدخل الإعدادات داخل منطقة يعلنها HEX، ولا تكتب فوق Firmware عشوائياً.">
              <View style={styles.twoButtons}>
                <View style={styles.flexOne}>
                  <FirmwareButton title="اختيار Unified Config" onPress={pickLocalConfiguration} disabled={isBusy} tone="secondary" testID="pick-unified-config" />
                </View>
                <View style={styles.flexOne}>
                  <FirmwareButton title="إزالة الإعداد" onPress={clearConfiguration} disabled={isBusy || configurationLines === null} tone="secondary" testID="clear-unified-config" />
                </View>
              </View>
              {configurationLines ? (
                <FirmwareNotice
                  title={configurationLabel ?? 'Unified Config صالح'}
                  text={`${configurationLines.length} سطراً • سيُتحقق من مؤشري البداية والنهاية والتداخل قبل أي مسح.`}
                  tone="success"
                />
              ) : (
                <FirmwareNotice title="بدون Custom Defaults" text="يمكن التفليش كما هو أو تحميل Unified Config محلياً." tone="info" />
              )}
            </FirmwareSection>

            {sourceMode === 'online' ? (
              <>
                <FirmwareSection title="Flight Controller والـ Target" caption="اختر جهاز USB عند التعدد، أو استخدم التعرف التلقائي الذي يقرأ MSP_BOARD_INFO فعلياً.">
                  <View style={styles.twoButtons}>
                    <View style={styles.flexOne}>
                      <FirmwareButton
                        title="تحديث أجهزة USB"
                        onPress={() => refreshDevices().catch(setFailure)}
                        disabled={isBusy}
                        tone="secondary"
                        testID="refresh-detect-devices"
                      />
                    </View>
                    <View style={styles.flexOne}>
                      <FirmwareButton title="التعرف التلقائي" onPress={autoDetect} disabled={isBusy} testID="auto-detect-fc" />
                    </View>
                  </View>
                  {serialDevices.length > 0 ? <Text style={styles.fieldLabel}>جهاز USB المستخدم في Auto Detect</Text> : (
                    <FirmwareNotice title="لا يوجد جهاز Serial" text="يمكنك اختيار Target يدوياً، أو توصيل Flight Controller ثم الضغط على تحديث." tone="info" />
                  )}
                  {serialDevices.map(device => (
                    <Pressable
                      key={device.deviceId}
                      testID={`detect-serial-device-${device.deviceId}`}
                      disabled={isBusy}
                      onPress={() => { setSelectedSerialId(device.deviceId); setSelectedPortIndex(0); }}
                      style={[styles.deviceRow, selectedSerialId === device.deviceId && styles.deviceRowSelected]}>
                      <Text style={styles.deviceName}>{deviceLabel(device)}</Text>
                      <Text style={styles.deviceMeta}>{device.driverType} • {device.portCount} منفذ</Text>
                    </Pressable>
                  ))}
                  {selectedSerial && selectedSerial.portCount > 1 ? (
                    <FirmwareChoice
                      value={String(selectedPortIndex)}
                      choices={Array.from({length: selectedSerial.portCount}, (_, index) => ({value: String(index), label: `المنفذ ${index}`}))}
                      onChange={value => setSelectedPortIndex(Number(value))}
                      disabled={isBusy}
                      testIDPrefix="detect-port"
                    />
                  ) : null}
                  {detectedSummary ? <FirmwareNotice title="نتيجة التعرف" text={detectedSummary} tone="success" /> : null}
                  <Pressable
                    disabled={isBusy}
                    testID="target-selector"
                    onPress={() => setTargetListOpen(true)}
                    style={[styles.selectorButton, isBusy && styles.dimmed]}>
                    <Text style={styles.selectorValue}>{selectedTarget || 'اختر Target يدوياً'}</Text>
                    <Text style={styles.selectorHint}>فتح قائمة واضحة قابلة للبحث</Text>
                  </Pressable>
                  {selectedTargetInfo ? (
                    <FirmwareNotice
                      title={`تصنيف اللوحة: ${groupLabel(selectedTargetInfo.group)}`}
                      text={`${selectedTargetInfo.manufacturer ?? 'المصنّع غير معلن'} • ${selectedTargetInfo.mcu ?? 'MCU غير معلن'} • Target ${selectedTargetInfo.target}`}
                      tone={selectedTargetInfo.group === 'supported'
                        ? 'success'
                        : selectedTargetInfo.group === 'legacy' ? 'warning' : 'info'}
                    />
                  ) : null}
                  {targetsLoadState === 'loading' ? <FirmwareNotice title="قائمة اللوحات" text="يجري تحميلها الآن؛ الاختيار المحلي وUSB يبقيان متاحين." /> : null}
                  {targetsLoadState === 'error' ? <FirmwareNotice title="القائمة غير متاحة" text={targetsLoadError ?? 'استخدم الملف المحلي أو أعد المحاولة.'} tone="error" /> : null}
                </FirmwareSection>

                <FirmwareSection title="إصدار Firmware" caption="اختر القناة أولاً، ثم الإصدار والتاريخ بوضوح. الإصدارات التطويرية تحتاج إقراراً منفصلاً قبل التفليش.">
                  {releasesLoadState === 'loading' ? (
                    <FirmwareNotice title="تحميل الإصدارات" text={`يجري جلب الإصدارات المتاحة لـ ${selectedTarget}.`} />
                  ) : null}
                  {releasesLoadState === 'error' ? (
                    <FirmwareNotice title="تعذر تحميل الإصدارات" text={releasesLoadError ?? 'أعد اختيار اللوحة أو استخدم ملفاً محلياً.'} tone="error" />
                  ) : null}
                  {releaseChannelChoices.length > 0 ? (
                    <FirmwareChoice
                      value={releaseChannel}
                      choices={releaseChannelChoices}
                      onChange={value => setReleaseChannel(value)}
                      disabled={isBusy}
                      testIDPrefix="release-channel"
                    />
                  ) : null}
                  {visibleReleases.length > 0 ? (
                    <>
                      <Pressable
                        testID="release-selector"
                        disabled={isBusy}
                        onPress={() => setReleaseListOpen(value => !value)}
                        style={[styles.selectorButton, isBusy && styles.dimmed]}>
                        <Text style={styles.selectorValue}>
                          {selectedReleaseInfo ? releaseLabel(selectedReleaseInfo) : 'اختر إصدار Firmware'}
                        </Text>
                        <Text style={styles.selectorHint}>
                          {selectedReleaseInfo?.label ?? 'الإصدار والتاريخ'} • {releaseListOpen ? 'إخفاء القائمة' : 'عرض القائمة'}
                        </Text>
                      </Pressable>
                      {releaseListOpen ? (
                        <View style={styles.choiceRows}>
                          {visibleReleases.map(release => (
                            <Pressable
                              key={release.release}
                              testID={`release-${release.release}`}
                              disabled={isBusy}
                              onPress={() => {
                                setSelectedRelease(release.release);
                                setReleaseListOpen(false);
                              }}
                              style={[styles.releaseRow, selectedRelease === release.release && styles.releaseRowSelected]}>
                              <Text style={[styles.releaseText, selectedRelease === release.release && styles.releaseTextSelected]}>{releaseLabel(release)}</Text>
                              <Text style={styles.releaseMeta}>تاريخ الإصدار: {release.label}</Text>
                            </Pressable>
                          ))}
                        </View>
                      ) : null}
                    </>
                  ) : null}
                  {detailLoadState === 'loading' ? <FirmwareNotice title="تفاصيل البناء" text="يجري تحميل معلومات Target وخيارات البناء…" /> : null}
                  {detailLoadState === 'error' ? <FirmwareNotice title="تعذر تحميل تفاصيل البناء" text={detailLoadError ?? 'اختر إصداراً آخر أو أعد المحاولة.'} tone="error" /> : null}
                  {targetDetail ? (
                    <>
                      <FirmwareNotice
                        title={`${targetDetail.target} • ${targetDetail.release}`}
                        text={`${targetDetail.manufacturer ?? 'المصنّع غير معلن'} • ${targetDetail.mcu ?? 'MCU غير معلن'} • ${targetDetail.date ?? 'تاريخ البناء يحدده الخادم'} • ${targetDetail.cloudBuild ? 'يدعم Cloud Build' : 'Core Build جاهز'}`}
                      />
                      <FirmwareNotice
                        title="المعلومات داخل FPV-ARBCON"
                        text="لن يفتح اختيار اللوحة أو الإصدار أي تطبيق أو موقع خارجي؛ جميع خطوات البناء والتفليش تبقى داخل هذه الشاشة."
                        tone="success"
                      />
                    </>
                  ) : null}
                </FirmwareSection>

                <FirmwareSection
                  title="تهيئة البناء"
                  caption="Core Build أو Cloud Build، ثم Radio وTelemetry وOSD وMotor وبقية الخيارات."
                  testID="build-configuration">
                  {targetDetail ? (
                    <>
                    {targetDetail.cloudBuild ? (
                      <FirmwareChoice
                        value={coreBuild ? 'core' : 'cloud'}
                        choices={[{value: 'core', label: 'Core Build'}, {value: 'cloud', label: 'Cloud Build مخصص'}]}
                        onChange={value => {
                          if (value === 'cloud' && !cloudOptionsAvailable) {
                            setStatus('خيارات Cloud Build لم تجهز بعد؛ أبقِ Core Build أو أعد اختيار الإصدار.');
                            return;
                          }
                          setCoreBuild(value === 'core');
                        }}
                        disabled={isBusy}
                        testIDPrefix="build-mode"
                      />
                    ) : (
                      <FirmwareNotice title="Core Build" text="هذا الإصدار لا يعلن Cloud Build؛ سيُستخدم البناء الأساسي الكامل." />
                    )}
                    {buildOptionsLoadState === 'loading' ? <FirmwareNotice title="خيارات البناء" text="يجري تحميل Radio وTelemetry وOSD وMotor والخيارات الأخرى…" /> : null}
                    {buildOptionsLoadState === 'error' ? (
                      <FirmwareNotice
                        title="Cloud Build غير متاح حالياً"
                        text={`${buildOptionsLoadError ?? 'تعذر تحميل الخيارات.'} ما زال Core Build متاحاً بأمان.`}
                        tone="warning"
                      />
                    ) : null}
                    {targetDetail.cloudBuild && !coreBuild ? (
                      <>
                        <OptionGroup testIDPrefix="radio-protocol" title="بروتوكول الراديو" options={buildOptions.radioProtocols} selected={radioProtocol} onChange={setRadioProtocol} />
                        <OptionGroup
                          testIDPrefix="telemetry-protocol"
                          title="Telemetry"
                          options={selectedRadioIncludesTelemetry
                            ? [{name: 'مضمّن تلقائياً مع بروتوكول الراديو', value: '-1', default: true, includesTelemetry: true}]
                            : buildOptions.telemetryProtocols}
                          selected={telemetryProtocol}
                          onChange={setTelemetryProtocol}
                          disabled={selectedRadioIncludesTelemetry}
                        />
                        <OptionGroup testIDPrefix="osd-protocol" title="OSD" options={buildOptions.osdProtocols} selected={osdProtocol} onChange={setOsdProtocol} />
                        {buildOptions.osdProtocols.length > 0 && !osdProtocol ? (
                          <FirmwareToggle
                            label="متابعة Cloud Build بدون OSD"
                            detail="إقرار صريح قبل بناء Firmware بلا OSD."
                            value={osdOmissionConfirmed}
                            onValueChange={setOsdOmissionConfirmed}
                            disabled={isBusy}
                            warning
                            testID="confirm-no-osd"
                          />
                        ) : null}
                        <OptionGroup testIDPrefix="motor-protocol" title="بروتوكول المحركات" options={buildOptions.motorProtocols} selected={motorProtocol} onChange={setMotorProtocol} />
                        {buildOptions.generalOptions.length > 0 ? (
                          <View style={styles.optionGroup}>
                            <FirmwareButton
                              title={`${generalOptionsExpanded ? 'إخفاء' : 'عرض'} الخيارات الأخرى (${buildOptions.generalOptions.length})`}
                              onPress={() => setGeneralOptionsExpanded(value => !value)}
                              disabled={isBusy}
                              tone="secondary"
                              testID="toggle-general-build-options"
                            />
                            {generalOptionsExpanded ? buildOptions.generalOptions.map(option => (
                              <FirmwareToggle
                                key={option.value}
                                label={option.name}
                                detail={option.value}
                                value={generalOptions.includes(option.value)}
                                onValueChange={enabled => setGeneralOptions(previous => enabled
                                  ? Array.from(new Set([...previous, option.value]))
                                  : previous.filter(value => value !== option.value))}
                              />
                            )) : null}
                          </View>
                        ) : null}
                        <FirmwareToggle
                          label="وضع الخبير"
                          detail="يعرض Custom Defines واختيار Commit التطويري؛ اتركه مغلقاً للاستخدام العادي."
                          value={expertMode}
                          onValueChange={setExpertMode}
                          disabled={isBusy}
                          testID="firmware-expert-mode"
                        />
                        {expertMode ? (
                          <>
                            <Text style={styles.fieldLabel}>Custom Defines (تفصلها مسافات)</Text>
                            <TextInput
                              value={customDefines}
                              onChangeText={setCustomDefines}
                              editable={!isBusy}
                              autoCapitalize="characters"
                              placeholder="USE_BARO=BMP280 USE_GPS"
                              placeholderTextColor={colors.textMuted}
                              style={[styles.input, styles.monoInput]}
                            />
                            {isDevelopment ? (
                              <>
                                <Text style={styles.fieldLabel}>Commit SHA اختياري</Text>
                                <TextInput
                                  value={commit}
                                  onChangeText={setCommit}
                                  editable={!isBusy}
                                  autoCapitalize="none"
                                  placeholder="اكتب SHA أو ابحث في القائمة"
                                  placeholderTextColor={colors.textMuted}
                                  style={[styles.input, styles.monoInput]}
                                />
                                {filteredCommits.slice(0, 20).map(item => (
                                  <Pressable
                                    key={item.sha}
                                    onPress={() => setCommit(item.sha)}
                                    style={[styles.commitRow, commit === item.sha && styles.targetRowSelected]}>
                                    <Text style={styles.commitMessage}>{item.message}</Text>
                                    <Text style={styles.commitSha}>{item.sha}</Text>
                                  </Pressable>
                                ))}
                                {filteredCommits.length > 20 ? <Text style={styles.selectorHint}>اكتب جزءاً من SHA أو الرسالة لتضييق النتائج.</Text> : null}
                              </>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    ) : null}
                    </>
                  ) : (
                    <FirmwareNotice
                      title="تهيئة البناء جاهزة"
                      text="اختر Flight Controller وإصدار Firmware أعلاه؛ ستظهر هنا مباشرة خيارات Core/Cloud وRadio وTelemetry وOSD وMotor والخيارات الأخرى."
                      tone="info"
                    />
                  )}
                </FirmwareSection>

                <FirmwareButton
                  title="بناء وتنزيل Firmware"
                  onPress={buildRemoteFirmware}
                  disabled={isBusy || targetDetail === null}
                  testID="build-firmware"
                />
              </>
            ) : null}

            {firmware ? (
              <FirmwareNotice title={`${firmware.kind} صالح • ${firmwareFilenameLabel(firmware.filename)}`} text={firmwareDescription(firmware)} tone="success" />
            ) : null}
          </>
        ) : (
          <>
            <FirmwareSection title="Firmware المحمّل" caption="لا يكفي امتداد الملف؛ تم تحليل البنية والعناوين والـ checksum.">
              {firmware ? (
                <FirmwareNotice title={`${firmware.kind} • ${firmwareFilenameLabel(firmware.filename)}`} text={firmwareDescription(firmware)} tone="success" />
              ) : (
                <FirmwareNotice title="لا يوجد ملف" text="ارجع إلى الخطوة الأولى وحمّل Firmware صالحاً." tone="warning" />
              )}
              <View style={styles.twoButtons}>
                <View style={styles.flexOne}><FirmwareButton title="اختيار ملف آخر" onPress={pickLocalFirmware} disabled={isBusy} tone="secondary" /></View>
                <View style={styles.flexOne}><FirmwareButton title="حفظ نسخة" onPress={saveCurrentFirmware} disabled={isBusy || !firmware} tone="secondary" /></View>
              </View>
              {firmware?.kind === 'HEX' ? (
                <FirmwareChoice
                  value={hexMethod}
                  choices={[{value: 'dfu', label: 'STM32 DFU (DfuSe)'}, {value: 'serial', label: 'STM32 ROM Serial'}]}
                  onChange={setHexMethod}
                  disabled={isBusy}
                  testIDPrefix="hex-method"
                />
              ) : null}
              {firmware?.kind === 'UF2' ? (
                <FirmwareNotice
                  title="مسار UF2 الصحيح"
                  text="سيُحفظ الملف بعد التحقق. أدخل RP2040/STM32 في وضع BOOT ثم انسخ UF2 إلى قرص USB الظاهر؛ UF2 ليس DfuSe ولا يُرسل إلى واجهة DFU."
                  tone="info"
                />
              ) : null}
              {configurationLines ? (
                <FirmwareNotice
                  title={`Custom Defaults • ${configurationLabel ?? 'إعداد صالح'}`}
                  text={firmware?.kind === 'HEX'
                    ? `${configurationLines.length} سطراً ستُدخل في المساحة التي يعلنها HEX قبل المسح.`
                    : 'Custom Defaults لا تنطبق إلا على HEX؛ لن تُحقن في UF2 أو BIN.'}
                  tone={firmware?.kind === 'HEX' ? 'success' : 'warning'}
                />
              ) : null}
              <View style={styles.twoButtons}>
                <View style={styles.flexOne}><FirmwareButton title="تغيير Unified Config" onPress={pickLocalConfiguration} disabled={isBusy} tone="secondary" testID="change-unified-config" /></View>
                <View style={styles.flexOne}><FirmwareButton title="إزالة Unified Config" onPress={clearConfiguration} disabled={isBusy || configurationLines === null} tone="secondary" /></View>
              </View>
            </FirmwareSection>

            <FirmwareSection title="USB وBootloader" caption="يجب اختيار جهاز واحد بوضوح عند وجود أكثر من وحدة USB.">
              <View style={styles.twoButtons}>
                <View style={styles.flexOne}><FirmwareButton title="تحديث أجهزة USB" onPress={() => refreshDevices().catch(setFailure)} disabled={isBusy} tone="secondary" /></View>
                <View style={styles.flexOne}><FirmwareButton title="Auto detect" onPress={autoDetect} disabled={isBusy} tone="secondary" /></View>
              </View>
              {/* Browser only - see chooseSerialDevice()/chooseDfuDevice().
                  Android raises its own system permission dialog during
                  open() and renders neither button. */}
              {supportsSerialPicker || supportsDfuPicker ? (
                <View style={styles.twoButtons}>
                  {supportsSerialPicker ? (
                    <View style={styles.flexOne}>
                      <FirmwareButton
                        title="اختيار جهاز USB"
                        onPress={chooseSerialDevice}
                        disabled={isBusy}
                        tone="secondary"
                        testID="firmware-choose-serial-device"
                      />
                    </View>
                  ) : null}
                  {supportsDfuPicker ? (
                    <View style={styles.flexOne}>
                      <FirmwareButton
                        title="اختيار STM32 DFU"
                        onPress={chooseDfuDevice}
                        disabled={isBusy}
                        tone="secondary"
                        testID="firmware-choose-dfu-device"
                      />
                    </View>
                  ) : null}
                </View>
              ) : null}
              {firmware?.kind === 'HEX' && hexMethod === 'dfu' ? (
                noReboot ? (
                  dfuDevices.length > 0 ? (
                    <FirmwareNotice
                      title="وضع DFU جاهز"
                      text="الجهاز ظاهر كـ STM32 DFU. سيبدأ DfuSe مباشرةً بعد إقرارات الأمان من دون البحث عن Serial."
                      tone="success"
                    />
                  ) : (
                    <FirmwareNotice
                      title="ينتظر DFU اليدوي"
                      text="خيار «بدون تسلسل إعادة تشغيل» مفعّل، لكن لا يوجد جهاز DFU الآن. اضغط BOOT أثناء توصيل USB ثم حدّث الأجهزة."
                      tone="warning"
                    />
                  )
                ) : serialDevices.length > 0 ? (
                  <FirmwareNotice
                    title="الوضع العادي مكتشف"
                    text="الجهاز ظاهر كمنفذ USB عادي. عند البدء سيقرأ التطبيق هوية Target، يرسل أمر MSP الآمن للدخول إلى Bootloader، ثم ينتظر ظهور DFU تلقائياً قبل أي مسح."
                    tone="info"
                  />
                ) : dfuDevices.length > 0 ? (
                  <FirmwareNotice
                    title="الجهاز في DFU بالفعل"
                    text="فعّل «بدون تسلسل إعادة تشغيل» وأكّد Target يدوياً؛ لا يوجد منفذ Serial يمكن استخدامه للتعرف التلقائي أو النسخة الاحتياطية."
                    tone="warning"
                  />
                ) : (
                  <FirmwareNotice
                    title="لا يوجد مسار USB جاهز"
                    text="صِل Flight Controller بكابل بيانات ثم حدّث الأجهزة. سيظهر إما كمنفذ Serial عادي أو كجهاز STM32 DFU."
                    tone="warning"
                  />
                )
              ) : null}
              <FirmwareButton
                title={`${advancedUsbRecoveryExpanded ? 'إخفاء' : 'عرض'} أدوات USB والاستعادة المتقدمة`}
                onPress={() => setAdvancedUsbRecoveryExpanded(value => !value)}
                disabled={isBusy}
                tone="secondary"
                testID="toggle-advanced-usb-recovery"
              />
              {advancedUsbRecoveryExpanded ? (
                <>
              <View style={styles.twoButtons}>
                <View style={styles.flexOne}>
                  <FirmwareButton
                    title="إجراء التفليش الأساسي"
                    tone="secondary"
                    onPress={() => setShowFlashGuide(value => !value)}
                    testID="toggle-flash-guide"
                  />
                </View>
                <View style={styles.flexOne}>
                  <FirmwareButton
                    title="استكشاف أعطال Firmware"
                    tone="secondary"
                    onPress={() => setShowTroubleshooting(value => !value)}
                    testID="toggle-flash-troubleshooting"
                  />
                </View>
              </View>
              {showFlashGuide ? (
                <FirmwareNotice
                  title="الإجراء الأساسي داخل FPV-ARBCON"
                  text="أزل المراوح وافصل البطارية، اختر Target والإصدار أو ملفاً محلياً، تحقق من صيغة HEX/UF2/BIN، صِل USB فقط، اختر جهازاً واحداً، أكّد بوابة الأمان، ثم ابدأ ولا تفصل الكابل حتى يكتمل التحقق وإعادة التشغيل."
                  tone="info"
                />
              ) : null}
              {showTroubleshooting ? (
                <FirmwareNotice
                  title="استكشاف الأعطال داخل التطبيق"
                  text="إذا لم يظهر الجهاز: بدّل كابل USB إلى كابل بيانات، امنح إذن USB، أعد إدخال BOOT/DFU ثم حدّث الأجهزة. عند تعدد الأجهزة اختر الجهاز والمنفذ يدوياً. لا تتجاوز عدم تطابق Target، ولا تستخدم المسح الكامل إلا للاستعادة المتقدمة."
                  tone="warning"
                />
              ) : null}
                </>
              ) : (
                <FirmwareNotice
                  title="المسار البسيط جاهز"
                  text="عند وجود جهاز واحد يختاره التطبيق تلقائياً، ويعيد ربط Android USB ID إذا تغيّر. افتح الأدوات المتقدمة فقط للاستعادة أو التشخيص."
                  tone="success"
                />
              )}
              {serialDevices.length > 0 ? <Text style={styles.fieldLabel}>أجهزة Serial</Text> : null}
              {serialDevices.map(device => (
                <Pressable
                  key={device.deviceId}
                  disabled={isBusy}
                  onPress={() => { setSelectedSerialId(device.deviceId); setSelectedPortIndex(0); }}
                  style={[styles.deviceRow, selectedSerialId === device.deviceId && styles.deviceRowSelected]}>
                  <Text style={styles.deviceName}>{deviceLabel(device)}</Text>
                  <Text style={styles.deviceMeta}>{device.driverType} • {device.portCount} منفذ</Text>
                </Pressable>
              ))}
              {selectedSerial && selectedSerial.portCount > 1 ? (
                <FirmwareChoice
                  value={String(selectedPortIndex)}
                  choices={Array.from({length: selectedSerial.portCount}, (_, index) => ({value: String(index), label: `المنفذ ${index}`}))}
                  onChange={value => setSelectedPortIndex(Number(value))}
                  disabled={isBusy}
                />
              ) : null}
              {dfuDevices.length > 0 ? <Text style={styles.fieldLabel}>أجهزة DFU</Text> : null}
              {dfuDevices.map(device => (
                <Pressable
                  key={device.deviceId}
                  testID={`dfu-device-${device.deviceId}`}
                  disabled={isBusy}
                  onPress={() => setSelectedDfuId(device.deviceId)}
                  style={[styles.deviceRow, selectedDfuId === device.deviceId && styles.deviceRowSelected]}>
                  <Text style={styles.deviceName}>{dfuLabel(device)}</Text>
                  <Text style={styles.deviceMeta}>Interface {device.interfaceNumber} • Alt {device.alternateSetting} • {device.memoryLayout ?? 'Memory layout سيُتحقق منه قبل المسح'}</Text>
                </Pressable>
              ))}
              {advancedUsbRecoveryExpanded ? (
                <>
                  <FirmwareButton title="الخروج من وضع DFU" onPress={exitDfu} disabled={isBusy || dfuDevices.length === 0} tone="secondary" />
                  <FirmwareToggle
                    label="أفهم أن إزالة Read Protection تمسح Flash بالكامل"
                    detail="خيار إنقاذ متقدم فقط للوحات STM32 المحمية؛ ستحتاج إعادة إدخال DFU والتفليش بعدها."
                    value={readUnprotectConfirmed}
                    onValueChange={setReadUnprotectConfirmed}
                    disabled={isBusy || dfuDevices.length === 0}
                    warning
                    testID="confirm-dfu-read-unprotect"
                  />
                  <FirmwareButton
                    title="إزالة DFU Read Protection"
                    onPress={unprotectDfu}
                    disabled={isBusy || dfuDevices.length === 0 || !readUnprotectConfirmed}
                    tone="danger"
                    testID="unprotect-dfu-device"
                  />
                </>
              ) : null}
            </FirmwareSection>

            <FirmwareSection title="خيارات التفليش والاستعادة" caption="الإعدادات الافتراضية هي المسار الموصى به؛ التفاصيل المتقدمة متاحة عند الحاجة.">
              <FirmwareNotice
                title="الإعداد الآمن الموصى به"
                text="مسح انتقائي، دخول Bootloader تلقائي، Baud تلقائي، ونسخة CLI لهذا التشغيل مع استعادتها بعد النجاح."
                tone="success"
              />
              <FirmwareButton
                title={`${advancedFlashOptionsExpanded ? 'إخفاء' : 'عرض'} خيارات التفليش المتقدمة`}
                onPress={() => setAdvancedFlashOptionsExpanded(value => !value)}
                disabled={isBusy}
                tone="secondary"
                testID="toggle-advanced-flash-options"
              />
              {advancedFlashOptionsExpanded ? (
                <>
              <FirmwareToggle
                label="مسح كامل للـ Chip"
                detail="يمسح كل القطاعات؛ المسح الانتقائي هو الخيار الافتراضي الأكثر أماناً."
                value={fullErase}
                onValueChange={setFullErase}
                disabled={isBusy}
                warning
              />
              <FirmwareToggle
                label="بدون تسلسل إعادة تشغيل"
                detail="استخدمه عندما وضعت اللوحة يدوياً في bootloader."
                value={noReboot}
                onValueChange={value => {
                  setNoReboot(value);
                  if (!value) setFlashOnConnect(false);
                }}
                disabled={isBusy}
              />
              <FirmwareToggle
                label="Flash on connect"
                detail="يبدأ عند توصيل bootloader فقط بعد اكتمال جميع إقرارات الأمان."
                value={flashOnConnect}
                onValueChange={setFlashOnConnect}
                disabled={isBusy || !noReboot}
                warning
              />
              <FirmwareToggle
                label="Baud rate يدوي"
                detail="التلقائي: 256000 لـ STM32 و460800 لـ ESP."
                value={manualBaud}
                onValueChange={setManualBaud}
                disabled={isBusy}
              />
              {manualBaud ? (
                <FirmwareChoice
                  value={String(baudRate)}
                  choices={FLASH_BAUD_RATES.map(value => ({value: String(value), label: String(value)}))}
                  onChange={value => setBaudRate(Number(value))}
                  disabled={isBusy}
                />
              ) : null}
              <Text style={styles.fieldLabel}>سياسة النسخة الاحتياطية CLI</Text>
              <FirmwareChoice
                value={backupMode}
                choices={[{value: 'ask', label: 'اسأل / لكل تشغيل'}, {value: 'always', label: 'دائماً'}, {value: 'never', label: 'معطّل'}]}
                onChange={setBackupMode}
                disabled={isBusy}
              />
              {backupMode === 'ask' ? (
                <FirmwareToggle
                  label="إنشاء Backup لهذا التشغيل"
                  detail="diff all ثم حفظ ملف فعلي قبل أي erase."
                  value={backupThisRun}
                  onValueChange={setBackupThisRun}
                  disabled={isBusy}
                />
              ) : null}
              <FirmwareToggle
                label="استعادة الإعدادات بعد التفليش"
                detail="تُستعاد نسخة الذاكرة فقط إذا نجح التفليش وعاد المنفذ؛ save لا يُرسل عند أي خطأ CLI."
                value={restoreAfterFlash}
                onValueChange={setRestoreAfterFlash}
                disabled={isBusy || backupMode === 'never'}
              />
              <FirmwareButton title="استعادة Backup CLI من ملف" onPress={restoreLocalBackup} disabled={isBusy || serialDevices.length === 0} tone="secondary" />
                </>
              ) : null}
            </FirmwareSection>

            <FirmwareSection title="بوابة الأمان" caption="لا يمكن تجاوز هذه الخطوات ضمنياً حتى مع Flash on connect.">
              <FirmwareToggle label="أزلت جميع المراوح" value={propsRemoved} onValueChange={setPropsRemoved} disabled={isBusy} warning testID="confirm-props-removed" />
              <FirmwareToggle label="فصلت البطارية والطاقة من USB فقط" value={usbPowerOnly} onValueChange={setUsbPowerOnly} disabled={isBusy} warning testID="confirm-usb-power-only" />
              {noReboot ? (
                <FirmwareToggle
                  label="تحققت يدوياً من Target والـ bootloader"
                  detail="مطلوب لأن MSP auto detect غير متاح بعد الدخول اليدوي إلى bootloader."
                  value={manualTargetConfirmed}
                  onValueChange={setManualTargetConfirmed}
                  disabled={isBusy}
                  warning
                />
              ) : null}
              {selectedTarget && detectedTarget && selectedTarget.toUpperCase() !== detectedTarget.toUpperCase() ? (
                <FirmwareToggle
                  label="تجاوز عدم تطابق Target"
                  detail={`المحدد ${selectedTarget}، المكتشف ${detectedTarget}. تفعيل هذا الخيار قد يعطّل اللوحة.`}
                  value={targetMismatchOverride}
                  onValueChange={setTargetMismatchOverride}
                  disabled={isBusy}
                  warning
                />
              ) : null}
              {isDevelopment ? (
                <FirmwareToggle
                  label="أفهم مخاطر الإصدار التطويري"
                  detail="قد توجد تغييرات غير مستقرة؛ لن يبدأ التفليش دون هذا الإقرار."
                  value={unstableConfirmed}
                  onValueChange={setUnstableConfirmed}
                  disabled={isBusy}
                  warning
                />
              ) : null}
            </FirmwareSection>
          </>
        )}

        <FirmwareSection title="حالة العملية" caption="آخر 60 رسالة فقط تُحفظ في الذاكرة لمنع نمو السجل وإبطاء الشاشة.">
          <FirmwareProgress percent={progress} label={status} />
          {flashResult !== undefined ? (
            /* THE ONE RESULT (P0-F). Every flash attempt ends with exactly
             * one of these three lines - never a bar left claiming 98%. */
            <View
              style={[
                styles.resultNotice,
                flashResult.kind === 'SUCCESS'
                  ? styles.resultSuccess
                  : flashResult.kind === 'FAILED'
                    ? styles.resultFailed
                    : styles.resultUnconfirmed,
              ]}
              testID="flash-result">
              <Text
                style={[
                  styles.resultTitle,
                  flashResult.kind === 'SUCCESS'
                    ? styles.resultTitleSuccess
                    : flashResult.kind === 'FAILED'
                      ? styles.resultTitleFailed
                      : styles.resultTitleUnconfirmed,
                ]}
                testID="flash-result-title">
                {t(`firmwareFlasher.result.${flashResult.kind}`)}
              </Text>
              {flashResult.reason !== undefined && flashResult.kind !== 'SUCCESS' ? (
                <Text style={styles.resultBody} testID="flash-result-reason">
                  {flashResult.reason}
                </Text>
              ) : null}
              {flashResult.nextAction !== undefined ? (
                <Text style={styles.resultBody} testID="flash-result-next-action">
                  {flashResult.nextAction}
                </Text>
              ) : null}
              {flashResult.restore?.kind === 'FAILED' ? (
                <Text style={styles.resultBody} testID="flash-restore-failed">
                  {t('firmwareFlasher.result.restoreFailed', {
                    reason: flashResult.restore.detail ?? '',
                  })}
                </Text>
              ) : flashResult.restore?.kind === 'SUCCEEDED' ? (
                <Text style={styles.resultBody} testID="flash-restore-succeeded">
                  {t('firmwareFlasher.result.restoreSucceeded')}
                </Text>
              ) : null}
            </View>
          ) : null}
          {bootloaderState !== undefined ? (
            <Text style={styles.stallBody} testID="flasher-bootloader-state">
              {t(bootloaderStateLabelKey(bootloaderState))}
            </Text>
          ) : null}
          {pendingBootloaderFlash !== undefined ? (
            <View style={styles.stallNotice} testID="flasher-awaiting-dfu-permission">
              <Text style={styles.stallTitle}>
                {t('firmwareFlasher.bootloader.WAITING_FOR_PERMISSION')}
              </Text>
              <Text style={styles.stallBody}>
                {t('firmwareFlasher.permissionNeededBody')}
              </Text>
              <FirmwareButton
                title={t('firmwareFlasher.chooseDfuAndContinue')}
                onPress={chooseDfuAndContinue}
                tone="primary"
                testID="choose-dfu-and-continue"
              />
            </View>
          ) : null}
          {stallVerdict?.stalled === true && flashSnapshot !== undefined ? (
            <View style={styles.stallNotice} testID="flasher-stalled">
              <Text style={styles.stallTitle}>
                {t('firmwareFlasher.stalledTitle')}
              </Text>
              <Text style={styles.stallBody}>
                {t('firmwareFlasher.stalledBody', {
                  seconds: Math.round(stallVerdict.silentForMs / 1000),
                  phase: t(flashPhaseLabelKey(flashSnapshot.phase)),
                })}
              </Text>
              <Text style={styles.stallBody}>
                {t('firmwareFlasher.stalledWebUsbNote')}
              </Text>
            </View>
          ) : null}
          {flashSnapshot !== undefined ? (
            <>
              <FirmwareButton
                title={t('firmwareFlasher.copyReport')}
                onPress={copyFlashReport}
                tone="secondary"
                testID="copy-flash-report"
              />
              {flashReportCopied !== 'idle' ? (
                <Text style={styles.stallBody} testID="copy-flash-report-result">
                  {t(
                    flashReportCopied === 'copied'
                      ? 'firmwareFlasher.copyReportDone'
                      : 'firmwareFlasher.copyReportFailed',
                  )}
                </Text>
              ) : null}
            </>
          ) : null}
          {buildKey ? (
            <>
              <FirmwareButton
                title={buildLogLoading ? 'تحميل سجل Build…' : 'عرض سجل Build داخل التطبيق'}
                onPress={loadBuildLogInsideApp}
                disabled={buildLogLoading}
                tone="secondary"
                testID="load-build-log"
              />
              {buildLogText ? (
                <View style={styles.logBox} testID="build-log">
                  <Text style={styles.logLine}>{buildLogText}</Text>
                </View>
              ) : null}
            </>
          ) : null}
          <View style={styles.twoButtons}>
            <View style={styles.flexOne}>
              <FirmwareButton
                title={firmware?.kind === 'UF2' ? 'تحقق وحفظ UF2' : 'ابدأ التفليش الآمن'}
                onPress={startFlash}
                disabled={isBusy || !firmware}
                testID="start-safe-flash"
              />
            </View>
            {canCancel ? (
              <View style={styles.flexOne}><FirmwareButton title="إلغاء" onPress={cancelOperation} tone="danger" testID="cancel-firmware-operation" /></View>
            ) : null}
          </View>
          {logLines.length > 0 ? (
            <View style={styles.logBox} testID="firmware-log">
              {logLines.map((line, index) => <Text key={`${index}-${line}`} style={styles.logLine}>{line}</Text>)}
            </View>
          ) : null}
        </FirmwareSection>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  resultNotice: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
  },
  resultSuccess: {
    backgroundColor: colors.successSoft,
    borderColor: colors.success,
  },
  resultFailed: {
    backgroundColor: colors.errorSoft,
    borderColor: colors.error,
  },
  resultUnconfirmed: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
  },
  resultTitle: {
    ...typography.bodyStrong,
    color: colors.textPrimary,
  },
  resultTitleSuccess: {
    color: colors.success,
  },
  resultTitleFailed: {
    color: colors.error,
  },
  resultTitleUnconfirmed: {
    color: colors.warning,
  },
  resultBody: {
    ...typography.caption,
    color: colors.textPrimary,
  },
  stallNotice: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
    gap: spacing.xs,
  },
  stallTitle: {
    ...typography.sectionTitle,
    color: colors.warning,
    writingDirection: 'rtl',
  },
  stallBody: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  root: {flex: 1, backgroundColor: colors.background},
  modalRoot: {
    flex: 1,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.md,
    backgroundColor: colors.background,
  },
  modalHeader: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  modalTitle: {...typography.title, color: colors.textPrimary},
  modalClose: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  modalCloseText: {fontSize: 30, lineHeight: 32, color: colors.textPrimary},
  loadingRow: {minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm},
  loadingText: {...typography.body, color: colors.textSecondary},
  header: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.backgroundRaised,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  backButton: {width: 42, height: 42, borderRadius: 21, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center'},
  headerCopy: {flex: 1},
  headerEyebrow: {...typography.eyebrow, color: colors.accentStrong},
  headerTitle: {...typography.title, color: colors.textPrimary},
  formatPill: {paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.pill, backgroundColor: colors.surfaceAlt},
  formatPillText: {...typography.caption, color: colors.info, fontWeight: '700'},
  steps: {flexDirection: 'row', padding: spacing.sm, gap: spacing.sm, backgroundColor: colors.backgroundRaised},
  step: {flex: 1, minHeight: 40, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center'},
  stepActive: {backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accent},
  stepText: {...typography.caption, color: colors.textMuted, fontWeight: '700'},
  stepTextActive: {color: colors.accentStrong},
  scroll: {flex: 1},
  content: {
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    padding: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  input: {
    minHeight: 46,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundRaised,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    textAlign: 'right',
    ...typography.body,
  },
  monoInput: {...typography.mono, textAlign: 'left', writingDirection: 'ltr'},
  selectorButton: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, minHeight: 48, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.borderStrong}, selectorCopy: {flex: 1, gap: 2},
  selectorValue: {...typography.sectionTitle, color: colors.textPrimary},
  selectorHint: {...typography.caption, color: colors.textMuted},
  targetList: {flex: 1, borderRadius: radii.md, backgroundColor: colors.backgroundRaised},
  targetListContent: {paddingBottom: spacing.xl},
  targetRow: {minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.borderSoft},
  targetRowSelected: {backgroundColor: colors.accentSoft},
  targetCopy: {flex: 1},
  targetName: {...typography.sectionTitle, color: colors.textPrimary},
  targetMeta: {...typography.caption, color: colors.textMuted},
  targetGroup: {...typography.caption, color: colors.info, maxWidth: 105, textAlign: 'left'},
  emptyText: {...typography.body, color: colors.textMuted, padding: spacing.lg, textAlign: 'center'},
  choiceRows: {gap: spacing.sm},
  releaseRow: {padding: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt},
  releaseRowSelected: {borderColor: colors.accent, backgroundColor: colors.accentSoft},
  releaseText: {...typography.sectionTitle, color: colors.textPrimary},
  releaseTextSelected: {color: colors.accentStrong},
  releaseMeta: {...typography.caption, color: colors.textMuted},
  optionGroup: {gap: spacing.sm},
  fieldLabel: {...typography.sectionTitle, color: colors.textSecondary},
  twoButtons: {flexDirection: 'row', gap: spacing.sm},
  flexOne: {flex: 1},
  deviceRow: {padding: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.backgroundRaised, gap: 2},
  deviceRowSelected: {borderColor: colors.accent, backgroundColor: colors.accentSoft},
  deviceName: {...typography.sectionTitle, color: colors.textPrimary},
  deviceMeta: {...typography.caption, color: colors.textMuted},
  commitRow: {padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.borderSoft, gap: 2},
  commitMessage: {...typography.caption, color: colors.textPrimary, fontWeight: '700'},
  commitSha: {...typography.mono, color: colors.textMuted, textAlign: 'left', writingDirection: 'ltr'},
  logBox: {maxHeight: 280, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surfaceAlt, gap: 4},
  logLine: {...typography.mono, color: colors.textSecondary, textAlign: 'left', writingDirection: 'ltr'},
  dimmed: {opacity: 0.4},
});
