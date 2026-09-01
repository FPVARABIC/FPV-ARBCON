/**
 * OPENING A PORT AND HANDING IT TO THE COORDINATOR - the one copy.
 *
 * Two callers need this exact sequence and they must not drift: the
 * operator pressing "إعداد الدرون" on Home (useDirectConnect) and the
 * application reopening a board it asked to reboot
 * (useRebootReconnect). A second, subtly different open path is how a
 * session ends up registered without a trace, or traced without being
 * registered.
 *
 * It deliberately does NOT decide anything: which board, whether to ask,
 * what to show. It opens the one it is given and returns the sessionId.
 */

import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import type {
  SerialConfiguration,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';
import {
  beginConnectionTrace,
  getLastConnectionTrace,
} from '../../core/protocol/msp/identification/connectionTrace';
import {recordConnectionStage} from '../../platforms/connectionReport';
import type {ConnectOption} from './connectFlow';

/**
 * Owned by the UI, not by the transport defaults: a standard 8N1 with no
 * flow control, unchanged from the connection screen that used to hold
 * it. This is a rework of WHERE the connection is driven from, not of
 * HOW the port is opened.
 */
export const SERIAL_CONFIGURATION: SerialConfiguration = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: '1',
  parity: 'none',
  flowControl: 'off',
};

/**
 * Opens the port, registers the session, and closes the reboot
 * lifecycle if one was running. Returns the sessionId the coordinator
 * now owns; throws whatever the transport threw.
 */
export async function openBoard(
  client: UsbSerialTransportClient,
  option: ConnectOption,
): Promise<string> {
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
  /* The only place a sessionId ever becomes known. openSession() commits
     its entry synchronously and chains identification; the wall watches
     that, not this call's return. */
  mspSessionCoordinator.openSession(client, sessionId);
  recordConnectionStage('MSP_SESSION_ACTIVATED', {sessionId});
  trace.reached('SERIAL_PORT_OPENED', sessionId);
  /*
   * DELIBERATELY DOES NOT END THE REBOOT LIFECYCLE.
   *
   * An open port is not a recovered flight controller. A board can
   * enumerate, accept the port, and then fail to identify - and calling
   * this recovery would drop the deadline exactly when the remaining
   * wait becomes unbounded. The two callers decide for themselves when
   * their own operation is over; see useRebootReconnect, which waits
   * for a VERIFIED session and keeps the deadline running until it.
   */
  return sessionId;
}
