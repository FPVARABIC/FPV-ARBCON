/**
 * THE CONNECTION, AS A SERVICE RATHER THAN A DESTINATION.
 *
 * WHAT THIS REPLACES. Connecting used to mean going somewhere: Home ->
 * a connection page -> find the board in a list -> press اتصال -> and
 * only then the configuration workspace. Every step but the last asked
 * the operator to confirm a decision they had already made by pressing
 * the button that got them there, and the page itself kept coming back
 * into the product as a place the application could strand somebody.
 *
 * There is no such page now. This hook performs the whole sequence -
 * chooser, open, MSP activation, identification - while the operator
 * stays on Home, and reports it as one small phase Home can render next
 * to the card they pressed.
 *
 * THE ONE HARD CONSTRAINT, and it dictates the shape of begin():
 * navigator.serial.requestPort() is honoured only inside the user
 * gesture that started it, and ANY await before the call ends that
 * gesture. So begin() is synchronous up to and including the chooser
 * call; everything asynchronous happens in the continuation.
 *
 * WHAT THIS HOOK DOES NOT DO: navigate. Reaching the workspace is the
 * wall's decision (verifiedConnection.ts, App.tsx) - one place decides
 * that a board is real, so there is no window in which two of them
 * disagree.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';

import {
  localizeTransportError,
  usbSerialTransportClient,
} from '../../platforms/react-native/transport';
import type {
  SerialConfiguration,
  TransportError,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';
import {
  MspOwnershipActivationError,
  mspSessionCoordinator,
} from '../../platforms/react-native/protocol';
import {fcRebootRecovery} from '../../platforms/react-native/protocol/fcRebootRecovery';
import {
  beginConnectionTrace,
  getLastConnectionTrace,
} from '../../core/protocol/msp/identification/connectionTrace';
import {recordConnectionStage} from '../../platforms/connectionReport';
import {
  resolveConnectTarget,
  type ConnectOption,
  type ConnectPhase,
} from './connectFlow';
import {useVerifiedFcConnection} from './useVerifiedFcConnection';

/**
 * Owned by the UI, not by the transport defaults: a standard 8N1 with no
 * flow control, the same configuration the connection screen used before
 * it was removed. Unchanged on purpose - this is a rework of WHERE the
 * connection is driven from, not of HOW the port is opened.
 */
const SERIAL_CONFIGURATION: SerialConfiguration = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: '1',
  parity: 'none',
  flowControl: 'off',
};

/**
 * How long identification may run before Home stops waiting.
 *
 * A spinner with no end is the failure mode this bounds. The coordinator
 * has its own per-request timeouts and normally reports FAILED long
 * before this fires; this exists for the case where it reports nothing
 * at all.
 */
const IDENTIFY_DEADLINE_MS = 20_000;

export type DirectConnect = {
  readonly phase: ConnectPhase;
  /** Press "إعداد الدرون" with no verified board. MUST be called from
   *  the operator's own gesture - see the header note on requestPort. */
  readonly begin: () => void;
  /** Operator picked one entry out of an ambiguous bench. */
  readonly choose: (option: ConnectOption) => void;
  /** Dismiss a failure or an open picker. Opens nothing, closes nothing
   *  at the transport level - there is no session yet to close. */
  readonly dismiss: () => void;
};

/**
 * A session that is ALREADY live is adopted rather than duplicated.
 *
 * Back out of the workspace deliberately does not deactivate the session
 * (a port the operator is still using must not close because they looked
 * at Home), so re-entering has to reattach instead of opening a second
 * port against the same hardware.
 *
 * A key with no sessionId names nothing. Adopting one is not harmless
 * optimism - it was an infinite loop: the malformed key went into the
 * route, the redirect read it back, found the ownership of `undefined`
 * reported INACTIVE, and reset straight back here forever.
 */
