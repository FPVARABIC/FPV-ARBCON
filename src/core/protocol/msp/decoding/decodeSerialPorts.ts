/* eslint-disable no-bitwise -- MSP serial masks and u32 wire encoding are bit-defined. */
import {MspPayloadReader} from './MspPayloadReader';

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
  // Betaflight derives the record width from the payload itself
  // (`portConfigSize = data.remaining() / count`) and then simply skips
  // whatever it does not understand at the end of each record, validating
  // nothing (src/js/msp/MSPHelper.js case MSP2_COMMON_SERIAL_CONFIG). Ports is
  // the screen an operator opens to fix a serial problem, so a firmware that
  // widens the per-port record - which Betaflight has done before - must not
  // be the reason they cannot open it.
  //
  // Reading tolerantly is safe here because encodeSerialPorts is the strict
  // half of the pair: it re-derives a uniform layout from the records and
  // rejects a non-uniform or non-u8 set, so a partially understood read can
  // never be written back as a corrupt serial configuration.
  const reader = new MspPayloadReader(payload, {lenient: true});
  const declared = reader.readU8();
  const recordWidth =
    declared > 0 ? Math.floor(reader.remaining() / declared) : 0;
  if (declared === 0 || recordWidth < SERIAL_PORT_RECORD_MIN_BYTES) {
    return Object.freeze([]);
  }
  const count = Math.min(declared, Math.floor(reader.remaining() / recordWidth));
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
