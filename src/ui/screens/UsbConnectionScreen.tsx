import React, {useCallback, useEffect, useReducer, useRef} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, spacing, typography} from '../theme';
import {
  ConnectionActions,
  ConnectionHeader,
  SerialConfigurationPanel,
  UsbDeviceList,
  ValidationLog,
  deviceKey,
  formatHex,
  shortenSessionId,
} from '../components/connection';
import type {ConnectionState, ValidationLogEntry} from '../components/connection';
import {
  isSupportedDevice,
  localizeTransportError,
  usbSerialTransportClient,
} from '../../platforms/react-native/transport';
import type {
  SerialConfiguration,
  TransportError,
  UsbSerialDeviceDescriptor,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';

/**
 * Owned by the UI/client, not the Kotlin transport defaults. Approved as a
 * standard 8N1/no-flow-control configuration for this hardware-validation
 * screen - it does not make the transport layer MSP-aware.
 */
const DEFAULT_SERIAL_CONFIGURATION: SerialConfiguration = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: '1',
  parity: 'none',
  flowControl: 'off',
};

const MAX_LOG_ENTRIES = 50;

interface ScreenState {
  connectionState: ConnectionState;
  devices: UsbSerialDeviceDescriptor[];
  hasScannedOnce: boolean;
  selectedDeviceKey: string | null;
  selectedPortIndex: number | null;
  activeSessionId: string | null;
  errorMessage: string | null;
  lastResult: 'connectSuccess' | 'disconnectSuccess' | null;
  /**
   * Set when closeSession() rejects. The native registry already removed
   * the session before it could report failure (UsbSerialTransportModule
   * .closeSession removes it unconditionally before closing), so cleanup
   * is not confirmed. Requires a fresh, successful scan before a new
   * connect attempt is allowed - a stale pre-failure selection must never
   * be immediately reconnectable.
   */
  requiresCableReset: boolean;
  /**
   * Set from the last completed scan's supported-device count so the screen
   * can show accurate, non-overclaiming detection feedback. Cleared at the
   * start of every new scan. Rendering is additionally gated on
   * connectionState === 'ready' so a stale banner cannot linger once the
   * user moves on to connecting/connected/disconnecting/error.
   */
  detectionMessageKey: 'oneSupported' | 'multipleSupported' | null;
  log: ValidationLogEntry[];
  logExpanded: boolean;
  nextLogId: number;
}

type Action =
  | {type: 'SCAN_START'}
  | {type: 'SCAN_SUCCESS'; devices: UsbSerialDeviceDescriptor[]}
  | {type: 'SCAN_FAILURE'; error: TransportError; message: string}
  | {type: 'SELECT_DEVICE'; device: UsbSerialDeviceDescriptor}
  | {type: 'SELECT_PORT'; portIndex: number}
  | {type: 'CONNECT_START'}
  | {type: 'CONNECT_SUCCESS'; sessionId: string}
  | {type: 'CONNECT_FAILURE'; error: TransportError; message: string}
  | {type: 'DISCONNECT_START'}
  | {type: 'DISCONNECT_SUCCESS'}
  | {type: 'DISCONNECT_FAILURE'; error: TransportError; message: string}
  | {type: 'CLEAR_LOG'}
  | {type: 'TOGGLE_LOG'};

const initialState: ScreenState = {
  connectionState: 'idle',
  devices: [],
  hasScannedOnce: false,
  selectedDeviceKey: null,
  selectedPortIndex: null,
  activeSessionId: null,
  errorMessage: null,
  lastResult: null,
  requiresCableReset: false,
  detectionMessageKey: null,
  log: [],
  logExpanded: false,
  nextLogId: 1,
};

const BUSY_STATES: ReadonlySet<ConnectionState> = new Set([
  'scanning',
  'connecting',
  'disconnecting',
]);

function appendLog(
  state: ScreenState,
  messageKey: string,
  params?: Record<string, string | number>,
): Pick<ScreenState, 'log' | 'nextLogId'> {
  const entry: ValidationLogEntry = {
    id: state.nextLogId,
    timestamp: Date.now(),
    messageKey,
    params,
  };
  // Newest first, bounded to MAX_LOG_ENTRIES so memory cannot grow without
  // limit across a long physical-testing session.
  const log = [entry, ...state.log].slice(0, MAX_LOG_ENTRIES);
  return {log, nextLogId: state.nextLogId + 1};
}

