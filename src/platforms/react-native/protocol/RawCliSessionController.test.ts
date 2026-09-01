import {
  MspClient,
  type MspTransport,
  type MspTransportUnsubscribe,
} from '../../../core';
import { RawCliSessionController } from './RawCliSessionController';
import type { RNMspTransport } from './RNMspTransport';
import type { MspTelemetryScheduler, TelemetryPauseLease } from '../../../core';

const SESSION_KEY = { sessionId: 'session-cli', generation: 4 } as const;

class SilentMspTransport implements MspTransport {
  async writeBytes(): Promise<void> {}
  onDataReceived(): MspTransportUnsubscribe {
    return () => undefined;
  }
  onSessionDetached(): MspTransportUnsubscribe {
    return () => undefined;
  }
  async restartReceiveLoop(): Promise<void> {}
}

class RawHarnessTransport {
  listener: ((bytes: Uint8Array) => void) | undefined;
  writes: string[] = [];
  released = 0;
  saveResult = true;
  enterRawMode(listener: (bytes: Uint8Array) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
      this.released += 1;
    };
  }
  async writeRawBytes(bytes: Uint8Array): Promise<void> {
    const text = String.fromCharCode(...bytes);
    this.writes.push(text);
    if (text === '#\r') this.reply('Entering CLI Mode\r\n# ');
    else if (text === 'bad\r')
      this.reply('bad\r\n###ERROR: invalid name\r\n# ');
    else if (text !== 'save\r' && text !== 'exit\r')
      this.reply(`${text.trim()}\r\nok\r\n# `);
  }
  async saveTextFile(): Promise<boolean> {
    return this.saveResult;
  }
  private reply(value: string): void {
    this.listener?.(
      Uint8Array.from(value, character => character.charCodeAt(0)),
    );
  }
}

function harness(overrides: { background?: boolean; motors?: boolean } = {}) {
  const client = new MspClient(new SilentMspTransport(), SESSION_KEY.sessionId);
  const raw = new RawHarnessTransport();
  const pause: TelemetryPauseLease = {
    id: 'cli-pause',
    release: jest.fn(),
  };
  const scheduler = {
    acquirePauseLease: jest.fn(() => pause),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(async () => undefined),
  } as unknown as MspTelemetryScheduler;
  const coordinator = {
    getSessionKey: jest.fn(() => SESSION_KEY),
    getActiveMspClient: jest.fn(() => client),
    getActiveTransport: jest.fn(() => raw as unknown as RNMspTransport),
    getTelemetryScheduler: jest.fn(() => scheduler),
    getMotorTestSessionIdentity: jest.fn(() => ({
      physicalGeneration: SESSION_KEY.generation,
      mspEpoch: client.getEpoch(),
    })),
    getIdentificationState: jest.fn(() => ({ status: 'IDLE' } as const)),
  };
  const controller = new RawCliSessionController({
    coordinator,
    appStatePhase: () => (overrides.background ? 'APP_BACKGROUND' : 'ACTIVE'),
    motorTestActive: () => overrides.motors ?? false,
  });
  return { controller, client, raw, scheduler, pause };
}

describe('RawCliSessionController', () => {
  it('pauses, drains, reserves MSP, diverts raw CLI and releases on exit', async () => {
    const { controller, client, raw, scheduler, pause } = harness();
    await controller.begin(SESSION_KEY);
    expect(controller.getPhase()).toBe('ACTIVE');
    expect(scheduler.discardPendingDemands).toHaveBeenCalledTimes(1);
    expect(scheduler.waitUntilIdle).toHaveBeenCalledTimes(1);
    expect(client.isMotorTestLeaseHeld()).toBe(true);

    await expect(controller.execute('set foo = 1')).resolves.toMatchObject({
      error: false,
    });
    expect(raw.writes).toEqual(['#\r', 'set foo = 1\r']);

    await controller.exitWithoutSave();
    expect(raw.writes.at(-1)).toBe('exit\r');
    expect(raw.released).toBe(1);
    expect(pause.release).toHaveBeenCalledTimes(1);
    expect(client.isMotorTestLeaseHeld()).toBe(false);
    expect(controller.getPhase()).toBe('IDLE');
  });

  it('detects CLI errors and refuses save until the session is discarded', async () => {
    const { controller, raw } = harness();
    await controller.begin(SESSION_KEY);
    await expect(controller.execute('bad')).resolves.toMatchObject({
      error: true,
    });
    await expect(controller.saveAndClose()).rejects.toThrow(/لن يُرسل save/);
    expect(raw.writes).not.toContain('save\r');
    await controller.exitWithoutSave();
  });

  it('saves only a clean session and releases ownership after the settle bound', async () => {
    jest.useFakeTimers();
    try {
      const { controller, client, raw } = harness();
      // begin() and execute() each wait for the prompt to settle, so their
      // windows have to be advanced under fake timers too.
      const started = controller.begin(SESSION_KEY);
      await jest.advanceTimersByTimeAsync(100);
      await started;
      const executing = controller.execute('set foo = 1');
      await jest.advanceTimersByTimeAsync(100);
      await executing;
      const saving = controller.saveAndClose();
      await jest.advanceTimersByTimeAsync(750);
      await saving;
      expect(raw.writes.at(-1)).toBe('save\r');
      expect(client.isMotorTestLeaseHeld()).toBe(false);
    } finally {
      // Restored even on failure: a leaked fake clock hangs the NEXT test,
      // which is exactly what happened while this suite was being written.
      jest.useRealTimers();
    }
  });

  it('fails before touching the link while backgrounded or motor testing', async () => {
    const background = harness({ background: true });
    await expect(background.controller.begin(SESSION_KEY)).rejects.toThrow(
      /الواجهة/,
    );
    expect(background.raw.writes).toEqual([]);
    const motors = harness({ motors: true });
    await expect(motors.controller.begin(SESSION_KEY)).rejects.toThrow(
      /المحركات/,
    );
    expect(motors.raw.writes).toEqual([]);
  });

  it('normalizes commands, captures diff all and saves the backup through the owned transport', async () => {
    const { controller } = harness();
    await controller.begin(SESSION_KEY);
    await expect(
      controller.executeBatch(['# comment', '', 'set a = 1']),
    ).resolves.toEqual({ commandCount: 1, errors: [] });
    await expect(controller.captureDiffAll()).resolves.toContain('ok');
    await expect(controller.saveTextFile('backup.txt', '# diff')).resolves.toBe(
      true,
    );
    await expect(controller.execute('save')).rejects.toThrow(/save وexit/);
    expect(controller.getOutput()).toContain('diff all');
    controller.clearOutput();
    expect(controller.getOutput()).toBe('');
    await controller.exitWithoutSave();
  });
});

