import {OperatorMessageError} from '../../core/firmware-flasher/operatorMessage';
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
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type {RootStackParamList} from '../../navigation/types';
import {describeFlightControllerHardware, resolveCatalogTarget} from '../../core';
import {abortable} from '../../core/async/deadline';
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
import {MIN_TOUCH_TARGET} from '../components/controls';
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
import {PROSE_MEASURE, colors, noticeSurface, radii, spacing, typography} from '../theme';
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
  flashRecoveryLabelKey,
  readFlashFailureDetail,
  recoveryAdvisoryFor,
  resolveOperatorFacingText,
  FlashPlanError,
} from '../../core/firmware-flasher/flashErrorCodes';
import {runImagePreflight} from '../../core/firmware-flasher/imagePreflight';
import type {CancellationTicket} from '../../platforms/react-native/protocol/Stm32SerialFlasher';
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
/**
 * The three DOM shapes this screen's web-only dialog path needs. Declared
 * structurally so the React Native project need not pull in `lib.dom`.
 */
type WebFocusable = {
  focus?: () => void;
  readonly isConnected?: boolean;
  getAttribute?: (name: string) => string | null;
};
type WebKeyEvent = {
  readonly key: string;
  readonly shiftKey: boolean;
  preventDefault: () => void;
};
type WebElementList = {readonly length: number; readonly [index: number]: WebFocusable};
type WebDocument = {
  readonly activeElement?: WebFocusable | null;
  querySelector: (selector: string) => {querySelectorAll: (s: string) => WebElementList} | null;
  addEventListener: (type: string, listener: (event: WebKeyEvent) => void, capture?: boolean) => void;
  removeEventListener: (type: string, listener: (event: WebKeyEvent) => void, capture?: boolean) => void;
};

type FlashResultPresentation = {
  readonly kind: FlashOutcomeKind;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly restore?: FlashRestoreTruth;
  /**
   * The DESTRUCTIVE-STATE advisory, shown ALONGSIDE the reason and never
   * instead of it. Present only when the board's flash may no longer hold
   * runnable firmware.
   */
  readonly recovery?: string;
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
  return "Onverwachte fout in Firmware Flasher.";
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
      return `${image.hex.totalBytes.toLocaleString('nl-NL')} byte • ${image.hex.segments.length} gebieden • 0x${image.hex.lowestAddress.toString(16)} — 0x${image.hex.highestAddressExclusive.toString(16)}`;
    case 'UF2':
      return `${image.uf2.totalPayloadBytes.toLocaleString('nl-NL')} byte • ${image.uf2.blocks.length} blokken • Family ${image.uf2.familyId === undefined ? "Niet opgegeven" : `0x${image.uf2.familyId.toString(16)}`}`;
    case 'BIN':
      return `${image.esp.imageBytes.toLocaleString('nl-NL')} byte • ESP chip ID 0x${image.esp.chipId.toString(16)} • ${image.esp.segmentCount} delen`;
  }
}

function groupLabel(group: string | undefined): string {
  switch (group) {
    case 'supported': return "Geverifieerde partner";
    case 'legacy': return "Verouderd / Legacy";
    default: return "Fabrikantcommunity";
  }
}

