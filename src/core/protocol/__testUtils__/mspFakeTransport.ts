/**
 * TEST-ONLY MspTransport implementation.
 *
 * Lives under __testUtils__/ (not __tests__/, so Jest's default testMatch
 * doesn't pick it up as a test file itself) and is not exported from
 * src/core/protocol/index.ts or src/core/index.ts - not reachable from any
 * production import path, same convention as mspFixtures.ts.
 *
 * Gives tests explicit, manual control over exactly when a writeBytes()
 * call's Promise settles (success or failure), so the write-vs-response
 * race described in mspClient.ts's request() doc comment can be constructed
 * deterministically - a real transport's timing could never be controlled
 * precisely enough for that from a test.
 *
 * Matches MspTransport's session-scoped signatures exactly: writeBytes()
 * and onDataReceived() carry no sessionId (one FakeMspTransport instance
 * simulates one session's transport, same as the real interface contract);
 * only onSessionDetached()'s event still carries one, since that field is
 * part of MspTransport's own MspTransportSessionDetachedEvent shape.
 */

import type {
  MspTransport,
  MspTransportError,
  MspTransportSessionDetachedEvent,
} from '../mspTransport';

interface PendingWrite {
  data: Uint8Array;
  resolve: () => void;
  reject: (error: MspTransportError) => void;
}

interface PendingRestart {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class FakeMspTransport implements MspTransport {
  readonly writes: PendingWrite[] = [];
  /** Pass 6.2b: pending restartReceiveLoop() calls, oldest first - same
   * manual-control pattern as `writes` above. "Hang" behavior needs no
   * separate method: simply never calling resolveNextRestart()/
   * rejectNextRestart() for an entry leaves that call's Promise pending
   * forever, exactly like an un-settled write. */
  readonly restarts: PendingRestart[] = [];
  /** Phase 2G Pass 1: an append-only HISTORY of every writeBytes() call,
   * in invocation order, which `writes` above deliberately is not - that
   * array is shifted as each write settles, so it only ever shows what is
   * still outstanding. Submission-order proofs need the history: "the stop
   * is the NEXT transport write" is a statement about invocation order,
   * and nothing else in this fake records it. Purely additive; no existing
   * behaviour is changed. */
  readonly writeLog: Uint8Array[] = [];

  private dataListeners = new Set<(bytes: Uint8Array) => void>();
  private sessionDetachedListeners = new Set<(event: MspTransportSessionDetachedEvent) => void>();

  writeBytes(data: Uint8Array): Promise<void> {
    this.writeLog.push(data);
    return new Promise<void>((resolve, reject) => {
      this.writes.push({ data, resolve, reject });
    });
  }

  onDataReceived(listener: (bytes: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onSessionDetached(callback: (event: MspTransportSessionDetachedEvent) => void): () => void {
    this.sessionDetachedListeners.add(callback);
    return () => this.sessionDetachedListeners.delete(callback);
  }

  /** Resolves the oldest not-yet-settled write() call. */
  resolveNextWrite(): void {
    const next = this.writes.shift();
    if (!next) {
      throw new Error('FakeMspTransport.resolveNextWrite(): no pending write.');
    }
    next.resolve();
  }

  /** Rejects the oldest not-yet-settled write() call with the given code. */
  rejectNextWrite(code: string, message = 'fake transport write failure'): void {
    const next = this.writes.shift();
    if (!next) {
      throw new Error('FakeMspTransport.rejectNextWrite(): no pending write.');
    }
    next.reject({ code, message });
  }

  emitData(data: Uint8Array): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitSessionDetached(sessionId: string): void {
    for (const listener of this.sessionDetachedListeners) {
      listener({ sessionId });
    }
  }

  restartReceiveLoop(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.restarts.push({ resolve, reject });
    });
  }

  /** Resolves the oldest not-yet-settled restartReceiveLoop() call. */
  resolveNextRestart(): void {
    const next = this.restarts.shift();
    if (!next) {
      throw new Error('FakeMspTransport.resolveNextRestart(): no pending restart.');
    }
    next.resolve();
  }

  /** Rejects the oldest not-yet-settled restartReceiveLoop() call. */
  rejectNextRestart(reason: unknown = new Error('fake transport restart failure')): void {
    const next = this.restarts.shift();
    if (!next) {
      throw new Error('FakeMspTransport.rejectNextRestart(): no pending restart.');
    }
    next.reject(reason);
  }
}
