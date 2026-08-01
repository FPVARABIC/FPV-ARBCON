import { encodeDshotEscDirection } from './encodeDshotEscDirection';

describe('encodeDshotEscDirection', () => {
  it('encodes one blocking normal command followed by ESC save', () => {
    expect(Array.from(encodeDshotEscDirection(0, 'NORMAL'))).toEqual([
      1, 0, 2, 7, 12,
    ]);
  });

  it('encodes reverse for one exact zero-based motor index', () => {
    expect(Array.from(encodeDshotEscDirection(3, 'REVERSED'))).toEqual([
      1, 3, 2, 8, 12,
    ]);
  });

  it('rejects broadcast, invalid index, and unknown direction', () => {
    expect(() => encodeDshotEscDirection(255, 'NORMAL')).toThrow();
    expect(() => encodeDshotEscDirection(-1, 'NORMAL')).toThrow();
    expect(() => encodeDshotEscDirection(0, 'sideways' as never)).toThrow();
  });
});
