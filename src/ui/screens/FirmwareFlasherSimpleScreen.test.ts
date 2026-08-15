import {
  defaultStableRelease,
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