function releaseLabel(release: FirmwareRelease): string {
  const channel = release.channel === 'stable'
    ? "Stabiel"
    : release.channel === 'candidate'
      ? "Releasekandidaat"
      : "Ontwikkelversie";
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
    ...(options.some(option => option.value === '') ? [] : [{value: '', label: "Geen"}]),
    ...options.map(option => ({value: option.value, label: option.name})),
  ].filter((choice, index, all) => all.findIndex(candidate => candidate.value === choice.value) === index);
  const selectedLabel = choices.find(choice => choice.value === selected)?.label ?? "Kiezen";
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
          <Text style={styles.selectorHint}>{open ? "Opties verbergen" : "Kiezen of wijzigen"}</Text>
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
  const [status, setStatus] = useState("Kies een Target en een online versie, of laad een lokaal bestand.");
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
  /** The flasher instance that owns the CURRENT attempt's cancellation
   *  decision. React's rendered progress is one frame behind the wire and
   *  must never be the thing that decides whether cancelling is safe. */
  const activeFlasher = useRef<Stm32SerialFlasher | null>(null);
  const [pendingCancel, setPendingCancel] = useState<CancellationTicket | null>(null);
  /** The authority for "is a question still unanswered", readable and
   *  clearable synchronously so one keypress cannot be answered twice. */
  const pendingCancelRef = useRef<CancellationTicket | null>(null);

  const bootloader = useMemo(() => new FirmwareBootloaderController(client), [client]);
  const cliBackup = useMemo(() => new CliBackupService(client), [client]);
  const cloudBuild = useMemo(() => new CloudBuildCoordinator(buildApi), [buildApi]);

  const appendLog = useCallback((line: string) => {
    const clean = sanitizeUserVisibleText(line.trim());
    if (!clean) return;
    setLogLines(previous => [`${new Date().toLocaleTimeString('nl-NL')} — ${clean}`, ...previous].slice(0, MAX_LOG_LINES));
  }, []);

  /**
   * The NON-FLASH failure funnel. It used to render `error.message`
   * verbatim, so whatever text an exception happened to carry became the
   * operator's line. It now goes through the same contract as the flash
   * funnel; the raw sentence survives on the diagnostic surface below.
   */
  const setFailure = useCallback((error: unknown) => {
    const message = resolveOperatorFacingText(t, error);
    const diagnostics = sanitizeUserVisibleText(errorMessage(error));
    setOperation('error');
    setStatus(message);
    appendLog(`Fout: ${message}`);
    if (diagnostics.length > 0 && diagnostics !== message) {
      appendLog(`Diagnostiek: ${diagnostics}`);
    }
  }, [appendLog, t]);

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
    appendLog(`Ontdek USB: ${supported.length} serial en ${dfu.length} DFU.`);
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

  /**
   * THE BOARDS DOWNLOAD, ON ITS OWN, so a retry can repeat exactly this
   * and nothing else.
   *
   * It used to live inline in the mount effect below, beside USB
   * discovery and the attach/detach subscriptions. That made the failure
   * copy - "استخدم الملف المحلي أو أعد المحاولة" - a promise the screen
   * could not keep: there was no way to run this again without unmounting
   * the whole screen, and re-running the effect would also have torn down
   * and rebuilt the USB listeners, which have nothing to do with a failed
   * HTTP request.
   *
   * Its own AbortController, superseding the previous attempt, so a
   * second press cannot let a slow first answer overwrite a newer one.
   */
  const targetsAbortRef = useRef<AbortController | null>(null);
  const loadTargetCatalog = useCallback(() => {
    targetsAbortRef.current?.abort();
    const controller = new AbortController();
    targetsAbortRef.current = controller;
    setTargetsLoadState('loading');
    setTargetsLoadError(null);
    buildApi.loadTargets(controller.signal)
      .then(loadedTargets => {
        if (!mounted.current || controller.signal.aborted) return;
        setTargets(loadedTargets);
        setTargetsLoadState('ready');
        appendLog(`${loadedTargets.length} Target is gedownload van de officiële bron.`);
      })
      .catch(error => {
        if (!mounted.current || controller.signal.aborted) return;
        // Online failure must never disable local firmware or USB discovery.
        const message = errorMessage(error);
        setTargetsLoadState('error');
        setTargetsLoadError(message);
        setStatus(`De online lijst kon niet worden geladen. De lokale werkwijze blijft beschikbaar. ${message}`);
        appendLog(`De Target-lijst kon niet worden bijgewerkt: ${message}`);
      });
  }, [appendLog, buildApi]);

  useEffect(() => {
    mounted.current = true;
    loadTargetCatalog();
    refreshDevices().catch(error => {
      if (mounted.current) appendLog(`USB-apparaten zoeken is mislukt: ${errorMessage(error)}`);
    });
    const unsubscribeAttach = client.onDeviceAttached(() => {
      refreshDevices().catch(error => appendLog(errorMessage(error)));
    });
    const unsubscribeDetach = client.onDeviceDetached(() => {
      refreshDevices().catch(error => appendLog(errorMessage(error)));
    });
    return () => {
      mounted.current = false;
      targetsAbortRef.current?.abort();
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
  }, [appendLog, client, loadTargetCatalog, refreshDevices]);

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
        setStatus(`Versies ${selectedTarget}: ${message} niet te downloaden`);
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
        appendLog(`Cloud Build-opties konden niet worden geladen; Core Build blijft beschikbaar: ${optionsError}`);
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
      setConfigurationLabel(configuration ? `De standaard ${detail.target}.` : null);
      setUnstableConfirmed(false);
      setExpertMode(false);
      setGeneralOptionsExpanded(false);
      appendLog(`Details ${selectedTarget} / ${selectedRelease} klaar.`);
    }).catch(error => {
      if (controller.signal.aborted) return;
      const message = errorMessage(error);
      setTargetDetail(null);
      setDetailLoadState('error');
      setDetailLoadError(message);
      setBuildOptionsLoadState('error');
      setBuildOptionsLoadError("De opties zijn niet geladen omdat de release details nog niet voltooid zijn.");
      setStatus(`Buildgegevens konden niet worden geladen: ${message}`);
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
        if (!controller.signal.aborted) appendLog(`Commits: ${errorMessage(error)} kan niet worden geladen.`);
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
      {value: 'stable', label: "Stable / stabiel"},
      {value: 'candidate', label: 'Release Candidate'},
      {value: 'development', label: "Development / ontwikkelversie"},
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
    setStatus("Structuur van het firmwarebestand controleren…");
    await afterInteractions();
    const parsed = parseFirmwareFile(filename, bytes);
    if (!mounted.current) return;
    setFirmware(parsed);
    setHexMethod(parsed.kind === 'HEX' ? 'dfu' : 'serial');
    setOperation('idle');
    setProgress(0);
    setStatus(`Het bestand is geldig: ${firmwareFilenameLabel(parsed.filename)}`);
    appendLog(`${parsed.kind}: ${firmwareDescription(parsed)} is een succes.`);
    setStep('flash');
  }, [appendLog]);

  const pickLocalFirmware = useCallback(async () => {
    try {
      setSourceMode('local');
      const selection = await client.pickFirmwareFile();
      if (selection === null) return;
      setOperation('loading');
      setStatus("Firmwarebestand decoderen en verifiëren…");
      await afterInteractions();
      const bytes = await base64ToBytesAsync(selection.dataBase64);
      if (bytes.length !== selection.sizeBytes) throw new OperatorMessageError({key: 'flasherScreen.e01'}, "De grootte van het firmwarebestand wijkt af van de ontvangen gegevens.");
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
        throw new OperatorMessageError({key: 'flasherScreen.e02'}, "Unified Config is groter dan de veilige limiet van 256 KiB.");
      }
      setOperation('loading');
      setStatus("Unified Config decoderen en verifiëren…");
      const bytes = await base64ToBytesAsync(selection.dataBase64);
      if (bytes.length !== selection.sizeBytes) throw new OperatorMessageError({key: 'flasherScreen.e03'}, "De grootte van Unified Config wijkt af van de ontvangen gegevens.");
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const lines = parseUnifiedConfigText(text);
      setConfigurationLines(lines);
      setConfigurationLabel(firmwareFilenameLabel(selection.name));
      setOperation('idle');
      setStatus(`Unified Config geldig: ${firmwareFilenameLabel(selection.name)}. De configuratie wordt bij het flashen van HEX in het Custom Defaults-gebied geplaatst.`);
      appendLog(`Lokale Unified Config geladen (${lines.length} regels).`);
    } catch (error) {
      setFailure(error);
    }
  }, [appendLog, client, setFailure]);

  const clearConfiguration = useCallback(() => {
    setConfigurationLines(null);
    setConfigurationLabel(null);
    setStatus("Unified Config verwijderd. De firmware wordt zonder ingebedde Custom Defaults geflasht.");
  }, []);

  const buildRemoteFirmware = useCallback(async () => {
    if (targetDetail === null) return;
    if (!coreBuild && buildOptions.osdProtocols.length > 0 && !osdProtocol && !osdOmissionConfirmed) {
      setFailure(new Error("Kies een OSD-protocol of bevestig expliciet dat Cloud Build zonder OSD mag doorgaan."));
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
      appendLog(`Build: ${request.options.join(', ')} besteld.`);
      const result = await cloudBuild.buildAndDownload(request, update => {
        if (!mounted.current) return;
        if (update.key) setBuildKey(update.key);
        reportProgress(update.percent, update.message);
      }, controller.signal);
      const resolvedConfiguration = result.configuration ?? targetDetail.configuration;
      setConfigurationLines(resolvedConfiguration ?? null);
      setConfigurationLabel(resolvedConfiguration ? `Build voor ${targetDetail.target}.` : null);
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
    setStatus("Vluchtcontroller via MSP identificeren…");
    try {
      // Enumerate at the moment of the action. Android can assign a new
      // deviceId between the last rendered list and this press; reusing the
      // stale id is what previously produced "selected serial not found"
      // even while one controller was plainly visible on screen.
      const devices = (await client.listDevices()).filter(isSupportedDevice);
      const chosen = resolveSerialSelection(devices, selectedSerialId);
      if (!chosen) {
        throw devices.length > 1
          ? new FirmwareDetectionError(
              "Kies handmatig een USB-apparaat voordat u automatisch laat detecteren.",
              undefined,
              {key: 'flasherScreen.e26'},
            )
          : new FirmwareDetectionError(
              "Geen vluchtcontroller gevonden.",
              undefined,
              {key: 'flasherScreen.e27'},
            );
      }
      if (selectedPortIndex < 0 || selectedPortIndex >= chosen.portCount) {
        throw new FirmwareDetectionError("Ongeldige USB-seriële poort. Kies een poort uit de lijst en probeer het opnieuw.", undefined, {key: 'flasherScreen.e04'});
      }
      if (chosen.deviceId !== selectedSerialId) {
        setSelectedSerialId(chosen.deviceId);
        appendLog("De USB-identificatie is veranderd. De enige controller is opnieuw aangesloten voor automatische identificatie.");
      }
      const selection = {
        deviceId: chosen.deviceId,
        portIndex: selectedPortIndex,
      };
      const detected = await bootloader.detectFlightController(controller.signal, selection);
      try {
        const identity = detected.identity;
        // Board name first - see flightControllerNaming.ts. A unified
        // target answers its MCU family as targetName, which is never a
        // catalogue entry.
        const target = resolveCatalogTarget(identity.board);
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
          ? `${catalogMatch.target} herkend en geselecteerd.`
          : `${target} is geïdentificeerd, maar niet op de downloadlijst.`);
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
        sanitizeUserVisibleText(log.trim() || "Het Build-record is leeg."),
      );
    } catch (error) {
      setBuildLogText(
        `Build: ${sanitizeUserVisibleText(errorMessage(error))} record niet te downloaden.`,
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
          throw new OperatorMessageError(
            {key: 'flasherScreen.e28'},
            "Het apparaat staat in DFU-modus, niet in seriële modus. Kies DFU en bevestig het Target handmatig.",
          );
        }
      }
      throw devices.length > 1
        ? new OperatorMessageError({key: 'flasherScreen.e29'}, "Kies handmatig een serieel apparaat om door te gaan.")
        : new OperatorMessageError({key: 'flasherScreen.e30'}, "Het seriële apparaat is niet gevonden.");
    }
    if (selectedPortIndex < 0 || selectedPortIndex >= chosen.portCount) {
      throw new OperatorMessageError({key: 'flasherScreen.e05'}, "Ongeldig nummer voor de seriële poort.");
    }
    if (chosen.deviceId !== selectedSerialId) {
      setSelectedSerialId(chosen.deviceId);
      appendLog("De USB-identificatie verandert na het opnieuw tellen; Ik heb het enige veilig verbonden apparaat opnieuw aangesloten.");
    }
    return chosen;
  }, [appendLog, client, selectedPortIndex, selectedSerialId]);

  /**
   * A FILE-SAVE DIALOG IS PACED BY A PERSON, SO ITS EXIT IS CANCEL.
   *
   * `saveFirmwareFile()` resolves when the operator picks a location -
   * which may legitimately take minutes, so a deadline here would be a
   * defect. But `saving` makes `isBusy` true, and `isBusy` blocks
   * navigation, so a dialog whose Promise never settles used to trap the
   * operator on this screen with no cancel button. It now owns an
   * AbortController like every other operation, and `saving` is
   * cancellable.
   */
  const saveCurrentFirmware = useCallback(async () => {
    if (!firmware) return;
    const controller = new AbortController();
    operationController.current = controller;
    setOperation('saving');
    setStatus("Kies waar u de firmware wilt opslaan…");
    try {
      const saved = await abortable(
        client.saveFirmwareFile(
          firmwareFilenameLabel(firmware.filename),
          'application/octet-stream',
          bytesToBase64(firmware.bytes),
        ),
        controller.signal,
      );
      setOperation(saved ? 'success' : 'idle');
      setStatus(saved ? "Firmware is succesvol opgeslagen." : "Opslaan van firmware geannuleerd. Het bestand is niet gewijzigd.");
      if (saved) appendLog(`${firmwareFilenameLabel(firmware.filename)} is opgeslagen.`);
    } catch (error) {
      if (controller.signal.aborted) {
        // The operator's own cancel is not a failure banner.
        setOperation('idle');
        setStatus("Opslaan van firmware geannuleerd.");
      } else {
        setFailure(error);
      }
    } finally {
      if (operationController.current === controller) operationController.current = null;
    }
  }, [appendLog, client, firmware, setFailure]);

  const saveCliBackup = useCallback(async (
    device: UsbSerialDeviceDescriptor,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const shouldBackup = backupMode === 'always' || (backupMode === 'ask' && backupThisRun);
    if (!shouldBackup) return null;
    setOperation('backing-up');
    setStatus("CLI-back-up maken met diff all vóór het wissen…");
    const backup = await cliBackup.capture(device.deviceId, selectedPortIndex, signal);
    const filename = `fpv-arbcon-backup-${selectedTarget || 'fc'}-${Date.now()}.txt`;
    // Same reasoning as saveCurrentFirmware: a save dialog has no honest
    // deadline, so the flash's own cancel is what ends the wait.
    const saved = await abortable(cliBackup.saveBackup(filename, backup), signal);
    if (!saved) throw new OperatorMessageError({key: 'flasherScreen.e06'}, "Back-up geannuleerd. Wissen is niet gestart.");
    appendLog(`CLI-back-up opgeslagen (${backup.length} tekens) vóór het flashen.`);
    return backup;
  }, [appendLog, backupMode, backupThisRun, cliBackup, selectedPortIndex, selectedTarget]);

  const validateSafety = useCallback(() => {
    if (!firmware) throw new OperatorMessageError({key: 'flasherScreen.e07'}, "Kies eerst een geldig firmwarebestand.");
    if (!propsRemoved) throw new OperatorMessageError({key: 'flasherScreen.e08'}, "Bevestig dat de propellers verwijderd zijn voordat u flasht.");
    if (!usbPowerOnly) throw new OperatorMessageError({key: 'flasherScreen.e09'}, "Bevestig dat de accu losgekoppeld is en alleen USB voeding levert.");
    if (selectedReleaseInfo?.channel === 'development' && !unstableConfirmed) {
      throw new OperatorMessageError({key: 'flasherScreen.e10'}, "Een ontwikkelversie vereist expliciete aanvaarding van het risico.");
    }
    if (noReboot && !manualTargetConfirmed) {
      throw new OperatorMessageError({key: 'flasherScreen.e11'}, "Het Target moet handmatig worden bevestigd.");
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
    setStatus("Wachten op de vluchtcontroller en daarna de CLI-instellingen herstellen…");
    const device = await bootloader.waitForOneSerialDevice(30_000, signal);
    const result = await cliBackup.restore(device.deviceId, 0, backup, signal, (done, total) => {
      reportProgress(total > 0 ? 95 + done * 4 / total : 95, `CLI: ${done} / ${total} herstellen`);
    });
    if (result.errors.length > 0) {
      throw new OperatorMessageError({key: 'flasherScreen.e12', values: {v0: result.errors.length}}, `save is niet verzonden omdat ${result.errors.length} CLI-opdrachten zijn mislukt.`);
    }
    appendLog(`${result.commandCount} CLI-opdrachten hersteld; daarna is save verzonden.`);
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
      if (!chosen) throw new OperatorMessageError({key: 'flasherScreen.e13'}, "Kies één DFU-apparaat. De app kiest het flashdoel niet op goed geluk.");
      if (chosen.deviceId !== selectedDfuId) setSelectedDfuId(chosen.deviceId);
      dfu = chosen;
    } else {
      if (serial === null) throw new OperatorMessageError({key: 'flasherScreen.e14'}, "Geen serieel apparaat gekozen voor de herstart naar DFU.");
      const detected = await bootloader.detectFlightController(signal, {
        deviceId: serial.deviceId,
        portIndex: selectedPortIndex,
      });
      try {
        if (!targetMismatchOverride && !detected.targetMatches(selectedTarget)) {
          const actual = describeFlightControllerHardware(detected.identity.board);
          setDetectedTarget(actual);
          throw new OperatorMessageError({key: 'flasherScreen.e15', values: {v0: selectedTarget, v1: actual}}, `Target ${selectedTarget} komt niet overeen met ${actual}. Sta dit verschil alleen toe na handmatige controle.`);
        }
        await detected.rebootToBootloader(selectedTarget, targetMismatchOverride);
      } finally {
        /* Model B: the reboot CONSUMES the lease. The caller discharges the
         * obligation only when that transfer never happened. */
        if (detected.leaseState === 'HELD_BY_CALLER') await detected.release();
      }
      setStatus("Wachten op STM32 DFU…");
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
    appendLog(`DfuSe op deviceId ${dfu.deviceId} starten.`);
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
    attempt: number,
  ): Promise<FlashMethodOutcome> => {
    /**
     * THE AUTHORITATIVE PREFLIGHT, on the FINAL composed image and before
     * anything touches the bus. Unified Config is injected at flash time
     * and appends a segment of arbitrary length, so an image that looked
     * writable at file load can be unwritable here - these are the bytes
     * that would actually be sent. Every refusal below happens with no
     * port open, which is what makes it impossible to discover an
     * image-local fault after the board has already been erased.
     */
    const preflight = runImagePreflight(image.hex);
    if (!preflight.accepted) {
      throw new FlashPlanError(
        preflight.rejections[0].code,
        preflight.rejections.map(rejection => rejection.detail).join(' | '),
      );
    }

    let device = await requireOneSerial();
    const backup = noReboot ? null : await saveCliBackup(device, signal);
    if (!noReboot) {
      const detected = await bootloader.detectFlightController(signal, {
        deviceId: device.deviceId,
        portIndex: selectedPortIndex,
      });
      try {
        if (!targetMismatchOverride && !detected.targetMatches(selectedTarget)) {
          const actual = describeFlightControllerHardware(detected.identity.board);
          setDetectedTarget(actual);
          throw new OperatorMessageError({key: 'flasherScreen.e16', values: {v0: selectedTarget, v1: actual}}, `Target ${selectedTarget} komt niet overeen met ${actual}.`);
        }
        await detected.rebootToBootloader(selectedTarget, targetMismatchOverride);
      } finally {
        /* Model B: rebootToBootloader CONSUMES the lease and releases on
         * every one of its own exits. The caller discharges the obligation
         * only on paths where that transfer never happened - so exactly one
         * logical release, never two. */
        if (detected.leaseState === 'HELD_BY_CALLER') await detected.release();
      }
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
    }, {
      attemptId: attempt,
      onCancelConfirmed: () => operationController.current?.abort(),
    });
    activeFlasher.current = flasher;
    try {
      await flasher.flash(preflight.snapshot, {baudRate: manualBaud ? baudRate : 256000, fullErase});
    } finally {
      if (activeFlasher.current === flasher) activeFlasher.current = null;
    }
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
          const actual = describeFlightControllerHardware(detected.identity.board);
          setDetectedTarget(actual);
          throw new OperatorMessageError({key: 'flasherScreen.e17', values: {v0: selectedTarget, v1: actual}}, `Target ${selectedTarget} komt niet overeen met ${actual}.`);
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
    const diagnostics = sanitizeUserVisibleText(errorMessage(error));
    /**
     * A CODED failure is resolved from its code through the shared chain -
     * flasher key, then the shared `errors.*` namespace, then a localized
     * unknown. That is what stops the MSP layer's English sentences from
     * being the primary line an Arabic-reading operator sees. An uncoded
     * failure is one this application composed itself, in Arabic, for the
     * operator; its own sentence remains the reason.
     */
    const reason = resolveOperatorFacingText(t, error);
    /* Orthogonal to the reason: what state the board's flash was left in. */
    const detail = readFlashFailureDetail(error);
    const advisory = recoveryAdvisoryFor(detail?.destructiveState);
    const recovery = advisory === 'NONE' ? undefined : t(flashRecoveryLabelKey(advisory));
    lastFlashErrorCode.current = code;
    if (kind === 'UNCONFIRMED') {
      const nextAction = t(flashNextActionLabelKey(code));
      setFlashResult({kind: 'UNCONFIRMED', reason, nextAction, recovery});
      setOperation('unconfirmed');
      setStatus(reason);
      appendLog(`Voltooiing van het flashen niet bevestigd: ${reason}`);
    } else {
      setFlashResult({kind: 'FAILED', reason, recovery});
      setOperation('error');
      setStatus(reason);
      appendLog(`Fout: ${reason}`);
    }
    if (recovery !== undefined) appendLog(recovery);
    /**
     * THE ONLY PLACE ALLOWED TO SAY NO ERASE BEGAN. The engine has settled
     * and its terminal destructive state is `PRE_DESTRUCTIVE`, which means
     * the erase payload was never handed to the transport - a claim about
     * bytes that have already not been sent, rather than a prediction.
     */
    if (code === 'STM32_CANCELLED' && detail?.destructiveState === 'PRE_DESTRUCTIVE') {
      appendLog(t('firmwareFlasher.cancel.noEraseBegan'));
    }
    /* The engine's own words are kept, as diagnostics, never as the reason. */
    if (code !== undefined && diagnostics.length > 0) {
      appendLog(`Diagnostiek: ${diagnostics}`);
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
    reportProgress(100, "Schrijven en verifiëren voltooid.", true, true);
    appendLog("Firmware geschreven en door teruglezen geverifieerd.");
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
      appendLog(`Flashen geslaagd, maar CLI-instellingen herstellen is mislukt: ${restore.detail}`);
    }
    if (!mounted.current || flashAttemptSerial.current !== attempt) return;
    setFlashResult({kind: 'SUCCESS', restore});
    setOperation('success');
    setStatus(
      restore.kind === 'FAILED'
        ? "Firmware geïnstalleerd, maar de instellingen zijn niet hersteld."
        : "Firmware geschreven en geverifieerd.",
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
      setStatus("UF2 is geldig en opgeslagen. Kopieer het bestand naar de bootloaderschijf in Android Bestanden. UF2 kan niet via DfuSe worden geflasht.");
      return;
    }
    let selectedFirmware = firmware;
    if (firmware.kind === 'HEX' && configurationLines !== null) {
      try {
        selectedFirmware = applyCustomDefaultsToFirmware(firmware, configurationLines);
        appendLog(`Unified Config (lijn ${configurationLines.length}) is ingevoerd in het aangegeven gebied Custom Defaults.`);
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
    setStatus("Het begin van de geverifieerde Firmware...");
    try {
      let outcome: FlashMethodOutcome;
      if (selectedFirmware.kind === 'HEX') {
        outcome = hexMethod === 'dfu'
          ? await flashHexDfu(selectedFirmware, controller.signal)
          : await flashHexSerial(selectedFirmware, controller.signal, attempt);
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
        appendLog("Het herstel van instellingen is definitief gestopt na succesvolle flashen; De restitusie is bevroren.");
        setFlashResult({
          kind: 'SUCCESS',
          restore: {kind: 'FAILED', detail: t('firmwareFlasher.restoreSilent')},
        });
        setOperation('success');
        setStatus("Firmware geïnstalleerd, maar de instellingen zijn niet hersteld.");
        return;
      }
      client.cancelDfuFlash().catch(() => undefined);
      if (snapshot === undefined) {
        // Not one transfer ever started, so nothing destructive can be
        // pending: a plain, honest failure and a safe restart.
        lastFlashErrorCode.current = FLASH_CODE_NEVER_STARTED;
        const reason = t(flashReasonLabelKey(FLASH_CODE_NEVER_STARTED));
        appendLog(`Fout: ${reason}`);
        setFlashResult({kind: 'FAILED', reason});
        setOperation('error');
        setStatus(reason);
        return;
      }
      lastFlashErrorCode.current = FLASH_CODE_UI_BACKSTOP;
      const reason = t(flashReasonLabelKey(FLASH_CODE_UI_BACKSTOP));
      appendLog(`Voltooiing van het flashen niet bevestigd: ${reason}`);
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
        new Error("Ik ben al begonnen met schrijven. Ze mag niet herhaald worden. Maak het los en probeer het opnieuw."),
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
        appendLog("De ophangende operatie is hervat nadat de browser toestemming heeft gegeven; Het restartbevel is niet meer verzonden.");
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

  /**
   * Cancellation is decided by the ACTIVE FLASHER, not by what React last
   * rendered. Before anything destructive has been transmitted the abort is
   * immediate; from the moment the erase request is handed to the transport
   * it is potentially destructive, so a confirmation is required first.
   */
  /**
   * COMPLETION WINS. If the attempt settles while the confirmation is on
   * screen, the question is moot: dismiss it and keep the real outcome.
   * The terminal advisory is derived from the FINAL destructive state, not
   * from the state captured when the ticket was issued.
   */
  useEffect(() => {
    if (pendingCancel === null) return;
    if (!['flashing', 'restoring'].includes(operation)) {
      pendingCancelRef.current = null;
      setPendingCancel(null);
    }
  }, [operation, pendingCancel]);

  /* ------------------------------------------------------------------ *
   * THE CONFIRMATION DIALOG'S KEYBOARD AND FOCUS CONTRACT
   *
   * Measured, not assumed: a Chromium run of this exact dialog showed
   * focus staying on the button that opened it and Escape doing nothing,
   * while the app's own target-picker modal moved focus and closed on
   * Escape. Both are restored here, and only ever on the SAFE action.
   *
   * The DOM is reached through the minimal structural types below rather
   * than the global `lib.dom` ones: this project's React Native tsconfig
   * has no DOM library, and a web-only path should not drag one in.
   * ------------------------------------------------------------------ */

  /** The dialog's safe action - «متابعة التفليش» - takes initial focus. */
  const dismissButtonRef = useRef<View | null>(null);
  /** Where focus came from, so it can be handed back on dismiss. */
  const focusBeforeDialog = useRef<WebFocusable | null>(null);

  const restoreFocusToCancelControl = useCallback(() => {
    if (Platform.OS !== 'web') return;
    const previous = focusBeforeDialog.current;
    focusBeforeDialog.current = null;
    /* Only if the control still exists - a settled attempt removes it. */
    if (previous?.isConnected === true) previous.focus?.();
  }, []);


  /**
   * ARIA the platform does not derive on its own. RN's
   * `accessibilityViewIsModal` maps to nothing on the web, so the dialog
   * role and its Arabic name/description are declared explicitly. Inert on
   * native, where `accessibilityRole="alert"` already carries the meaning.
   */
  const dialogContainerProps =
    Platform.OS === 'web'
      ? ({
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': 'cancel-flash-confirm-title',
          'aria-describedby': 'cancel-flash-confirm-description',
          'aria-label': t('firmwareFlasher.cancelConfirm.accessibilityLabel'),
        } as unknown as Record<string, unknown>)
      : {};

  const cancelOperation = useCallback(() => {
    const flasher = activeFlasher.current;
    if (flasher !== null) {
      const request = flasher.requestCancellation();
      if (request.kind === 'CONFIRMATION_REQUIRED') {
        pendingCancelRef.current = request.ticket;
        setPendingCancel(request.ticket);
        appendLog(t('firmwareFlasher.cancel.confirmationPending'));
        return;
      }
      if (request.kind === 'CANCELLED_IMMEDIATELY') {
        /**
         * A REQUEST, NOT AN OUTCOME. Whether the attempt really ended with
         * the board untouched is stated once the engine has settled and its
         * terminal destructive state is known - see settleFlashFailure. A
         * line claiming "before any erase" written at request time would be
         * a promise about bytes that had not been sent yet.
         */
        appendLog(t('firmwareFlasher.cancel.requested'));
        return;
      }
    }
    operationController.current?.abort();
    if (operation === 'flashing') client.cancelDfuFlash().catch(() => undefined);
    appendLog(t('firmwareFlasher.cancel.requested'));
  }, [appendLog, client, operation, t]);

  /** Only the instance and attempt that issued the ticket may be aborted by
   *  it, so a confirmation belonging to a superseded attempt is inert. */
  const confirmCancelOperation = useCallback(() => {
    /* TAKE-AND-CLEAR: one answer per question, however many times the
     * platform and this application both deliver the same keypress. */
    const ticket = pendingCancelRef.current;
    pendingCancelRef.current = null;
    setPendingCancel(null);
    if (ticket === null) return;
    const accepted = activeFlasher.current?.confirmCancellation(ticket) ?? false;
    appendLog(t(accepted
      ? 'firmwareFlasher.cancel.confirmed'
      : 'firmwareFlasher.cancel.staleTicket'));
    restoreFocusToCancelControl();
  }, [appendLog, restoreFocusToCancelControl, t]);

  const dismissCancelOperation = useCallback(() => {
    const ticket = pendingCancelRef.current;
    pendingCancelRef.current = null;
    setPendingCancel(null);
    if (ticket === null) return;
    activeFlasher.current?.withdrawCancellation(ticket);
    appendLog(t('firmwareFlasher.cancel.withdrawn'));
    restoreFocusToCancelControl();
  }, [appendLog, restoreFocusToCancelControl, t]);

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    if (pendingCancel === null) return undefined;
    const web = (globalThis as unknown as {document?: WebDocument}).document;
    if (web === undefined) return undefined;

    focusBeforeDialog.current = web.activeElement ?? null;
    /* One frame later: RN-Web has mounted the modal subtree by then, and
     * focusing a node that is not in the document is a silent no-op. */
    const handle = setTimeout(() => {
      (dismissButtonRef.current as unknown as WebFocusable | null)?.focus?.();
    }, 0);

    const onKeyDown = (event: WebKeyEvent): void => {
      /**
       * ESCAPE IS HANDLED HERE. react-native-web's own Escape handling
       * answered a `transparent` Modal only sometimes - measured across
       * three viewport widths, it closed this dialog on some and not on
       * others - so the safe dismissal cannot depend on it. Enter and Space
       * are NOT handled here: Pressable already answers both, and Wave
       * 1D-A's contrary finding came from a synthetic KeyboardEvent.
       *
       * Because both this handler and the platform's may fire for one
       * keypress, the two answers below are idempotent by construction:
       * they take the pending ticket out of a ref, so the second call finds
       * nothing to do.
       */
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissCancelOperation();
        return;
      }
      /**
       * (the rest of the original note)
       *
       * Wave 1D-A found this dialog ignoring all three while the app's own
       * target-picker modal answered them. The difference was not the key
       * handling: it was FOCUS. The picker autofocuses its search field, so
       * the keys reached the modal; this dialog left focus on the button
       * behind it, so they never did. Moving focus to the safe action - the
       * effect above - is the whole fix, and react-native-web's Modal and
       * Pressable then answer Escape, Enter and Space themselves.
       *
       * Handling them here as well made every answer fire twice and wrote
       * the operator's log twice for one keypress, so the finding is
       * corrected rather than patched around. What remains genuinely
       * missing is the focus trap below.
       */
      if (event.key !== 'Tab') return;
      /* FOCUS TRAP. While a question about erasing a board is open, Tab
       * must not walk out behind it. */
      const card = web.querySelector('[data-testid="cancel-flash-confirm"]');
      if (card === null || card === undefined) return;
      const focusable = card.querySelectorAll('[tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = web.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus?.();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus?.();
      }
    };

    web.addEventListener('keydown', onKeyDown, true);
    return () => {
      clearTimeout(handle);
      web.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dismissCancelOperation, pendingCancel]);

  const exitDfu = useCallback(async () => {
    try {
      const devices = await client.listDfuDevices();
      const chosen = resolveDfuSelection(devices, selectedDfuId);
      if (!chosen) throw new OperatorMessageError({key: 'flasherScreen.e18'}, "Kies een DFU-apparaat om de modus veilig te verlaten.");
      if (chosen.deviceId !== selectedDfuId) setSelectedDfuId(chosen.deviceId);
      setOperation('flashing');
      setStatus("Opdracht om DFU te verlaten verzenden…");
      await client.exitDfuMode(chosen.deviceId);
      setOperation('success');
      setStatus("De opdracht om DFU te verlaten is verzonden.");
      appendLog("Exit DFU voltooid.");
      await refreshDevices();
    } catch (error) {
      setFailure(error);
    }
  }, [appendLog, client, refreshDevices, selectedDfuId, setFailure]);

  const unprotectDfu = useCallback(async () => {
    if (!readUnprotectConfirmed) {
      setFailure(new Error("Bevestig eerst dat het verwijderen van Read Protection het volledige flashgeheugen wist."));
      return;
    }
    try {
      const devices = await client.listDfuDevices();
      const chosen = resolveDfuSelection(devices, selectedDfuId);
      if (!chosen) throw new OperatorMessageError({key: 'flasherScreen.e19'}, "Kies een DFU-apparaat om Read Protection te verwijderen.");
      if (chosen.deviceId !== selectedDfuId) setSelectedDfuId(chosen.deviceId);
      setOperation('flashing');
      setStatus("Read Protection verwijderen; USB moet niet worden ontkoppeld totdat de besturingsapparaat...");
      appendLog("DFU begint read-unprotect; Dit proces verwijdert Flash via STM32 ROM..");
      await client.unprotectDfuDevice(chosen.deviceId);
      setOperation('success');
      setReadUnprotectConfirmed(false);
      setStatus("Read Protection. is verwijderd. Snijd het bord af, voer DFU opnieuw in en voer flashen opnieuw uit.");
      appendLog("read-unprotect voltooid met reset/disconnect verwacht.");
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
        throw new OperatorMessageError({key: 'flasherScreen.e20'}, "Het CLI-bestand is groter dan de veilige limiet van 1 MiB.");
      }
      const bytes = await base64ToBytesAsync(selection.dataBase64);
      if (bytes.length !== selection.sizeBytes) throw new OperatorMessageError({key: 'flasherScreen.e21'}, "De grootte van het CLI-bestand wijkt af van de ontvangen gegevens.");
      let text = '';
      for (const byte of bytes) {
        if (byte > 127) throw new OperatorMessageError({key: 'flasherScreen.e22'}, "Het CLI-bestand moet ASCII bevatten.");
        text += String.fromCharCode(byte);
      }
      if (!isPlausibleCliBackup(text)) throw new OperatorMessageError({key: 'flasherScreen.e23'}, "Het gekozen CLI-bestand is ongeldig.");
      const device = await requireOneSerial();
      setOperation('restoring');
      const result = await cliBackup.restore(device.deviceId, selectedPortIndex, text, controller.signal, (done, total) => {
        reportProgress(total > 0 ? done * 100 / total : 0, `CLI: ${done} / ${total} herstellen`);
      });
      if (result.errors.length > 0) throw new OperatorMessageError({key: 'flasherScreen.e24', values: {v0: result.errors.length}}, `${result.errors.length}-opdrachten mislukken; save. is niet gestuurd.`);
      setOperation('success');
      setStatus(`${result.commandCount} heeft de opdrachten van CLI succesvol teruggevonden.`);
    } catch (error) {
      setFailure(error);
    } finally {
      if (operationController.current === controller) operationController.current = null;
    }
  }, [cliBackup, client, reportProgress, requireOneSerial, selectedPortIndex, setFailure]);

  const isBusy = !['idle', 'success', 'error', 'unconfirmed'].includes(operation);
  const canCancel = ['building', 'detecting', 'saving', 'backing-up', 'flashing', 'restoring'].includes(operation);
  const isDevelopment = selectedReleaseInfo?.channel === 'development';

  useEffect(() => {
    if (!isBusy) return;
    return navigation?.addListener('beforeRemove', event => {
      event.preventDefault();
      Alert.alert(
        "Operatie Firmware wordt uitgevoerd.",
        "Schakel de procedure uit van de 'Cancele' knop en wacht tot ze is gestopt voordat je het scherm verlaat.",
        [{text: "OK"}],
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
              <Text style={styles.modalTitle}>{"Vluchtcontroller kiezen"}</Text>
              <Text style={styles.selectorHint}>{"Zoek op Target, fabrikant of MCU"}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={"De lijst van platen sluiten."}
              onPress={() => setTargetListOpen(false)}
              style={styles.modalClose}>
              <Text style={styles.modalCloseText}>×</Text>
            </Pressable>
          </View>
          <TextInput
            value={targetQuery}
            onChangeText={setTargetQuery}
            autoFocus
            placeholder={"Voorbeeld: SPEEDYBEEF405V4"}
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            testID="target-search"
          />
          {targetsLoadState === 'loading' ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.loadingText}>{"De lijst met printplaaten wordt geüpload."}</Text>
            </View>
          ) : null}
          {targetsLoadState === 'error' ? (
            <View style={styles.catalogRetry}>
              <FirmwareNotice
                title={"De printplaatenlijst kan niet worden geladen."}
                text={targetsLoadError ?? "Zoek op het internet of gebruik het Firmware-bestand lokaal."}
                tone="error"
              />
              {/* The sentence above offers a retry, so one exists. It
                  repeats the boards download and NOTHING else - USB
                  discovery and the attach/detach subscriptions are not
                  involved in an HTTP failure and are not disturbed. */}
              <FirmwareButton
                title={"Herladen van de lijst."}
                tone="secondary"
                size="compact"
                onPress={loadTargetCatalog}
                testID="retry-targets-picker"
              />
            </View>
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
                accessibilityRole="radio"
                accessibilityState={{selected: selectedTarget === item.target}}
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
                  <Text style={styles.targetMeta}>{item.manufacturer ?? "Een onbekende fabrikant."} • {item.mcu ?? "MCU niet bekend."}</Text>
                </View>
                <Text style={styles.targetGroup}>{groupLabel(item.group)}</Text>
              </Pressable>
            )}
            ListEmptyComponent={targetsLoadState === 'ready'
              ? <Text style={styles.emptyText}>{"Er is geen Targets match."}</Text>
              : null}
          />
        </View>
      </Modal>

      {/**
        * THE DESTRUCTIVE CONFIRMATION.
        *
        * Measured in Chromium against the app's own target-picker modal,
        * this dialog used to differ from it on three counts: focus stayed
        * behind the dialog, Escape did nothing, and Enter did not activate
        * the focused control. A keyboard or screen-reader operator was
        * therefore never taken to a question about erasing their board.
        *
        * The SAFE action takes initial focus. «إلغاء رغم ذلك» - the
        * destructive one - is never focused automatically, so no single
        * stray Enter or Space can end a flash mid-erase.
        */}
      <Modal
        visible={pendingCancel !== null}
        animationType="fade"
        transparent
        /* Android hardware Back and RN-Web's own close request both land
         * here, on the SAFE path: dismissing continues the flash. */
        onRequestClose={dismissCancelOperation}>
        <View
          style={styles.confirmBackdrop}
          testID="cancel-flash-confirm"
          onStartShouldSetResponder={() => true}
          {...dialogContainerProps}>
          <View
            style={styles.confirmCard}
            accessibilityViewIsModal
            accessibilityRole="alert"
            accessibilityLabel={t('firmwareFlasher.cancelConfirm.title')}
            accessibilityHint={t('firmwareFlasher.cancelConfirm.body')}>
            <Text style={styles.modalTitle} nativeID="cancel-flash-confirm-title">
              {t('firmwareFlasher.cancelConfirm.title')}
            </Text>
            <Text
              style={styles.confirmBody}
              testID="cancel-flash-confirm-body"
              nativeID="cancel-flash-confirm-description">
              {t('firmwareFlasher.cancelConfirm.body')}
            </Text>
            <View style={styles.twoButtons}>
              <View style={styles.flexOne}>
                <FirmwareButton
                  title={t('firmwareFlasher.cancelConfirm.dismiss')}
                  onPress={dismissCancelOperation}
                  tone="secondary"
                  testID="cancel-flash-dismiss"
                  buttonRef={dismissButtonRef}
                />
              </View>
              <View style={styles.flexOne}>
                <FirmwareButton
                  title={t('firmwareFlasher.cancelConfirm.confirm')}
                  onPress={confirmCancelOperation}
                  tone="danger"
                  testID="cancel-flash-confirm-accept"
                />
              </View>
            </View>
          </View>
        </View>
      </Modal>

      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={"Terug"}
          accessibilityState={{disabled: isBusy}}
          disabled={isBusy}
          onPress={() => navigation?.goBack()}
          style={[styles.backButton, isBusy && styles.dimmed]}>
          <Icon name="chevron-back" size={24} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerEyebrow}>{"Een onafhankelijk en veilig instrument."}</Text>
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
          <Text style={[styles.stepText, step === 'board' && styles.stepTextActive]}>{"1 Printplaat en build"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{selected: step === 'flash'}}
          disabled={isBusy}
          testID="firmware-step-flash"
          onPress={() => setStep('flash')}
          style={[styles.step, step === 'flash' && styles.stepActive]}>
          <Text style={[styles.stepText, step === 'flash' && styles.stepTextActive]}>{"2 verifiëren en flashen"}</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled>
        {step === 'board' ? (
          <>
            <FirmwareSection title={"Firmwarebron"} caption={"De twee sporen gaan door dezelfde strenge controle voordat flashen wordt toegelaten."}>
              <FirmwareChoice
                value={sourceMode}
                disabled={isBusy}
                testIDPrefix="firmware-source"
                choices={[{value: 'online', label: "Officiële firmware online"}, {value: 'local', label: "Lokaal bestand"}]}
                onChange={setSourceMode}
              />
              {sourceMode === 'local' ? (
                <FirmwareButton title={"Kies HEX of UF2 of BIN"} onPress={pickLocalFirmware} disabled={isBusy} testID="pick-local-firmware" />
              ) : null}
            </FirmwareSection>

            <FirmwareSection title="Unified Config / Custom Defaults" caption={"De instellingen worden in het door HEX aangegeven gebied geplaatst. De app schrijft ze niet op willekeurige firmwareadressen."}>
              <View style={styles.twoButtons}>
                <View style={styles.flexOne}>
                  <FirmwareButton title={"Kies Unified Config"} onPress={pickLocalConfiguration} disabled={isBusy} tone="secondary" testID="pick-unified-config" />
                </View>
                <View style={styles.flexOne}>
                  <FirmwareButton title={"Verwijder de setup."} onPress={clearConfiguration} disabled={isBusy || configurationLines === null} tone="secondary" testID="clear-unified-config" />
                </View>
              </View>
              {configurationLines ? (
                <FirmwareNotice
                  title={configurationLabel ?? "Unified Config is geldig."}
                  text={`${configurationLines.length} regels • Begin- en eindmarkeringen en overlappende gebieden worden vóór het wissen gecontroleerd.`}
                  tone="success"
                />
              ) : (
                <FirmwareNotice title={"Custom Defaults"} text={"U kunt zo flashen of een lokale Unified Config laden."} tone="info" />
              )}
            </FirmwareSection>

            {sourceMode === 'online' ? (
              <>
                <FirmwareSection title={"Flight Controller en Target"} caption={"Kies bij meerdere USB-apparaten het juiste apparaat, of gebruik automatische identificatie om de printplaatnaam uit te lezen."}>
                  <View style={styles.twoButtons}>
                    <View style={styles.flexOne}>
                      <FirmwareButton
                        title={"USB-apparaten vernieuwen"}
                        onPress={() => refreshDevices().catch(setFailure)}
                        disabled={isBusy}
                        tone="secondary"
                        testID="refresh-detect-devices"
                      />
                    </View>
                    <View style={styles.flexOne}>
                      <FirmwareButton title={"Automatisch identificeren"} onPress={autoDetect} disabled={isBusy} testID="auto-detect-fc" />
                    </View>
                  </View>
                  {serialDevices.length > 0 ? <Text style={styles.fieldLabel}>{"USB apparaat gebruikt in Auto Detect"}</Text> : (
                    <FirmwareNotice title={"Geen seriële poort"} text={"Je kunt Target handmatig kiezen, of Flight Controller aansluiten en vervolgens op update klikken."} tone="info" />
                  )}
                  {serialDevices.map(device => (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{selected: selectedSerialId === device.deviceId}}
                      key={device.deviceId}
                      testID={`detect-serial-device-${device.deviceId}`}
                      disabled={isBusy}
                      onPress={() => { setSelectedSerialId(device.deviceId); setSelectedPortIndex(0); }}
                      style={[styles.deviceRow, selectedSerialId === device.deviceId && styles.deviceRowSelected]}>
                      <Text style={styles.deviceName}>{deviceLabel(device)}</Text>
                      <Text style={styles.deviceMeta}>{device.driverType} • {device.portCount} {"Uitgang."}</Text>
                    </Pressable>
                  ))}
                  {selectedSerial && selectedSerial.portCount > 1 ? (
                    <FirmwareChoice
                      value={String(selectedPortIndex)}
                      choices={Array.from({length: selectedSerial.portCount}, (_, index) => ({value: String(index), label: `Port ${index}`}))}
                      onChange={value => setSelectedPortIndex(Number(value))}
                      disabled={isBusy}
                      testIDPrefix="detect-port"
                    />
                  ) : null}
                  {detectedSummary ? <FirmwareNotice title={"Het resultaat van de identificatie."} text={detectedSummary} tone="success" /> : null}
                  <Pressable
                    disabled={isBusy}
                    testID="target-selector"
                    onPress={() => setTargetListOpen(true)}
                    style={[styles.selectorButton, isBusy && styles.dimmed]}>
                    <Text style={styles.selectorValue}>{selectedTarget || "Target handmatig kiezen."}</Text>
                    <Text style={styles.selectorHint}>{"Doorzoekbare lijst openen"}</Text>
                  </Pressable>
                  {selectedTargetInfo ? (
                    <FirmwareNotice
                      title={`Printplaatcategorie: ${groupLabel(selectedTargetInfo.group)}`}
                      text={`${selectedTargetInfo.manufacturer ?? "De fabrikant is onbekend."} • ${selectedTargetInfo.mcu ?? "MCU niet bekend."} • Target ${selectedTargetInfo.target}`}
                      tone={selectedTargetInfo.group === 'supported'
                        ? 'success'
                        : selectedTargetInfo.group === 'legacy' ? 'warning' : 'info'}
                    />
                  ) : null}
                  {targetsLoadState === 'loading' ? <FirmwareNotice title={"De lijst met printplaaten."} text={"Ze wordt nu geüpload. Plaatselijke selectie en USB blijven beschikbaar."} /> : null}
                  {targetsLoadState === 'error' ? (
                    <View style={styles.catalogRetry}>
                      <FirmwareNotice title={"De lijst is niet beschikbaar."} text={targetsLoadError ?? "Gebruik het lokale bestand of probeer het opnieuw."} tone="error" />
                      <FirmwareButton
                        title={"Herladen van de lijst."}
                        tone="secondary"
                        size="compact"
                        onPress={loadTargetCatalog}
                        testID="retry-targets"
                      />
                    </View>
                  ) : null}
                </FirmwareSection>

                <FirmwareSection title={"Firmware versie"} caption={"Kies eerst het kanaal en daarna de versie met datum. Ontwikkelversies vereisen vóór het flashen een afzonderlijke risicobevestiging."}>
                  {releasesLoadState === 'loading' ? (
                    <FirmwareNotice title={"Versies downloaden"} text={`De beschikbare versies van ${selectedTarget} worden ingevoerd.`} />
                  ) : null}
                  {releasesLoadState === 'error' ? (
                    <FirmwareNotice title={"Versies kunnen niet worden gedownload."} text={releasesLoadError ?? "Selecteer het bord opnieuw of gebruik een lokaal bestand."} tone="error" />
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
                          {selectedReleaseInfo ? releaseLabel(selectedReleaseInfo) : "Kies een Firmware-versie."}
                        </Text>
                        <Text style={styles.selectorHint}>
                          {selectedReleaseInfo?.label ?? "Versie en datum"} • {releaseListOpen ? "Lijst verbergen" : "Lijst tonen"}
                        </Text>
                      </Pressable>
                      {releaseListOpen ? (
                        <View style={styles.choiceRows}>
                          {visibleReleases.map(release => (
                            <Pressable
                              accessibilityRole="radio"
                              accessibilityState={{selected: selectedRelease === release.release}}
                              key={release.release}
                              testID={`release-${release.release}`}
                              disabled={isBusy}
                              onPress={() => {
                                setSelectedRelease(release.release);
                                setReleaseListOpen(false);
                              }}
                              style={[styles.releaseRow, selectedRelease === release.release && styles.releaseRowSelected]}>
                              <Text style={[styles.releaseText, selectedRelease === release.release && styles.releaseTextSelected]}>{releaseLabel(release)}</Text>
                              <Text style={styles.releaseMeta}>{"Uitgave datum:"}{release.label}</Text>
                            </Pressable>
                          ))}
                        </View>
                      ) : null}
                    </>
                  ) : null}
                  {detailLoadState === 'loading' ? <FirmwareNotice title={"De details van de bouw."} text={"Target informatie en bouwopties worden geladen..."} /> : null}
                  {detailLoadState === 'error' ? <FirmwareNotice title={"Buildgegevens konden niet worden geladen"} text={detailLoadError ?? "Kies een andere versie of probeer het opnieuw."} tone="error" /> : null}
                  {targetDetail ? (
                    <>
                      <FirmwareNotice
                        title={`${targetDetail.target} • ${targetDetail.release}`}
                        text={`${targetDetail.manufacturer ?? "De fabrikant is onbekend."} • ${targetDetail.mcu ?? "MCU niet bekend."} • ${targetDetail.date ?? "De server bepaalt de builddatum"} • ${targetDetail.cloudBuild ? "Ondersteunt Cloud Build" : "Core Build klaar."}`}
                      />
                      <FirmwareNotice
                        title={"Informatie binnen FPV-ARBCON"}
                        text={"Het selecteren van het bord of de versie zal geen externe app of site openen; Alle bouwstappen en flashen blijven binnen dit scherm."}
                        tone="success"
                      />
                    </>
                  ) : null}
                </FirmwareSection>

                <FirmwareSection
                  title={"Build configureren"}
                  caption={"Kies Core Build of Cloud Build en daarna Radio, Telemetry, OSD, Motor en de overige opties."}
                  testID="build-configuration">
                  {targetDetail ? (
                    <>
                    {targetDetail.cloudBuild ? (
                      <FirmwareChoice
                        value={coreBuild ? 'core' : 'cloud'}
                        choices={[{value: 'core', label: 'Core Build'}, {value: 'cloud', label: "Aangepaste Cloud Build"}]}
                        onChange={value => {
                          if (value === 'cloud' && !cloudOptionsAvailable) {
                            setStatus("Opties Cloud Build nog niet klaar; Houd Core Build bij of kies de versie opnieuw.");
                            return;
                          }
                          setCoreBuild(value === 'core');
                        }}
                        disabled={isBusy}
                        testIDPrefix="build-mode"
                      />
                    ) : (
                      <FirmwareNotice title="Core Build" text={"Deze versie biedt geen Cloud Build; De volledige Core Build wordt gebruikt."} />
                    )}
                    {buildOptionsLoadState === 'loading' ? <FirmwareNotice title={"Buildopties"} text={"Radio, Telemetry, OSD, Motor en de overige opties laden…"} /> : null}
                    {buildOptionsLoadState === 'error' ? (
                      <FirmwareNotice
                        title={"Cloud Build momenteel niet beschikbaar"}
                        text={`${buildOptionsLoadError ?? "Opties kunnen niet worden geladen."} Core Build is nog steeds veilig beschikbaar.`}
                        tone="warning"
                      />
                    ) : null}
                    {targetDetail.cloudBuild && !coreBuild ? (
                      <>
                        <OptionGroup testIDPrefix="radio-protocol" title={"Radioprotocol"} options={buildOptions.radioProtocols} selected={radioProtocol} onChange={setRadioProtocol} />
                        <OptionGroup
                          testIDPrefix="telemetry-protocol"
                          title="Telemetry"
                          options={selectedRadioIncludesTelemetry
                            ? [{name: "Automatisch opgenomen bij het radioprotocol", value: '-1', default: true, includesTelemetry: true}]
                            : buildOptions.telemetryProtocols}
                          selected={telemetryProtocol}
                          onChange={setTelemetryProtocol}
                          disabled={selectedRadioIncludesTelemetry}
                        />
                        <OptionGroup testIDPrefix="osd-protocol" title="OSD" options={buildOptions.osdProtocols} selected={osdProtocol} onChange={setOsdProtocol} />
                        {buildOptions.osdProtocols.length > 0 && !osdProtocol ? (
                          <FirmwareToggle
                            label={"Doorgaan met Cloud Build zonder OSD"}
                            detail={"Expliciete bevestiging voordat firmware zonder OSD wordt gebouwd."}
                            value={osdOmissionConfirmed}
                            onValueChange={setOsdOmissionConfirmed}
                            disabled={isBusy}
                            warning
                            testID="confirm-no-osd"
                          />
                        ) : null}
                        <OptionGroup testIDPrefix="motor-protocol" title={"Motorprotocol"} options={buildOptions.motorProtocols} selected={motorProtocol} onChange={setMotorProtocol} />
                        {buildOptions.generalOptions.length > 0 ? (
                          <View style={styles.optionGroup}>
                            <FirmwareButton
                              title={`${generalOptionsExpanded ? "Verbergen" : "Tonen"} overige opties (${buildOptions.generalOptions.length})`}
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
                          label={"Expertmodus"}
                          detail={"Toont Custom Defines en de keuze van een ontwikkelcommit; Laat dit uitgeschakeld voor normaal gebruik."}
                          value={expertMode}
                          onValueChange={setExpertMode}
                          disabled={isBusy}
                          testID="firmware-expert-mode"
                        />
                        {expertMode ? (
                          <>
                            <Text style={styles.fieldLabel}>{"Custom Defines (gescheiden door spaties)"}</Text>
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
                                <Text style={styles.fieldLabel}>{"Commit SHA (optioneel)"}</Text>
                                <TextInput
                                  value={commit}
                                  onChangeText={setCommit}
                                  editable={!isBusy}
                                  autoCapitalize="none"
                                  placeholder={"Voer een SHA in of zoek in de lijst"}
                                  placeholderTextColor={colors.textMuted}
                                  style={[styles.input, styles.monoInput]}
                                />
                                {filteredCommits.slice(0, 20).map(item => (
                                  <Pressable
                                    accessibilityRole="radio"
                                    accessibilityState={{selected: commit === item.sha}}
                                    key={item.sha}
                                    onPress={() => setCommit(item.sha)}
                                    style={[styles.commitRow, commit === item.sha && styles.targetRowSelected]}>
                                    <Text style={styles.commitMessage}>{item.message}</Text>
                                    <Text style={styles.commitSha}>{item.sha}</Text>
                                  </Pressable>
                                ))}
                                {filteredCommits.length > 20 ? <Text style={styles.selectorHint}>{"Voer een deel van de SHA of het commitbericht in om te filteren."}</Text> : null}
                              </>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    ) : null}
                    </>
                  ) : (
                    <FirmwareNotice
                      title={"Buildconfiguratie gereed"}
                      text={"Selecteer Flight Controller en versie Firmware hierboven; Hier worden de opties Core/Cloud, Radio, Telemetry, OSD, Motor en andere opties direct weergegeven."}
                      tone="info"
                    />
                  )}
                </FirmwareSection>

                <FirmwareButton
                  title={"Firmware bouwen en downloaden"}
                  onPress={buildRemoteFirmware}
                  disabled={isBusy || targetDetail === null}
                  testID="build-firmware"
                />
              </>
            ) : null}

            {firmware ? (
              <FirmwareNotice title={`${firmware.kind} geldig • ${firmwareFilenameLabel(firmware.filename)}`} text={firmwareDescription(firmware)} tone="success" />
            ) : null}
          </>
        ) : (
          <>
            <FirmwareSection title={"Gedownloade firmware"} caption={"De bestandsextensie alleen is onvoldoende. Structuur, adressen en checksum zijn gecontroleerd."}>
              {firmware ? (
                <FirmwareNotice title={`${firmware.kind} • ${firmwareFilenameLabel(firmware.filename)}`} text={firmwareDescription(firmware)} tone="success" />
              ) : (
                <FirmwareNotice title={"Geen bestand"} text={"Ga terug naar de eerste stap en laad een geldig firmwarebestand."} tone="warning" />
              )}
              <View style={styles.twoButtons}>
                <View style={styles.flexOne}><FirmwareButton title={"Ander bestand kiezen"} onPress={pickLocalFirmware} disabled={isBusy} tone="secondary" /></View>
                <View style={styles.flexOne}><FirmwareButton title={"Kopie opslaan"} onPress={saveCurrentFirmware} disabled={isBusy || !firmware} tone="secondary" /></View>
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
                  title={"UF2 correct overzetten"}
                  text={"Het bestand wordt na verificatie opgeslagen. Start RP2040/STM32 in BOOT-modus en kopieer UF2 naar de getoonde USB-schijf. UF2 is geen DfuSe en wordt niet naar de DFU-interface verzonden."}
                  tone="info"
                />
              ) : null}
              {configurationLines ? (
                <FirmwareNotice
                  title={`Custom Defaults • ${configurationLabel ?? "Goed voorbereid."}`}
                  text={firmware?.kind === 'HEX'
                    ? `${configurationLines.length} een lijn die zal worden ingevoerd in de ruimte die HEX voor het onderzoek aankondigt.`
                    : "Custom Defaults gelden alleen voor HEX. Ze worden niet in UF2 of BIN geplaatst."}
                  tone={firmware?.kind === 'HEX' ? 'success' : 'warning'}
                />
              ) : null}
              <View style={styles.twoButtons}>
                <View style={styles.flexOne}><FirmwareButton title={"Unified Config wijzigen"} onPress={pickLocalConfiguration} disabled={isBusy} tone="secondary" testID="change-unified-config" /></View>
                <View style={styles.flexOne}><FirmwareButton title={"Unified Config verwijderen"} onPress={clearConfiguration} disabled={isBusy || configurationLines === null} tone="secondary" /></View>
              </View>
            </FirmwareSection>

            <FirmwareSection title={"USB en Bootloader"} caption={"Een apparaat moet duidelijk worden gekozen als er meer dan één USB.-unit is."}>
              <View style={styles.twoButtons}>
                <View style={styles.flexOne}><FirmwareButton title={"USB-apparaten vernieuwen"} onPress={() => refreshDevices().catch(setFailure)} disabled={isBusy} tone="secondary" /></View>
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
                        title={"USB-apparaat kiezen"}
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
                        title={"Kies STM32 DFU"}
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
                      title={"DFU is klaar."}
                      text={"Het apparaat ziet eruit als STM32 DFU.. DfuSe begint direct na de beveiligingsverklaringen zonder zoektocht naar Serial.."}
                      tone="success"
                    />
                  ) : (
                    <FirmwareNotice
                      title={"DFU wacht op de hand."}
                      text={"De optie zonder actieve reboot-sequentie, maar er is geen DFU-apparaat. Druk op BOOT tijdens het aansluiten van USB en zet de apparaten aan."}
                      tone="warning"
                    />
                  )
                ) : serialDevices.length > 0 ? (
                  <FirmwareNotice
                    title={"De normale situatie is ontdekt."}
                    text={"Het apparaat verschijnt als een normale USB-uitvoerder. Bij het opstarten leest de app de Target-ID, stuurt de MSP-beveiligde opdracht naar Bootloader, en wacht dan automatisch op het verschijnen van DFU voor elke scan."}
                    tone="info"
                  />
                ) : dfuDevices.length > 0 ? (
                  <FirmwareNotice
                    title={"Het apparaat is al in DFU."}
                    text={"Target handmatig bevestigen. Er is geen Serial-poort die gebruikt kan worden voor automatische herkenning of back-up."}
                    tone="warning"
                  />
                ) : (
                  <FirmwareNotice
                    title={"Er is geen USB-traject klaar."}
                    text={"Verbind Flight Controller met een data-kabel en stel de apparaten aan. Het zal verschijnen als een gewone Serial-uitvoerder of als een STM32 DFU.-uitvoerder."}
                    tone="warning"
                  />
                )
              ) : null}
              <FirmwareButton
                title={`${advancedUsbRecoveryExpanded ? "Verbergen" : "Tonen"} USB tools en geavanceerd herstel`}
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
                    title={"flashen basisprocedure"}
                    tone="secondary"
                    onPress={() => setShowFlashGuide(value => !value)}
                    testID="toggle-flash-guide"
                  />
                </View>
                <View style={styles.flexOne}>
                  <FirmwareButton
                    title={"Firmware ontfouten verkennen."}
                    tone="secondary"
                    onPress={() => setShowTroubleshooting(value => !value)}
                    testID="toggle-flash-troubleshooting"
                  />
                </View>
              </View>
              {showFlashGuide ? (
                <FirmwareNotice
                  title={"De basisprocedure binnen FPV-ARBCON"}
                  text={"propellers verwijderen en accu ontkoppelen, Target en lokale versie of bestand kiezen, HEX/UF2/BIN-formulier controleren, USB alleen koppelen, één apparaat selecteren, de beveiligingspoort bevestigen, en vervolgens beginnen en de kabel niet ontkoppelen totdat de controle en herstart zijn voltooid."}
                  tone="info"
                />
              ) : null}
              {showTroubleshooting ? (
                <FirmwareNotice
                  title={"Het verkennen van storingen in een applicatie"}
                  text={"Als het apparaat niet verschijnt: verander de USB-kabel in een data-kabel, geef USB toestemming, voer opnieuw BOOT/DFU in en stel de apparaten weer in. Als je meerdere apparaten hebt, selecteer je apparaat en de poort handmatig. Target is niet meer in overeenstemming, en gebruik de volledige scanner alleen voor geavanceerde herstel."}
                  tone="warning"
                />
              ) : null}
                </>
              ) : (
                <FirmwareNotice
                  title={"De eenvoudige baan is klaar."}
                  text={"Als er één apparaat is, wordt het automatisch door de app gekozen en Android USB ID wordt opnieuw aangesloten als het verandert. Open de geavanceerde instrumenten alleen voor herstel of diagnose."}
                  tone="success"
                />
              )}
              {serialDevices.length > 0 ? <Text style={styles.fieldLabel}>{"Serial apparaten."}</Text> : null}
              {serialDevices.map(device => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{selected: selectedSerialId === device.deviceId}}
                  key={device.deviceId}
                  disabled={isBusy}
                  onPress={() => { setSelectedSerialId(device.deviceId); setSelectedPortIndex(0); }}
                  style={[styles.deviceRow, selectedSerialId === device.deviceId && styles.deviceRowSelected]}>
                  <Text style={styles.deviceName}>{deviceLabel(device)}</Text>
                  <Text style={styles.deviceMeta}>{device.driverType} • {device.portCount} {"Uitgang."}</Text>
                </Pressable>
              ))}
              {selectedSerial && selectedSerial.portCount > 1 ? (
                <FirmwareChoice
                  value={String(selectedPortIndex)}
                  choices={Array.from({length: selectedSerial.portCount}, (_, index) => ({value: String(index), label: `Port ${index}`}))}
                  onChange={value => setSelectedPortIndex(Number(value))}
                  disabled={isBusy}
                />
              ) : null}
              {dfuDevices.length > 0 ? <Text style={styles.fieldLabel}>{"DFU apparaten."}</Text> : null}
              {dfuDevices.map(device => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{selected: selectedDfuId === device.deviceId}}
                  key={device.deviceId}
                  testID={`dfu-device-${device.deviceId}`}
                  disabled={isBusy}
                  onPress={() => setSelectedDfuId(device.deviceId)}
                  style={[styles.deviceRow, selectedDfuId === device.deviceId && styles.deviceRowSelected]}>
                  <Text style={styles.deviceName}>{dfuLabel(device)}</Text>
                  <Text style={styles.deviceMeta}>Interface {device.interfaceNumber} • Alt {device.alternateSetting} • {device.memoryLayout ?? "De geheugenindeling wordt vóór het wissen gecontroleerd"}</Text>
                </Pressable>
              ))}
              {advancedUsbRecoveryExpanded ? (
                <>
                  <FirmwareButton title={"DFU-modus verlaten"} onPress={exitDfu} disabled={isBusy || dfuDevices.length === 0} tone="secondary" />
                  <FirmwareToggle
                    label={"Ik begrijp dat het verwijderen van Read Protection Flash volledig verwijdert."}
                    detail={"Geavanceerde redoptie alleen voor beschermde STM32-platen; Je moet DFU en flashen later opnieuw invoeren."}
                    value={readUnprotectConfirmed}
                    onValueChange={setReadUnprotectConfirmed}
                    disabled={isBusy || dfuDevices.length === 0}
                    warning
                    testID="confirm-dfu-read-unprotect"
                  />
                  <FirmwareButton
                    title={"DFU Read Protection verwijderen"}
                    onPress={unprotectDfu}
                    disabled={isBusy || dfuDevices.length === 0 || !readUnprotectConfirmed}
                    tone="danger"
                    testID="unprotect-dfu-device"
                  />
                </>
              ) : null}
            </FirmwareSection>

            <FirmwareSection title={"Flash- en herstelopties"} caption={"De standaardinstellingen zijn het aanbevolen pad. Geavanceerde details zijn beschikbaar wanneer nodig."}>
              <FirmwareNotice
                title={"De aanbevolen beveiligingsinstelling"}
                text={"Selectief wissen, automatisch naar de bootloader, automatische baudsnelheid en een CLI-back-up voor deze poging met herstel na geslaagd flashen."}
                tone="success"
              />
              <FirmwareButton
                title={`${advancedFlashOptionsExpanded ? "Verbergen" : "Tonen"} geavanceerde flashen opties`}
                onPress={() => setAdvancedFlashOptionsExpanded(value => !value)}
                disabled={isBusy}
                tone="secondary"
                testID="toggle-advanced-flash-options"
              />
              {advancedFlashOptionsExpanded ? (
                <>
              <FirmwareToggle
                label={"Volledige chip wissen"}
                detail={"Wist alle sectoren. Selectief wissen is de veiligere standaardinstelling."}
                value={fullErase}
                onValueChange={setFullErase}
                disabled={isBusy}
                warning
              />
              <FirmwareToggle
                label={"Zonder herstartprocedure"}
                detail={"Gebruik dit wanneer u de printplaat handmatig in bootloadermodus hebt gezet."}
                value={noReboot}
                onValueChange={value => {
                  setNoReboot(value);
                  if (!value) setFlashOnConnect(false);
                }}
                disabled={isBusy}
              />
              <FirmwareToggle
                label="Flash on connect"
                detail={"bootloader begint pas nadat alle veiligheidsverklaringen zijn voltooid."}
                value={flashOnConnect}
                onValueChange={setFlashOnConnect}
                disabled={isBusy || !noReboot}
                warning
              />
              <FirmwareToggle
                label={"Baud rate handmatig"}
                detail={"256000 voor STM32 en 460800 voor ESP."}
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
              <Text style={styles.fieldLabel}>{"CLI back-upbeleid"}</Text>
              <FirmwareChoice
                value={backupMode}
                choices={[{value: 'ask', label: "Bij elke poging vragen"}, {value: 'always', label: "Altijd"}, {value: 'never', label: "Uitgeschakeld"}]}
                onChange={setBackupMode}
                disabled={isBusy}
              />
              {backupMode === 'ask' ? (
                <FirmwareToggle
                  label={"Back-up maken voor deze poging"}
                  detail={"Voer diff all uit en sla een echt back-upbestand op vóór het wissen."}
                  value={backupThisRun}
                  onValueChange={setBackupThisRun}
                  disabled={isBusy}
                />
              ) : null}
              <FirmwareToggle
                label={"Instellingen na het flashen herstellen"}
                detail={"De back-up uit het geheugen wordt alleen hersteld als het flashen slaagt en de poort terugkomt. Bij een CLI-fout wordt save niet verzonden."}
                value={restoreAfterFlash}
                onValueChange={setRestoreAfterFlash}
                disabled={isBusy || backupMode === 'never'}
              />
              <FirmwareButton title={"Backup CLI herstellen uit een bestand"} onPress={restoreLocalBackup} disabled={isBusy || serialDevices.length === 0} tone="secondary" />
                </>
              ) : null}
            </FirmwareSection>

            <FirmwareSection title={"Veiligheidscontrole"} caption={"Deze controles worden ook bij Flash on connect niet automatisch overgeslagen."}>
              <FirmwareToggle label={"Ik heb alle propellers verwijderd"} value={propsRemoved} onValueChange={setPropsRemoved} disabled={isBusy} warning testID="confirm-props-removed" />
              <FirmwareToggle label={"Ik heb de accu losgekoppeld; alleen USB levert voeding"} value={usbPowerOnly} onValueChange={setUsbPowerOnly} disabled={isBusy} warning testID="confirm-usb-power-only" />
              {noReboot ? (
                <FirmwareToggle
                  label={"Ik heb de Target en bootloader handmatig gecontroleerd."}
                  detail={"Zoekt omdat MSP auto detect niet beschikbaar is na handmatige toegang tot bootloader."}
                  value={manualTargetConfirmed}
                  onValueChange={setManualTargetConfirmed}
                  disabled={isBusy}
                  warning
                />
              ) : null}
              {selectedTarget && detectedTarget && selectedTarget.toUpperCase() !== detectedTarget.toUpperCase() ? (
                <FirmwareToggle
                  label={"Afwijkend Target toch toestaan"}
                  detail={`Gekozen: ${selectedTarget}. Gedetecteerd: ${detectedTarget}. Deze optie kan de printplaat onbruikbaar maken.`}
                  value={targetMismatchOverride}
                  onValueChange={setTargetMismatchOverride}
                  disabled={isBusy}
                  warning
                />
              ) : null}
              {isDevelopment ? (
                <FirmwareToggle
                  label={"Ik begrijp de risico's van een ontwikkelversie"}
                  detail={"Er kunnen onstabiele veranderingen zijn; flashen zal niet beginnen zonder deze bevestiging."}
                  value={unstableConfirmed}
                  onValueChange={setUnstableConfirmed}
                  disabled={isBusy}
                  warning
                />
              ) : null}
            </FirmwareSection>
          </>
        )}

        <FirmwareSection title={"Bewerkingsstatus"} caption={"Alleen de laatste 60 berichten worden in het geheugen bewaard, zodat het logboek niet onbeperkt groeit en het scherm niet vertraagt."}>
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
              {/* The destructive-state advisory sits BESIDE the reason, never
                * in place of it: the operator needs both what went wrong and
                * what state the board was left in. */}
              {flashResult.recovery !== undefined ? (
                <Text style={styles.resultRecovery} testID="flash-result-recovery">
                  {flashResult.recovery}
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
                title={buildLogLoading ? "Build record downloaden..." : "Build-record in de app"}
                onPress={loadBuildLogInsideApp}
                disabled={buildLogLoading}
                tone="secondary"
                testID="load-build-log"
              />
              {buildLogText ? (
                <View style={styles.logBox} testID="build-log">
                  <Text style={styles.machineLine}>{buildLogText}</Text>
                </View>
              ) : null}
            </>
          ) : null}
          <View style={styles.twoButtons}>
            <View style={styles.flexOne}>
              <FirmwareButton
                title={firmware?.kind === 'UF2' ? "UF2 verifiëren en opslaan" : "Veilig flashen starten"}
                onPress={startFlash}
                disabled={isBusy || !firmware}
                testID="start-safe-flash"
              />
            </View>
            {canCancel ? (
              <View style={styles.flexOne}><FirmwareButton title={"Annuleren"} onPress={cancelOperation} tone="danger" testID="cancel-firmware-operation" /></View>
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
    color: colors.textPrimary, maxWidth: PROSE_MEASURE},
  stallNotice: {...noticeSurface, marginTop: spacing.sm,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
    gap: spacing.xs},
  stallTitle: {
    ...typography.sectionTitle,
    color: colors.warning,
    writingDirection: 'ltr'},
  stallBody: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'ltr', maxWidth: PROSE_MEASURE},
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
  confirmBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  confirmCard: {
    width: '100%',
    maxWidth: 520,
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.error,
  },
  confirmBody: {...typography.body, color: colors.textPrimary, textAlign: 'left'},
  resultRecovery: {
    ...typography.body,
    color: colors.error,
    fontWeight: '700',
    textAlign: 'left',
  },
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
  /* The notice and its recovery, stacked and left-aligned: the retry
     trails the sentence rather than stretching across the card. */
  catalogRetry: {gap: spacing.sm, alignItems: 'flex-start', alignSelf: 'stretch'},
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
  /* 44, not 42: MIN_TOUCH_TARGET, which the simple flasher's own back
     button already uses. Measured at 42x42 on every width. Now the
     constant itself rather than a copy of its value - a hard-coded 44
     is how the floor drifted out of six files in the first place. */
  backButton: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    borderRadius: 22,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCopy: {flex: 1},
  headerEyebrow: {...typography.eyebrow, color: colors.accentStrong},
  headerTitle: {...typography.title, color: colors.textPrimary},
  formatPill: {paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.pill, backgroundColor: colors.surfaceAlt},
  formatPillText: {...typography.caption, color: colors.info, fontWeight: '700'},
  steps: {flexDirection: 'row', padding: spacing.sm, gap: spacing.sm, backgroundColor: colors.backgroundRaised},
  /* 44, not 40. These two step tabs are the widest controls in the
     inventory (up to 949px) and still missed the floor, because only
     the height was ever short. */
  step: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
    textAlign: 'left',
    ...typography.body, maxWidth: PROSE_MEASURE},
  monoInput: {...typography.mono, textAlign: 'left', writingDirection: 'ltr'},
  selectorButton: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, minHeight: 48, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.borderStrong}, selectorCopy: {flex: 1, gap: 2},
  selectorValue: {...typography.sectionTitle, color: colors.textPrimary},
  selectorHint: {...typography.caption, color: colors.textMuted, maxWidth: PROSE_MEASURE},
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
  commitMessage: {...typography.caption, color: colors.textPrimary, fontWeight: '700', maxWidth: PROSE_MEASURE},
  commitSha: {...typography.mono, color: colors.textMuted, textAlign: 'left', writingDirection: 'ltr'},
  logBox: {maxHeight: 280, padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surfaceAlt, gap: 4},
  /* THE APP'S OWN MESSAGES, and they are Arabic sentences:
     «اكتشاف USB: 1 serial و0 DFU.». They used to share the ltr style
     below with the build server's log, which laid each sentence out
     left-to-right-first and painted its words out of order. The Latin
     identifiers inside stay left-to-right on their own, as bidi
     isolates - that never needed the whole line to be ltr. */
  logLine: {...typography.mono, color: colors.textSecondary, textAlign: 'left', writingDirection: 'ltr'},
  /* The BUILD SERVER's output. Machine text, genuinely left-to-right,
     and it keeps that. */
  machineLine: {...typography.mono, color: colors.textSecondary, textAlign: 'left', writingDirection: 'ltr'},
  dimmed: {opacity: 0.4},
});
