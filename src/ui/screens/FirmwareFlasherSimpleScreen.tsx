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
  FirmwareImage,
  FirmwareRelease,
  FirmwareTargetDetail,
  PendingBootloaderFlash,
} from '../../core/firmware-flasher';
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
 * THE SIMPLE SCREEN'S TERMINAL-FAILURE TRUTH, pure and exported for tests.
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

function defaultOption(options: readonly FirmwareBuildOption[]): string {
  return options.find(option => option.default)?.value ?? '';
}

/** Standard mode follows the official Build API defaults automatically. */
export function defaultBuildSelection(
  detail: FirmwareTargetDetail,
  options: ReturnType<typeof parseBuildOptions>,
) {
  const hasCloudOptions = [
    options.radioProtocols,
    options.telemetryProtocols,
    options.osdProtocols,
    options.motorProtocols,
    options.generalOptions,
  ].some(items => items.length > 0);
  const radio = defaultOption(options.radioProtocols);
  const selectedRadio = options.radioProtocols.find(option => option.value === radio);
  return {
    coreBuild: !detail.cloudBuild || !hasCloudOptions,
    radioProtocol: radio,
    telemetryProtocol: selectedRadio?.includesTelemetry === true
      ? '-1'
      : defaultOption(options.telemetryProtocols),
    osdProtocol: defaultOption(options.osdProtocols),
    motorProtocol: defaultOption(options.motorProtocols),
    generalOptions: options.generalOptions
      .filter(option => option.default)
      .map(option => option.value),
  } as const;
}

/** Simple mode never silently falls from Stable to RC/Development. */
export function defaultStableRelease(releases: readonly FirmwareRelease[]): string {
  return releases.find(release => release.channel === 'stable')?.release ?? '';
}

/** Waiting for the one-time DFU permission is part of the flash operation. */
export function simpleFlasherNavigationLocked(phase: SimpleFlasherPhase): boolean {
  return ['detecting', 'loading', 'waiting-permission', 'flashing'].includes(phase);
}

