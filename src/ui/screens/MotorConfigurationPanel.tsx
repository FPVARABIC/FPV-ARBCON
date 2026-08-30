import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  createMotorConfigurationDraft,
  motorConfigurationDraftsEqual,
  validateMotorConfigurationDraft,
  type MotorConfigurationDraft,
  type MotorConfigurationSnapshot,
} from '../../core/state/motorConfigurationModel';
import {
  motorConfigurationController,
  type MotorConfigurationBlockReason,
  type MotorConfigurationLoadOutcome,
  type MotorConfigurationSaveOutcome,
} from '../../platforms/react-native/protocol/MotorConfigurationController';
import {PROSE_MEASURE, colors, noticeSurface, radii, spacing, typography} from '../theme';
import { SelectField, ToggleSwitch } from '../components/controls';
import { BETAFLIGHT_MIXER_REFERENCE_V147 } from '../../core/firmware-adapters/betaflightMixerReferenceV147';
import { formatMotorProtocol } from './MotorConfigurationSummary';
import { partialApplyMessage } from '../presentation/writeStageNames';

const MIN_TOUCH_TARGET = 44;

const PROTOCOLS: readonly number[] = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
]);

type NumericField =
  | 'motorPwmRate'
  | 'motorIdleRaw'
  | 'maxThrottle'
  | 'minCommand'
  | 'motorPoleCount'
  | 'deadband3dLow'
  | 'deadband3dHigh'
  | 'neutral3d';

type NumericText = Readonly<Record<NumericField, string>>;

export interface MotorConfigurationControllerPort {
  load(sessionId: string): Promise<MotorConfigurationLoadOutcome>;
  save(
    sessionId: string,
    original: MotorConfigurationSnapshot,
    draft: MotorConfigurationDraft,
  ): Promise<MotorConfigurationSaveOutcome>;
}

export interface MotorConfigurationPanelProps {
  readonly sessionId: string;
  readonly controller?: MotorConfigurationControllerPort;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** Reports the panel's exclusive MSP transaction so the motor-test
   * session action cannot race its automatic read or a save. */
  readonly onBusyChange?: (busy: boolean) => void;
}

function numericTextFor(draft: MotorConfigurationDraft): NumericText {
  return Object.freeze({
    motorPwmRate: String(draft.motorPwmRate),
    motorIdleRaw: String(draft.motorIdleRaw),
    maxThrottle: String(draft.maxThrottle),
    minCommand: String(draft.minCommand),
    motorPoleCount: String(draft.motorPoleCount),
    deadband3dLow: String(draft.deadband3dLow),
    deadband3dHigh: String(draft.deadband3dHigh),
    neutral3d: String(draft.neutral3d),
  });
}