function reducer(state: ScreenState, action: Action): ScreenState {
  switch (action.type) {
    case 'SCAN_START': {
      if (BUSY_STATES.has(state.connectionState) || state.connectionState === 'connected') {
        return state;
      }
      return {
        ...state,
        connectionState: 'scanning',
        errorMessage: null,
        lastResult: null,
        detectionMessageKey: null,
        ...appendLog(state, 'validationLog.scanStarted'),
      };
    }
    case 'SCAN_SUCCESS': {
      // Recovering from a CLOSE_FAILED cable-reset requirement always
      // forces an explicit reselect, even if the user picked a (stale,
      // pre-failure) device again before this scan ran - that selection
      // must not carry over into the post-reset "ready" state.
      const stillPresent =
        !state.requiresCableReset && state.selectedDeviceKey
          ? action.devices.some(d => deviceKey(d) === state.selectedDeviceKey)
          : false;
      const selectedDevice = stillPresent
        ? action.devices.find(d => deviceKey(d) === state.selectedDeviceKey)
        : undefined;
      const selectedPortIndex =
        selectedDevice && state.selectedPortIndex !== null && state.selectedPortIndex < selectedDevice.portCount
          ? state.selectedPortIndex
          : selectedDevice?.portCount === 1
            ? 0
            : null;

      const scanCompletedLog = appendLog(state, 'validationLog.scanCompleted', {
        count: action.devices.length,
      });

      // Safe automatic-selection policy (selection only - never opens a
      // session): only applies when there is no existing valid selection to
      // preserve, and never while recovering from a CLOSE_FAILED cable
      // reset - that recovery always requires an explicit reselect.
      let autoSelectedDeviceKey: string | null = null;
      let autoSelectedPortIndex: number | null = null;
      let autoSelectLog: Pick<ScreenState, 'log' | 'nextLogId'> | null = null;
      const supportedDevices = action.devices.filter(isSupportedDevice);
      if (!stillPresent && !state.requiresCableReset && supportedDevices.length === 1) {
        const onlySupported = supportedDevices[0];
        autoSelectedDeviceKey = deviceKey(onlySupported);
        autoSelectedPortIndex = onlySupported.portCount === 1 ? 0 : null;
        autoSelectLog = appendLog(
          {...state, ...scanCompletedLog},
          'validationLog.autoSelected',
        );
      }

      const detectionMessageKey: ScreenState['detectionMessageKey'] =
        supportedDevices.length === 0 ? null : supportedDevices.length === 1 ? 'oneSupported' : 'multipleSupported';

      return {
        ...state,
        connectionState: 'ready',
        devices: action.devices,
        hasScannedOnce: true,
        selectedDeviceKey: stillPresent ? state.selectedDeviceKey : autoSelectedDeviceKey,
        selectedPortIndex: stillPresent ? selectedPortIndex : autoSelectedPortIndex,
        detectionMessageKey,
        // A completed scan is exactly what lifts a post-CLOSE_FAILED cable
        // reset requirement - a fresh scan is the only thing that clears it.
        requiresCableReset: false,
        ...(autoSelectLog ?? scanCompletedLog),
      };
    }
    case 'SCAN_FAILURE': {
      return {
        ...state,
        connectionState: 'error',
        hasScannedOnce: true,
        errorMessage: action.message,
        ...appendLog(state, 'validationLog.errorEntry', {
          message: action.message,
          code: action.error.code,
        }),
      };
    }
    case 'SELECT_DEVICE': {
      if (BUSY_STATES.has(state.connectionState) || state.connectionState === 'connected') {
        return state;
      }
      const key = deviceKey(action.device);
      const portIndex = action.device.portCount === 1 ? 0 : null;
      return {
        ...state,
        selectedDeviceKey: key,
        selectedPortIndex: portIndex,
        ...appendLog(state, 'validationLog.deviceSelected', {
          vid: formatHex(action.device.vendorId),
          pid: formatHex(action.device.productId),
        }),
      };
    }
    case 'SELECT_PORT': {
      if (BUSY_STATES.has(state.connectionState) || state.connectionState === 'connected') {
        return state;
      }
      return {...state, selectedPortIndex: action.portIndex};
    }
    case 'CONNECT_START': {
      if (BUSY_STATES.has(state.connectionState) || state.connectionState === 'connected') {
        return state;
      }
      return {
        ...state,
        connectionState: 'connecting',
        errorMessage: null,
        lastResult: null,
        ...appendLog(state, 'validationLog.connectStarted'),
      };
    }
    case 'CONNECT_SUCCESS': {
      return {
        ...state,
        connectionState: 'connected',
        activeSessionId: action.sessionId,
        lastResult: 'connectSuccess',
        ...appendLog(state, 'validationLog.connectSucceeded', {sessionId: action.sessionId}),
      };
    }
    case 'CONNECT_FAILURE': {
      return {
        ...state,
        connectionState: 'error',
        activeSessionId: null,
        errorMessage: action.message,
        ...appendLog(state, 'validationLog.errorEntry', {
          message: action.message,
          code: action.error.code,
        }),
      };
    }
    case 'DISCONNECT_START': {
      if (!state.activeSessionId || state.connectionState !== 'connected') {
        return state;
      }
      return {
        ...state,
        connectionState: 'disconnecting',
        errorMessage: null,
        lastResult: null,
        ...appendLog(state, 'validationLog.disconnectStarted'),
      };
    }
    case 'DISCONNECT_SUCCESS': {
      return {
        ...state,
        connectionState: 'ready',
        activeSessionId: null,
        lastResult: 'disconnectSuccess',
        ...appendLog(state, 'validationLog.disconnectSucceeded'),
      };
    }
    case 'DISCONNECT_FAILURE': {
      // The native registry already removed the session before it could
      // report failure (UsbSerialTransportModule.closeSession removes from
      // the registry unconditionally before closing), so the id is no
      // longer usable - but per spec this must show "خطأ", never a false
      // "غير متصل". Native USB cleanup is not confirmed, so the previous
      // selection must not be immediately reconnectable: it is cleared here
      // and requiresCableReset blocks a new connect attempt until a fresh
      // scan completes (see SCAN_SUCCESS, the only place that clears it).
      return {
        ...state,
        connectionState: 'error',
        activeSessionId: null,
        selectedDeviceKey: null,
        selectedPortIndex: null,
        requiresCableReset: true,
        errorMessage: action.message,
        ...appendLog(state, 'validationLog.errorEntry', {
          message: action.message,
          code: action.error.code,
        }),
      };
    }
    case 'CLEAR_LOG':
      return {...state, log: []};
    case 'TOGGLE_LOG':
      return {...state, logExpanded: !state.logExpanded};
    default:
      return state;
  }
}

