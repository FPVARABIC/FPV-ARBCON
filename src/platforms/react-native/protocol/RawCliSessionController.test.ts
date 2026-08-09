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
    const { controller, client, raw } = harness();
    await controller.begin(SESSION_KEY);
    await controller.execute('set foo = 1');
    const saving = controller.saveAndClose();
    await jest.advanceTimersByTimeAsync(750);
    await saving;
    expect(raw.writes.at(-1)).toBe('save\r');
    expect(client.isMotorTestLeaseHeld()).toBe(false);
    jest.useRealTimers();
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