function parseInteger(text: string): number | undefined {
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function withNumericText(
  draft: MotorConfigurationDraft,
  texts: NumericText,
): MotorConfigurationDraft | undefined {
  const values = Object.fromEntries(
    (Object.keys(texts) as NumericField[]).map(field => [
      field,
      parseInteger(texts[field]),
    ]),
  ) as Record<NumericField, number | undefined>;
  if (Object.values(values).some(value => value === undefined)) {
    return undefined;
  }
  return Object.freeze({
    ...draft,
    motorPwmRate: values.motorPwmRate as number,
    motorIdleRaw: values.motorIdleRaw as number,
    maxThrottle: values.maxThrottle as number,
    minCommand: values.minCommand as number,
    motorPoleCount: values.motorPoleCount as number,
    deadband3dLow: values.deadband3dLow as number,
    deadband3dHigh: values.deadband3dHigh as number,
    neutral3d: values.neutral3d as number,
  });
}

function blockReasonText(
  t: (key: string) => string,
  reason: MotorConfigurationBlockReason,
): string {
  switch (reason) {
    case 'DISCONNECTED':
      return t('motorConfiguration.reasonDisconnected');
    case 'IDENTIFYING':
      return t('motorConfiguration.reasonIdentifying');
    case 'INCOMPATIBLE_FIRMWARE':
      return t('motorConfiguration.reasonIncompatible');
    case 'APP_BACKGROUNDED':
      return t('motorConfiguration.reasonBackground');
    case 'LINK_RECOVERING':
      return t('motorConfiguration.reasonRecovering');
    case 'FC_ARMED':
      return t('motorConfiguration.reasonArmed');
    case 'ARMED_STATE_UNKNOWN':
      return t('motorConfiguration.reasonArmedUnknown');
    case 'MOTOR_TEST_ACTIVE':
      return t('motorConfiguration.reasonMotorTestActive');
    case 'INVALID_DRAFT':
      return t('motorConfiguration.reasonInvalid');
    case 'STALE_BASE':
      return t('motorConfiguration.reasonStale');
    case 'CONFIGURATION_BUSY':
      return t('motorConfiguration.reasonBusy');
    case 'ESC_DIRECTION_UNSUPPORTED':
      return t('motorConfiguration.reasonEscDirectionUnsupported');
    case 'CONFIGURATION_WRITE_UNVERIFIED':
      return t('motorConfiguration.reasonWriteUnverified');
  }
}

function outcomeText(
  t: (key: string) => string,
  outcome: MotorConfigurationSaveOutcome | undefined,
): { readonly text: string; readonly danger: boolean } | undefined {
  if (outcome === undefined) {
    return undefined;
  }
  switch (outcome.kind) {
    case 'NO_CHANGES':
      return { text: t('motorConfiguration.outcomeNoChanges'), danger: false };
    case 'SAVED_VERIFIED':
      return { text: t('motorConfiguration.outcomeSaved'), danger: false };
    case 'SAVED_UNVERIFIED':
      return {
        text: t('motorConfiguration.outcomeSavedUnverified'),
        danger: true,
      };
    case 'REJECTED':
      return { text: blockReasonText(t, outcome.reason), danger: true };
    case 'FAILED':
      return { text: t('motorConfiguration.outcomeFailed'), danger: true };
    case 'UNCONFIRMED':
      return {
        text: t('motorConfiguration.outcomeUnconfirmed'),
        danger: true,
      };
    /* U-R1. RAM moved, flash did not. `outcomeFailed` would say nothing
       happened - which is exactly the sentence that made an operator
       believe an aircraft was untouched while it was running half of an
       edit. The two phrasings separate "all of it is live, unsaved" from
       "some of it is live, unsaved". */
    case 'PARTIAL_UNPERSISTED':
      return {
        text: partialApplyMessage(outcome.failedStage === 'EEPROM'),
        danger: true,
      };
    case 'SESSION_ENDED':
      return {
        text: t('motorConfiguration.reasonDisconnected'),
        danger: true,
      };
  }
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.caption}>{detail}</Text>
    </View>
  );
}

function ToggleRow({
  label,
  detail,
  value,
  disabled,
  onValueChange,
  testID,
}: {
  label: string;
  detail: string;
  value: boolean;
  disabled: boolean;
  onValueChange(value: boolean): void;
  testID: string;
}) {
  return (
    <View style={styles.settingRow} testID={testID}>
      <View style={styles.flexOne}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.caption}>{detail}</Text>
      </View>
      {/* The platform Switch drew accentSoft on accent here - pale teal
          on pale teal, so ON and OFF were nearly indistinguishable on a
          motor-configuration row. The shared control states it plainly. */}
      <ToggleSwitch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        accessibilityLabel={label}
      />
    </View>
  );
}

function NumberField({
  label,
  detail,
  value,
  disabled,
  onChangeText,
  testID,
}: {
  label: string;
  detail: string;
  value: string;
  disabled: boolean;
  onChangeText(value: string): void;
  testID: string;
}) {
  return (
    <View style={styles.numberField} testID={testID}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.caption}>{detail}</Text>
      <TextInput
        value={value}
        editable={!disabled}
        keyboardType="number-pad"
        onChangeText={onChangeText}
        selectTextOnFocus
        style={[styles.input, disabled && styles.disabled]}
        accessibilityLabel={label}
      />
    </View>
  );
}

