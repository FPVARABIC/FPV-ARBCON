import {parseIntelHex} from './intelHex';
import {
  applyCustomDefaultsToFirmware,
  insertCustomDefaults,
  parseUnifiedConfigText,
  serializeIntelHex,
} from './customDefaults';

function u32le(value: number): Uint8Array {
  return Uint8Array.of(value, value >>> 8, value >>> 16, value >>> 24);
}

function image() {
  const pointers = new Uint8Array(8);
  pointers.set(u32le(0x08010000));
  pointers.set(u32le(0x08010200), 4);
  return {
    segments: [
      {address: 0x08000000, data: Uint8Array.of(1, 2, 3, 4)},
      {address: 0x08002800, data: pointers},
    ],
    totalBytes: 12,
    lowestAddress: 0x08000000,
    highestAddressExclusive: 0x08002808,
    entryPoint: 0x08000101,
  };
}

describe('Betaflight unified custom defaults', () => {
  it('cleans Unicode comments but rejects Unicode inside commands', () => {
    expect(parseUnifiedConfigText('# تعليق\nset foo = 1\n')).toEqual(['# _____', 'set foo = 1', '']);
    expect(() => parseUnifiedConfigText('set الاسم = 1')).toThrow(/محرفاً غير صالح/);
  });

  it('inserts config only into the firmware-advertised free region', () => {
    const inserted = insertCustomDefaults(image(), ['set motor_pwm_protocol = DSHOT300']);
    const config = inserted.segments.find(segment => segment.address === 0x08010000);
    expect(String.fromCharCode(...(config?.data ?? []))).toBe(
      '# Betaflight\nset motor_pwm_protocol = DSHOT300\0',
    );
    expect(inserted.totalBytes).toBeGreaterThan(12);
  });

  it('serializes the injected image back to strict Intel HEX without data loss', () => {
    const inserted = insertCustomDefaults(image(), ['set foo = 1']);
    const reparsed = parseIntelHex(String.fromCharCode(...serializeIntelHex(inserted)));
    expect(reparsed.segments).toEqual(inserted.segments);
    expect(reparsed.entryPoint).toBe(inserted.entryPoint);
  });

  it('updates both the structured and raw HEX forms used by serial and DFU', () => {
    const source = {kind: 'HEX' as const, filename: 'fw.hex', bytes: Uint8Array.of(1), hex: image()};
    const prepared = applyCustomDefaultsToFirmware(source, ['set foo = 1']);
    expect(prepared.hex.totalBytes).toBeGreaterThan(source.hex.totalBytes);
    expect(parseIntelHex(String.fromCharCode(...prepared.bytes))).toEqual(prepared.hex);
  });

  it('refuses injection when the pointer is absent or the declared area overlaps firmware', () => {
    expect(() => insertCustomDefaults({...image(), segments: image().segments.slice(0, 1)}, ['set foo = 1']))
      .toThrow(/لا يعلن منطقة/);
    expect(() => insertCustomDefaults({
      ...image(),
      segments: [...image().segments, {address: 0x08010000, data: Uint8Array.of(9)}],
    }, ['set foo = 1'])).toThrow(/تتداخل/);
  });
});
