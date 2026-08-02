jest.mock('../transport/native/NativeUsbSerialTransport');

import {isPlausibleCliBackup, restoreCommands} from './CliBackupService';

describe('CLI backup validation', () => {
  const backup = '# version\nset gyro_lpf1_static_hz = 100\nprofile 0\nsave\n';

  it('accepts printable diff output and removes comments/save from restore commands', () => {
    expect(isPlausibleCliBackup(backup)).toBe(true);
    expect(restoreCommands(backup)).toEqual(['set gyro_lpf1_static_hz = 100', 'profile 0']);
  });

  it('rejects binary garbage and output without a CLI comment header', () => {
    expect(isPlausibleCliBackup('# ok\nset x=\u0000')).toBe(false);
    expect(isPlausibleCliBackup('set x = 1')).toBe(false);
  });
});