export function MotorConfigurationPanel({
  sessionId,
  controller = motorConfigurationController,
  onDirtyChange,
  onBusyChange,
}: MotorConfigurationPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'LOADING' | 'IDLE' | 'SAVING'>('LOADING');
  const [original, setOriginal] = useState<MotorConfigurationSnapshot>();
  const [draft, setDraft] = useState<MotorConfigurationDraft>();
  const [numericText, setNumericText] = useState<NumericText>();
  const [loadError, setLoadError] = useState<string>();
  const [saveOutcome, setSaveOutcome] =
    useState<MotorConfigurationSaveOutcome>();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    onBusyChange?.(phase !== 'IDLE');
  }, [onBusyChange, phase]);
  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [onBusyChange],
  );

  const installSnapshot = useCallback(
    (snapshot: MotorConfigurationSnapshot) => {
      const next = createMotorConfigurationDraft(snapshot);
      setOriginal(snapshot);
      setDraft(next);
      setNumericText(numericTextFor(next));
      setConfirming(false);
    },
    [],
  );

  const load = useCallback(async () => {
    setPhase('LOADING');
    setLoadError(undefined);
    setSaveOutcome(undefined);
    try {
      const result = await controller.load(sessionId);
      if (result.kind === 'LOADED') {
        installSnapshot(result.snapshot);
      } else if (result.kind === 'REJECTED') {
        setLoadError(blockReasonText(t, result.reason));
      } else if (result.kind === 'SESSION_ENDED') {
        setLoadError(t('motorConfiguration.reasonDisconnected'));
      } else {
        setLoadError(t('motorConfiguration.loadFailed'));
      }
    } catch {
      setLoadError(t('motorConfiguration.loadFailed'));
    } finally {
      setPhase('IDLE');
    }
  }, [controller, installSnapshot, sessionId, t]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const effectiveDraft = useMemo(
    () =>
      draft === undefined || numericText === undefined
        ? undefined
        : withNumericText(draft, numericText),
    [draft, numericText],
  );
  const validation = useMemo(
    () =>
      effectiveDraft === undefined
        ? undefined
        : validateMotorConfigurationDraft(effectiveDraft),
    [effectiveDraft],
  );
  const changed =
    (original !== undefined && effectiveDraft !== undefined && !motorConfigurationDraftsEqual(createMotorConfigurationDraft(original), effectiveDraft)) ||
    (draft !== undefined && numericText !== undefined && Object.keys(numericText).some(key => numericText[key as NumericField] !== numericTextFor(draft)[key as NumericField]));
  useEffect(() => {
    onDirtyChange?.(changed);
    return () => onDirtyChange?.(false);
  }, [changed, onDirtyChange]);
  const canReview =
    phase === 'IDLE' &&
    changed &&
    validation?.valid === true &&
    loadError === undefined;
  const disabled = phase !== 'IDLE' || original === undefined;

  /**
   * THE AIRFRAMES THIS PANEL WILL OFFER TO WRITE.
   *
   * SOURCE OWNERSHIP, RESOLVED FOR M-E §7. Betaflight Configurator
   * 2026.6.1 (14a057ff) puts the mixer selector on the MOTORS tab -
   * MotorsTab.vue:13-14, a select bound to `fcStore.mixerConfig.mixer` -
   * and its save sends MSP_SET_MIXER_CONFIG at MotorsTab.vue:1388,
   * followed by an EEPROM write and a reboot. Our earlier design decision
   * that Motors may never change the mixer was therefore wrong about the
   * reference implementation, and M-E §7 says source truth wins.
   *
   * WE ARE STRICTER THAN THE REFERENCE IN ONE WAY, DELIBERATELY. The
   * reference sends the write and reports success on the acknowledgement.
   * This panel's save re-reads the whole configuration after the EEPROM
   * commit and compares it field by field against the draft, so a mixer
   * that did not take reports SAVED_UNVERIFIED rather than success. That
   * transaction is unchanged by M-E: the mixer byte was always in the
   * draft and always in the readback comparison; what was missing was a
   * control to change it.
   *
   * THREE MODES ARE NOT OFFERED, AND IT IS NOT A JUDGEMENT ABOUT THEM.
   * validateAndFixConfig() (config.c:200-218 @ 7348054f) REWRITES
   * HELI_90_DEG, PPM_TO_SERVO and SINGLECOPTER to a custom mode inside
   * readEEPROM(), before anything can observe the value. Offering them
   * would mean writing a byte that is guaranteed to read back as a
   * different byte, which our own verification would then - correctly -
   * report as unverified. The reference table records that rewrite per
   * mode, so this list is derived from it rather than hand-maintained.
   *
   * AN UNKNOWN MIXER IS NEVER NORMALISED. If the flight controller
   * reports an id this table does not know, `selectedKey` below is simply
   * not in the list: the field shows the raw value and offers no
   * substitute. Silently snapping it to a neighbouring mixer would be the
   * exact failure this whole subsystem exists to prevent.
   */
  const mixerOptions = useMemo(
    () =>
      BETAFLIGHT_MIXER_REFERENCE_V147.filter(
        row => row.configValidationRewrite === undefined,
      ).map(row => ({
        key: String(row.mixerId),
        label: t(`motorsScreen.topology.airframe.${row.firmwareName}`),
      })),
    [t],
  );

  const setBoolean = useCallback(
    (field: keyof MotorConfigurationDraft, value: boolean) => {
      setDraft(current =>
        current === undefined
          ? current
          : Object.freeze({ ...current, [field]: value }),
      );
      setSaveOutcome(undefined);
      setConfirming(false);
    },
    [],
  );

  /** Sets a numeric draft field from a value rather than from typed
   *  text. The text setters exist because a partially-typed number is not
   *  a number; a chosen option always is. */
  const setNumberValue = useCallback(
    (field: keyof MotorConfigurationDraft, value: number) => {
      setDraft(current =>
        current === undefined
          ? current
          : Object.freeze({ ...current, [field]: value }),
      );
      setSaveOutcome(undefined);
      setConfirming(false);
    },
    [],
  );

  const setNumber = useCallback((field: NumericField, value: string) => {
    setNumericText(current =>
      current === undefined
        ? current
        : Object.freeze({ ...current, [field]: value }),
    );
    setSaveOutcome(undefined);
    setConfirming(false);
  }, []);

  const resetDraft = useCallback(() => {
    if (original !== undefined) {
      installSnapshot(original);
    }
    setSaveOutcome(undefined);
  }, [installSnapshot, original]);

  const requestReload = useCallback(() => {
    if (!changed) {
      load().catch(() => undefined);
      return;
    }
    Alert.alert(t('motorConfiguration.discardChangesTitle'), t('motorConfiguration.discardChangesBody'), [
      { text: t('motorConfiguration.cancel'), style: 'cancel' },
      { text: t('motorConfiguration.discardAndReload'), style: 'destructive', onPress: () => { load().catch(() => undefined); } },
    ]);
  }, [changed, load, t]);

  const save = useCallback(async () => {
    if (
      original === undefined ||
      effectiveDraft === undefined ||
      validation?.valid !== true
    ) {
      return;
    }
    setPhase('SAVING');
    setSaveOutcome(undefined);
    try {
      const result = await controller.save(sessionId, original, effectiveDraft);
      setSaveOutcome(result);
      if (result.kind === 'SAVED_VERIFIED' || result.kind === 'NO_CHANGES') {
        installSnapshot(result.snapshot);
      } else {
        setConfirming(false);
      }
    } catch {
      setSaveOutcome({
        kind: 'FAILED',
        error: new Error('Unexpected motor configuration save failure.'),
        acknowledgedGroups: [],
        persisted: false,
      });
      setConfirming(false);
    } finally {
      setPhase('IDLE');
    }
  }, [
    controller,
    effectiveDraft,
    installSnapshot,
    original,
    sessionId,
    validation,
  ]);

  const outcome = outcomeText(t, saveOutcome);
  const digitalProtocol =
    effectiveDraft !== undefined &&
    effectiveDraft.motorProtocolRaw >= 5 &&
    effectiveDraft.motorProtocolRaw <= 8;
  const analogProtocol =
    effectiveDraft !== undefined &&
    effectiveDraft.motorProtocolRaw >= 0 &&
    effectiveDraft.motorProtocolRaw <= 4;

  return (
    <View style={styles.root} testID="motor-configuration-panel">
      <View style={styles.headerRow}>
        <View style={styles.flexOne}>
          <Text style={styles.eyebrow}>{t('motorConfiguration.eyebrow')}</Text>
          <Text style={styles.title}>{t('motorConfiguration.title')}</Text>
          <Text style={styles.caption}>{t('motorConfiguration.subtitle')}</Text>
        </View>
        <Pressable
          onPress={requestReload}
          disabled={phase !== 'IDLE'}
          style={[styles.smallButton, phase !== 'IDLE' && styles.disabled]}
          testID="motor-config-refresh"
        >
          <Text style={styles.smallButtonText}>
            {t('motorConfiguration.refresh')}
          </Text>
        </Pressable>
      </View>

      {phase === 'LOADING' ? (
        <Text style={styles.infoText} testID="motor-config-loading">
          {t('motorConfiguration.loading')}
        </Text>
      ) : null}
      {loadError !== undefined ? (
        <View style={styles.errorNotice} testID="motor-config-load-error">
          <Text style={styles.errorText}>{loadError}</Text>
        </View>
      ) : null}

      {draft !== undefined && numericText !== undefined ? (
        <>
          <View style={styles.section}>
            <SectionHeading
              title={t('motorConfiguration.protocolHeading')}
              detail={t('motorConfiguration.protocolDetail')}
            />
            <View style={styles.protocolGrid}>
              {PROTOCOLS.map(protocol => {
                const selected = draft.motorProtocolRaw === protocol;
                return (
                  <Pressable
                    key={protocol}
                    onPress={() => {
                      setDraft(current =>
                        current === undefined
                          ? current
                          : Object.freeze({
                              ...current,
                              motorProtocolRaw: protocol,
                            }),
                      );
                      setConfirming(false);
                      setSaveOutcome(undefined);
                    }}
                    disabled={disabled}
                    accessibilityRole="radio"
                    accessibilityState={{ selected, disabled }}
                    style={[
                      styles.protocolChip,
                      selected && styles.protocolChipSelected,
                    ]}
                    testID={`motor-config-protocol-${protocol}`}
                  >
                    <Text
                      style={[
                        styles.protocolText,
                        selected && styles.protocolTextSelected,
                      ]}
                    >
                      {formatMotorProtocol(protocol)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <ToggleRow
              label={t('motorConfiguration.unsynced')}
              detail={t('motorConfiguration.unsyncedDetail')}
              value={draft.useContinuousUpdate}
              disabled={disabled || !analogProtocol}
              onValueChange={value => setBoolean('useContinuousUpdate', value)}
              testID="motor-config-unsynced"
            />
            {analogProtocol ? (
              <View style={styles.numberGrid}>
                <NumberField
                  label={t('motorConfiguration.pwmRate')}
                  detail={t('motorConfiguration.pwmRateDetail')}
                  value={numericText.motorPwmRate}
                  disabled={disabled}
                  onChangeText={value => setNumber('motorPwmRate', value)}
                  testID="motor-config-pwm-rate"
                />
                <NumberField
                  label={t('motorConfiguration.maxThrottle')}
                  detail={t('motorConfiguration.externalRange')}
                  value={numericText.maxThrottle}
                  disabled={disabled}
                  onChangeText={value => setNumber('maxThrottle', value)}
                  testID="motor-config-max-throttle"
                />
                <NumberField
                  label={t('motorConfiguration.minCommand')}
                  detail={t('motorConfiguration.externalRange')}
                  value={numericText.minCommand}
                  disabled={disabled}
                  onChangeText={value => setNumber('minCommand', value)}
                  testID="motor-config-min-command"
                />
              </View>
            ) : null}
          </View>

          <View style={styles.section}>
            <SectionHeading
              title={t('motorConfiguration.escHeading')}
              detail={t('motorConfiguration.escDetail')}
            />
            <ToggleRow
              label={t('motorConfiguration.bidirectionalDshot')}
              detail={t('motorConfiguration.bidirectionalDshotDetail')}
              value={draft.dshotTelemetryEnabled}
              disabled={disabled || !digitalProtocol}
              onValueChange={value =>
                setBoolean('dshotTelemetryEnabled', value)
              }
              testID="motor-config-bidirectional-dshot"
            />
            <ToggleRow
              label={t('motorConfiguration.escSensor')}
              detail={t('motorConfiguration.escSensorDetail')}
              value={draft.escSensorEnabled}
              // Serial ESC telemetry is an independent Betaflight feature;
              // unlike bidirectional DShot it is not coupled to the motor
              // signalling family and can accompany analog protocols.
              disabled={disabled}
              onValueChange={value => setBoolean('escSensorEnabled', value)}
              testID="motor-config-esc-sensor"
            />
            <ToggleRow
              label={t('motorConfiguration.motorStop')}
              detail={t('motorConfiguration.motorStopDetail')}
              value={draft.motorStopEnabled}
              disabled={disabled}
              onValueChange={value => setBoolean('motorStopEnabled', value)}
              testID="motor-config-motor-stop"
            />
            {/* M-E §7 / §8 / §10: CHOOSING THE AIRCRAFT.
                It sits directly above the propeller-direction switch
                because the two are the same MSP command - byte 0 and
                byte 1 of MSP_SET_MIXER_CONFIG - and a save that changes
                either sends both. Changing it does not redraw the
                aircraft on its own: the drawing follows the RUNTIME motor
                count, and that only changes once the flight controller
                has rebooted and run mixerInit() again. The save's own
                reboot notice is what carries that, and it is unchanged. */}
            <SelectField
              label={t('motorConfiguration.mixerLabel')}
              helper={t('motorConfiguration.mixerDetail')}
              options={mixerOptions}
              selectedKey={String(draft.mixerModeRaw)}
              disabled={disabled}
              onSelect={value => setNumberValue('mixerModeRaw', Number(value))}
              testID="motor-config-mixer"
            />
            <ToggleRow
              label={t('motorConfiguration.propsDirection')}
              detail={t('motorConfiguration.propsDirectionDetail')}
              value={draft.yawMotorsReversed}
              disabled={disabled}
              onValueChange={value => setBoolean('yawMotorsReversed', value)}
              testID="motor-config-yaw-reversed"
            />
            <View style={styles.numberGrid}>
              <NumberField
                label={t('motorConfiguration.motorIdle')}
                detail={t('motorConfiguration.motorIdleDetail')}
                value={numericText.motorIdleRaw}
                disabled={disabled}
                onChangeText={value => setNumber('motorIdleRaw', value)}
                testID="motor-config-idle"
              />
              <NumberField
                label={t('motorConfiguration.motorPoles')}
                detail={t('motorConfiguration.motorPolesDetail')}
                value={numericText.motorPoleCount}
                disabled={disabled}
                onChangeText={value => setNumber('motorPoleCount', value)}
                testID="motor-config-poles"
              />
            </View>
          </View>

          <View style={styles.section}>
            <SectionHeading
              title={t('motorConfiguration.threeDHeading')}
              detail={t('motorConfiguration.threeDDetail')}
            />
            <ToggleRow
              label={t('motorConfiguration.threeDEnabled')}
              detail={t('motorConfiguration.threeDWarning')}
              value={draft.feature3dEnabled}
              disabled={disabled}
              onValueChange={value => setBoolean('feature3dEnabled', value)}
              testID="motor-config-3d-enabled"
            />
            {draft.feature3dEnabled ? (
              <View style={styles.numberGrid}>
                <NumberField
                  label={t('motorConfiguration.threeDLow')}
                  detail={t('motorConfiguration.externalRange')}
                  value={numericText.deadband3dLow}
                  disabled={disabled}
                  onChangeText={value => setNumber('deadband3dLow', value)}
                  testID="motor-config-3d-low"
                />
                <NumberField
                  label={t('motorConfiguration.threeDNeutral')}
                  detail={t('motorConfiguration.externalRange')}
                  value={numericText.neutral3d}
                  disabled={disabled}
                  onChangeText={value => setNumber('neutral3d', value)}
                  testID="motor-config-3d-neutral"
                />
                <NumberField
                  label={t('motorConfiguration.threeDHigh')}
                  detail={t('motorConfiguration.externalRange')}
                  value={numericText.deadband3dHigh}
                  disabled={disabled}
                  onChangeText={value => setNumber('deadband3dHigh', value)}
                  testID="motor-config-3d-high"
                />
              </View>
            ) : null}
          </View>

          {effectiveDraft === undefined || validation?.valid === false ? (
            <View style={styles.errorNotice} testID="motor-config-invalid">
              <Text style={styles.errorText}>
                {t('motorConfiguration.invalidValues')}
              </Text>
            </View>
          ) : null}

          {outcome !== undefined ? (
            <View
              style={outcome.danger ? styles.errorNotice : styles.successNotice}
              testID="motor-config-outcome"
            >
              <Text
                style={outcome.danger ? styles.errorText : styles.successText}
              >
                {outcome.text}
              </Text>
            </View>
          ) : null}

          {confirming ? (
            <View
              style={styles.confirmation}
              testID="motor-config-confirmation"
            >
              <Text style={styles.confirmationTitle}>
                {t('motorConfiguration.confirmTitle')}
              </Text>
              <Text style={styles.caption}>
                {t('motorConfiguration.confirmBody')}
              </Text>
              <View style={styles.actionRow}>
                <Pressable
                  onPress={() => setConfirming(false)}
                  style={styles.secondaryButton}
                  testID="motor-config-cancel-save"
                >
                  <Text style={styles.secondaryButtonText}>
                    {t('motorConfiguration.cancel')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    save().catch(() => undefined);
                  }}
                  style={styles.primaryButton}
                  testID="motor-config-confirm-save"
                >
                  <Text style={styles.primaryButtonText}>
                    {t('motorConfiguration.confirmSave')}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.actionRow}>
              <Pressable
                onPress={resetDraft}
                disabled={!changed || phase !== 'IDLE'}
                style={[
                  styles.secondaryButton,
                  (!changed || phase !== 'IDLE') && styles.disabled,
                ]}
                testID="motor-config-reset"
              >
                <Text style={styles.secondaryButtonText}>
                  {t('motorConfiguration.reset')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setConfirming(true)}
                disabled={!canReview}
                style={[styles.primaryButton, !canReview && styles.disabled]}
                testID="motor-config-review-save"
              >
                <Text style={styles.primaryButtonText}>
                  {phase === 'SAVING'
                    ? t('motorConfiguration.saving')
                    : t('motorConfiguration.reviewSave')}
                </Text>
              </Pressable>
            </View>
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.lg,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  flexOne: { flex: 1 },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accentStrong,
    writingDirection: 'rtl'},
  title: {
    ...typography.title,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  infoText: {
    ...typography.body,
    color: colors.accentStrong,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  section: {
    gap: spacing.md,
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  sectionHeading: { gap: 2 },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  settingRow: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    paddingTop: spacing.sm,
  },
  settingLabel: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl'},
  protocolGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  protocolChip: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: 94,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
  },
  protocolChipSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  protocolText: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'ltr',
  },
  protocolTextSelected: { color: colors.accentStrong, fontWeight: '700' },
  numberGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  numberField: {
    flexGrow: 1,
    flexBasis: 150,
    gap: spacing.xs,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: colors.textPrimary,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.sm,
    textAlign: 'center',
    writingDirection: 'ltr',
    ...typography.mono,
  },
  disabled: { opacity: 0.45 },
  smallButton: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
  },
  smallButtonText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
  },
  actionRow: { flexDirection: 'row', gap: spacing.sm },
  primaryButton: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET + 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    backgroundColor: colors.accent,
    padding: spacing.sm,
  },
  primaryButtonText: {
    ...typography.body,
    color: colors.accentText,
    fontWeight: '700',
    writingDirection: 'rtl'},
  secondaryButton: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET + 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    borderColor: colors.border,
    borderWidth: 1,
    padding: spacing.sm,
  },
  secondaryButtonText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl'},
  confirmation: {...noticeSurface, gap: spacing.md,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft},
  confirmationTitle: {
    ...typography.sectionTitle,
    color: colors.warning,
    writingDirection: 'rtl'},
  errorNotice: {...noticeSurface, backgroundColor: colors.errorSoft},
  errorText: {
    ...typography.body,
    color: colors.error,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  successNotice: {...noticeSurface, backgroundColor: colors.successSoft},
  successText: {
    ...typography.body,
    color: colors.success,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
});
