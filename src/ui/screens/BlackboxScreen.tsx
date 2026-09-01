/**
 * تسجيل الرحلات - ONBOARD FLIGHT LOGGING.
 *
 * =====================================================================
 * THE FIVE QUESTIONS THE FIRST SCREENFUL ANSWERS
 * =====================================================================
 *
 *   1. Does this firmware have logging at all?
 *   2. Is anything actually being logged?
 *   3. Where does it write?
 *   4. Is that medium ready?
 *   5. How much room is there - IF that is a real measurement?
 *
 * Those are four separate facts plus a conditional fifth, and the whole
 * layout exists to keep them separate. A build without Blackbox, a board
 * with a destination of NONE, a board with a destination and no flash
 * chip, and a board with a flash chip mid-erase are four different
 * situations, and collapsing any pair of them into one sentence is how a
 * configurator ends up telling somebody their firmware is unsupported
 * when nothing more than a destination is unset.
 *
 * QUESTION 2 HAS NO FEATURE FLAG BEHIND IT, and looking for one was a
 * real defect this screen shipped with for one round. `features_e` in
 * src/main/config/feature.h has no blackbox member at either pinned
 * firmware revision - bit 19, which an earlier version read as
 * FEATURE_BLACKBOX, is an unused gap between FEATURE_OSD (18) and
 * FEATURE_CHANNEL_FORWARDING (20). Betaflight gates logging on the
 * CONFIGURED DEVICE and nothing else, so that is what is asked.
 *
 * =====================================================================
 * WHAT THIS SCREEN IS NOT ALLOWED TO DO
 * =====================================================================
 *
 * NO LIVENESS CLAIM. Nothing here says "recording", "logging now" or
 * "your last flight was saved". The five commands this screen reads
 * carry no such fact: MSP_BLACKBOX_CONFIG reports a CONFIGURED
 * destination, not an active writer, and there is no "is it running"
 * field anywhere in the set. A green dot beside a board that has never
 * armed would be a fabrication.
 *
 * NO INVENTED NUMBER. Every figure comes through B-2's storage model,
 * which publishes `measurementsValid` precisely so a screen does not
 * have to decide for itself whether a zero is a reading. A busy flash
 * volume still reports sizes; they are not readings, and none of them
 * reaches the page.
 *
 * NO FAKE PROGRESS. An erase shows a spinner and the REAL elapsed time.
 * The firmware publishes no percentage and no estimate, so neither does
 * this - a bar creeping to 90% and stopping is worse than no bar.
 *
 * NO SUCCESS BEFORE PROOF. A save cannot report success here at all. It
 * ends at a reboot, and only a readback on a genuinely NEW session -
 * `verifyPersistence()`, refused by identity against the old one - turns
 * into «تم الحفظ».
 *
 * =====================================================================
 * WHY THE CONFIRMATION IS A RENDERED MODAL
 * =====================================================================
 *
 * Not because `Alert` is broken here - this application already ships
 * `platforms/web/webAlert.tsx` precisely because react-native-web's own
 * Alert is a no-op, and the shared screens' prompts do reach the browser
 * through it. The reason is what this particular dialog has to be:
 *
 *   IT IS PART OF THE PAGE, SO IT CAN BE MEASURED. Requirements this
 *   round include "the destructive dialog is inside the viewport at every
 *   width". A platform dialog is outside the document the geometry sweep
 *   walks; this one is a node with a bounding box, checked at 390 through
 *   1920 like everything else.
 *
 *   IT CARRIES ITS OWN DANGER STYLING AND EXACTLY TWO NAMED ACTIONS -
 *   «إلغاء» and «مسح الذاكرة» - rather than a generic OK/Cancel pair.
 *
 * ONE confirmation, and only one. No checkbox, no typed word, no long
 * press: a ritual that takes four steps trains people to perform it
 * without reading, which is the opposite of a safeguard.
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {useTranslation} from 'react-i18next';

import {
  blackboxFieldIncluded,
  describeBlackboxDevice,
  describeBlackboxRate,
  describeDataflash,
  describeDebugMode,
  describeSdcard,
  dataflashSectionVisible,
  formatBinarySize,
  kibibytesToBytes,
  offerableDebugModes,
  onlySerialRemains,
  sdcardSectionVisible,
  usedFraction,
  withBlackboxFieldIncluded,
  BLACKBOX_FIELD_BITS,
  OFFERABLE_BLACKBOX_DEVICES,
  type BlackboxFieldName,
} from '../../core/state/blackboxPresentation';
import {
  BLACKBOX_SAMPLE_RATE_MAX,
  BLACKBOX_SAMPLE_RATE_MIN,
  dataflashEraseWouldApply,
  type DataflashStorage,
  type SdcardStorage,
} from '../../core/state/blackboxStorageSemantics';
import {
  blackboxConfigurationController,
  type BlackboxBlockReason,
  type BlackboxEraseObservation,
  type BlackboxEraseOutcome,
  type BlackboxEraseProgress,
  type BlackboxLoadOutcome,
  type BlackboxOwnedDraft,
  type BlackboxPendingPersistence,
  type BlackboxPersistenceOutcome,
  type BlackboxSaveOutcome,
  type BlackboxSaveProgress,
  type BlackboxSnapshot,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {
  blackboxPendingSave,
  useBlackboxPendingSave,
} from '../session/blackboxPendingSave';
import {Button, NoticeBox, SelectField, ToggleSwitch} from '../components/controls';
import {MIN_TOUCH_TARGET} from '../components/controls';
import {StickyActionBar} from '../components/editing';
import {Icon} from '../icons';
import {
  PROSE_MEASURE,
  colors,
  isDesktopTier,
  radii,
  resolveLayoutTier,
  spacing,
  typography,
  useContentEnvelope,
} from '../theme';

/* ================================================================== *
 * PORTS
 * ================================================================== */