interface Props {
  /** Injectable for tests; defaults to the real singleton client. */
  client?: UsbSerialTransportClient;
}

export default function UsbConnectionScreen({
  client = usbSerialTransportClient,
}: Props): React.JSX.Element {
  const {t} = useTranslation();
  const [state, dispatch] = useReducer(reducer, initialState);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const isBusy = BUSY_STATES.has(state.connectionState);
  const isConnected = state.connectionState === 'connected';
  const selectedDevice = state.devices.find(d => deviceKey(d) === state.selectedDeviceKey) ?? null;
  const canConnect =
    !isBusy &&
    !isConnected &&
    !state.requiresCableReset &&
    selectedDevice !== null &&
    isSupportedDevice(selectedDevice) &&
    state.selectedPortIndex !== null;

  const handleRefresh = useCallback(async () => {
    dispatch({type: 'SCAN_START'});
    try {
      const devices = await client.listDevices();
      if (!mountedRef.current) {
        return;
      }
      dispatch({type: 'SCAN_SUCCESS', devices});
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const transportError = error as TransportError;
      dispatch({
        type: 'SCAN_FAILURE',
        error: transportError,
        message: localizeTransportError(t, transportError),
      });
    }
  }, [client, t]);

  // One automatic enumeration per mounted screen instance - same scan path
  // and reducer actions as manual تحديث (handleRefresh), never openDevice()/
  // closeSession(). The ref (not the effect dep array) is what makes this
  // one-time: it survives React Strict Mode's mount->unmount->remount effect
  // replay on the same component instance, so a second real listDevices()
  // call never happens even though the effect body itself may run twice.
  const hasAutoScannedRef = useRef(false);
  useEffect(() => {
    if (hasAutoScannedRef.current) {
      return;
    }
    hasAutoScannedRef.current = true;
    handleRefresh();
  }, [handleRefresh]);

  const handleSelectDevice = useCallback(
    (device: UsbSerialDeviceDescriptor) => {
      dispatch({type: 'SELECT_DEVICE', device});
    },
    [],
  );

  const handleSelectPort = useCallback((portIndex: number) => {
    dispatch({type: 'SELECT_PORT', portIndex});
  }, []);

  const handleConnect = useCallback(async () => {
    if (
      !selectedDevice ||
      state.selectedPortIndex === null ||
      isBusy ||
      isConnected ||
      state.requiresCableReset
    ) {
      return;
    }
    dispatch({type: 'CONNECT_START'});
    try {
      const sessionId = await client.openDevice(
        selectedDevice.deviceId,
        state.selectedPortIndex,
        DEFAULT_SERIAL_CONFIGURATION,
      );
      if (!mountedRef.current) {
        return;
      }
      dispatch({type: 'CONNECT_SUCCESS', sessionId});
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const transportError = error as TransportError;
      dispatch({
        type: 'CONNECT_FAILURE',
        error: transportError,
        message: localizeTransportError(t, transportError),
      });
    }
  }, [
    client,
    isBusy,
    isConnected,
    selectedDevice,
    state.requiresCableReset,
    state.selectedPortIndex,
    t,
  ]);

  const handleDisconnect = useCallback(async () => {
    if (!state.activeSessionId || state.connectionState !== 'connected') {
      return;
    }
    const sessionId = state.activeSessionId;
    dispatch({type: 'DISCONNECT_START'});
    try {
      await client.closeSession(sessionId);
      if (!mountedRef.current) {
        return;
      }
      dispatch({type: 'DISCONNECT_SUCCESS'});
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const transportError = error as TransportError;
      dispatch({
        type: 'DISCONNECT_FAILURE',
        error: transportError,
        message: localizeTransportError(t, transportError),
      });
    }
  }, [client, state.activeSessionId, state.connectionState, t]);

  const handleToggleLog = useCallback(() => dispatch({type: 'TOGGLE_LOG'}), []);
  const handleClearLog = useCallback(() => dispatch({type: 'CLEAR_LOG'}), []);

  const logExpanded = state.logExpanded || state.connectionState === 'error';

  return (
    <View style={styles.root}>
      <ConnectionHeader connectionState={state.connectionState} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled">
        <View style={styles.instructionBlock}>
          <Text style={styles.instructionPrimary}>{t('connection.instructionPrimary')}</Text>
          <Text style={styles.instructionSecondary}>{t('connection.instructionSecondary')}</Text>
        </View>

        {state.errorMessage ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorBannerText}>{state.errorMessage}</Text>
          </View>
        ) : null}

        {state.connectionState === 'ready' && state.detectionMessageKey === 'oneSupported' ? (
          <View style={styles.detectionBanner} accessibilityRole="text">
            <Text style={styles.detectionBannerText}>{t('devices.supportedDetected')}</Text>
          </View>
        ) : null}

        {state.connectionState === 'ready' && state.detectionMessageKey === 'multipleSupported' ? (
          <View style={styles.detectionBanner} accessibilityRole="text">
            <Text style={styles.detectionBannerText}>{t('devices.multipleSupportedGuidance')}</Text>
          </View>
        ) : null}

        <UsbDeviceList
          devices={state.devices}
          scanning={state.connectionState === 'scanning'}
          hasScannedOnce={state.hasScannedOnce}
          refreshDisabled={isBusy || isConnected}
          selectedKey={state.selectedDeviceKey}
          selectionDisabled={isBusy || isConnected}
          onRefresh={handleRefresh}
          onSelectDevice={handleSelectDevice}
        />

        {selectedDevice ? (
          <SerialConfigurationPanel
            configuration={DEFAULT_SERIAL_CONFIGURATION}
            portCount={selectedDevice.portCount}
            selectedPortIndex={state.selectedPortIndex}
            disabled={isBusy || isConnected}
            onSelectPort={handleSelectPort}
          />
        ) : null}

        <ConnectionActions
          connectionState={state.connectionState}
          canConnect={canConnect}
          lastResult={state.lastResult}
          shortSessionId={state.activeSessionId ? shortenSessionId(state.activeSessionId) : null}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
        />

        <ValidationLog
          entries={state.log}
          expanded={logExpanded}
          onToggle={handleToggleLog}
          onClear={handleClearLog}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing.xl,
  },
  instructionBlock: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  instructionPrimary: {
    ...typography.body,
    color: colors.textPrimary,
  },
  instructionSecondary: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  errorBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.error,
    borderRadius: 4,
    backgroundColor: colors.surfaceAlt,
  },
  errorBannerText: {
    ...typography.body,
    color: colors.error,
  },
  detectionBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.success,
    borderRadius: 4,
    backgroundColor: colors.surfaceAlt,
  },
  detectionBannerText: {
    ...typography.body,
    color: colors.success,
  },
});
