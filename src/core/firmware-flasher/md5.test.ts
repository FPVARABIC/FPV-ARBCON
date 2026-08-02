import {md5Hex} from './md5';

describe('md5Hex', () => {
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ])('hashes %p', (input, expected) => {
    expect(md5Hex(input)).toBe(expected);
  });

  it('accepts binary data without Unicode reinterpretation', () => {
    expect(md5Hex(Uint8Array.from([0, 255, 1]))).toBe('afb9b285695ee0ee62aa674ef510e70d');
  });
});