export interface BlackboxControllerPort {
  load(key: SetupUiSessionKey): Promise<BlackboxLoadOutcome>;
  save(
    key: SetupUiSessionKey,
    observed: BlackboxSnapshot,
    draft: BlackboxOwnedDraft,
    onProgress?: (progress: BlackboxSaveProgress) => void,
  ): Promise<BlackboxSaveOutcome>;
  verifyPersistence(
    key: SetupUiSessionKey,
    pending: BlackboxPendingPersistence,
  ): Promise<BlackboxPersistenceOutcome>;
  eraseDataflash(
    key: SetupUiSessionKey,
    observed: BlackboxSnapshot,
    onProgress?: (progress: BlackboxEraseProgress) => void,
  ): BlackboxEraseObservation;
}

export interface BlackboxScreenProps {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly controller?: BlackboxControllerPort;
  /** Injected only by tests and the measurement harness. */
  readonly now?: () => number;
}

/* ================================================================== *
 * SCREEN STATE
 * ================================================================== */

type Phase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'VERIFYING' | 'ERASING' | 'ERROR';

/** The four save captions §20 requires, in the order they can occur. */
type SaveStage = BlackboxSaveProgress | 'VERIFYING_AFTER_REBOOT';

interface EraseState {
  readonly progress: BlackboxEraseProgress;
  readonly startedAt: number;
}

function draftOf(snapshot: BlackboxSnapshot): BlackboxOwnedDraft {
  return {
    deviceRaw: snapshot.config.deviceRaw,
    sampleRateRaw: snapshot.config.sampleRateRaw,
    disabledFieldsMask: snapshot.config.disabledFieldsMask,
    debugMode: snapshot.debugMode,
  };
}

/**
 * FIELD BY FIELD, never JSON.stringify.
 *
 * The owned set is exactly four values, and comparing them by name is
 * what makes "no changes" mean the same thing here as it does inside the
 * controller. A structural comparison would also drift the moment either
 * side gained a field.
 */
function draftsEqual(a: BlackboxOwnedDraft, b: BlackboxOwnedDraft): boolean {
  return (
    a.deviceRaw === b.deviceRaw &&
    a.sampleRateRaw === b.sampleRateRaw &&
    a.disabledFieldsMask === b.disabledFieldsMask &&
    a.debugMode === b.debugMode
  );
}

