// The screen module reaches the USB transport at import time; without
// this mock the suite cannot even load under Jest (proven by Android
// validation run #116, where exactly that happened on CI).
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import {
  defaultStableRelease,
  simpleFailurePresentation,
  simpleFlasherNavigationLocked,
} from './FirmwareFlasherSimpleScreen';
import type {FirmwareRelease} from '../../core/firmware-flasher';

function release(
  value: string,
  channel: FirmwareRelease['channel'],
): FirmwareRelease {
  return {
    release: value,
    channel,
  } as FirmwareRelease;
}

describe('FirmwareFlasherSimpleScreen product contracts', () => {
  it('selects a stable release and never silently falls back to RC/development', () => {
    expect(defaultStableRelease([
      release('4.7.0-RC1', 'candidate'),
      release('4.6.0', 'stable'),
      release('4.8.0-dev', 'development'),
    ])).toBe('4.6.0');

    expect(defaultStableRelease([
      release('4.7.0-RC1', 'candidate'),
      release('4.8.0-dev', 'development'),
    ])).toBe('');
  });

  it('locks navigation during every destructive/prepared transition, including DFU permission hold', () => {
    expect(simpleFlasherNavigationLocked('detecting')).toBe(true);
    expect(simpleFlasherNavigationLocked('loading')).toBe(true);
    expect(simpleFlasherNavigationLocked('waiting-permission')).toBe(true);
    expect(simpleFlasherNavigationLocked('flashing')).toBe(true);

    expect(simpleFlasherNavigationLocked('idle')).toBe(false);
    expect(simpleFlasherNavigationLocked('ready')).toBe(false);
    expect(simpleFlasherNavigationLocked('success')).toBe(false);
    expect(simpleFlasherNavigationLocked('failed')).toBe(false);
    expect(simpleFlasherNavigationLocked('unconfirmed')).toBe(false);
  });
});
describe('simpleFailurePresentation maps rejections onto the shared truth contract', () => {
  const translate = (key: string, options?: {defaultValue: string}) =>
    options?.defaultValue !== undefined ? `${key}|${options.defaultValue}` : key;

  it('shows engine UNCONFIRMED codes as the honest third result with a next action', () => {
    const presentation = simpleFailurePresentation(
      {code: 'DFU_COMPLETION_UNCONFIRMED_MANIFEST', nativeMessage: 'GETSTATUS never settled.'},
      'RESETTING',
      translate,
    );
    expect(presentation.phase).toBe('unconfirmed');
    expect(presentation.text).toContain('firmwareFlasher.reason.DFU_COMPLETION_UNCONFIRMED_MANIFEST');
    expect(presentation.text).toContain('firmwareFlasher.nextAction.MANIFEST_SILENT');
  });

  it("maps Android's manifestation-window DFU_STATUS_TIMEOUT to unconfirmed, and only there", () => {
    expect(
      simpleFailurePresentation(
        {code: 'DFU_STATUS_TIMEOUT', nativeMessage: 'no manifest state'},
        'RESETTING',
        translate,
      ).phase,
    ).toBe('unconfirmed');
    expect(
      simpleFailurePresentation(
        {code: 'DFU_STATUS_TIMEOUT', nativeMessage: 'never idle'},
        'ERASING',
        translate,
      ).phase,
    ).toBe('failed');
  });

  it('reads the transport client rejection shape {code, nativeMessage} instead of a generic line', () => {
    const presentation = simpleFailurePresentation(
      {code: 'SOME_UNKNOWN_CODE', nativeMessage: 'DFU read-back mismatch at 0x8000010.'},
      'VERIFYING',
      translate,
    );
    expect(presentation.phase).toBe('failed');
    // Unknown code -> the REAL native message survives as the fallback.
    expect(presentation.text).toContain('DFU read-back mismatch at 0x8000010.');
    expect(presentation.text).not.toContain('حدث خطأ غير متوقع');
  });

  it('a poisoned-session refusal is a stated failure to START, never unconfirmed completion', () => {
    const presentation = simpleFailurePresentation(
      {code: 'DFU_SESSION_POISONED', nativeMessage: 'pending transfer against this session'},
      undefined,
      translate,
    );
    expect(presentation.phase).toBe('failed');
    expect(presentation.text).toContain('firmwareFlasher.reason.DFU_SESSION_POISONED');
  });
});