export default function FirmwareFlasherSimpleScreen({
  navigation,
  client = usbSerialTransportClient,
}: Props): React.JSX.Element {
  const {t} = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  const [phase, setPhase] = useState<SimpleFlasherPhase>('idle');
  const [status, setStatus] = useState('اختر اللوحة والإصدار، ثم حمّل Firmware.');
  const [progress, setProgress] = useState(0);

  const [targets, setTargets] = useState<readonly BetaflightTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetQuery, setTargetQuery] = useState('');
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [releases, setReleases] = useState<readonly FirmwareRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [selectedRelease, setSelectedRelease] = useState('');
  const [firmware, setFirmware] = useState<FirmwareImage | null>(null);
  const [detectedTarget, setDetectedTarget] = useState<string | null>(null);
  const [pendingFlash, setPendingFlash] = useState<{
    readonly pending: PendingBootloaderFlash;
    readonly image: Extract<FirmwareImage, {kind: 'HEX'}>;
  } | null>(null);

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
  const stableReleases = useMemo(
    () => releases.filter(release => release.channel === 'stable'),
    [releases],
  );

  const fail = useCallback((reason: unknown) => {
    const presentation = simpleFailurePresentation(
      reason,
      lastFlashPhaseRef.current,
      t,
    );
    setPhase(presentation.phase);
    setStatus(presentation.text);
  }, [t]);

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
        setSelectedRelease(defaultStableRelease(items));
      })
      .catch(reason => {
        if (!controller.signal.aborted) fail(reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReleasesLoading(false);
      });
    return () => controller.abort();
  }, [fail, selectedTarget]);

  useEffect(() => {
    setFirmware(null);
    setPendingFlash(null);
    setProgress(0);
  }, [selectedRelease, selectedTarget]);

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

  const selectTarget = useCallback((target: string) => {
    if (navigationLocked) return;
    setSelectedTarget(target);
    setTargetQuery('');
    setTargetPickerOpen(false);
    setDetectedTarget(null);
    setPendingFlash(null);
    setProgress(0);
    setPhase('idle');
    setStatus('اختر الإصدار ثم حمّل Firmware.');
  }, [navigationLocked]);

  const autoDetect = useCallback(async () => {
    if (navigationLocked) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('detecting');
    setStatus('التعرف على Flight Controller…');
    try {
      const devices = (await client.listDevices()).filter(isSupportedDevice);
      if (devices.length !== 1) {
        throw new Error(devices.length === 0
          ? supportsSerialPicker
            ? 'لم يُسمح للمتصفح بالوصول إلى اللوحة بعد. اضغط «اختيار جهاز USB» ثم أعد التعرف.'
            : 'لم يُعثر على Flight Controller متصل. وصّل اللوحة عبر USB ثم أعد المحاولة.'
          : 'يوجد أكثر من Flight Controller. اترك لوحة واحدة متصلة ثم أعد المحاولة.');
      }
      if (devices[0].portCount !== 1) {
        throw new Error('للوحة أكثر من منفذ USB serial. استخدم «متقدم» لاختيار المنفذ يدوياً.');
      }
      const detected = await bootloader.detectFlightController(controller.signal, {
        deviceId: devices[0].deviceId,
        portIndex: 0,
      });
      try {
        const identity = detected.identity;
        const target = identity.board.targetName ||
          identity.board.boardName ||
          identity.board.boardIdentifier;
        const match = targets.find(item => item.target.toUpperCase() === target.toUpperCase());
        if (!match) {
          throw new Error(`تم التعرف على ${target} لكن Target غير موجود في القائمة الرسمية المحمّلة.`);
        }
        setDetectedTarget(match.target);
        setSelectedTarget(match.target);
        setStatus(`تم التعرف على ${match.target}. اختر الإصدار ثم حمّل Firmware.`);
        setPhase('idle');
      } finally {
        await detected.release();
      }
    } catch (reason) {
      if (!controller.signal.aborted) fail(reason);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [bootloader, client, fail, navigationLocked, supportsSerialPicker, targets]);

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

  const loadFirmware = useCallback(async () => {
    if (!selectedTarget || !selectedRelease || navigationLocked) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('loading');
    setProgress(0);
    setStatus('تحضير Firmware الرسمي…');
    try {
      const detailInput = await betaflightBuildApi.loadBuild(
        selectedTarget,
        selectedRelease,
        controller.signal,
      );
      const detail = parseTargetDetail(detailInput, selectedTarget, selectedRelease);
      let request;
      try {
        const optionInput = await betaflightBuildApi.loadOptions(selectedRelease, controller.signal);
        const options = parseBuildOptions(optionInput);
        request = createBuildRequest(detail, defaultBuildSelection(detail, options));
      } catch (reason) {
        if (controller.signal.aborted) throw reason;
        request = createBuildRequest(detail, {coreBuild: true});
      }

      const result = await cloudBuild.buildAndDownload(
        request,
        update => {
          setProgress(update.percent);
          setStatus(update.message);
        },
        controller.signal,
      );
      let parsed = parseFirmwareFile(result.response.file, result.firmware);
      const configuration = result.configuration ?? detail.configuration ?? null;
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
  }, [cloudBuild, fail, navigationLocked, selectedRelease, selectedTarget]);

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
    } catch (reason) {
      fail(reason);
    }
  }, [client, fail]);

  const flashPreparedFirmware = useCallback(async () => {
    if (!firmware || navigationLocked) return;
    if (firmware.kind !== 'HEX') {
      setPhase('failed');
      setStatus('الوضع المبسط مخصص لـ Betaflight HEX. استخدم «متقدم» للأنواع الأخرى.');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('detecting');
    setProgress(0);
    setStatus('التحقق من اللوحة قبل التفليش…');
    try {
      const devices = (await client.listDevices()).filter(isSupportedDevice);
      if (devices.length !== 1) {
        throw new Error(devices.length === 0
          ? supportsSerialPicker
            ? 'لم يُعثر على لوحة Serial مسموح بها. اختر جهاز USB أولاً.'
            : 'لم يُعثر على Flight Controller في وضع Serial. إذا كانت اللوحة في DFU يدوياً فاستخدم «متقدم».'
          : 'يوجد أكثر من Flight Controller. اترك لوحة واحدة متصلة قبل التفليش.');
      }
      if (devices[0].portCount !== 1) {
        throw new Error('للوحة أكثر من منفذ USB serial. استخدم «متقدم» لاختيار المنفذ يدوياً.');
      }
      const detected = await bootloader.detectFlightController(controller.signal, {
        deviceId: devices[0].deviceId,
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
          operationId: `simple-flash-${Date.now()}`,
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
    client,
    completeFlash,
    fail,
    firmware,
    navigationLocked,
    selectedTarget,
    supportsSerialPicker,
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
      `سيتم تثبيت ${selectedRelease} على ${selectedTarget}. أزل المراوح وافصل البطارية واترك USB موصولاً حتى تظهر النتيجة النهائية.`,
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
            title="العودة إلى الوضع المبسط"
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
            placeholder="ابحث باسم Target"
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
                <Text style={styles.targetMeta}>{item.manufacturer ?? item.mcu ?? ''}</Text>
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
          <Text style={styles.subtitle}>اختيار · تحميل · تفليش</Text>
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
        <View style={styles.card}>
          <StepHeader number="1" title="اللوحة" />
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
          {detectedTarget ? <Text style={styles.detected}>تم التعرف: {detectedTarget}</Text> : null}
        </View>

        <View style={styles.card}>
          <StepHeader number="2" title="الإصدار" />
          {releasesLoading ? <ActivityIndicator color={colors.accent} /> : null}
          {!releasesLoading && selectedTarget && stableReleases.length === 0 ? (
            <Text style={styles.helper}>
              لا يوجد إصدار مستقر ظاهر. استخدم «متقدم» لإصدارات RC/Development.
            </Text>
          ) : null}
          <View style={styles.releaseWrap}>
            {stableReleases.slice(0, 6).map(release => {
              const selected = release.release === selectedRelease;
              return (
                <Pressable
                  key={release.release}
                  accessibilityRole="radio"
                  accessibilityState={{selected, disabled: navigationLocked}}
                  onPress={() => setSelectedRelease(release.release)}
                  disabled={navigationLocked}
                  style={[
                    styles.releaseChip,
                    selected && styles.releaseChipSelected,
                    navigationLocked && styles.dimmed,
                  ]}>
                  <Text style={[styles.releaseText, selected && styles.releaseTextSelected]}>
                    {release.release}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <StepHeader number="3" title="Firmware" />
          <FirmwareButton
            title={phase === 'loading'
              ? 'جارٍ التحميل…'
              : firmware
                ? 'إعادة تحميل Firmware'
                : 'تحميل Firmware'}
            onPress={() => loadFirmware().catch(() => undefined)}
            disabled={navigationLocked || !selectedTarget || !selectedRelease}
            testID="simple-load-firmware"
          />
          {firmware ? <Text style={styles.readyText}>جاهز: {firmware.filename}</Text> : null}
        </View>

        <View style={styles.card}>
          <StepHeader number="4" title="التفليش" />
          {isBusy ? <FirmwareProgress percent={progress} label={status} /> : null}

          {phase === 'success' ? (
            <FirmwareNotice
              title="تم بنجاح"
              text="تم تثبيت Firmware والتحقق منه وإعادة تشغيل اللوحة."
              tone="success"
            />
          ) : null}
          {phase === 'failed' ? (
            <FirmwareNotice title="تعذر إكمال العملية" text={status} tone="error" />
          ) : null}
          {phase === 'unconfirmed' ? (
            <FirmwareNotice
              title="تعذر تأكيد اكتمال العملية"
              text={status}
              tone="warning"
            />
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
          ) : null}

          {phase !== 'waiting-permission' ? (
            <FirmwareButton
              title={phase === 'flashing' ? 'التفليش جارٍ…' : 'تفليش Firmware'}
              onPress={confirmFlash}
              disabled={navigationLocked || firmware === null}
              testID="simple-flash-firmware"
            />
          ) : null}

          {isBusy || phase === 'waiting-permission' ? (
            <FirmwareButton
              title={phase === 'waiting-permission' ? 'إلغاء قبل بدء الكتابة' : 'إلغاء'}
              tone="secondary"
              onPress={cancel}
              testID="simple-cancel-flash"
            />
          ) : null}
        </View>

        <Text style={styles.footerNote}>
          الخيارات اليدوية والاسترداد وملفات Firmware المحلية موجودة في «متقدم» فقط عند الحاجة.
        </Text>
      </ScrollView>
    </View>
  );
}

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
  releaseWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  releaseChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  releaseChipSelected: {backgroundColor: colors.accentSoft, borderColor: colors.accent},
  releaseText: {...typography.caption, color: colors.textSecondary, fontWeight: '700'},
  releaseTextSelected: {color: colors.accentStrong},
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