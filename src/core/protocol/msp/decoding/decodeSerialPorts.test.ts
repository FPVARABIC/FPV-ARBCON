import { decodeSerialPorts, encodeSerialPorts } from './decodeSerialPorts';

describe('serial port wire contract', () => {
  it('decodes little-endian masks and round-trips future extension bytes', () => {
    const payload = Uint8Array.from([
      1, 20, 0x41, 0x00, 0x02, 0x80, 5, 4, 0, 5, 0xaa, 0xbb,
    ]);
    const ports = decodeSerialPorts(payload);
    expect(ports[0]).toMatchObject({
      identifier: 20,
      functionMask: 0x80020041,
      extensionBytes: Uint8Array.from([0xaa, 0xbb]),
    });
    expect(encodeSerialPorts(ports)).toEqual(payload);
  });

  it('reads what the framing can actually yield instead of refusing to load', () => {
    // Betaflight derives the record width from the payload and skips whatever
    // it does not understand at the end of each record, validating nothing
    // (MSPHelper.js case MSP2_COMMON_SERIAL_CONFIG). Ports is the screen an
    // operator opens to FIX a serial problem, so a firmware that widens the
    // per-port record must not be the reason they cannot open it.

    // Two bytes for a declared port: no whole record exists, so no port does.
    expect(decodeSerialPorts(Uint8Array.from([1, 0, 1]))).toEqual([]);

    // 19 bytes for 2 declared ports: two 9-byte records are readable and the
    // odd trailing byte is ignored, exactly as Betaflight skips it.
    expect(decodeSerialPorts(Uint8Array.from([2, ...new Array(19).fill(0)]))).toHaveLength(2);
  });

  it('but the WRITE still refuses a set it cannot lay out uniformly', () => {
    // The strict half of the pair. A tolerant read can never become a corrupt
    // serial configuration, because this is what builds the payload.
    const ports = decodeSerialPorts(
      Uint8Array.from([1, 20, 0x41, 0x00, 0x02, 0x80, 5, 4, 0, 5, 0xaa, 0xbb]),
    );
    expect(() =>
      encodeSerialPorts([...ports, {...ports[0], extensionBytes: new Uint8Array(0)}]),
    ).toThrow(/uniform/);
  });
});
