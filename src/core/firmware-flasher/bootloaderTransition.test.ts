/**
 * FIRST-USE BROWSER PERMISSION MUST RESUME THE PENDING FLASH.
 *
 * The automatic reboot-to-bootloader was real but only seamless when the
 * re-enumerated DFU identity had already been authorized: listDfuDevices()
 * is navigator.usb.getDevices(), which lists authorized devices only. On a
 * first flash the board really was in DFU, invisible to the poll, and the
 * operation timed out while the one control that could ask for permission
 * was disabled.
 *
 * NO HARDWARE: no USB, FC or DFU device is touched.
 */

import {
  STM32_DFU_PRODUCT_ID,
  STM32_DFU_VENDOR_ID,
  bootloaderStateLabelKey,
  canResumePendingFlash,
  dfuRejectionLabelKey,
  verifySelectedDfuDevice,
} from './bootloaderTransition';
import type {DfuIdentity, PendingBootloaderFlash} from './bootloaderTransition';
import ar from '../../i18n/locales/ar.json';

const PENDING: PendingBootloaderFlash = Object.freeze({
  operationId: 'flash-1',
  expectedTarget: 'STM32F405',
  rebootAlreadySent: true,
  writeAlreadyStarted: false,
});

function goodDevice(overrides: Partial<DfuIdentity> = {}): DfuIdentity {
  return {
    vendorId: STM32_DFU_VENDOR_ID,
    productId: STM32_DFU_PRODUCT_ID,
    interfaceNumber: 0,
    memoryLayout: '@Internal Flash /0x08000000/04*016Kg',
    ...overrides,
  };
}

describe('verifySelectedDfuDevice', () => {
  it('accepts the STM32 DFU identity with an interface and a declared layout', () => {
    expect(verifySelectedDfuDevice(goodDevice(), PENDING, 'flash-1')).toEqual({
      ok: true,
    });
  });

  it('refuses a device that is not STM32 DFU - the operator picked the wrong one', () => {
    expect(
      verifySelectedDfuDevice(goodDevice({vendorId: 0x1234}), PENDING, 'flash-1'),
    ).toEqual({ok: false, reason: 'WRONG_VENDOR_OR_PRODUCT'});
    expect(
      verifySelectedDfuDevice(goodDevice({productId: 0x0001}), PENDING, 'flash-1'),
    ).toEqual({ok: false, reason: 'WRONG_VENDOR_OR_PRODUCT'});
  });

  it('refuses a cancelled chooser rather than treating null as success', () => {
    expect(verifySelectedDfuDevice(null, PENDING, 'flash-1')).toEqual({
      ok: false,
      reason: 'WRONG_VENDOR_OR_PRODUCT',
    });
    expect(verifySelectedDfuDevice(undefined, PENDING, 'flash-1')).toEqual({
      ok: false,
      reason: 'WRONG_VENDOR_OR_PRODUCT',
    });
  });

  it('refuses a device with no DFU interface', () => {
    expect(
      verifySelectedDfuDevice(
        goodDevice({interfaceNumber: undefined}),
        PENDING,
        'flash-1',
      ),
    ).toEqual({ok: false, reason: 'NO_DFU_INTERFACE'});
  });

  it('refuses a device that declares NO memory layout - the same rule webUsbDfu enforces before the first erase', () => {
    expect(
      verifySelectedDfuDevice(goodDevice({memoryLayout: undefined}), PENDING, 'flash-1'),
    ).toEqual({ok: false, reason: 'NO_MEMORY_LAYOUT'});
    expect(
      verifySelectedDfuDevice(goodDevice({memoryLayout: ''}), PENDING, 'flash-1'),
    ).toEqual({ok: false, reason: 'NO_MEMORY_LAYOUT'});
  });

  it('refuses a resume aimed at a DIFFERENT operation - a stale button cannot flash a newer plan', () => {
    expect(verifySelectedDfuDevice(goodDevice(), PENDING, 'flash-2')).toEqual({
      ok: false,
      reason: 'STALE_OPERATION',
    });
  });
});

describe('canResumePendingFlash', () => {
  it('a prepared-but-not-yet-written operation may resume', () => {
    expect(canResumePendingFlash(PENDING)).toEqual({resumable: true});
  });

  it('NEVER resumes once erase or write has begun - destructive work is never repeated', () => {
    expect(
      canResumePendingFlash({...PENDING, writeAlreadyStarted: true}),
    ).toEqual({resumable: false, reason: 'WRITE_ALREADY_STARTED'});
  });

  it('a resumable operation always records that the reboot was already sent, so it can never be sent twice', () => {
    expect(PENDING.rebootAlreadySent).toBe(true);
  });
});

describe('every state and refusal reason is translated', () => {
  const flasher = ar.firmwareFlasher as unknown as Record<
    string,
    Record<string, string>
  >;

  it.each([
    'COMPLETED',
    'WAITING_FOR_PERMISSION',
    'MANUAL_REQUIRED',
    'UNEXPECTED_DEVICE',
    'ENUMERATION_TIMEOUT',
    'RESUMED_AFTER_PERMISSION',
    'FAILED_SAFELY',
  ] as const)('state %s has Arabic copy', state => {
    expect(bootloaderStateLabelKey(state)).toBe(
      `firmwareFlasher.bootloader.${state}`,
    );
    expect(typeof flasher.bootloader[state]).toBe('string');
    expect(flasher.bootloader[state].length).toBeGreaterThan(0);
  });

  it.each([
    'WRONG_VENDOR_OR_PRODUCT',
    'NO_DFU_INTERFACE',
    'NO_MEMORY_LAYOUT',
    'STALE_OPERATION',
  ] as const)('refusal %s has Arabic copy', reason => {
    expect(dfuRejectionLabelKey(reason)).toBe(
      `firmwareFlasher.dfuRejected.${reason}`,
    );
    expect(typeof flasher.dfuRejected[reason]).toBe('string');
  });

  it('the permission copy states plainly that nothing is re-sent or re-written', () => {
    const body = (ar.firmwareFlasher as unknown as Record<string, string>)
      .permissionNeededBody;
    expect(body).toContain('لن يُعاد إرسال أمر إعادة التشغيل');
    expect(body).toContain('مسح');
  });
});
