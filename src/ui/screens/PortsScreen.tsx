/**
 * Arabic-first Ports configuration surface.
 *
 * This component never talks to MSP directly. It edits an immutable copy
 * of wire truth and hands one complete transaction to
 * PortsConfigurationController, which owns session identity, telemetry
 * exclusion, disarmed proof, writes, EEPROM, readback and reboot handling.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  SERIAL_BAUD_RATES,
  SERIAL_ROLE_DEFINITIONS,
  availableBaudIndexes,
  enabledSerialRoles,
  hasSerialRole,
  serialPortDisplayName,
  serialPortsEqual,
  serialRoleIsAvailable,
  setSerialBaud,
  setSerialRole,
  unknownSerialFunctionMask,
  validateSerialPorts,
  type SerialBaudField,
  type SerialPortsSnapshot,
  type SerialPortsValidationIssue,
  type SerialRoleCategory,
  type SerialRoleKey,
} from '../../core/state/serialPortsModel';
import type { MspSerialPortRecord } from '../../core/protocol/msp';
import {
  portsConfigurationController,
  type PortsBlockReason,
  type PortsLoadOutcome,
  type PortsSaveOutcome,
  type SetupUiSessionKey,
  useMspOwnershipState,
} from '../../platforms/react-native/protocol';
import { colors, radii, spacing, typography, useContentEnvelope } from '../theme';
import { StickyActionBar } from '../components/editing';

const MIN_TOUCH_TARGET = 44;
const TELEMETRY_ROLES = SERIAL_ROLE_DEFINITIONS.filter(
  role => role.category === 'TELEMETRY',
);
const SENSOR_ROLES = SERIAL_ROLE_DEFINITIONS.filter(
  role => role.category === 'SENSOR',
);
const PERIPHERAL_ROLES = SERIAL_ROLE_DEFINITIONS.filter(
  role => role.category === 'PERIPHERAL',
);
const MSP_SHAREABLE = new Set<SerialRoleKey>([
  'TELEMETRY_FRSKY',
  'TELEMETRY_HOTT',
  'TELEMETRY_LTM',
  'TELEMETRY_MAVLINK',
  'BLACKBOX',
  'VTX_MSP',
]);

export interface PortsControllerPort {
  load(sessionKey: SetupUiSessionKey): Promise<PortsLoadOutcome>;
  save(
    sessionKey: SetupUiSessionKey,
    original: SerialPortsSnapshot,
    desiredPorts: readonly MspSerialPortRecord[],
  ): Promise<PortsSaveOutcome>;
}

export interface PortsScreenProps {
  readonly sessionKey?: SetupUiSessionKey;
  readonly controller?: PortsControllerPort;
  readonly onOpenGps?: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

type ScreenPhase = 'IDLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

function blockReasonKey(reason: PortsBlockReason): string {
  return `portsConfiguration.blockReason.${reason}`;
}

function issueKey(issue: SerialPortsValidationIssue): string {
  return `portsConfiguration.validation.${issue.code}`;
}

function outcomeKey(outcome: PortsSaveOutcome): string {
  switch (outcome.kind) {
    case 'NO_CHANGES':
      return 'portsConfiguration.outcome.noChanges';
    case 'SAVED_VERIFIED':
      return 'portsConfiguration.outcome.saved';
    case 'SAVED_UNVERIFIED':
      return 'portsConfiguration.outcome.savedUnverified';
    case 'UNCONFIRMED':
      return 'portsConfiguration.outcome.unconfirmed';
    case 'SESSION_ENDED':
      return 'portsConfiguration.outcome.sessionEnded';
    case 'FAILED':
      return 'portsConfiguration.outcome.failed';
    case 'REJECTED':
      return blockReasonKey(outcome.reason);
  }
}

function isDangerOutcome(outcome: PortsSaveOutcome): boolean {
  return outcome.kind !== 'NO_CHANGES' && outcome.kind !== 'SAVED_VERIFIED';
}

function roleLabelKey(role: SerialRoleKey): string {
  return `portsConfiguration.roles.${role}`;
}

function RoleSwitch({
  label,
  value,
  disabled,
  testID,
  onChange,
}: {
  readonly label: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly testID: string;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <View style={[styles.switchRow, disabled && styles.disabled]}>
      <Text style={styles.controlLabel}>{label}</Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        accessibilityLabel={label}
        accessibilityRole="switch"
        accessibilityState={{ checked: value, disabled }}
        trackColor={{ false: colors.disabled, true: colors.accentStrong }}
        thumbColor={value ? colors.accent : colors.textSecondary}
        testID={testID}
      />
    </View>
  );
}

function ChoiceGroup({
  categoryKey,
  title,
  roles,
  selected,
  snapshot,
  disabled,
  portIdentifier,
  isRoleDisabled,
  onSelect,
}: {
  readonly categoryKey: 'telemetry' | 'sensors' | 'peripherals';
  readonly title: string;
  readonly roles: typeof SERIAL_ROLE_DEFINITIONS;
  readonly selected?: SerialRoleKey;
  readonly snapshot: SerialPortsSnapshot;
  readonly disabled: boolean;
  readonly portIdentifier: number;
  readonly isRoleDisabled?: (role: SerialRoleKey) => boolean;
  readonly onSelect: (role?: SerialRoleKey) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.controlGroup}>
      <Text style={styles.groupLabel}>{title}</Text>
      <View style={styles.chipWrap}>
        <Pressable
          disabled={disabled}
          onPress={() => onSelect(undefined)}
          accessibilityLabel={`${title}: ${t('portsConfiguration.none')}`}
          accessibilityRole="radio"
          accessibilityState={{
            selected: selected === undefined,
            disabled,
          }}
          style={[
            styles.chip,
            selected === undefined && styles.chipSelected,
            disabled && styles.disabled,
          ]}
          testID={`ports-${portIdentifier}-${categoryKey}-none`}
        >
          <Text
            style={[
              styles.chipText,
              selected === undefined && styles.chipTextSelected,
            ]}
          >
            {t('portsConfiguration.none')}
          </Text>
        </Pressable>
        {roles.map(role => {
          const available = serialRoleIsAvailable(snapshot, role.key);
          const active = selected === role.key;
          const roleDisabled = isRoleDisabled?.(role.key) === true;
          return (
            <Pressable
              key={role.key}
              disabled={disabled || !available || roleDisabled}
              onPress={() => onSelect(role.key)}
              accessibilityLabel={`${title}: ${t(roleLabelKey(role.key))}`}
              accessibilityRole="radio"
              accessibilityState={{
                selected: active,
                disabled: disabled || !available || roleDisabled,
              }}
              style={[
                styles.chip,
                active && styles.chipSelected,
                (!available || disabled || roleDisabled) && styles.disabled,
              ]}
              testID={`ports-${portIdentifier}-role-${role.key}`}
            >
              <Text
                style={[styles.chipText, active && styles.chipTextSelected]}
              >
                {t(roleLabelKey(role.key))}
              </Text>
              {!available ? (
                <Text style={styles.unavailableText}>
                  {t('portsConfiguration.notCompiled')}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function BaudSelector({
  field,
  port,
  apiMinor,
  disabled,
  onChange,
}: {
  readonly field: SerialBaudField;
  readonly port: MspSerialPortRecord;
  readonly apiMinor: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.baudSection}>
      <Text style={styles.baudLabel}>
        {t(`portsConfiguration.baud.${field}`)}
      </Text>
      <View style={styles.chipWrap}>
        {availableBaudIndexes(field, apiMinor).map(index => {
          const selected = port[field] === index;
          return (
            <Pressable
              key={index}
              disabled={disabled}
              onPress={() => onChange(index)}
              accessibilityLabel={`${t(`portsConfiguration.baud.${field}`)}: ${
                SERIAL_BAUD_RATES[index]
              }`}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              style={[
                styles.baudChip,
                selected && styles.chipSelected,
                disabled && styles.disabled,
              ]}
              testID={`ports-${port.identifier}-${field}-${index}`}
            >
              <Text
                style={[
                  styles.chipText,
                  styles.ltr,
                  selected && styles.chipTextSelected,
                ]}
              >
                {SERIAL_BAUD_RATES[index]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function PortCard({
  port,
  snapshot,
  disabled,
  onToggle,
  onSelectCategory,
  onBaud,
}: {
  readonly port: MspSerialPortRecord;
  readonly snapshot: SerialPortsSnapshot;
  readonly disabled: boolean;
  readonly onToggle: (role: SerialRoleKey, value: boolean) => void;
  readonly onSelectCategory: (
    category: SerialRoleCategory,
    role?: SerialRoleKey,
  ) => void;
  readonly onBaud: (field: SerialBaudField, value: number) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const roles = enabledSerialRoles(port);
  const telemetry = roles.find(role =>
    TELEMETRY_ROLES.some(definition => definition.key === role),
  );
  const sensor = roles.find(role =>
    SENSOR_ROLES.some(definition => definition.key === role),
  );
  const peripheral = roles.find(role =>
    PERIPHERAL_ROLES.some(definition => definition.key === role),
  );
  const unknownMask = unknownSerialFunctionMask(port);
  const isUsb = port.identifier === 20;
  const baudSummary = useMemo(() => {
    const values: string[] = [];
    const append = (role: SerialRoleKey, index: number) => {
      const baud = SERIAL_BAUD_RATES[index];
      if (baud !== undefined) values.push(`${t(roleLabelKey(role))}: ${baud}`);
    };
    if (hasSerialRole(port, 'MSP')) append('MSP', port.mspBaudIndex);
    if (sensor === 'GPS') append('GPS', port.gpsBaudIndex);
    if (telemetry !== undefined) append(telemetry, port.telemetryBaudIndex);
    if (peripheral === 'BLACKBOX') append('BLACKBOX', port.blackboxBaudIndex);
    return values.join(' · ');
  }, [peripheral, port, sensor, t, telemetry]);

  return (
    <View style={styles.portCard} testID={`ports-card-${port.identifier}`}>
      <Pressable
        onPress={() => setExpanded(value => !value)}
        accessibilityLabel={`${serialPortDisplayName(port.identifier)}: ${
          expanded
            ? t('portsConfiguration.collapsePort')
            : t('portsConfiguration.editPort')
        }`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        style={styles.portHeader}
        testID={`ports-card-toggle-${port.identifier}`}
      >
        <View>
          <Text style={styles.portName}>
            {serialPortDisplayName(port.identifier)}
          </Text>
          <Text style={styles.portIdentifier}>
            {t('portsConfiguration.portIdentifier', { id: port.identifier })}
          </Text>
        </View>
        <View style={styles.portHeaderStatus}>
          <View style={styles.roleCountBadge}>
            <Text style={styles.roleCountText}>
              {t('portsConfiguration.activeRoleCount', { count: roles.length })}
            </Text>
          </View>
          <Text style={styles.expandText}>
            {expanded
              ? t('portsConfiguration.collapsePort')
              : t('portsConfiguration.editPort')}
          </Text>
        </View>
      </Pressable>
      {roles.length > 0 ? (
        <Text style={styles.roleSummary}>
          {roles.map(role => t(roleLabelKey(role))).join(' · ')}
        </Text>
      ) : null}
      {baudSummary.length > 0 ? (
        <Text
          style={[styles.baudSummary, styles.ltr]}
          testID={`ports-baud-summary-${port.identifier}`}
        >
          {baudSummary}
        </Text>
      ) : null}
      {unknownMask !== 0 ? (
        <View style={styles.preservedNotice}>
          <Text style={styles.preservedText}>
            {t('portsConfiguration.unknownFunctionsPreserved')}
          </Text>
          <Text style={[styles.preservedMask, styles.ltr]}>
            0x{unknownMask.toString(16).toUpperCase()}
          </Text>
        </View>
      ) : null}
      {expanded ? (
        <>
          <View style={styles.primaryControls}>
            <RoleSwitch
              label={t('portsConfiguration.msp')}
              value={hasSerialRole(port, 'MSP')}
              disabled={disabled || (isUsb && hasSerialRole(port, 'MSP'))}
              testID={`ports-${port.identifier}-msp`}
              onChange={value => onToggle('MSP', value)}
            />
            <RoleSwitch
              label={t('portsConfiguration.serialRx')}
              value={hasSerialRole(port, 'RX_SERIAL')}
              disabled={disabled || isUsb}
              testID={`ports-${port.identifier}-rx`}
              onChange={value => onToggle('RX_SERIAL', value)}
            />
          </View>
          {hasSerialRole(port, 'MSP') ? (
            <BaudSelector
              field="mspBaudIndex"
              port={port}
              apiMinor={snapshot.apiVersionMinor}
              disabled={disabled}
              onChange={value => onBaud('mspBaudIndex', value)}
            />
          ) : null}

          <ChoiceGroup
            categoryKey="telemetry"
            title={t('portsConfiguration.telemetry')}
            roles={TELEMETRY_ROLES}
            selected={telemetry}
            snapshot={snapshot}
            disabled={disabled}
            portIdentifier={port.identifier}
            isRoleDisabled={role => isUsb && !MSP_SHAREABLE.has(role)}
            onSelect={role => onSelectCategory('TELEMETRY', role)}
          />
          {telemetry !== undefined ? (
            <BaudSelector
              field="telemetryBaudIndex"
              port={port}
              apiMinor={snapshot.apiVersionMinor}
              disabled={disabled}
              onChange={value => onBaud('telemetryBaudIndex', value)}
            />
          ) : null}
          <ChoiceGroup
            categoryKey="sensors"
            title={t('portsConfiguration.sensors')}
            roles={SENSOR_ROLES}
            selected={sensor}
            snapshot={snapshot}
            disabled={disabled || isUsb}
            portIdentifier={port.identifier}
            onSelect={role => onSelectCategory('SENSOR', role)}
          />
          {sensor === 'GPS' ? (
            <BaudSelector
              field="gpsBaudIndex"
              port={port}
              apiMinor={snapshot.apiVersionMinor}
              disabled={disabled}
              onChange={value => onBaud('gpsBaudIndex', value)}
            />
          ) : null}
          <ChoiceGroup
            categoryKey="peripherals"
            title={t('portsConfiguration.peripherals')}
            roles={PERIPHERAL_ROLES}
            selected={peripheral}
            snapshot={snapshot}
            disabled={disabled}
            portIdentifier={port.identifier}
            isRoleDisabled={role => isUsb && !MSP_SHAREABLE.has(role)}
            onSelect={role => onSelectCategory('PERIPHERAL', role)}
          />
          {peripheral === 'BLACKBOX' ? (
            <BaudSelector
              field="blackboxBaudIndex"
              port={port}
              apiMinor={snapshot.apiVersionMinor}
              disabled={disabled}
              onChange={value => onBaud('blackboxBaudIndex', value)}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export default function PortsScreen({
  sessionKey,
  controller = portsConfigurationController,
  onOpenGps,
  onDirtyChange,
}: PortsScreenProps): React.JSX.Element {
  const { t } = useTranslation();
  // Desktop tiers get the wider workspace envelope; narrower tiers keep
  // the 1180px reading cap. See useContentEnvelope.ts.
  const { maxWidth: contentMaxWidth } = useContentEnvelope(true);
  const ownership = useMspOwnershipState(sessionKey?.sessionId ?? '');
  const ownershipRef = useRef(ownership);
  ownershipRef.current = ownership;
  const [phase, setPhase] = useState<ScreenPhase>('IDLE');
  const [original, setOriginal] = useState<SerialPortsSnapshot>();
  const [draft, setDraft] = useState<readonly MspSerialPortRecord[]>([]);
  const [loadOutcome, setLoadOutcome] = useState<PortsLoadOutcome>();
  const [saveOutcome, setSaveOutcome] = useState<PortsSaveOutcome>();
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (sessionKey === undefined || ownership !== 'ACTIVE') {
      setPhase('IDLE');
      setOriginal(undefined);
      setDraft([]);
      return () => {
        cancelled = true;
      };
    }
    setPhase('LOADING');
    setLoadOutcome(undefined);
    setSaveOutcome(undefined);
    controller
      .load(sessionKey)
      .then(outcome => {
        if (cancelled) return;
        setLoadOutcome(outcome);
        if (outcome.kind === 'LOADED') {
          setOriginal(outcome.snapshot);
          setDraft(outcome.snapshot.ports);
          setPhase('READY');
        } else {
          setOriginal(undefined);
          setDraft([]);
          setPhase('ERROR');
        }
      })
      .catch(error => {
        if (cancelled) return;
        setLoadOutcome({ kind: 'FAILED', error });
        setOriginal(undefined);
        setDraft([]);
        setPhase('ERROR');
      });
    return () => {
      cancelled = true;
    };
  }, [controller, ownership, reloadToken, sessionKey]);

  const snapshot = useMemo(
    () =>
      original === undefined
        ? undefined
        : Object.freeze({ ...original, ports: draft }),
    [draft, original],
  );
  const issues = useMemo(
    () => (snapshot === undefined ? [] : validateSerialPorts(snapshot)),
    [snapshot],
  );
  const dirty =
    original !== undefined && !serialPortsEqual(original.ports, draft);
  const controlsDisabled = phase === 'LOADING' || phase === 'SAVING';

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const updateRole = useCallback(
    (identifier: number, role: SerialRoleKey, value: boolean) => {
      setSaveOutcome(undefined);
      setDraft(current => {
        let next = current;
        if (value && role === 'MSP') {
          const currentPort = next.find(port => port.identifier === identifier);
          for (const active of currentPort === undefined
            ? []
            : enabledSerialRoles(currentPort)) {
            if (active !== 'MSP' && !MSP_SHAREABLE.has(active)) {
              next = setSerialRole(next, identifier, active, false);
            }
          }
        }
        if (value && role === 'RX_SERIAL')
          next = setSerialRole(next, identifier, 'MSP', false);
        return setSerialRole(next, identifier, role, value);
      });
    },
    [],
  );

  const selectCategory = useCallback(
    (
      identifier: number,
      category: SerialRoleCategory,
      selected?: SerialRoleKey,
    ) => {
      setSaveOutcome(undefined);
      setDraft(current => {
        let next = current;
        for (const role of SERIAL_ROLE_DEFINITIONS.filter(
          item => item.category === category,
        )) {
          next = setSerialRole(next, identifier, role.key, false);
        }
        if (selected === undefined) return next;
        if (category === 'TELEMETRY') {
          for (const role of PERIPHERAL_ROLES)
            next = setSerialRole(next, identifier, role.key, false);
        }
        if (category === 'PERIPHERAL') {
          for (const role of TELEMETRY_ROLES)
            next = setSerialRole(next, identifier, role.key, false);
        }
        if (!MSP_SHAREABLE.has(selected))
          next = setSerialRole(next, identifier, 'MSP', false);
        if (selected === 'VTX_MSP')
          next = setSerialRole(next, identifier, 'MSP', true);
        return setSerialRole(next, identifier, selected, true);
      });
    },
    [],
  );

  const updateBaud = useCallback(
    (identifier: number, field: SerialBaudField, value: number) => {
      setSaveOutcome(undefined);
      setDraft(current => setSerialBaud(current, identifier, field, value));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (
      sessionKey === undefined ||
      original === undefined ||
      !dirty ||
      issues.length > 0
    )
      return;
    setPhase('SAVING');
    let outcome: PortsSaveOutcome;
    try {
      outcome = await controller.save(sessionKey, original, draft);
    } catch (error) {
      outcome = { kind: 'FAILED', error };
    }
    setSaveOutcome(outcome);
    if (
      outcome.kind === 'SAVED_VERIFIED' &&
      ownershipRef.current === 'ACTIVE'
    ) {
      setOriginal(outcome.snapshot);
      setDraft(outcome.snapshot.ports);
    }
    setPhase(
      outcome.kind === 'SESSION_ENDED' || ownershipRef.current !== 'ACTIVE'
        ? 'ERROR'
        : 'READY',
    );
  }, [controller, dirty, draft, issues.length, original, sessionKey]);

  const reloadNow = useCallback(() => {
    setSaveOutcome(undefined);
    setReloadToken(token => token + 1);
  }, []);

  const requestReload = useCallback(() => {
    if (!dirty) {
      reloadNow();
      return;
    }
    Alert.alert(
      t('portsConfiguration.discardChangesTitle'),
      t('portsConfiguration.discardChangesBody'),
      [
        {
          text: t('portsConfiguration.cancel'),
          style: 'cancel',
        },
        {
          text: t('portsConfiguration.discardAndReload'),
          style: 'destructive',
          onPress: reloadNow,
        },
      ],
    );
  }, [dirty, reloadNow, t]);

  /**
   * WHICH ports actually changed, named. "غير محفوظة" alone does not tell
   * an operator whether the change they meant to make is the one that is
   * pending, and a save bar that cannot say what it would write is not
   * evidence of anything.
   */
  const pendingPortChanges = useMemo(() => {
    if (original === undefined) {
      return [];
    }
    const lines: string[] = [];
    for (const port of draft) {
      const before = original.ports.find(
        candidate => candidate.identifier === port.identifier,
      );
      if (before === undefined || serialPortsEqual([before], [port])) {
        continue;
      }
      const roles = enabledSerialRoles(port);
      const name = serialPortDisplayName(port.identifier);
      lines.push(
        roles.length === 0
          ? `${name}: ${t('portsConfiguration.none')}`
          : `${name}: ${roles.map(role => t(roleLabelKey(role))).join('، ')}`,
      );
    }
    return lines;
  }, [draft, original, t]);

  const loadMessage =
    loadOutcome?.kind === 'REJECTED'
      ? t(blockReasonKey(loadOutcome.reason))
      : loadOutcome?.kind === 'FAILED'
      ? t('portsConfiguration.loadFailed')
      : loadOutcome?.kind === 'SESSION_ENDED'
      ? t('portsConfiguration.blockReason.DISCONNECTED')
      : undefined;

  return (
    <View style={styles.root} testID="ports-screen">
      <ScrollView
        contentContainerStyle={[styles.content, { maxWidth: contentMaxWidth }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>{t('portsConfiguration.eyebrow')}</Text>
          <Text style={styles.title}>{t('portsConfiguration.title')}</Text>
          <Text style={styles.subtitle}>
            {t('portsConfiguration.subtitle')}
          </Text>
        </View>

        <View style={styles.warningCard}>
          <Text style={styles.warningTitle}>
            {t('portsConfiguration.warningTitle')}
          </Text>
          <Text style={styles.warningText}>
            {t('portsConfiguration.warningBody')}
          </Text>
        </View>

        {phase === 'IDLE' ? (
          <Text style={styles.stateText}>
            {t('portsConfiguration.blockReason.DISCONNECTED')}
          </Text>
        ) : null}
        {phase === 'LOADING' ? (
          <Text style={styles.stateText}>
            {t('portsConfiguration.loading')}
          </Text>
        ) : null}
        {loadMessage !== undefined ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{loadMessage}</Text>
            <Pressable
              style={styles.secondaryButton}
              accessibilityRole="button"
              accessibilityLabel={t('portsConfiguration.reload')}
              onPress={reloadNow}
              testID="ports-retry-load"
            >
              <Text style={styles.secondaryButtonText}>
                {t('portsConfiguration.reload')}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {snapshot !== undefined ? (
          <>
            <View style={styles.summaryCard}>
              <View>
                <Text style={styles.summaryTitle}>
                  {t('portsConfiguration.detectedPorts')}
                </Text>
                <Text style={styles.summaryValue}>{snapshot.ports.length}</Text>
              </View>
              <View>
                <Text style={styles.summaryTitle}>
                  {t('portsConfiguration.apiVersion')}
                </Text>
                <Text style={[styles.summaryValue, styles.ltr]}>
                  1.{snapshot.apiVersionMinor}
                </Text>
              </View>
              <View>
                <Text style={styles.summaryTitle}>
                  {t('portsConfiguration.changes')}
                </Text>
                <Text
                  style={[styles.summaryStatus, dirty && styles.summaryDirty]}
                >
                  {dirty
                    ? t('portsConfiguration.unsaved')
                    : t('portsConfiguration.synced')}
                </Text>
              </View>
            </View>

            <View
              style={styles.gpsIntegrationCard}
              testID="ports-gps-integration"
            >
              <View style={styles.gpsIntegrationCopy}>
                <Text style={styles.summaryTitle}>
                  {t('portsConfiguration.gpsIntegrationTitle')}
                </Text>
                <Text style={styles.gpsIntegrationText}>
                  {draft.some(port => hasSerialRole(port, 'GPS'))
                    ? draft
                        .filter(port => hasSerialRole(port, 'GPS'))
                        .map(
                          port =>
                            `${serialPortDisplayName(port.identifier)} · ${
                              SERIAL_BAUD_RATES[port.gpsBaudIndex] ?? '?'
                            }`,
                        )
                        .join('، ')
                    : t('portsConfiguration.gpsNotAssigned')}
                </Text>
              </View>
              {onOpenGps !== undefined ? (
                <Pressable
                  onPress={onOpenGps}
                  style={styles.secondaryButton}
                  accessibilityRole="button"
                  testID="ports-open-gps"
                >
                  <Text style={styles.secondaryButtonText}>
                    {t('portsConfiguration.openGps')}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {snapshot.vtxTableAvailable === true &&
            snapshot.vtxTableConfigured === false &&
            draft.some(port => hasSerialRole(port, 'VTX_MSP')) ? (
              <View style={styles.noticeCard} testID="ports-vtx-table-warning">
                <Text style={styles.noticeText}>
                  {t('portsConfiguration.vtxTableMissing')}
                </Text>
              </View>
            ) : null}

            {issues.length > 0 ? (
              <View
                style={styles.validationCard}
                testID="ports-validation-errors"
              >
                <Text style={styles.validationTitle}>
                  {t('portsConfiguration.validationTitle')}
                </Text>
                {issues.map((issue, index) => (
                  <Text
                    key={`${issue.code}-${
                      issue.portIdentifier ?? 'all'
                    }-${index}`}
                    style={styles.validationText}
                  >
                    •{' '}
                    {t(issueKey(issue), {
                      port:
                        issue.portIdentifier === undefined
                          ? ''
                          : serialPortDisplayName(issue.portIdentifier),
                      role:
                        issue.role === undefined
                          ? ''
                          : t(roleLabelKey(issue.role)),
                    })}
                  </Text>
                ))}
              </View>
            ) : null}

            {draft.map(port => (
              <PortCard
                key={port.identifier}
                port={port}
                snapshot={snapshot}
                disabled={controlsDisabled}
                onToggle={(role, value) =>
                  updateRole(port.identifier, role, value)
                }
                onSelectCategory={(category, role) =>
                  selectCategory(port.identifier, category, role)
                }
                onBaud={(field, value) =>
                  updateBaud(port.identifier, field, value)
                }
              />
            ))}

            {saveOutcome !== undefined ? (
              <View
                style={[
                  styles.outcomeCard,
                  isDangerOutcome(saveOutcome) && styles.outcomeDanger,
                ]}
                testID="ports-save-outcome"
              >
                <Text
                  style={[
                    styles.outcomeText,
                    isDangerOutcome(saveOutcome) && styles.errorText,
                  ]}
                >
                  {t(outcomeKey(saveOutcome))}
                </Text>
              </View>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                disabled={controlsDisabled || !dirty}
                accessibilityRole="button"
                accessibilityLabel={t('portsConfiguration.reset')}
                accessibilityState={{
                  disabled: controlsDisabled || !dirty,
                }}
                onPress={() => {
                  setDraft(original?.ports ?? []);
                  setSaveOutcome(undefined);
                }}
                style={[
                  styles.secondaryButton,
                  (controlsDisabled || !dirty) && styles.disabled,
                ]}
                testID="ports-reset"
              >
                <Text style={styles.secondaryButtonText}>
                  {t('portsConfiguration.reset')}
                </Text>
              </Pressable>
              <Pressable
                disabled={controlsDisabled}
                accessibilityRole="button"
                accessibilityLabel={t('portsConfiguration.reload')}
                accessibilityState={{ disabled: controlsDisabled }}
                onPress={requestReload}
                style={[
                  styles.secondaryButton,
                  controlsDisabled && styles.disabled,
                ]}
                testID="ports-reload"
              >
                <Text style={styles.secondaryButtonText}>
                  {t('portsConfiguration.reload')}
                </Text>
              </Pressable>
              <Pressable
                disabled={controlsDisabled || !dirty || issues.length > 0}
                accessibilityRole="button"
                accessibilityLabel={t('portsConfiguration.saveAndReboot')}
                accessibilityState={{
                  disabled: controlsDisabled || !dirty || issues.length > 0,
                }}
                onPress={handleSave}
                style={[
                  styles.saveButton,
                  (controlsDisabled || !dirty || issues.length > 0) &&
                    styles.disabled,
                ]}
                testID="ports-save"
              >
                <Text style={styles.saveButtonText}>
                  {phase === 'SAVING'
                    ? t('portsConfiguration.saving')
                    : t('portsConfiguration.saveAndReboot')}
                </Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </ScrollView>
      {/* OUTSIDE the ScrollView on purpose: the in-scroll actions above
          sit below six UART cards, which is why the operator reported
          that no save action appeared at all. This bar is on screen
          whenever something is genuinely pending. */}
      <StickyActionBar
        visible={dirty}
        summary={
          pendingPortChanges.length > 0
            ? pendingPortChanges.join('   ')
            : t('portsConfiguration.unsaved')
        }
        details={pendingPortChanges}
        saveLabel={t('portsConfiguration.saveAndReboot')}
        discardLabel={t('portsConfiguration.reset')}
        onSave={handleSave}
        onDiscard={() => {
          setDraft(original?.ports ?? []);
          setSaveOutcome(undefined);
        }}
        disabledReason={
          issues.length > 0
            ? t('portsConfiguration.validationTitle')
            : undefined
        }
        busy={phase === 'SAVING'}
        busyLabel={t('portsConfiguration.saving')}
        testID="ports-sticky-actions"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
  },
  hero: { alignItems: 'flex-end', gap: spacing.xs },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accent,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  title: {
    ...typography.display,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  warningCard: {
    backgroundColor: '#2A2115',
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  warningTitle: {
    ...typography.sectionTitle,
    color: colors.warning,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  warningText: {
    ...typography.body,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  stateText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    padding: spacing.xl,
    writingDirection: 'rtl',
  },
  errorCard: {
    backgroundColor: '#301B21',
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.md,
  },
  errorText: {
    ...typography.body,
    color: colors.error,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  summaryCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  summaryTitle: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  summaryValue: {
    ...typography.title,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  summaryStatus: {
    ...typography.sectionTitle,
    color: colors.success,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  summaryDirty: { color: colors.warning },
  gpsIntegrationCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  gpsIntegrationCopy: { flex: 1, minWidth: 220 },
  gpsIntegrationText: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.xs,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  noticeCard: {
    backgroundColor: colors.accentSoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  noticeText: {
    ...typography.body,
    color: colors.info,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  validationCard: {
    backgroundColor: '#2A2115',
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  validationTitle: {
    ...typography.sectionTitle,
    color: colors.warning,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  validationText: {
    ...typography.caption,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  portCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  portHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  portHeaderStatus: { alignItems: 'flex-start', gap: spacing.xs },
  portName: {
    ...typography.title,
    color: colors.textPrimary,
    writingDirection: 'ltr',
  },
  portIdentifier: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'left',
    writingDirection: 'rtl',
  },
  roleCountBadge: {
    backgroundColor: colors.accentSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  roleCountText: {
    ...typography.caption,
    color: colors.accent,
    writingDirection: 'rtl',
  },
  expandText: {
    ...typography.caption,
    color: colors.accent,
    writingDirection: 'rtl',
  },
  roleSummary: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  baudSummary: {
    ...typography.caption,
    color: colors.accent,
    textAlign: 'left',
  },
  preservedNotice: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.sm,
    padding: spacing.md,
    gap: spacing.sm,
  },
  preservedText: {
    ...typography.caption,
    color: colors.warning,
    textAlign: 'right',
    writingDirection: 'rtl',
    flex: 1,
  },
  preservedMask: { ...typography.mono, color: colors.warning },
  primaryControls: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  switchRow: {
    flex: 1,
    minWidth: 210,
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  controlLabel: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  controlGroup: { gap: spacing.sm },
  groupLabel: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceAlt,
  },
  chipSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  chipText: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  chipTextSelected: { color: colors.accent, fontWeight: '800' },
  unavailableText: {
    fontSize: 9,
    lineHeight: 12,
    color: colors.textMuted,
    writingDirection: 'rtl',
  },
  baudSection: { gap: spacing.xs, paddingTop: spacing.xs },
  baudLabel: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  baudChip: {
    minHeight: 36,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  ltr: { writingDirection: 'ltr' },
  disabled: { opacity: 0.42 },
  outcomeCard: {
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.success,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  outcomeDanger: { backgroundColor: '#301B21', borderColor: colors.error },
  outcomeText: {
    ...typography.body,
    color: colors.success,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingTop: spacing.sm,
  },
  secondaryButton: {
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryButtonText: {
    ...typography.sectionTitle,
    color: colors.accent,
    writingDirection: 'rtl',
  },
  saveButton: {
    flexGrow: 1,
    minHeight: 52,
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  saveButtonText: {
    ...typography.sectionTitle,
    color: colors.accentText,
    writingDirection: 'rtl',
  },
});