/** `mm:ss` from real elapsed milliseconds. Never an estimate. */
function elapsedLabel(millis: number): string {
  const total = Math.max(0, Math.floor(millis / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/* ================================================================== *
 * SMALL PRESENTATIONAL PIECES
 * ================================================================== */

function Section({
  title,
  hint,
  children,
  testID,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.card} testID={testID}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {hint === undefined ? null : <Text style={styles.sectionHint}>{hint}</Text>}
      {children}
    </View>
  );
}

/**
 * Label + value on one line. Never renders a dash in place of a fact.
 *
 * `inline` is what keeps a desktop from spending a whole 1366px row on
 * two words: stacked full-width rows read well on a phone and look like
 * a form left half-finished on a monitor, so on wide layouts the facts
 * sit beside each other and the label hugs its value instead of being
 * pushed a metre away by space-between.
 */
function Fact({
  label,
  value,
  inline = false,
  accessibilityLabel,
  testID,
}: {
  label: string;
  value: string;
  inline?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <View
      style={inline ? styles.factInline : styles.factRow}
      accessible
      accessibilityLabel={accessibilityLabel ?? `${label}: ${value}`}
      testID={testID}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

/**
 * A status chip. COLOUR IS NEVER THE ONLY SIGNAL - every chip carries an
 * icon and a word, so it survives a monochrome screen and a colour-blind
 * reader alike.
 */
function Chip({
  tone,
  icon,
  label,
  testID,
}: {
  tone: 'good' | 'idle' | 'warn';
  icon: 'circle-check' | 'circle-x' | 'triangle-alert' | 'hard-drive';
  label: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <View
      style={[styles.chip, styles[`chip_${tone}` as const]]}
      accessible
      accessibilityLabel={label}
      testID={testID}>
      <Icon name={icon} size={14} color={CHIP_FG[tone]} />
      <Text style={[styles.chipText, {color: CHIP_FG[tone]}]}>{label}</Text>
    </View>
  );
}

const CHIP_FG = {
  good: colors.success,
  idle: colors.textMuted,
  warn: colors.warning,
} as const;

/**
 * The usage bar, drawn ONLY from a proven fraction.
 *
 * `fraction === undefined` renders nothing at all rather than an empty
 * track, because an empty track reads as "nothing stored" - which is
 * exactly the claim a volume with no valid measurements cannot make.
 */
function UsageBar({
  fraction,
  testID,
}: {
  fraction: number | undefined;
  testID?: string;
}): React.JSX.Element | null {
  if (fraction === undefined) return null;
  return (
    <View style={styles.barTrack} testID={testID}>
      <View style={[styles.barFill, {width: `${Math.round(fraction * 100)}%`}]} />
    </View>
  );
}

/* ================================================================== *
 * THE SCREEN
 * ================================================================== */

export default function BlackboxScreen({
  sessionKey,
  active,
  onDirtyChange,
  controller = blackboxConfigurationController,
  now = Date.now,
}: BlackboxScreenProps): React.JSX.Element {
  const {t} = useTranslation();
  const {width, fontScale} = useWindowDimensions();
  const wide = isDesktopTier(resolveLayoutTier(width, fontScale));
  const {maxWidth} = useContentEnvelope(true);

  const [phase, setPhase] = useState<Phase>('IDLE');
  const [snapshot, setSnapshot] = useState<BlackboxSnapshot>();
  const [draft, setDraft] = useState<BlackboxOwnedDraft>();
  const [loadOutcome, setLoadOutcome] = useState<BlackboxLoadOutcome>();
  const [saveOutcome, setSaveOutcome] = useState<BlackboxSaveOutcome>();
  const [saveStage, setSaveStage] = useState<SaveStage>();
  const [persistence, setPersistence] = useState<BlackboxPersistenceOutcome>();
  const [eraseState, setEraseState] = useState<EraseState>();
  const [eraseOutcome, setEraseOutcome] = useState<BlackboxEraseOutcome>();
  const [confirmingErase, setConfirmingErase] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  const pending = useBlackboxPendingSave();
  const eraseRef = useRef<BlackboxEraseObservation | undefined>(undefined);

  /* ---------------------------------------------------------------- *
   * LOAD
   * ---------------------------------------------------------------- */

  /**
   * A PENDING SAVE OWNS THE FIRST READ OF A NEW SESSION.
   *
   * `verifyPersistence()` reads the whole snapshot itself, under the same
   * exclusive operation lease the ordinary load takes. Running both on the
   * same mount is not merely wasteful - the controller allows ONE Blackbox
   * operation per session, so whichever lost the race came back
   * OPERATION_IN_PROGRESS and the operator was told a save had failed when
   * nothing had. The verification goes first and the load waits for it.
   */
  const awaitingVerification =
    pending !== null &&
    sessionKey !== undefined &&
    pending.writtenOnGeneration !== sessionKey.generation;

  useEffect(() => {
    if (!active || sessionKey === undefined || awaitingVerification) return;
    let cancelled = false;
    setPhase('LOADING');
    setSaveOutcome(undefined);
    controller
      .load(sessionKey)
      .then(outcome => {
        if (cancelled) return;
        setLoadOutcome(outcome);
        if (outcome.kind === 'LOADED') {
          setSnapshot(outcome.snapshot);
          setDraft(draftOf(outcome.snapshot));
          setPhase('READY');
        } else {
          setSnapshot(undefined);
          setDraft(undefined);
          setPhase('ERROR');
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadOutcome({kind: 'FAILED', error});
        setPhase('ERROR');
      });
    return () => {
      cancelled = true;
    };
  }, [active, awaitingVerification, controller, reloadToken, sessionKey]);

  /* ---------------------------------------------------------------- *
   * POST-REBOOT VERIFICATION
   *
   * The token outlived the screen; this is where it is answered. The
   * generation guard is the whole contract: a token whose generation
   * still matches the live session is one the board never left, and the
   * controller would refuse it as STALE_SESSION anyway. Waiting here for
   * a DIFFERENT generation is what makes the eventual SUCCEEDED mean
   * "it survived a restart".
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!active || sessionKey === undefined || pending === null) return;
    if (!awaitingVerification) return;
    let cancelled = false;
    setPhase('VERIFYING');
    setSaveStage('VERIFYING_AFTER_REBOOT');
    controller
      .verifyPersistence(sessionKey, pending)
      .then(outcome => {
        if (cancelled) return;
        // Answered either way: the token must not be checked twice.
        blackboxPendingSave.clear();
        setPersistence(outcome);
        setSaveStage(undefined);
        if (outcome.kind === 'SUCCEEDED') {
          setSnapshot(outcome.snapshot);
          setDraft(draftOf(outcome.snapshot));
        }
        /* Anything else leaves the screen with no snapshot of its own, and
           clearing the token above releases the load effect to go and get
           one. The verdict message is held in separate state, so the
           re-read does not erase what the operator was just told. */
        setPhase('READY');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        blackboxPendingSave.clear();
        setPersistence({kind: 'FAILED', error});
        setSaveStage(undefined);
        setPhase('READY');
      });
    return () => {
      cancelled = true;
    };
  }, [active, awaitingVerification, controller, pending, sessionKey]);

  /* ---------------------------------------------------------------- *
   * ERASE ELAPSED TIME - real seconds, never an estimate
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (eraseState === undefined) {
      setElapsed(0);
      return;
    }
    setElapsed(now() - eraseState.startedAt);
    const timer = setInterval(() => {
      setElapsed(now() - eraseState.startedAt);
    }, 1000);
    return () => clearInterval(timer);
  }, [eraseState, now]);

  /**
   * LEAVING WHILE AN ERASE RUNS stops the WATCH and nothing else.
   *
   * There is no "stop erasing" command in the firmware, so nothing is
   * sent. The observation is released, the chip carries on, and the
   * screen never claims otherwise. This is also why no modal traps the
   * operator here: navigating away is allowed.
   */
  useEffect(
    () => () => {
      eraseRef.current?.cancel();
      eraseRef.current = undefined;
    },
    [],
  );

  /* ---------------------------------------------------------------- *
   * DERIVED
   * ---------------------------------------------------------------- */

  /**
   * IS ANYTHING BEING LOGGED? The device byte is the whole answer.
   * blackboxEraseAll(), blackboxMayEditConfig() and the logging path
   * itself all switch on `blackboxConfig()->device`, and no feature flag
   * exists to consult beside it.
   */
  const loggingConfigured =
    snapshot !== undefined && snapshot.configuration.device.device !== 'NONE';
  const persisted = snapshot === undefined ? undefined : draftOf(snapshot);
  const dirty =
    persisted !== undefined && draft !== undefined && !draftsEqual(persisted, draft);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const busy = phase === 'SAVING' || phase === 'VERIFYING' || phase === 'ERASING';
  const saving = phase === 'SAVING' || phase === 'VERIFYING';
  const erasing = phase === 'ERASING';

  const update = useCallback((change: Partial<BlackboxOwnedDraft>) => {
    setDraft(current => (current === undefined ? current : {...current, ...change}));
    setSaveOutcome(undefined);
    setPersistence(undefined);
  }, []);

  /* ---------------------------------------------------------------- *
   * ACTIONS
   * ---------------------------------------------------------------- */

  const save = useCallback(async () => {
    if (sessionKey === undefined || snapshot === undefined || draft === undefined) return;
    setPhase('SAVING');
    setSaveStage('SENDING');
    setPersistence(undefined);
    let outcome: BlackboxSaveOutcome;
    try {
      outcome = await controller.save(sessionKey, snapshot, draft, setSaveStage);
    } catch (error) {
      outcome = {kind: 'FAILED', error};
    }
    setSaveOutcome(outcome);
    if (outcome.kind === 'AWAITING_REBOOT_VERIFICATION') {
      /* The workspace is about to unmount with the board. Hand the token
         to the store that outlives it - see blackboxPendingSave. */
      blackboxPendingSave.set(outcome.pending);
      /* AND SAY WHAT IS ACTUALLY HAPPENING NOW. The write and the readback
         are done and the reboot has been asked for; what remains is the
         post-restart readback. Leaving the previous caption up would keep
         claiming a step that has already finished. */
      setSaveStage('VERIFYING_AFTER_REBOOT');
      return;
    }
    setSaveStage(undefined);
    if (outcome.kind === 'NO_CHANGES') {
      setDraft(draftOf(outcome.snapshot));
    }
    setPhase('READY');
  }, [controller, draft, sessionKey, snapshot]);

  const discard = useCallback(() => {
    if (snapshot === undefined) return;
    setDraft(draftOf(snapshot));
    setSaveOutcome(undefined);
    setPersistence(undefined);
  }, [snapshot]);

  const beginErase = useCallback(() => {
    if (sessionKey === undefined || snapshot === undefined) return;
    setConfirmingErase(false);
    setEraseOutcome(undefined);
    setPhase('ERASING');
    setEraseState({progress: 'REQUESTED', startedAt: now()});
    const observation = controller.eraseDataflash(sessionKey, snapshot, progress => {
      setEraseState(current =>
        current === undefined ? current : {...current, progress},
      );
    });
    eraseRef.current = observation;
    observation.result
      .then(outcome => {
        eraseRef.current = undefined;
        setEraseOutcome(outcome);
        setEraseState(undefined);
        setPhase('READY');
        if (outcome.kind === 'SUCCEEDED') {
          /* RE-RENDER FROM THE NEW OBSERVED STATE, not from a hope. The
             controller only returns SUCCEEDED on a READY_EMPTY reading,
             and that reading is what the card now shows. */
          setSnapshot(current =>
            current === undefined ? current : {...current, dataflash: outcome.dataflash},
          );
        }
      })
      .catch((error: unknown) => {
        eraseRef.current = undefined;
        setEraseOutcome({kind: 'FAILED', error});
        setEraseState(undefined);
        setPhase('READY');
      });
  }, [controller, now, sessionKey, snapshot]);

  const reload = useCallback(() => {
    setPersistence(undefined);
    setSaveOutcome(undefined);
    setReloadToken(value => value + 1);
  }, []);

  /* ---------------------------------------------------------------- *
   * RENDER
   * ---------------------------------------------------------------- */

  const body = (): React.ReactNode => {
    if (phase === 'LOADING' || phase === 'IDLE') {
      return (
        <Text style={styles.loading} testID="blackbox-loading">
          {t('blackbox.loading')}
        </Text>
      );
    }
    if (snapshot === undefined || draft === undefined) {
      return (
        <NoticeBox variant="warning" title={t('blackbox.loadFailedTitle')} testID="blackbox-load-failed">
          <Text style={styles.noticeBody}>
            {loadOutcome?.kind === 'REJECTED'
              ? t(`blackbox.blockReason.${loadOutcome.reason}` as const)
              : t('blackbox.loadFailedBody')}
          </Text>
          <Button
            label={t('blackbox.reread')}
            onPress={reload}
            variant="secondary"
            icon="refresh-cw"
            style={styles.inlineAction}
            testID="blackbox-reload"
          />
        </NoticeBox>
      );
    }

    /**
     * A BUILD WITHOUT BLACKBOX GETS ONE SENTENCE AND NOTHING ELSE.
     *
     * No device selector, no rate, no storage card, no erase button - not
     * even disabled ones. A greyed control still says "this exists here",
     * and on this firmware it does not.
     */
    if (!snapshot.config.supported) {
      return (
        <NoticeBox
          variant="info"
          title={t('blackbox.unsupportedTitle')}
          testID="blackbox-unsupported">
          <Text style={styles.noticeBody}>{t('blackbox.unsupportedBody')}</Text>
        </NoticeBox>
      );
    }

    return (
      <>
        {statusSection(snapshot, t)}
        {storageSections()}
        {settingsSection()}
        {advancedSection()}
      </>
    );
  };

  /* ---- ① status ------------------------------------------------- */

  const statusSection = (
    current: BlackboxSnapshot,
    translate: typeof t,
  ): React.ReactNode => {
    const device = describeBlackboxDevice(current.configuration.device);
    const rate = describeBlackboxRate(current.configuration.sampleRate);
    const deviceText =
      device.raw === undefined
        ? translate(device.key)
        : translate(device.key, {raw: device.raw});
    const rateText =
      rate.key === 'blackbox.rate.fraction'
        ? translate(rate.key, {divider: rate.divider})
        : rate.key === 'blackbox.rate.unknown'
          ? translate(rate.key, {raw: rate.raw})
          : translate(rate.key);

    return (
      <Section
        title={translate('blackbox.statusTitle')}
        testID="blackbox-status">
        {/* NOTHING IS BEING LOGGED IS NOT THE SAME AS NOT SUPPORTED, and
            the difference is the device byte. The firmware writes nothing
            when the destination is NONE and writes when it is anything
            else; there is no separate feature bit to consult, so there is
            no separate fact to state. */}
        {current.configuration.device.device === 'NONE' ? (
          <View style={styles.inlineNotice} testID="blackbox-feature-disabled">
            <Icon name="circle-alert" size={16} color={colors.warning} />
            <Text style={styles.inlineNoticeText}>
              {translate('blackbox.featureDisabled')}
            </Text>
          </View>
        ) : null}
        <View style={wide ? styles.factsRow : undefined}>
          <Fact
            label={translate('blackbox.destinationLabel')}
            value={deviceText}
            inline={wide}
            accessibilityLabel={translate('blackbox.destinationAccessible', {
              value: deviceText,
            })}
            testID="blackbox-persisted-device"
          />
          <Fact
            label={translate('blackbox.rateLabel')}
            value={rateText}
            inline={wide}
            accessibilityLabel={translate('blackbox.rateAccessible', {value: rateText})}
            testID="blackbox-persisted-rate"
          />
        </View>
        {/* THE DRAFT NOTE. The status above keeps showing what the board
            HOLDS; this says what a save would change it to. */}
        {dirty && draft !== undefined ? (
          <View style={styles.draftNotice} testID="blackbox-draft-notice">
            <Icon name="pencil" size={14} color={colors.accentStrong} />
            <Text style={styles.draftText}>
              {translate('blackbox.draftPending', {
                value: labelForDevice(draft.deviceRaw, translate),
              })}
            </Text>
          </View>
        ) : null}
      </Section>
    );
  };

  /* ---- ② storage ------------------------------------------------ */

  const storageSections = (): React.ReactNode => {
    if (snapshot === undefined) return null;
    const {dataflash, sdcard} = snapshot;
    if (onlySerialRemains(dataflash, sdcard)) {
      return (
        <Section title={t('blackbox.storageTitle')} testID="blackbox-storage">
          <Text style={styles.factValue} testID="blackbox-serial-only">
            {t('blackbox.serialOnly')}
          </Text>
        </Section>
      );
    }
    return (
      <View style={wide ? styles.storageRow : undefined}>
        {dataflashSectionVisible(dataflash) ? flashCard(dataflash) : null}
        {sdcardSectionVisible(sdcard) ? sdCard(sdcard) : null}
      </View>
    );
  };

  const flashCard = (storage: DataflashStorage): React.ReactNode => {
    const copy = describeDataflash(storage);
    const fraction = usedFraction({
      usedBytes: storage.usedBytes,
      totalBytes: storage.totalBytes,
      measurementsValid: storage.measurementsValid,
    });
    /* §25: the erase depends on the PERSISTED configuration. A draft that
       merely selects FLASH must not unlock a destructive command the
       firmware would apply to nothing. */
    const eraseApplies =
      snapshot !== undefined &&
      dataflashEraseWouldApply(snapshot.configuration, storage);
    const draftOnlyFlash =
      draft?.deviceRaw === 1 && snapshot?.configuration.device.device !== 'FLASH';

    return (
      <View style={[styles.card, wide && styles.storageColumn]} testID="blackbox-flash">
        <View style={styles.cardHead}>
          <Icon name="hard-drive" size={18} color={colors.accentStrong} />
          <Text style={styles.sectionTitle}>{t('blackbox.flashTitle')}</Text>
        </View>
        {/* THE HEADLINE GOES TOO, for the same reason the numbers do.
            "Contains logs" was true when the erase started and is being
            unmade as it runs; leaving it up beside a spinner states a
            condition of a volume nobody is reading. During an erase the
            only honest thing this card can say is what the operation is
            doing, and that is what it says. */}
        {erasing ? null : (
          <Text style={styles.stateHeadline} testID="blackbox-flash-state">
            {t(copy.headlineKey)}
          </Text>
        )}
        {/* NOT WHILE IT IS BEING ERASED.
            The snapshot still holds the last reading - "8 MiB used" - and
            for the whole of an erase that number is not merely stale, it
            is being actively invalidated sector by sector. Leaving it on
            screen beside a spinner presents a measurement of a volume
            nobody is measuring, which is the same defect as printing a
            capacity for a busy chip. The figures come back when a real
            reading does. */}
        {!erasing &&
        copy.showsMeasurements &&
        storage.usedBytes !== undefined &&
        storage.totalBytes !== undefined ? (
          <>
            <Text style={styles.measurement} testID="blackbox-flash-usage">
              {t('blackbox.usedOfTotal', {
                used: sizeText(storage.usedBytes, t),
                total: sizeText(storage.totalBytes, t),
              })}
            </Text>
            <UsageBar fraction={fraction} testID="blackbox-flash-bar" />
          </>
        ) : null}
        {erasing ? (
          <View style={styles.eraseLive} testID="blackbox-erase-progress">
            <ActivityIndicator color={colors.accentStrong} />
            <Text style={styles.eraseText}>
              {eraseState?.progress === 'REQUESTED'
                ? t('blackbox.eraseStarting')
                : t('blackbox.eraseRunning')}
            </Text>
            <Text style={styles.eraseClock} testID="blackbox-erase-elapsed">
              {elapsedLabel(elapsed)}
            </Text>
          </View>
        ) : eraseApplies ? (
          <Button
            label={t('blackbox.eraseAction')}
            onPress={() => setConfirmingErase(true)}
            variant="danger"
            icon="trash-2"
            disabled={busy}
            accessibilityLabel={t('blackbox.eraseAccessible')}
            style={styles.inlineAction}
            testID="blackbox-erase-button"
          />
        ) : draftOnlyFlash ? (
          <Text style={styles.hintText} testID="blackbox-erase-needs-save">
            {t('blackbox.eraseNeedsSavedDevice')}
          </Text>
        ) : null}
        {eraseOutcome === undefined ? null : (
          <Text
            style={
              eraseOutcome.kind === 'SUCCEEDED' ? styles.successText : styles.warningText
            }
            testID="blackbox-erase-outcome">
            {eraseOutcomeText(eraseOutcome, t)}
          </Text>
        )}
      </View>
    );
  };

  const sdCard = (storage: SdcardStorage): React.ReactNode => {
    const copy = describeSdcard(storage);
    const totalBytes =
      storage.totalKilobytes === undefined
        ? undefined
        : kibibytesToBytes(storage.totalKilobytes);
    const freeBytes =
      storage.freeKilobytes === undefined
        ? undefined
        : kibibytesToBytes(storage.freeKilobytes);
    const usedBytes =
      totalBytes === undefined || freeBytes === undefined
        ? undefined
        : totalBytes - freeBytes;

    return (
      <View style={[styles.card, wide && styles.storageColumn]} testID="blackbox-sd">
        <View style={styles.cardHead}>
          <Icon name="layers" size={18} color={colors.accentStrong} />
          <Text style={styles.sectionTitle}>{t('blackbox.sdTitle')}</Text>
        </View>
        <Text style={styles.stateHeadline} testID="blackbox-sd-state">
          {t(copy.headlineKey)}
        </Text>
        {copy.showsMeasurements && totalBytes !== undefined && freeBytes !== undefined ? (
          <>
            {/* FREE, NOT USED, is the headline - and that is the
                firmware's own meaning. msp.c fills freeSpace from
                afatfs_getContiguousFreeSpace(), the largest CONTIGUOUS
                run available, which is exactly "how much room is there
                for the next log" and is NOT the arithmetic complement of
                a used figure. Printing "used" as the headline would
                over-state occupancy on a fragmented card. */}
            <Text style={styles.measurement} testID="blackbox-sd-usage">
              {t('blackbox.freeOfTotal', {
                free: sizeText(freeBytes, t),
                total: sizeText(totalBytes, t),
              })}
            </Text>
            <UsageBar
              fraction={usedFraction({
                usedBytes,
                totalBytes,
                measurementsValid: storage.measurementsValid,
              })}
              testID="blackbox-sd-bar"
            />
            <Text style={styles.hintText}>{t('blackbox.sdFreeIsContiguous')}</Text>
          </>
        ) : null}
        {storage.state === 'FATAL' || storage.state === 'UNKNOWN' ? (
          <Text style={styles.diagnostic} testID="blackbox-sd-diagnostic">
            {t('blackbox.sdDiagnostic', {
              state: storage.stateRaw,
              error: storage.filesystemLastError,
            })}
          </Text>
        ) : null}
      </View>
    );
  };

  /* ---- ③ settings ----------------------------------------------- */

  const settingsSection = (): React.ReactNode => {
    if (draft === undefined || snapshot === undefined) return null;
    const rateOptions = [];
    for (let raw = BLACKBOX_SAMPLE_RATE_MIN; raw <= BLACKBOX_SAMPLE_RATE_MAX; raw += 1) {
      const label = describeBlackboxRate({
        raw,
        divider: Math.pow(2, raw),
        modelled: true,
      });
      rateOptions.push({
        key: String(raw),
        label:
          label.key === 'blackbox.rate.full'
            ? t(label.key)
            : t(label.key, {divider: label.divider}),
      });
    }
    /* A board reporting a rate this build cannot name keeps it as a
       choice of its own, so opening the selector cannot silently rewrite
       the operator's configuration. */
    const rateUnmodelled = !snapshot.configuration.sampleRate.modelled;
    if (rateUnmodelled) {
      rateOptions.push({
        key: String(snapshot.config.sampleRateRaw),
        label: t('blackbox.rate.unknown', {raw: snapshot.config.sampleRateRaw}),
      });
    }

    const deviceOptions = OFFERABLE_BLACKBOX_DEVICES.map(raw => ({
      key: String(raw),
      label: labelForDevice(raw, t),
    }));
    if (!snapshot.configuration.device.modelled) {
      deviceOptions.push({
        key: String(snapshot.config.deviceRaw),
        label: t('blackbox.device.UNKNOWN', {raw: snapshot.config.deviceRaw}),
      });
    }

    const debugOptions = offerableDebugModes(snapshot.debugModeCount).map(raw => ({
      key: String(raw),
      label: describeDebugMode(raw).name ?? String(raw),
    }));
    const debugUnnamed = describeDebugMode(draft.debugMode).name === undefined;
    if (debugUnnamed) {
      debugOptions.push({
        key: String(draft.debugMode),
        label: t('blackbox.debugModeUnknown', {raw: draft.debugMode}),
      });
    }

    return (
      <Section
        title={t('blackbox.settingsTitle')}
        hint={t('blackbox.settingsHint')}
        testID="blackbox-settings">
        <View style={styles.fieldsRow}>
          <View style={styles.field}>
            <SelectField
              label={t('blackbox.deviceField')}
              options={deviceOptions}
              selectedKey={String(draft.deviceRaw)}
              onSelect={key => update({deviceRaw: Number(key)})}
              disabled={busy}
              testID="blackbox-device-select"
            />
          </View>
          <View style={styles.field}>
            <SelectField
              label={t('blackbox.rateField')}
              options={rateOptions}
              selectedKey={String(draft.sampleRateRaw)}
              onSelect={key => update({sampleRateRaw: Number(key)})}
              disabled={busy}
              helper={t('blackbox.rateHelper')}
              testID="blackbox-rate-select"
            />
          </View>
          <View style={styles.field}>
            <SelectField
              label={t('blackbox.debugModeField')}
              options={debugOptions}
              selectedKey={String(draft.debugMode)}
              onSelect={key => update({debugMode: Number(key)})}
              disabled={busy}
              helper={t('blackbox.debugModeHelper')}
              testID="blackbox-debug-select"
            />
          </View>
        </View>
      </Section>
    );
  };

  /* ---- ④ advanced ------------------------------------------------ */

  const advancedSection = (): React.ReactNode => {
    if (draft === undefined) return null;
    return (
      <View style={styles.card} testID="blackbox-advanced">
        <Pressable
          onPress={() => setAdvancedOpen(open => !open)}
          accessibilityRole="button"
          accessibilityState={{expanded: advancedOpen}}
          accessibilityLabel={t('blackbox.advancedTitle')}
          style={styles.disclosure}
          testID="blackbox-advanced-toggle">
          <Text style={styles.sectionTitle}>{t('blackbox.advancedTitle')}</Text>
          <Icon
            name={advancedOpen ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={colors.textSecondary}
          />
        </Pressable>
        {advancedOpen ? (
          <View style={styles.fieldsGrid} testID="blackbox-fields">
            <Text style={styles.sectionHint}>{t('blackbox.fieldsHint')}</Text>
            {BLACKBOX_FIELD_BITS.map(field => (
              <View style={styles.fieldToggle} key={field}>
                <Text style={styles.factLabel}>{t(`blackbox.field.${field}` as const)}</Text>
                <ToggleSwitch
                  value={blackboxFieldIncluded(draft.disabledFieldsMask, field)}
                  onValueChange={included =>
                    update({
                      disabledFieldsMask: withBlackboxFieldIncluded(
                        draft.disabledFieldsMask,
                        field as BlackboxFieldName,
                        included,
                      ),
                    })
                  }
                  disabled={busy}
                  accessibilityLabel={t('blackbox.fieldAccessible', {
                    name: t(`blackbox.field.${field}` as const),
                  })}
                  testID={`blackbox-field-${field}`}
                />
              </View>
            ))}
          </View>
        ) : null}
      </View>
    );
  };

  /* ---- outcome copy ---------------------------------------------- */

  const statusLine = ((): {text: string; warning: boolean} | undefined => {
    if (saveStage !== undefined) {
      return {text: t(`blackbox.saveStage.${saveStage}` as const), warning: false};
    }
    if (persistence !== undefined) {
      return persistenceText(persistence, t);
    }
    if (saveOutcome !== undefined) {
      return saveOutcomeText(saveOutcome, t);
    }
    return undefined;
  })();

  return (
    <View style={styles.root} testID="blackbox-screen">
      <ScrollView contentContainerStyle={[styles.content, {maxWidth}]}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('blackbox.title')}</Text>
          <Text style={styles.subtitle}>{t('blackbox.subtitle')}</Text>
          {/* ONE CHIP, AND ONLY ONE.
              "Is anything being logged at all" is the question a pilot
              opens this screen with, and it is answered by the device
              byte rather than by any feature flag - see the status card
              below. The destination NAME deliberately does not get a chip
              of its own: it is already the first row of that card and the
              selector below it, and a third copy in the header is noise
              rather than hierarchy. */}
          {snapshot !== undefined && snapshot.config.supported ? (
            <View style={styles.chips} testID="blackbox-chips">
              <Chip
                tone={loggingConfigured ? 'good' : 'idle'}
                icon={loggingConfigured ? 'circle-check' : 'circle-x'}
                label={
                  loggingConfigured
                    ? t('blackbox.chipFeatureOn')
                    : t('blackbox.chipFeatureOff')
                }
                testID="blackbox-chip-feature"
              />
            </View>
          ) : null}
        </View>

        {statusLine === undefined ? null : (
          <View
            style={statusLine.warning ? styles.warning : styles.success}
            testID="blackbox-status-line">
            <Text style={statusLine.warning ? styles.warningText : styles.successText}>
              {statusLine.text}
            </Text>
            {persistence?.kind === 'PERSISTENCE_MISMATCH' ||
            saveOutcome?.kind === 'READBACK_MISMATCH' ? (
              <Button
                label={t('blackbox.reread')}
                onPress={reload}
                variant="secondary"
                icon="refresh-cw"
                style={styles.inlineAction}
                testID="blackbox-reread"
              />
            ) : null}
          </View>
        )}

        {body()}
        <View style={styles.bottomSpace} />
      </ScrollView>

      <StickyActionBar
        visible={dirty && !erasing}
        summary={t('blackbox.pendingSummary')}
        details={[t('blackbox.pendingDetail')]}
        saveLabel={t('blackbox.saveAction')}
        discardLabel={t('blackbox.discardAction')}
        onSave={save}
        onDiscard={discard}
        busy={saving}
        busyLabel={
          saveStage === undefined
            ? t('blackbox.saveStage.SENDING')
            : t(`blackbox.saveStage.${saveStage}` as const)
        }
        testID="blackbox-save-bar"
      />

      {/* THE ONE CONFIRMATION. A Modal, not Alert - see this file's
          header for why Alert cannot be used here at all. */}
      <Modal
        visible={confirmingErase}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmingErase(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} testID="blackbox-erase-dialog">
            <Text style={styles.dialogTitle}>{t('blackbox.eraseConfirmTitle')}</Text>
            <Text style={styles.dialogBody}>{t('blackbox.eraseConfirmBody')}</Text>
            <Text style={styles.dialogHint}>{t('blackbox.eraseConfirmHint')}</Text>
            <View style={styles.dialogActions}>
              <Button
                label={t('blackbox.eraseConfirmCancel')}
                onPress={() => setConfirmingErase(false)}
                variant="secondary"
                testID="blackbox-erase-cancel"
              />
              <Button
                label={t('blackbox.eraseConfirmAccept')}
                onPress={beginErase}
                variant="danger"
                icon="trash-2"
                testID="blackbox-erase-confirm"
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* ================================================================== *
 * COPY HELPERS - key selection only; the words live in the catalogue
 * ================================================================== */

type Translate = (key: string, options?: Record<string, unknown>) => string;

function sizeText(bytes: number, t: Translate): string {
  const size = formatBinarySize(bytes);
  return `${size.amount} ${t(size.unitKey)}`;
}

function labelForDevice(raw: number, t: Translate): string {
  const label = describeBlackboxDevice({
    device:
      raw === 0 ? 'NONE' : raw === 1 ? 'FLASH' : raw === 2 ? 'SDCARD' : raw === 3 ? 'SERIAL' : 'UNKNOWN',
    raw,
    modelled: raw >= 0 && raw <= 3,
  });
  return label.raw === undefined ? t(label.key) : t(label.key, {raw: label.raw});
}

function saveOutcomeText(
  outcome: BlackboxSaveOutcome,
  t: Translate,
): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'NO_CHANGES':
      return {text: t('blackbox.outcome.noChanges'), warning: false};
    case 'AWAITING_REBOOT_VERIFICATION':
      return {text: t('blackbox.saveStage.VERIFYING_AFTER_REBOOT'), warning: false};
    /**
     * THE ACK-WITHOUT-APPLY CASE. The known firmware cause is a write
     * refused while logging is active, and the secondary line says so as
     * a possibility. It is NOT asserted: nothing in this session proved
     * the board was logging.
     */
    case 'READBACK_MISMATCH':
      return {text: t('blackbox.outcome.readbackMismatch'), warning: true};
    case 'REJECTED':
      return {text: t(`blackbox.blockReason.${outcome.reason}` as const), warning: true};
    case 'UNCONFIRMED':
      return {text: t('blackbox.outcome.unconfirmed'), warning: true};
    case 'SESSION_ENDED':
      return {text: t('blackbox.outcome.sessionEnded'), warning: true};
    case 'FAILED':
      return {text: t('blackbox.outcome.failed'), warning: true};
  }
}

function persistenceText(
  outcome: BlackboxPersistenceOutcome,
  t: Translate,
): {text: string; warning: boolean} {
  switch (outcome.kind) {
    case 'SUCCEEDED':
      return {text: t('blackbox.outcome.saved'), warning: false};
    case 'PERSISTENCE_MISMATCH':
      return {text: t('blackbox.outcome.persistenceMismatch'), warning: true};
    /** A distinct sentence: this is not a failure, it is a wrong moment. */
    case 'STALE_SESSION':
      return {text: t('blackbox.outcome.staleSession'), warning: true};
    case 'REJECTED':
      return {text: t(`blackbox.blockReason.${outcome.reason}` as const), warning: true};
    case 'SESSION_ENDED':
      return {text: t('blackbox.outcome.sessionEnded'), warning: true};
    case 'FAILED':
      return {text: t('blackbox.outcome.failed'), warning: true};
  }
}

function eraseOutcomeText(outcome: BlackboxEraseOutcome, t: Translate): string {
  switch (outcome.kind) {
    case 'SUCCEEDED':
      return t('blackbox.erase.succeeded');
    case 'REFUSED':
      return t(`blackbox.eraseRefusal.${outcome.reason}` as const);
    /** Not "the erase failed" - we stopped waiting, the board may not have. */
    case 'TIMED_OUT':
      return t('blackbox.erase.timedOut');
    case 'LINK_LOST':
      return t('blackbox.erase.linkLost');
    /** Not "the erase was cancelled" - only the watching was. */
    case 'OBSERVATION_CANCELLED':
      return t('blackbox.erase.observationCancelled');
    case 'REJECTED':
      return t(`blackbox.blockReason.${outcome.reason}` as const);
    case 'FAILED':
      return t('blackbox.erase.failed');
  }
}

/** Re-exported for the block-reason catalogue gate. */
export type {BlackboxBlockReason};

/* ================================================================== *
 * STYLE
 * ================================================================== */

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  content: {
    width: '100%',
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  header: {gap: spacing.xs},
  title: {...typography.title, color: colors.textPrimary, textAlign: 'right'},
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
    maxWidth: PROSE_MEASURE,
  },
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  chip_good: {borderColor: colors.success, backgroundColor: colors.successSoft},
  chip_idle: {borderColor: colors.border, backgroundColor: colors.surfaceAlt},
  chip_warn: {borderColor: colors.warning, backgroundColor: colors.warningSoft},
  chipText: {...typography.caption, fontWeight: '600'},

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardHead: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  sectionTitle: {...typography.sectionTitle, color: colors.textPrimary, textAlign: 'right'},
  sectionHint: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    maxWidth: PROSE_MEASURE,
  },
  /* Two storage cards side by side only where there is genuinely room;
     on a phone they stack at full width rather than being squeezed. */
  storageRow: {flexDirection: 'row', gap: spacing.md},
  storageColumn: {flex: 1},

  factRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 26,
  },
  /* Wide layouts only: the facts sit beside each other and each label
     hugs its own value, instead of two words at opposite ends of a
     1366px card. */
  factsRow: {flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.xxl},
  factInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 26,
  },
  factLabel: {...typography.label, color: colors.textSecondary, textAlign: 'right'},
  factValue: {...typography.bodyStrong, color: colors.textPrimary, textAlign: 'left'},
  stateHeadline: {...typography.bodyStrong, color: colors.textPrimary, textAlign: 'right'},
  measurement: {
    ...typography.value,
    color: colors.textPrimary,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  hintText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    maxWidth: PROSE_MEASURE,
  },
  diagnostic: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'left',
    writingDirection: 'ltr',
  },

  barTrack: {
    height: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  barFill: {height: 8, borderRadius: radii.pill, backgroundColor: colors.accentStrong},

  inlineNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  inlineNoticeText: {
    ...typography.body,
    color: colors.warning,
    flexShrink: 1,
    textAlign: 'right',
  },
  draftNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  draftText: {
    ...typography.body,
    color: colors.accentText,
    flexShrink: 1,
    textAlign: 'right',
  },

  eraseLive: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  eraseText: {...typography.body, color: colors.textPrimary, flexShrink: 1},
  eraseClock: {
    ...typography.value,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
    writingDirection: 'ltr',
  },

  fieldsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md},
  field: {flexGrow: 1, flexBasis: 220},
  fieldsGrid: {gap: spacing.xs},
  fieldToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
  },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET,
  },

  warning: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  warningText: {
    ...typography.body,
    color: colors.warning,
    textAlign: 'right',
    maxWidth: PROSE_MEASURE,
  },
  success: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  successText: {
    ...typography.body,
    color: colors.success,
    textAlign: 'right',
    maxWidth: PROSE_MEASURE,
  },
  noticeBody: {...typography.body, color: colors.textPrimary, textAlign: 'right'},
  inlineAction: {alignSelf: 'flex-start'},
  loading: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    padding: spacing.xl,
  },
  bottomSpace: {height: spacing.xl},

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(21,34,50,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.error,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  dialogTitle: {...typography.heading, color: colors.error, textAlign: 'right'},
  dialogBody: {...typography.body, color: colors.textPrimary, textAlign: 'right'},
  dialogHint: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
