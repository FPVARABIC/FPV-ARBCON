import {FakeClock, RealClock} from './clock';

describe('RealClock', () => {
  it('reflects the real wall clock (within a generous tolerance for test execution time)', () => {
    const before = Date.now();
    const clock = new RealClock();
    const observed = clock.now();
    const after = Date.now();

    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });
});

describe('FakeClock', () => {
  it('starts at 0 by default', () => {
    expect(new FakeClock().now()).toBe(0);
  });

  it('starts at the given startAtMs', () => {
    expect(new FakeClock(5000).now()).toBe(5000);
  });

  it('advance() moves time forward by exactly the given amount', () => {
    const clock = new FakeClock(100);
    clock.advance(50);
    expect(clock.now()).toBe(150);
    clock.advance(1);
    expect(clock.now()).toBe(151);
  });

  it('advance() rejects a negative duration', () => {
    const clock = new FakeClock();
    expect(() => clock.advance(-1)).toThrow(/negative duration/);
  });

  it('set() jumps directly to an absolute time', () => {
    const clock = new FakeClock(100);
    clock.set(9999);
    expect(clock.now()).toBe(9999);
  });

  it('never advances on its own - only explicit advance()/set() calls move it', () => {
    const clock = new FakeClock(42);
    expect(clock.now()).toBe(42);
    expect(clock.now()).toBe(42);
    expect(clock.now()).toBe(42);
  });
});
