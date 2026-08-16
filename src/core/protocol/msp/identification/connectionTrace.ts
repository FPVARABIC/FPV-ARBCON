/**
 * THE CONNECTION, RECORDED STAGE BY STAGE - FOR DEVELOPERS, NOT OPERATORS.
 *
 * When a real flight controller fails to connect, the single most useful
 * question is "how far did it actually get?", and the app could not answer
 * it. ConnectionStage (connectionStageTruth.ts) answers the operator's
 * version of that question in one Arabic sentence; this answers the
 * engineer's version, in enough detail to sit next to a Betaflight session
 * and be compared line by line.
 *
 * Nothing here is shown in the normal UI. It is a developer diagnostic,
 * surfaced only behind an explicit "copy connection report" action, and it
 * is deliberately plain ASCII so it survives being pasted into an issue.
 *
 * Progression, finest-grained first-to-last:
 *
 *   USB_DEVICE_FOUND     a device is on the bus
 *   PORT_OPENED          a serial port was opened on it
 *   SERIAL_READY         the read loop is running; writes are possible
 *   MSP_SYNCED           at least one well-framed MSP response was decoded
 *   API_VERSION_RECEIVED MSP_API_VERSION answered and decoded
 *   FC_VARIANT_RECEIVED  MSP_FC_VARIANT answered and decoded
 *   FC_VERSION_RECEIVED  MSP_FC_VERSION answered and decoded (optional)
 *   BOARD_INFO_RECEIVED  MSP_BOARD_INFO answered (bytes in hand)
 *   BOARD_INFO_PARSED    those bytes decoded into fields
 *   FC_IDENTIFIED        protocol truth satisfied - this IS a flight controller
 *   READY                the session is usable
 *
 * The last stage reached, and the reason the next one did not happen, are
 * the two facts every failed hardware test needs.
 */

export const CONNECTION_TRACE_STAGES = [
  'USB_DEVICE_FOUND',
  'PORT_OPENED',
  'SERIAL_READY',
  'MSP_SYNCED',
  'API_VERSION_RECEIVED',
  'FC_VARIANT_RECEIVED',
  'FC_VERSION_RECEIVED',
  'BOARD_INFO_RECEIVED',
  'BOARD_INFO_PARSED',
  'FC_IDENTIFIED',
  'READY',
] as const;

export type ConnectionTraceStage = (typeof CONNECTION_TRACE_STAGES)[number];

export type ConnectionTraceEntry = {
  readonly atMs: number;
  readonly stage: ConnectionTraceStage | 'NOTE' | 'FAILURE';
  readonly message: string;
};

/** Lowercase hex, space-separated, bounded. The raw MSP_BOARD_INFO payload
 * is the single most valuable artifact in a failed identification, so it is
 * captured verbatim rather than summarized. */
export function toHex(bytes: Uint8Array, maxBytes = 256): string {
  const shown = bytes.subarray(0, maxBytes);
  let out = '';
  for (let i = 0; i < shown.length; i += 1) {
    out += (i > 0 ? ' ' : '') + shown[i].toString(16).padStart(2, '0');
  }
  return bytes.length > maxBytes ? `${out} ...(+${bytes.length - maxBytes} bytes)` : out;
}

export class ConnectionTrace {
  private readonly entries: ConnectionTraceEntry[] = [];
  private readonly facts = new Map<string, string>();
  private readonly startedAtMs: number;
  private reachedStage: ConnectionTraceStage | undefined;
  private failure: {stage: ConnectionTraceStage | 'NOTE'; reason: string} | undefined;

  /** `now` is injected so tests are deterministic and so this never
   * reaches for a clock the platform might not provide. */
  constructor(private readonly now: () => number = () => Date.now()) {
    this.startedAtMs = this.now();
  }

  /** Marks a stage as genuinely reached. */
  reached(stage: ConnectionTraceStage, message = ''): void {
    this.reachedStage = stage;
    this.entries.push({atMs: this.now() - this.startedAtMs, stage, message});
  }

  /** A timed observation that is not itself a stage - a command written, a
   * response length, a retry. */
  note(message: string): void {
    this.entries.push({atMs: this.now() - this.startedAtMs, stage: 'NOTE', message});
  }

  /** The first thing that did not work. Later failures are still recorded,
   * but the FIRST one is what `firstFailure()` reports - a cascade's tail
   * is rarely the cause. */
  failed(stage: ConnectionTraceStage | 'NOTE', reason: string): void {
    if (this.failure === undefined) {
      this.failure = {stage, reason};
    }
    this.entries.push({atMs: this.now() - this.startedAtMs, stage: 'FAILURE', message: `${stage}: ${reason}`});
  }

  /** A named fact worth reporting whatever happens: VID/PID, open
   * parameters, decoded fields, the resolver's answer. */
  fact(key: string, value: string | number | undefined): void {
    if (value === undefined || value === '') {
      return;
    }
    this.facts.set(key, String(value));
  }

  lastStageReached(): ConnectionTraceStage | undefined {
    return this.reachedStage;
  }

  firstFailure(): {stage: ConnectionTraceStage | 'NOTE'; reason: string} | undefined {
    return this.failure;
  }

  /**
   * The exportable report. Plain text, stable key order, no localization -
   * this is compared against a Betaflight session, not read by an operator.
   */
  toText(): string {
    const lines: string[] = ['FPV-ARBCON connection report', ''];
    lines.push(`last stage reached: ${this.reachedStage ?? '(none)'}`);
    lines.push(
      `first failure: ${
        this.failure === undefined ? '(none)' : `${this.failure.stage} - ${this.failure.reason}`
      }`,
    );
    lines.push('');
    lines.push('facts:');
    for (const [key, value] of this.facts) {
      lines.push(`  ${key}: ${value}`);
    }
    lines.push('');
    lines.push('timeline (ms from start):');
    for (const entry of this.entries) {
      const suffix = entry.message === '' ? '' : ` - ${entry.message}`;
      lines.push(`  +${entry.atMs} ${entry.stage}${suffix}`);
    }
    return lines.join('\n');
  }
}

/**
 * The most recent connection attempt's trace, so a developer can export it
 * AFTER a failure without having had diagnostics switched on beforehand -
 * which is the only way a one-off hardware failure is ever captured.
 * Mirrors the existing getLastDfuFlashTimeline() precedent.
 */
let lastTrace: ConnectionTrace | undefined;

export function beginConnectionTrace(now?: () => number): ConnectionTrace {
  lastTrace = new ConnectionTrace(now);
  return lastTrace;
}

export function getLastConnectionTrace(): ConnectionTrace | undefined {
  return lastTrace;
}
