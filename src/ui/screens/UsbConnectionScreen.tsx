import React, {useCallback, useEffect, useReducer, useRef} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import type {RootStackParamList} from '../../navigation/types';
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
  UsbDeviceHotplugEvent,
  UsbSerialDeviceDescriptor,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';
import {
  MspOwnershipActivationError,
  mspSessionCoordinator,
  useMspOwnershipState,
} from '../../platforms/react-native/protocol';
// DEBUG-ONLY SCAFFOLDING (Pass 5.3/5.4, isolated in Pass 7.7) - both
// panels are reached only through debugPanels.ts, which resolves them
// behind __DEV__ so a production bundle never retains them. Each render
// site below is null in a release build.
import {DevAppLogPanel, DevSerialPanel} from './debugPanels';

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
  /**
   * Set by a hot-plug event only - never by the initial mount scan or
   * manual تحديث. Cleared at the start of every new scan (SCAN_START), same
   * lifecycle as detectionMessageKey, so it cannot linger once the user
   * moves on. 'deviceDetached' covers a physical detach before/without a
   * connection; 'sessionDetachedDuringConnection' covers a physical detach
   * of the device an active session was open on.
   */
  hotplugMessageKey: 'deviceDetached' | 'sessionDetachedDuringConnection' | null;
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
  | {type: 'TOGGLE_LOG'}
  | {type: 'DEVICE_ATTACHED_LOG'}
  | {type: 'DEVICE_DETACHED'; identity: UsbDeviceHotplugEvent}
  | {type: 'SESSION_DETACHED'; sessionId: string};

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
  hotplugMessageKey: null,
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
        hotplugMessageKey: null,
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
    case 'DEVICE_ATTACHED_LOG':
      return {...state, ...appendLog(state, 'validationLog.usbDeviceAttached')};
    case 'DEVICE_DETACHED': {
      // Instant local reconciliation - Android already told us exactly which
      // device disappeared, so there is no need to wait for (or trigger) a
      // fresh listDevices() round trip just to know it is gone.
      const key = deviceKey(action.identity);
      const matchesSelected = state.selectedDeviceKey === key;
      const wasListed = state.devices.some(d => deviceKey(d) === key);
      const devices = wasListed ? state.devices.filter(d => deviceKey(d) !== key) : state.devices;

      // A paired SESSION_DETACHED dispatch (same physical event) may have
      // already set the more specific "session detached during connection"
      // message - never downgrade that back to the generic one, regardless
      // of which of the two dispatches happens to run first.
      const hotplugMessageKey =
        state.hotplugMessageKey === 'sessionDetachedDuringConnection'
          ? state.hotplugMessageKey
          : 'deviceDetached';

      const detachedLog = appendLog(state, 'validationLog.usbDeviceDetached');
      if (!matchesSelected) {
        return {...state, devices, hotplugMessageKey, ...detachedLog};
      }

      const staleClearedLog = appendLog(
        {...state, ...detachedLog},
        'validationLog.staleSelectionCleared',
      );
      return {
        ...state,
        devices,
        selectedDeviceKey: null,
        selectedPortIndex: null,
        detectionMessageKey: null,
        hotplugMessageKey,
        ...staleClearedLog,
      };
    }
    case 'SESSION_DETACHED': {
      // Only the active session's own detach is meaningful - a stale id
      // (already closed/replaced) is ignored rather than corrupting the
      // current state.
      if (!action.sessionId || action.sessionId !== state.activeSessionId) {
        return state;
      }
      // A physical detach is not a close failure: requiresCableReset is
      // deliberately left untouched here (see DISCONNECT_FAILURE, the only
      // action allowed to set it).
      return {
        ...state,
        connectionState: 'ready',
        activeSessionId: null,
        lastResult: null,
        errorMessage: null,
        detectionMessageKey: null,
        hotplugMessageKey: 'sessionDetachedDuringConnection',
        ...appendLog(state, 'validationLog.sessionInvalidatedAfterDetach'),
      };
    }
    default:
      return state;
  }
}

interface Props {
  /** Injectable for tests; defaults to the real singleton client. */
  client?: UsbSerialTransportClient;
  /**
   * Pass 7.1: optional (not the real Stack.Screen-injected prop's required
   * type) so every existing test in UsbConnectionScreen.test.tsx that
   * renders this screen standalone, outside a NavigationContainer, keeps
   * working unchanged - handleConnect() below simply skips navigating when
   * it is absent. The real app (App.tsx) always provides it via
   * Stack.Screen's component prop.
   */
  navigation?: NativeStackScreenProps<RootStackParamList, 'Connection'>['navigation'];
}

