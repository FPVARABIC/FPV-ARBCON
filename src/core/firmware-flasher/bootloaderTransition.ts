/**
 * AUTOMATIC REBOOT-TO-BOOTLOADER: the truthful state model.
 *
 * THE GAP THIS CLOSES. The automatic transition was real but only
 * seamless when the re-enumerated DFU identity had ALREADY been
 * authorized in this browser: `listDfuDevices()` is
 * `navigator.usb.getDevices()`, which lists authorized devices only. On a
 * first flash the MSP reboot succeeded, the serial device disappeared,
 * the new DFU identity was invisible to the poll, and the operation ran
 * out its wait and failed - while the one control that could have asked
 * for permission was disabled because a flash was "busy".
 *
 * Browser security is NOT bypassed here and must never be: WebUSB
 * requires a user gesture for `requestDevice()`. What changes is that the
 * app now STOPS SAFELY and asks, instead of timing out.
 *
 * PURE. No transport, no WebUSB, no timers, no commands. It classifies a
 * transition and verifies a selected device against what the pending
 * operation expects, so both are testable without hardware.
 */

/** Every outcome the operator may be shown. No state means "probably". */
export type BootloaderTransitionState =
  /** The reboot was sent, the DFU device appeared and was authorized. */
  | 'COMPLETED'
  /** The device is expected to be there, but the browser must ask the
   * operator to pick it. The prepared flash is held, not restarted. */
  | 'WAITING_FOR_PERMISSION'
  /** This firmware exposes no supported reboot-to-bootloader. */
  | 'MANUAL_REQUIRED'
  /** Something appeared, but it is not what this operation expects. */
  | 'UNEXPECTED_DEVICE'
  /** Nothing re-enumerated inside the bounded wait. */
  | 'ENUMERATION_TIMEOUT'
  /** The operator granted permission and the held flash continued. */
  | 'RESUMED_AFTER_PERMISSION'
  /** Stopped without flashing, for a stated reason. */
  | 'FAILED_SAFELY';

/** What a held operation remembers so it can be resumed rather than redone. */
export interface PendingBootloaderFlash {
  /** Identifies this exact prepared operation; a resume must match it. */
  readonly operationId: string;
  /** The target the operator selected and the app already verified. */
  readonly expectedTarget: string;
  /** Set once the MSP reboot has actually been sent, so a resume can
   * never send it a second time. */
  readonly rebootAlreadySent: boolean;
  /** Set once any erase or write has begun. A resume must refuse rather
   * than repeat destructive work. */
  readonly writeAlreadyStarted: boolean;
}

/** The minimum a DFU descriptor must expose to be verifiable. */
export interface DfuIdentity {
  readonly vendorId: number;
  readonly productId: number;
  readonly interfaceNumber?: number;
  readonly memoryLayout?: string;
}

/** STM32's DFU identity. Betaflight Configurator uses the same pair. */
export const STM32_DFU_VENDOR_ID = 0x0483;
export const STM32_DFU_PRODUCT_ID = 0xdf11;

export type DfuVerification =
  | {readonly ok: true}
  | {readonly ok: false; readonly reason: DfuRejectionReason};

export type DfuRejectionReason =
  | 'WRONG_VENDOR_OR_PRODUCT'
  | 'NO_DFU_INTERFACE'
  | 'NO_MEMORY_LAYOUT'
  | 'STALE_OPERATION';

/**
 * Whether a device the operator just picked may be flashed by the held
 * operation.
 *
 * Refuses explicitly rather than proceeding on a guess: an operator who
 * picks the wrong device in the browser's chooser must be told, not have
 * their peripheral erased. The memory-layout requirement is the same one
 * webUsbDfu already enforces before the first erase - a device that
 * declares no layout is refused rather than assumed.
 */
export function verifySelectedDfuDevice(
  device: DfuIdentity | null | undefined,
  pending: PendingBootloaderFlash,
  resumeOperationId: string,
): DfuVerification {
  if (pending.operationId !== resumeOperationId) {
    return {ok: false, reason: 'STALE_OPERATION'};
  }
  if (device === null || device === undefined) {
    return {ok: false, reason: 'WRONG_VENDOR_OR_PRODUCT'};
  }
  if (
    device.vendorId !== STM32_DFU_VENDOR_ID ||
    device.productId !== STM32_DFU_PRODUCT_ID
  ) {
    return {ok: false, reason: 'WRONG_VENDOR_OR_PRODUCT'};
  }
  if (device.interfaceNumber === undefined) {
    return {ok: false, reason: 'NO_DFU_INTERFACE'};
  }
  if (device.memoryLayout === undefined || device.memoryLayout.length === 0) {
    return {ok: false, reason: 'NO_MEMORY_LAYOUT'};
  }
  return {ok: true};
}

/**
 * Whether a held operation may be resumed at all.
 *
 * A resume continues a PREPARED flash. It must never re-send the reboot
 * (the board is already in DFU) and must never restart destructive work
 * that already began.
 */
export function canResumePendingFlash(
  pending: PendingBootloaderFlash,
): {readonly resumable: boolean; readonly reason?: 'WRITE_ALREADY_STARTED'} {
  if (pending.writeAlreadyStarted) {
    return {resumable: false, reason: 'WRITE_ALREADY_STARTED'};
  }
  return {resumable: true};
}

/** The i18n key for a state. One place, so no screen invents wording. */
export function bootloaderStateLabelKey(state: BootloaderTransitionState): string {
  return `firmwareFlasher.bootloader.${state}`;
}

/** The i18n key for a refusal reason. */
export function dfuRejectionLabelKey(reason: DfuRejectionReason): string {
  return `firmwareFlasher.dfuRejected.${reason}`;
}
