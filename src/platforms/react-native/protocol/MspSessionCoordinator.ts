/**
 * Session-lifecycle coordinator (Pass 6.3 Step 2) - owns the pairing of
 * one RNMspTransport with one MspClient per open physical session. NOT
 * owned by any screen: a module-level singleton, mirroring
 * usbSerialTransportClient's own established precedent (see
 * UsbSerialTransportClient.ts) - this codebase has no React Context usage
 * and no generic event-emitter/pub-sub pattern for cross-cutting state, so
 * a singleton is the only choice consistent with existing precedent.
 *
 * Call openSession() once a session is confirmed successfully open (the
 * hook point is UsbConnectionScreen.tsx's handleConnect(), immediately
 * after client.openDevice() resolves and CONNECT_SUCCESS is dispatched -
 * that is the only place a sessionId ever becomes known). Call
 * closeSession() for an intentional close (handleDisconnect()'s success
 * path). Physical detach needs no explicit call from any screen at all:
 * openSession() below registers its own independent listener directly on
 * the created RNMspTransport (a second listener alongside MspClient's own
 * internal one, per Step 1's multi-listener support) that drives the same
 * teardown automatically the moment the transport reports the detach.
 *
 * Dispose ordering on every teardown path (intentional close OR physical
 * detach): MspClient.dispose() FIRST, THEN RNMspTransport.dispose() -
 * MspClient.dispose() only removes MspClient's own two listeners from the
 * transport's internal Sets (via the unsubscribe functions the transport
 * returned to it); it does nothing to the transport's one real underlying
 * subscription, nothing to any other independently-registered listener
 * (the debug panel's own monitor - Step 3), and nothing to guard the
 * transport's writeBytes()/restartReceiveLoop() against further use.
 * RNMspTransport.dispose() is the only call that does all three - running
 * it first would fully kill the transport out from under MspClient while
 * MspClient's own state/API has not yet been updated to reflect that.
 */

import {MspClient} from '../../../core';
import type {UsbSerialTransportClient} from '../transport';
import {RNMspTransport} from './RNMspTransport';

interface SessionEntry {
  transport: RNMspTransport;
  mspClient: MspClient;
}

export class MspSessionCoordinator {
  private readonly sessions = new Map<string, SessionEntry>();

  /**
   * Idempotent: exactly one MspClient ever exists per sessionId. A second
   * call for a sessionId that already has an entry returns that SAME
   * MspClient instance rather than constructing a new pairing - this is
   * what guarantees "exactly one MspClient per physical session" from
   * every call site, not just the first one.
   */
  openSession(client: UsbSerialTransportClient, sessionId: string): MspClient {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing.mspClient;
    }

    const transport = new RNMspTransport(client, sessionId);
    const mspClient = new MspClient(transport, sessionId);

    // Own, independent listener - see the class doc comment. Not screen-
    // driven: fires automatically the moment the transport reports this
    // session's physical detach, regardless of what any screen is doing.
    transport.onSessionDetached(() => {
      this.disposeSession(sessionId);
    });

    this.sessions.set(sessionId, {transport, mspClient});
    return mspClient;
  }

  /** Exposed for future consumers (Pass 6.4+ screens/hooks) - the same
   * MspClient instance every open session's openSession() call already
   * returned, reachable without needing to call openSession() again. */
  getActiveMspClient(sessionId: string): MspClient | undefined {
    return this.sessions.get(sessionId)?.mspClient;
  }

  /** Pass 6.3 Step 3: the same RNMspTransport instance openSession()
   * internally created, for consumers that need raw bytes (Uint8Array) -
   * MspClient never re-exposes those, only parsed MSP frames. The debug
   * panel's read-only monitor is the first such consumer: it registers
   * its own independent onDataReceived listener directly on this exact
   * instance (Step 1's multi-listener support), never a second, separate
   * subscription to the raw underlying client. */
  getActiveTransport(sessionId: string): RNMspTransport | undefined {
    return this.sessions.get(sessionId)?.transport;
  }

  /** Intentional close - see the class doc comment's hook-point note. */
  closeSession(sessionId: string): void {
    this.disposeSession(sessionId);
  }

  private disposeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }
    this.sessions.delete(sessionId);
    entry.mspClient.dispose();
    entry.transport.dispose();
  }
}

export const mspSessionCoordinator = new MspSessionCoordinator();