export default function UsbConnectionScreen({
  client = usbSerialTransportClient,
  navigation,
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
  // Pass 6.4b: '' is a safe fallback when no session is active -
  // getOwnershipState() reports INACTIVE for any sessionId with no entry,
  // including this placeholder one, so mspActive below is correctly false
  // whenever state.activeSessionId is null.
  const mspOwnershipState = useMspOwnershipState(state.activeSessionId ?? '');
  const mspActive = mspOwnershipState !== 'INACTIVE';
  const selectedDevice = state.devices.find(d => deviceKey(d) === state.selectedDeviceKey) ?? null;
  const canConnect =
    !isBusy &&
    !isConnected &&
    !state.requiresCableReset &&
    selectedDevice !== null &&
    isSupportedDevice(selectedDevice) &&
    state.selectedPortIndex !== null;

  // scanInFlightRef/rescanQueuedRef serialize every caller of handleRefresh
  // (initial mount scan, manual تحديث, USB attach events) onto a single
  // real listDevices() call at a time. A call that arrives while one is
  // already in flight does not start a second, overlapping native call -
  // it only flags that another pass is needed. This is a generation/dirty
  // mechanism, not a fixed "one follow-up only" cap: the do/while loop below
  // keeps looping for as long as a new event keeps arriving during the scan
  // it triggers (even a follow-up scan itself), and only stops once one full
  // scan completes with no event having arrived during it - guaranteeing the
  // final state always reflects a scan that started after the last observed
  // event, so a hot-plug event during a follow-up scan is never silently
  // lost. It cannot loop forever on its own: only a genuinely new external
  // event (a real broadcast, or another caller) re-arms it, so it always
  // stops once hot-plug activity stops.
  const scanInFlightRef = useRef(false);
  const rescanQueuedRef = useRef(false);

  // deferredRescanRef records "an attach event arrived while scanning was
  // ineligible due to isBusy/isConnected" - a different deferral than
  // rescanQueuedRef above (which only ever applies to a scan already in
  // flight). It is consumed - cleared - the moment a real scan actually
  // starts, regardless of what triggered that scan (the watcher effect
  // below, a manual تحديث press, or anything else), so it can never cause
  // a stale extra scan later. It is never set or read directly from JSX;
  // handleRefresh and the watcher effect are its only two touchpoints.
  const deferredRescanRef = useRef(false);

  const handleRefresh = useCallback(async () => {
    if (scanInFlightRef.current) {
      rescanQueuedRef.current = true;
      return;
    }
    if (isBusy || isConnected) {
      // Not safe to enumerate right now (mid connect/disconnect, or an
      // active connection) - hot-plug must never disturb it, and this
      // mirrors the manual تحديث button's own refreshDisabled guard. Record
      // that a scan is owed instead of silently dropping it - the watcher
      // effect below runs it once eligibility is regained.
      deferredRescanRef.current = true;
      return;
    }
    deferredRescanRef.current = false;
    scanInFlightRef.current = true;
    try {
      do {
        rescanQueuedRef.current = false;
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
      } while (rescanQueuedRef.current && mountedRef.current);
    } finally {
      scanInFlightRef.current = false;
    }
  }, [client, t, isBusy, isConnected]);

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

  // Runs a deferred rescan (see deferredRescanRef above) the moment the
  // screen becomes eligible to scan again - i.e. whenever isBusy/isConnected
  // change and neither is true anymore. Re-checks eligibility through
  // handleRefresh's own guard rather than trusting this effect's own timing
  // - handleRefresh is the single source of truth for whether a scan may
  // actually run, and for clearing the flag once one does. Effects never
  // fire after unmount, so a deferred flag left pending at unmount is
  // simply never consumed - no stale work follows.
  useEffect(() => {
    if (!isBusy && !isConnected && deferredRescanRef.current) {
      handleRefresh();
    }
  }, [isBusy, isConnected, handleRefresh]);

  // handleRefresh's identity changes with isBusy/isConnected, but the
  // hot-plug subscriptions below must be created exactly once per mounted
  // screen instance (re-subscribing on every connectionState change would
  // both violate "subscribe once" and momentarily drop events between an
  // unsubscribe/resubscribe pair). This ref always exposes the latest
  // handleRefresh to the stable listeners without making them a dependency.
  const handleRefreshRef = useRef(handleRefresh);
  useEffect(() => {
    handleRefreshRef.current = handleRefresh;
  }, [handleRefresh]);

  // Subscribes to native USB hot-plug events exactly once per mounted
  // screen instance; unsubscribes on unmount. Intentionally depends only on
  // `client` (stable across the component's life) - see handleRefreshRef
  // above for why handleRefresh itself must not be a dependency here.
  useEffect(() => {
    const unsubscribeAttached = client.onDeviceAttached(() => {
      if (!mountedRef.current) {
        return;
      }
      dispatch({type: 'DEVICE_ATTACHED_LOG'});
      handleRefreshRef.current();
    });
    const unsubscribeDetached = client.onDeviceDetached(identity => {
      if (!mountedRef.current) {
        return;
      }
      dispatch({type: 'DEVICE_DETACHED', identity});
    });
    const unsubscribeSessionDetached = client.onSessionDetached(event => {
      if (!mountedRef.current) {
        return;
      }
      dispatch({type: 'SESSION_DETACHED', sessionId: event.sessionId});
    });
    return () => {
      unsubscribeAttached();
      unsubscribeDetached();
      unsubscribeSessionDetached();
    };
  }, [client]);

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
      // Pass 6.4b: the only place a sessionId ever becomes known - see
      // MspSessionCoordinator.ts's own doc comment. Only a construction
      // failure (MspOwnershipActivationError) is treated as a real
      // connection-level failure below; identification runs fire-and-
      // forget afterward and never affects this dispatch either way.
      mspSessionCoordinator.openSession(client, sessionId);
      // Pass 7.1: openSession() above commits its session entry
      // synchronously before returning (see its own doc comment), so
      // getSessionKey() is always defined here - the `if` is a defensive
      // invariant, not an expected-false branch. A push, never
      // replace/reset: the user can still navigate back to this exact
      // connected state. navigation is only absent in tests that render
      // this screen standalone (see the Props doc comment above).
      const sessionKey = mspSessionCoordinator.getSessionKey(sessionId);
      if (sessionKey) {
        navigation?.navigate('Setup', {sessionKey});
      }
      dispatch({type: 'CONNECT_SUCCESS', sessionId});
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      // MspOwnershipActivationError does not carry {code, nativeMessage} -
      // re-wrapped as one so it can flow through the exact same
      // localizeTransportError() mechanism openDevice() failures already
      // use. Unlike a genuinely unpredictable NATIVE error code,
      // MSP_ACTIVATION_FAILED is a code THIS layer mints itself (see
      // MspOwnershipActivationError/KNOWN_ERROR_CODES in
      // transportErrors.ts) - it has its own dedicated, real Arabic
      // translation (ar.json), not a fallback to 'errors.UNKNOWN'.
      const transportError: TransportError =
        error instanceof MspOwnershipActivationError
          ? {code: 'MSP_ACTIVATION_FAILED', nativeMessage: error.message}
          : (error as TransportError);
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
    navigation,
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
      // Pass 6.4b: intentional-close hook point, paired with openSession()
      // in handleConnect() above - see MspSessionCoordinator.ts's own doc
      // comment on why this must run BEFORE DISCONNECT_SUCCESS dispatches.
      mspSessionCoordinator.deactivateMspSession(sessionId);
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

        {/* DEBUG-ONLY (Pass 5.4, isolated in Pass 7.7): absent from every
            production bundle - DevAppLogPanel is undefined there. */}
        {DevAppLogPanel ? <DevAppLogPanel /> : null}

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

        {state.hotplugMessageKey ? (
          <View style={styles.hotplugBanner} accessibilityRole="text">
            <Text style={styles.hotplugBannerText}>
              {t(
                state.hotplugMessageKey === 'deviceDetached'
                  ? 'devices.deviceDetached'
                  : 'devices.sessionDetachedDuringConnection',
              )}
            </Text>
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

        {/* DEBUG-ONLY (Pass 5.3, isolated in Pass 7.7): same __DEV__ gate. */}
        {DevSerialPanel && isConnected && state.activeSessionId ? (
          <DevSerialPanel
            sessionId={state.activeSessionId}
            client={client}
            // Pass 6.4b: the real, reactive value - derived from
            // useMspOwnershipState() above, which now correctly flips true
            // at ACTIVATING (before construction even completes), not just
            // once ACTIVE.
            mspActive={mspActive}
          />
        ) : null}

        {/* SINGLE-APP MERGE: the development-only motor-test entry that
            used to sit here is GONE - the control itself, not just its
            import. Motors is a tab in the main shell now, so leaving this
            pressable would be a SECOND, ungoverned way in: it navigated
            straight to the screen from the connection screen, bypassing
            the shell that owns which tab is active and that fires the
            lifecycle bridge's blur source when the operator leaves Motors.
            This screen's job ends at handing the session key to 'Setup'. */}

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
  hotplugBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
    borderRadius: 4,
    backgroundColor: colors.surfaceAlt,
  },
  hotplugBannerText: {
    ...typography.body,
    color: colors.warning,
  },
});