/**
 * A board that answers only when the test says so, one chunk at a time - the
 * shape a real serial link has, and the only way to reproduce a long stream
 * or a chunk boundary that lands on a '#'.
 */
class ChunkedHarnessTransport extends RawHarnessTransport {
  manual = false;
  async writeRawBytes(bytes: Uint8Array): Promise<void> {
    const text = String.fromCharCode(...bytes);
    this.writes.push(text);
    if (text === '#\r') {
      this.emit('Entering CLI Mode\r\n# ');
      return;
    }
    if (this.manual) return;
    await super.writeRawBytes(bytes);
  }
  emit(value: string): void {
    this.listener?.(Uint8Array.from(value, c => c.charCodeAt(0)));
  }
}

function chunkedHarness() {
  const raw = new ChunkedHarnessTransport();
  const client = new MspClient(new SilentMspTransport(), SESSION_KEY.sessionId);
  const pause: TelemetryPauseLease = {id: 'cli-pause', release: jest.fn()};
  const scheduler = {
    acquirePauseLease: jest.fn(() => pause),
    discardPendingDemands: jest.fn(),
    waitUntilIdle: jest.fn(async () => undefined),
  } as unknown as MspTelemetryScheduler;
  const controller = new RawCliSessionController({
    coordinator: {
      getSessionKey: jest.fn(() => SESSION_KEY),
      getActiveMspClient: jest.fn(() => client),
      getActiveTransport: jest.fn(() => raw as unknown as RNMspTransport),
      getTelemetryScheduler: jest.fn(() => scheduler),
      getMotorTestSessionIdentity: jest.fn(() => ({
        physicalGeneration: SESSION_KEY.generation,
        mspEpoch: client.getEpoch(),
      })),
      getIdentificationState: jest.fn(() => ({status: 'IDLE'} as const)),
    },
    appStatePhase: () => 'ACTIVE',
    motorTestActive: () => false,
  });
  return {controller, raw};
}

describe('a CLI command whose output is long, or arrives in awkward chunks', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** `begin` waits for the prompt too, so its settle window must be advanced. */
  async function beginFake(controller: RawCliSessionController): Promise<void> {
    const started = controller.begin(SESSION_KEY);
    await jest.advanceTimersByTimeAsync(100);
    await started;
  }

  it('does NOT time out while the board is still streaming', async () => {
    // The bound used to start at the write and fire five seconds later no
    // matter what, so `diff all` on a slow link was killed for being long
    // rather than for being stuck - and execute() treats a timeout as a dead
    // session and tears the CLI down, which is the first step of the Presets
    // backup. It is now an INACTIVITY bound, which is what Betaflight's
    // lastArrival stamp amounts to.
    const {controller, raw} = chunkedHarness();
    await beginFake(controller);
    raw.manual = true;

    const pending = controller.execute('diff all');
    // Twelve seconds of steady output - well past the old five-second bound.
    for (let second = 0; second < 12; second += 1) {
      raw.emit(`# line ${second}\r\n`);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    raw.emit('# ');
    await jest.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.response).toContain('line 11');
    expect(result.error).toBe(false);
  });

  it('does NOT cut the response short when a chunk happens to end on a "#"', async () => {
    // diff/dump output is full of '#' lines. Resolving on one truncated the
    // response AND left the rest to arrive during the NEXT command, so one
    // command's output was reported as another's.
    const {controller, raw} = chunkedHarness();
    await beginFake(controller);
    raw.manual = true;

    const pending = controller.execute('diff all');
    raw.emit('# version\r\nset a = 1\r\n#');   // chunk ends exactly on a '#'
    await jest.advanceTimersByTimeAsync(20);       // less than the settle window
    raw.emit(' Betaflight\r\nset b = 2\r\n# ');
    await jest.advanceTimersByTimeAsync(100);
    const result = await pending;
    // Everything after the mid-stream '#' survived.
    expect(result.response).toContain('set b = 2');
    expect(result.response).toContain('Betaflight');
  });

  it('still fails when the board really has gone silent', async () => {
    // Tolerance for long output must not become tolerance for a dead link.
    const {controller, raw} = chunkedHarness();
    await beginFake(controller);
    raw.manual = true;

    // Settled into a value so the rejection is handled the moment it happens,
    // rather than while the clock is still being advanced past it.
    const outcome = controller
      .execute('status')
      .then(() => 'resolved', (error: Error) => error.message);
    // The idle bound fires, then execute() tears the session down, which
    // itself waits out the exit settle before the rejection surfaces.
    await jest.advanceTimersByTimeAsync(5_001);
    await jest.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toMatch(/مهلة/);
    expect(controller.getPhase()).toBe('IDLE');
  });
});