function adoptLiveSession(): string | null {
  for (const sessionId of mspSessionCoordinator.listSessionIds()) {
    if (mspSessionCoordinator.getOwnershipState(sessionId) === 'INACTIVE') {
      continue;
    }
    const key = mspSessionCoordinator.getSessionKey(sessionId);
    if (typeof key?.sessionId === 'string' && key.sessionId.length > 0) {
      return key.sessionId;
    }
  }
  return null;
}

export function useDirectConnect(
  client: UsbSerialTransportClient = usbSerialTransportClient,
): DirectConnect {
  const {t} = useTranslation();
  const [phase, setPhase] = useState<ConnectPhase>({kind: 'IDLE'});
  const connection = useVerifiedFcConnection();

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Guards re-entry: a second press while a chooser is open must not
   *  open a second chooser, and a double tap must not open two ports. */
  const busyRef = useRef(false);
  /**
   * The session this attempt is waiting on.
   *
   * Watching THIS id rather than the aggregate "is anything connected?"
   * verdict is deliberate. The aggregate is read through
   * useSyncExternalStore, so immediately after openSession() commits its
   * entry the hook may still be holding the previous snapshot - and a
   * failure effect keyed on that would declare a perfectly good
   * connection dead one render after opening it.
   */
  const awaitingRef = useRef<string | null>(null);
  const settle = useCallback((next: ConnectPhase) => {
    if (!mountedRef.current) return;
    busyRef.current = next.kind !== 'IDLE' && next.kind !== 'FAILED';
    setPhase(next);
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      /* MspOwnershipActivationError does not carry {code, nativeMessage},
         so it is re-wrapped as one and flows through the same Arabic
         localization every transport failure already uses. The code is
         one this layer mints itself and has its own real translation -
         it is not a fallback to "unknown". */
      const transportError: TransportError =
        error instanceof MspOwnershipActivationError
          ? {code: 'MSP_ACTIVATION_FAILED', nativeMessage: error.message}
          : (error as TransportError);
      recordConnectionStage('CONNECT_FAILED', {code: transportError.code});
      settle({
        kind: 'FAILED',
        message: localizeTransportError(t, transportError),
      });
    },
    [settle, t],
  );

  /** Open one port and hand the session to the coordinator. */
  const openOption = useCallback(
    async (option: ConnectOption) => {
      settle({kind: 'OPENING'});
      recordConnectionStage('CONNECT_PRESSED', {
        vendorId: option.device.vendorId,
        productId: option.device.productId,
        portIndex: option.portIndex,
      });
      const trace = getLastConnectionTrace() ?? beginConnectionTrace();
      const sessionId = await client.openDevice(
        option.device.deviceId,
        option.portIndex,
        SERIAL_CONFIGURATION,
      );
      if (!mountedRef.current) return;
      /* The only place a sessionId ever becomes known. openSession()
         commits its entry synchronously and chains identification; the
         wall watches that, not this call's return. */
      mspSessionCoordinator.openSession(client, sessionId);
      recordConnectionStage('MSP_SESSION_ACTIVATED', {sessionId});
      trace.reached('SERIAL_PORT_OPENED', sessionId);
      /* A live session exists again. If this was the tail of a reboot
         the application itself asked for, that lifecycle ends here. */
      fcRebootRecovery.noteRecovered();
      awaitingRef.current = sessionId;
      settle({kind: 'IDENTIFYING'});
    },
    [client, settle],
  );

  /** Enumerate, then either open or ask. */
  const openFromScan = useCallback(
    async (authorized?: {vendorId: number; productId: number} | null) => {
      settle({kind: 'OPENING'});
      const devices = await client.listDevices();
      if (!mountedRef.current) return;
      const target = resolveConnectTarget(devices, authorized);
      if (target.kind === 'NONE') {
        settle({kind: 'FAILED', message: t('directConnect.noBoard')});
        return;
      }
      if (target.kind === 'AMBIGUOUS') {
        settle({kind: 'PICKING', options: target.options});
        return;
      }
      await openOption(target.option);
    },
    [client, openOption, settle, t],
  );

  const begin = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;

    /* Already live: reattach. The wall opens the workspace off the same
       coordinator state, so there is nothing to do but wait for it. */
    const adopted = adoptLiveSession();
    if (adopted !== null) {
      awaitingRef.current = adopted;
      settle({kind: 'IDENTIFYING'});
      return;
    }

    /* SYNCHRONOUS UP TO HERE. Everything above is a coordinator read;
       nothing has awaited, so the operator's gesture is still live and
       the browser will honour the chooser. */
    const supportsPicker =
      typeof client.supportsDevicePicker === 'function' &&
      client.supportsDevicePicker();

    if (!supportsPicker) {
      /* Android: there is no chooser. The system raises its own
         permission dialog during open(), which is not gesture-bound. */
      openFromScan(null).catch(fail);
      return;
    }

    const trace = getLastConnectionTrace() ?? beginConnectionTrace();
    trace.reached(
      'SERIAL_CHOOSER_OPENED',
      'requestPort() invoked from the operator gesture',
    );
    settle({kind: 'CHOOSING'});
    client
      .requestDevicePermission()
      .then(device => {
        if (!mountedRef.current) return;
        if (device === null) {
          /* A dismissed chooser is a decision, not a failure, and above
             all it is not "this flight controller is unsupported". The
             operator stays on Home with nothing to dismiss. */
          trace.note('chooser dismissed by the operator - no device selected');
          settle({kind: 'IDLE'});
          return;
        }
        trace.reached(
          'SERIAL_PORT_SELECTED',
          `vid=0x${device.vendorId.toString(16)} pid=0x${device.productId.toString(16)}`,
        );
        return openFromScan({
          vendorId: device.vendorId,
          productId: device.productId,
        });
      })
      .catch(fail);
  }, [client, fail, openFromScan, settle]);

  const choose = useCallback(
    (option: ConnectOption) => {
      openOption(option).catch(fail);
    },
    [fail, openOption],
  );

  const dismiss = useCallback(() => {
    awaitingRef.current = null;
    settle({kind: 'IDLE'});
  }, [settle]);

  /**
   * IDENTIFICATION HAS TO END, one way or the other.
   *
   * Without this the card spins forever on a board that has already said
   * it cannot be read - the exact failure mode "no spinner that never
   * ends" forbids. Two endings are real failures and both are read off
   * the session this attempt actually opened:
   *
   *   the board was read and could not be understood  -> FAILED
   *   the link died before it answered at all         -> FAILED
   *
   * Success needs nothing here: the wall sees the same coordinator state
   * and opens the workspace, which unmounts Home.
   *
   * `connection` is the re-evaluation trigger, not the evidence - it
   * changes whenever ownership or identification does, which is exactly
   * when this question is worth re-asking.
   */
  useEffect(() => {
    const sessionId = awaitingRef.current;
    if (phase.kind !== 'IDENTIFYING' || sessionId === null) return undefined;
    const identification =
      mspSessionCoordinator.getIdentificationState(sessionId);
    if (identification.status === 'FAILED') {
      awaitingRef.current = null;
      settle({kind: 'FAILED', message: t('directConnect.identifyFailed')});
      return undefined;
    }
    if (mspSessionCoordinator.getOwnershipState(sessionId) === 'INACTIVE') {
      awaitingRef.current = null;
      settle({kind: 'FAILED', message: t('directConnect.identifyFailed')});
      return undefined;
    }
    const timer = setTimeout(() => {
      awaitingRef.current = null;
      settle({kind: 'FAILED', message: t('directConnect.identifyTimeout')});
    }, IDENTIFY_DEADLINE_MS);
    return () => clearTimeout(timer);
    // `connection` is a trigger, not evidence: it changes whenever
    // ownership or identification does, which is exactly when this
    // question is worth re-asking. The evidence is read fresh above.
  }, [connection, phase.kind, settle, t]);

  return {phase, begin, choose, dismiss};
}
