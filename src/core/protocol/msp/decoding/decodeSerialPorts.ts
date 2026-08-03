/* eslint-disable no-bitwise -- MSP serial masks and u32 wire encoding are bit-defined. */
import { MspPayloadReadError, MspPayloadReader } from './MspPayloadReader';

export const SERIAL_PORT_RECORD_MIN_BYTES = 9;

export interface MspSerialPortRecord {
  readonly identifier: number;
  readonly functionMask: number;
  readonly mspBaudIndex: number;
  readonly gpsBaudIndex: number;
  readonly telemetryBaudIndex: number;
  readonly blackboxBaudIndex: number;
  /** Firmware-defined trailing fields, round-tripped byte-for-byte. */
  readonly extensionBytes: Uint8Array;
}

export function decodeSerialPorts(
  payload: Uint8Array,
): readonly MspSerialPortRecord[] {
  const reader = new MspPayloadReader(payload);
  const count = reader.readU8();
  if (count === 0) {
    if (reader.remaining() !== 0) {
      throw new MspPayloadReadError(
        'Serial configuration declares zero ports but contains trailing bytes.',
      );
    }
    return Object.freeze([]);
  }
  if (reader.remaining() % count !== 0) {
    throw new MspPayloadReadError(
      'Serial configuration records do not have a uniform width.',
    );
  }
  const recordWidth = reader.remaining() / count;
  if (recordWidth < SERIAL_PORT_RECORD_MIN_BYTES) {
    throw new MspPayloadReadError(
      `Serial configuration record width ${recordWidth} is below ${SERIAL_PORT_RECORD_MIN_BYTES}.`,
    );
  }
  const ports: MspSerialPortRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    ports.push(
      Object.freeze({
        identifier: reader.readU8(),
        functionMask: reader.readU32LE(),
        mspBaudIndex: reader.readU8(),
        gpsBaudIndex: reader.readU8(),
        telemetryBaudIndex: reader.readU8(),
        blackboxBaudIndex: reader.readU8(),
        extensionBytes: reader.readBytes(
          recordWidth - SERIAL_PORT_RECORD_MIN_BYTES,
        ),
      }),
    );
  }
  return Object.freeze(ports);
}

function pushU32LE(target: number[], value: number): void {
  target.push(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

export function encodeSerialPorts(
  ports: readonly MspSerialPortRecord[],
): Uint8Array {
  if (ports.length > 0xff) {
    throw new RangeError(
      'Serial configuration cannot contain more than 255 ports.',
    );
  }
  const extensionWidth = ports[0]?.extensionBytes.length ?? 0;
  if (ports.some(port => port.extensionBytes.length !== extensionWidth)) {
    throw new RangeError(
      'Serial configuration extension widths must remain uniform.',
    );
  }
  const bytes: number[] = [ports.length];
  for (const port of ports) {
    for (const value of [
      port.identifier,
      port.mspBaudIndex,
      port.gpsBaudIndex,
      port.telemetryBaudIndex,
      port.blackboxBaudIndex,
    ]) {
      if (!Number.isInteger(value) || value < 0 || value > 0xff) {
        throw new RangeError('Serial configuration contains a non-u8 value.');
      }
    }
    bytes.push(port.identifier);
    pushU32LE(bytes, port.functionMask >>> 0);
    bytes.push(
      port.mspBaudIndex,
      port.gpsBaudIndex,
      port.telemetryBaudIndex,
      port.blackboxBaudIndex,
    );
    bytes.push(...port.extensionBytes);
  }
  return Uint8Array.from(bytes);
}
