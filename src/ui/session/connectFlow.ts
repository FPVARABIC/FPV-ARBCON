/**
 * CONNECTING, WITHOUT A PAGE TO CONNECT ON.
 *
 * There is no connection screen any more. Pressing "إعداد الدرون" on Home
 * opens the board chooser, opens the port, waits for identification and
 * lands the operator in the configuration workspace - and every visible
 * step of that happens on Home. This module is the part of it that is
 * pure: which board to open, and what a failure is called.
 *
 * WHY IT IS SPLIT OUT AT ALL. The rules below are the ones that used to
 * live in a 1300-line screen's reducer, where "is this bench ambiguous?"
 * could only be answered by rendering it. They are decisions, not
 * pixels, so they are tested as decisions.
 */

import type {UsbSerialDeviceDescriptor} from '../../platforms/react-native/transport';

/** One openable thing: a supported board and one of its ports. */
export type ConnectOption = {
  readonly device: UsbSerialDeviceDescriptor;
  readonly portIndex: number;
};

export type ConnectTarget =
  /** Exactly one thing to open. Open it without asking. */
  | {readonly kind: 'ONE'; readonly option: ConnectOption}
  /** Nothing openable is present. */
  | {readonly kind: 'NONE'}
  /** A real choice the operator has to make. */
  | {readonly kind: 'AMBIGUOUS'; readonly options: readonly ConnectOption[]};

/**
 * The phase Home shows while a connection is being made. Deliberately
 * SMALL: an operator watching a card wants to know whether to keep
 * waiting, not to read a state machine.
 */
export type ConnectPhase =
  /** Nothing in flight. */
  | {readonly kind: 'IDLE'}
  /** The browser's own board chooser is open. */
  | {readonly kind: 'CHOOSING'}
  /** A port is being opened. */
  | {readonly kind: 'OPENING'}
  /** The link is up and the board is being asked what it is. */
  | {readonly kind: 'IDENTIFYING'}
  /** More than one board on the bench - the operator picks. */
  | {readonly kind: 'PICKING'; readonly options: readonly ConnectOption[]}
  /** Something went wrong, in one Arabic sentence. */
  | {readonly kind: 'FAILED'; readonly message: string};

/**
 * A device is openable when the transport recognized its driver AND
 * reported a usable port. Support is never inferred from product text or
 * from VID/PID - the same invariant isSupportedDevice() enforces, kept
 * here so this module can be tested without the transport singleton.
 */
const UNSUPPORTED_DRIVER_TYPE = 'UNSUPPORTED';

function isOpenable(device: UsbSerialDeviceDescriptor): boolean {
  return device.driverType !== UNSUPPORTED_DRIVER_TYPE && device.portCount > 0;
}

/** Every port of every supported board, in enumeration order. */
export function connectOptions(
  devices: readonly UsbSerialDeviceDescriptor[],
): ConnectOption[] {
  const options: ConnectOption[] = [];
  for (const device of devices) {
    if (!isOpenable(device)) continue;
    for (let portIndex = 0; portIndex < device.portCount; portIndex += 1) {
      options.push({device, portIndex});
    }
  }
  return options;
}

/**
 * WHAT TO OPEN.
 *
 * `authorized` is the board the operator just picked in the browser's
 * own chooser, when there was one. It is matched rather than trusted
 * outright: getPorts() is the single source of truth for what is
 * actually authorized, and a device that appeared only because
 * requestPort() returned it is one the ordinary scan cannot confirm.
 *
 * A board the operator explicitly chose is never AMBIGUOUS against the
 * others on the bench - they chose. It can still be ambiguous against
 * ITSELF when it exposes more than one port, and that is a real
 * question with no safe default.
 */
export function resolveConnectTarget(
  devices: readonly UsbSerialDeviceDescriptor[],
  authorized?: {readonly vendorId: number; readonly productId: number} | null,
): ConnectTarget {
  const all = connectOptions(devices);
  const options =
    authorized == null
      ? all
      : all.filter(
          option =>
            option.device.vendorId === authorized.vendorId &&
            option.device.productId === authorized.productId,
        );
  if (options.length === 0) return {kind: 'NONE'};
  if (options.length === 1) return {kind: 'ONE', option: options[0]};
  return {kind: 'AMBIGUOUS', options};
}

/** A stable identity for a listed option, for keys and for selection. */
export function connectOptionId(option: ConnectOption): string {
  return `${option.device.deviceId}:${option.portIndex}`;
}

/**
 * The label an operator reads when they have to choose. Product name
 * when the device reports one, VID:PID when it does not - never an
 * invented friendly name for hardware we cannot identify yet.
 */
export function describeConnectOption(
  option: ConnectOption,
  multiplePorts: boolean,
): string {
  const {device, portIndex} = option;
  const name =
    typeof device.productName === 'string' && device.productName.length > 0
      ? device.productName
      : `USB ${device.vendorId.toString(16).padStart(4, '0')}:${device.productId
          .toString(16)
          .padStart(4, '0')}`;
  return multiplePorts ? `${name} — منفذ ${portIndex + 1}` : name;
}
