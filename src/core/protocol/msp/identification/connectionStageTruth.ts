/**
 * WHAT ACTUALLY FAILED, IN THE OPERATOR'S TERMS.
 *
 * Connecting to a flight controller is four separate facts, and the
 * product used to collapse them into one sentence:
 *
 *   1. USB DETECTED    - a device is physically on the bus
 *   2. TRANSPORT OPEN  - a serial port was opened on it
 *   3. MSP RESPONDING  - the firmware answered the protocol
 *   4. FC IDENTIFIED   - it told us what board it is
 *
 * Saying "no flight controller found" when a USB device WAS found - it
 * simply had no usable driver, or stayed silent, or answered with an
 * empty board name - sends the operator to check their cable when the
 * real answer is somewhere else entirely. These stages name the first
 * one that did not hold, and nothing here depends on the board's brand.
 */

export type ConnectionStage =
  /** Nothing at all is attached. */
  | 'NO_USB_DEVICE'
  /** USB devices exist, but none exposes a serial interface we can drive. */
  | 'USB_WITHOUT_SERIAL_DRIVER'
  /** More than one candidate; picking one for the operator is not safe. */
  | 'MULTIPLE_USB_DEVICES'
  /** The board has more ports than we can choose between automatically. */
  | 'MULTIPLE_PORTS'
  /** The port could not be opened (permission, busy, driver). */
  | 'TRANSPORT_OPEN_FAILED'
  /** Opened, but the firmware never answered MSP. */
  | 'MSP_NOT_RESPONDING'
  /** Answered, but with an MSP API older than this app supports. */
  | 'MSP_INCOMPATIBLE'
  /** Answered, but its board metadata carried no usable name. */
  | 'BOARD_METADATA_INCOMPLETE'
  /** Everything held. */
  | 'IDENTIFIED';

export type ConnectionStageEvidence = {
  /** USB devices visible to the platform, before any driver filtering. */
  readonly usbDeviceCount: number;
  /** Of those, the ones exposing a serial interface we can open. */
  readonly serialCapableCount: number;
  /** Ports on the chosen device, when one was chosen. */
  readonly portCount?: number;
  readonly transportOpened?: boolean;
  readonly mspResponded?: boolean;
  readonly mspCompatible?: boolean;
  /** Whether MSP_BOARD_INFO produced at least one usable board name. */
  readonly boardNamed?: boolean;
};

/**
 * The FIRST stage that did not hold. Order matters: each stage can only
 * be judged once the previous one held, so a silent board is never
 * reported as a missing board.
 */
export function classifyConnectionStage(evidence: ConnectionStageEvidence): ConnectionStage {
  if (evidence.usbDeviceCount <= 0) {
    return 'NO_USB_DEVICE';
  }
  if (evidence.serialCapableCount <= 0) {
    // A device IS attached - it just is not something we can open as a
    // serial port. Telling the operator "nothing found" here was the
    // misleading message this type exists to prevent.
    return 'USB_WITHOUT_SERIAL_DRIVER';
  }
  if (evidence.serialCapableCount > 1) {
    return 'MULTIPLE_USB_DEVICES';
  }
  if (evidence.portCount !== undefined && evidence.portCount > 1) {
    return 'MULTIPLE_PORTS';
  }
  if (evidence.transportOpened === false) {
    return 'TRANSPORT_OPEN_FAILED';
  }
  if (evidence.mspResponded === false) {
    return 'MSP_NOT_RESPONDING';
  }
  if (evidence.mspCompatible === false) {
    return 'MSP_INCOMPATIBLE';
  }
  if (evidence.boardNamed === false) {
    return 'BOARD_METADATA_INCOMPLETE';
  }
  return 'IDENTIFIED';
}

/**
 * THE SEVEN-STAGE CLASSIFICATION, AND WHERE THE GATE ACTUALLY IS.
 *
 *   1. USB/serial device available
 *   2. port permission granted
 *   3. port opened
 *   4. MSP responding
 *   5. supported FC firmware identified
 *   -------------------------------------- entry to configuration
 *   6. board metadata available
 *   7. official target catalogue matched
 *
 * Stages 1-5 are protocol truth and they alone decide whether the operator
 * may enter normal flight-controller configuration. Stages 6 and 7 enrich
 * the experience - they name the board and match it to the firmware
 * catalogue - and they must never block a controller that satisfied 1-5.
 *
 * That separation is the whole point: a board from a vendor this project
 * has never heard of, or one whose BOARD_INFO is short or silent, answers
 * the protocol correctly and is a working flight controller. Only features
 * that genuinely need a known target may ask for a manual selection.
 */
export function canEnterConfiguration(stage: ConnectionStage): boolean {
  return stage === 'IDENTIFIED' || stage === 'BOARD_METADATA_INCOMPLETE';
}

/** The i18n key carrying each stage's operator sentence. */
export function connectionStageLabelKey(stage: ConnectionStage): string {
  return `connectionStage.${stage}`;
}
