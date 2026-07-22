import {decodeFcVariant} from './decodeFcVariant';
import {MspPayloadReadError} from './MspPayloadReader';

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text.split('').map(c => c.charCodeAt(0)));
}

describe('decodeFcVariant', () => {
  it('decodes a realistic full payload correctly ("BTFL")', () => {
    expect(decodeFcVariant(ascii('BTFL'))).toEqual({identifier: 'BTFL'});
  });

  it('decodes any 4-character identifier verbatim, without judging its content', () => {
    expect(decodeFcVariant(ascii('INAV'))).toEqual({identifier: 'INAV'});
    expect(decodeFcVariant(ascii('EMUF'))).toEqual({identifier: 'EMUF'});
    expect(decodeFcVariant(ascii('ZZZZ'))).toEqual({identifier: 'ZZZZ'});
  });

  it('throws MspPayloadReadError for a truncated payload', () => {
    expect(() => decodeFcVariant(ascii('BTF'))).toThrow(MspPayloadReadError);
  });
});
