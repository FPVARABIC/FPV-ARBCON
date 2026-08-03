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

  it.each([
    Uint8Array.from([1, 0, 1]),
    Uint8Array.from([2, ...new Array(19).fill(0)]),
  ])('rejects malformed record framing', payload => {
    expect(() => decodeSerialPorts(payload)).toThrow();
  });
});
