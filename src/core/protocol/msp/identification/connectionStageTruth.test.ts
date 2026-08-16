/**
 * CONNECTION STAGE TRUTH.
 *
 * The operator reported being told "no USB device detected" when a USB
 * device demonstrably WAS attached. These tests pin the distinction the
 * product now makes: a missing device, a device with no serial driver, a
 * port that would not open, a silent firmware, an old firmware and an
 * unnamed board are six different situations with six different answers.
 */

import {
  classifyConnectionStage,
  connectionStageLabelKey,
} from './connectionStageTruth';

describe('the first stage that did not hold', () => {
  it('nothing attached is the only case that may say "no USB device"', () => {
    expect(classifyConnectionStage({usbDeviceCount: 0, serialCapableCount: 0})).toBe(
      'NO_USB_DEVICE',
    );
  });

  it('THE REPORTED DEFECT: a device IS attached but exposes no serial driver', () => {
    // This used to be reported as "no flight controller found", sending
    // the operator to check a cable that was never the problem.
    expect(classifyConnectionStage({usbDeviceCount: 1, serialCapableCount: 0})).toBe(
      'USB_WITHOUT_SERIAL_DRIVER',
    );
  });

  it('several candidates are an ambiguity, not an absence', () => {
    expect(classifyConnectionStage({usbDeviceCount: 2, serialCapableCount: 2})).toBe(
      'MULTIPLE_USB_DEVICES',
    );
  });

  it('a multi-port board asks for a port, not a cable', () => {
    expect(
      classifyConnectionStage({usbDeviceCount: 1, serialCapableCount: 1, portCount: 3}),
    ).toBe('MULTIPLE_PORTS');
  });

  it('a port that will not open is named as such', () => {
    expect(
      classifyConnectionStage({
        usbDeviceCount: 1,
        serialCapableCount: 1,
        portCount: 1,
        transportOpened: false,
      }),
    ).toBe('TRANSPORT_OPEN_FAILED');
  });

  it('an opened port with a silent firmware is an MSP fact, not a USB fact', () => {
    expect(
      classifyConnectionStage({
        usbDeviceCount: 1,
        serialCapableCount: 1,
        portCount: 1,
        transportOpened: true,
        mspResponded: false,
      }),
    ).toBe('MSP_NOT_RESPONDING');
  });

  it('an answering but too-old firmware is its own stage', () => {
    expect(
      classifyConnectionStage({
        usbDeviceCount: 1,
        serialCapableCount: 1,
        transportOpened: true,
        mspResponded: true,
        mspCompatible: false,
      }),
    ).toBe('MSP_INCOMPATIBLE');
  });

  it('an answering firmware with no board name is still a responding firmware', () => {
    expect(
      classifyConnectionStage({
        usbDeviceCount: 1,
        serialCapableCount: 1,
        transportOpened: true,
        mspResponded: true,
        mspCompatible: true,
        boardNamed: false,
      }),
    ).toBe('BOARD_METADATA_INCOMPLETE');
  });

  it('every stage holding is IDENTIFIED', () => {
    expect(
      classifyConnectionStage({
        usbDeviceCount: 1,
        serialCapableCount: 1,
        portCount: 1,
        transportOpened: true,
        mspResponded: true,
        mspCompatible: true,
        boardNamed: true,
      }),
    ).toBe('IDENTIFIED');
  });

  it('addresses each stage by its own i18n key', () => {
    expect(connectionStageLabelKey('MSP_NOT_RESPONDING')).toBe(
      'connectionStage.MSP_NOT_RESPONDING',
    );
  });
});
