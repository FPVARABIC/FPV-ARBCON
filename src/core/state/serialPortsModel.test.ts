/* eslint-disable no-bitwise -- fixtures use the same function-mask notation as firmware. */
import type { MspSerialPortRecord } from '../protocol/msp';
import {
  deriveSerialPortsFeatureMask,
  FEATURE_ESC_SENSOR_BIT_FOR_PORTS,
  FEATURE_RX_SERIAL_BIT,
  normalizeSerialPortsForSave,
  setSerialRole,
  unknownSerialFunctionMask,
  validateSerialPorts,
  type SerialPortsSnapshot,
} from './serialPortsModel';

const port = (
  identifier: number,
  functionMask: number,
  overrides: Partial<MspSerialPortRecord> = {},
): MspSerialPortRecord => ({
  identifier,
  functionMask,
  mspBaudIndex: 5,
  gpsBaudIndex: 4,
  telemetryBaudIndex: 0,
  blackboxBaudIndex: 5,
  extensionBytes: Uint8Array.from([0x99]),
  ...overrides,
});
const snapshot = (
  ports: readonly MspSerialPortRecord[],
  serialRxProvider = 9,
): SerialPortsSnapshot => ({
  ports,
  featureMaskRaw: 0,
  apiVersionMajor: 1,
  apiVersionMinor: 48,
  serialRxProvider,
});

describe('serial ports policy', () => {
  it('protects USB MSP and requires one to two MSP ports', () => {
    expect(
      validateSerialPorts(snapshot([port(20, 0)])).map(issue => issue.code),
    ).toEqual(expect.arrayContaining(['USB_MSP_REQUIRED', 'NO_MSP_PORT']));
    expect(
      validateSerialPorts(snapshot([port(20, 1), port(0, 1), port(1, 1)])).map(
        issue => issue.code,
      ),
    ).toContain('TOO_MANY_MSP_PORTS');
  });

  it('limits Serial RX to one port and validates sharing against the active provider', () => {
    const invalid = validateSerialPorts(
      snapshot([port(20, 1), port(0, (1 << 6) | (1 << 12))], 9),
    );
    expect(invalid.map(issue => issue.code)).toContain('INVALID_PORT_SHARING');
    expect(
      validateSerialPorts(
        snapshot([port(20, 1), port(0, (1 << 6) | (1 << 12))], 7),
      ),
    ).toEqual([]);
  });

  it('matches MSP sharing rules instead of allowing every telemetry protocol', () => {
    expect(
      validateSerialPorts(snapshot([port(20, 1), port(0, 1 | (1 << 2))])),
    ).toEqual([]);
    expect(
      validateSerialPorts(snapshot([port(20, 1), port(0, 1 | (1 << 5))])).map(
        issue => issue.code,
      ),
    ).toContain('INVALID_PORT_SHARING');
  });

  it('blocks MSP/RX and high baud on SoftSerial', () => {
    const issues = validateSerialPorts(
      snapshot([
        port(20, 1),
        port(30, (1 << 6) | (1 << 2), { telemetryBaudIndex: 5 }),
      ]),
    );
    expect(issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining([
        'SOFTSERIAL_MSP_OR_RX',
        'SOFTSERIAL_BAUD_TOO_HIGH',
      ]),
    );
  });

  it('preserves unknown future bits and extension bytes while editing known roles', () => {
    const original = port(0, (1 << 20) >>> 0);
    const edited = setSerialRole([original], 0, 'GPS', true)[0];
    expect(unknownSerialFunctionMask(edited)).toBe(1 << 20);
    expect(edited.extensionBytes).toEqual(Uint8Array.from([0x99]));
  });

  it('normalizes only official GPS and Blackbox AUTO defaults at save time', () => {
    const normalized = normalizeSerialPortsForSave([
      port(0, (1 << 1) | (1 << 7), { gpsBaudIndex: 0, blackboxBaudIndex: 0 }),
      port(20, 1, { gpsBaudIndex: 0, blackboxBaudIndex: 0 }),
    ]);
    expect(normalized[0].gpsBaudIndex).toBe(4);
    expect(normalized[0].blackboxBaudIndex).toBe(5);
    expect(normalized[1].gpsBaudIndex).toBe(0);
    expect(normalized[1].blackboxBaudIndex).toBe(0);
  });

  it('derives coupled FC features while preserving every unrelated bit', () => {
    const unrelated = 2 ** 31;
    const mask = deriveSerialPortsFeatureMask(unrelated, [
      port(20, 1),
      port(0, (1 << 6) | (1 << 10)),
    ]);
    expect(mask).toBe(
      (unrelated + FEATURE_RX_SERIAL_BIT + FEATURE_ESC_SENSOR_BIT_FOR_PORTS) >>>
        0,
    );
  });
});
