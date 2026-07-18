package com.fpvarbcon.transport

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A unique handle identifying exactly one startReading() attempt for one
 * sessionId. Two tokens are never equal unless they came from the exact
 * same [UsbSerialReadRegistry.start] call - even for the same sessionId
 * started at two different times. Mirrors [ReservationToken]'s own
 * generation-based design (see UsbSerialSessionRegistry.kt) but is a
 * distinct type: a receive attempt and an open-attempt reservation are
 * different domains and must never be compared to each other.
 */
internal data class ReceiveToken(internal val generation: Long)

/**
 * Identifies one physical worker thread's [SerialReadLoop.run] invocation
 * for one receive attempt. Exists so a *new* startReading() attempt for the
 * same session can wait, bounded, for the *previous* attempt's real thread
 * to have actually returned from run() - not merely for its token to stop
 * being "current" - before that new attempt is allowed to call
 * UsbSerialPort.read() itself.
 *
 * This is the corrective fix for PASS5.2-AUDIT-F1: token invalidation alone
 * stops a stale worker from *emitting*, but it does nothing to stop that
 * worker's underlying thread from still being physically blocked inside a
 * real, unsynchronized UsbSerialPort.read() call - and the pinned
 * usb-serial-for-android 3.10.0 CommonUsbSerialPort.read() implementation
 * has no internal synchronization and reuses a mutable read-request field
 * across calls, so two threads calling read() concurrently on the same port
 * is a genuine, confirmed (from the dependency's own source) data race, not
 * merely a hypothetical concern.
 */
internal class ReadWorkerHandle {
  private val doneLatch = CountDownLatch(1)

  /**
   * Called exactly once, by the worker thread itself, in a finally block
   * immediately after its SerialReadLoop.run() call returns - whether that
   * return was a normal stop, a superseding detach/close/invalidate, or an
   * unexpected read failure. Idempotent (a second call is a harmless no-op,
   * matching CountDownLatch#countDown's own contract).
   */
  fun markDone() {
    doneLatch.countDown()
  }

  /**
   * True if the worker had already called [markDone] within [timeoutMillis];
   * false if the bound elapsed first. Never waits past that bound either
   * way - this is the one place a new startReading() attempt may block its
   * own (dedicated, non-main) thread, and only for this fixed, short window.
   */
  fun awaitDone(timeoutMillis: Long): Boolean = doneLatch.await(timeoutMillis, TimeUnit.MILLISECONDS)
}

/**
 * sessionId -> the receive attempt currently occupying that session's slot,
 * if any. Enforces "at most one active receive loop per session" and, as of
 * the PASS5.2-AUDIT-F1 correction, "at most one real UsbSerialPort.read()
 * call in flight per session at any time" - not merely at the software
 * emission layer.
 *
 * Deliberately independent of [UsbSerialSessionRegistry]: this class knows
 * nothing about UsbSerialSession, UsbDeviceConnection, or UsbSerialPort - it
 * only ever stores a sessionId (String) and a small internal Entry. Session
 * existence is checked by the caller (UsbSerialTransportModule) against
 * UsbSerialSessionRegistry before calling [start]; this registry has no way
 * to reject "unknown session" itself, by design, so the two registries'
 * responsibilities stay cleanly separated.
 *
 * Every entry has two independent facts: whether its token is still
 * *active* (allowed to emit - becomes false the instant [retire] is called,
 * with no delay) and whether its worker thread has *actually finished*
 * (confirmed only by [confirmRetired], called by that exact thread). An
 * entry is only removed - freeing the sessionId for a completely fresh
 * [start] - once the worker itself confirms it has finished, never merely
 * because its token stopped being active. This is what makes "at most one
 * real read in flight" true even across a rapid stopReading()->startReading()
 * cycle: [start] refuses a new attempt for a session whose previous entry
 * hasn't been confirmed retired yet, forcing the caller to wait for
 * [ReadWorkerHandle.awaitDone] first (see UsbSerialTransportModule.startReading).
 *
 * A receive worker never removes anything but its own entry, and only once,
 * via [confirmRetired] - which is itself ownership-gated by [ReadWorkerHandle]
 * identity, so even in principle a stale worker could never clear a newer
 * entry. In practice this can never even be attempted: [start] guarantees a
 * newer entry can only exist after the older one was already removed.
 */
internal class UsbSerialReadRegistry {

  /** The outcome of a single [start] call - see each case's own note. */
  internal sealed class StartAttempt {
    /** No entry existed for this sessionId; a fresh token+handle now occupies it. */
    data class Started(val token: ReceiveToken, val handle: ReadWorkerHandle) : StartAttempt()

    /** A receive loop is genuinely running right now - reject immediately, no wait is useful. */
    object AlreadyActive : StartAttempt()

    /**
     * The previous attempt's token is no longer active (already
     * stopped/superseded), but its worker thread has not yet confirmed it
     * exited. The caller must wait on [handle] (bounded) and retry - never
     * proceed to read on this session's port until [handle] confirms done.
     */
    data class Retiring(val handle: ReadWorkerHandle) : StartAttempt()
  }

  private class Entry(val token: ReceiveToken, val handle: ReadWorkerHandle, var active: Boolean)

  private val entries = mutableMapOf<String, Entry>()
  private var nextGeneration = 0L

  /**
   * Atomically decides the outcome of one startReading() attempt for
   * [sessionId] - see [StartAttempt]'s own cases. Never blocks; waiting (if
   * needed) is entirely the caller's responsibility, on its own thread.
   */
  @Synchronized
  fun start(sessionId: String): StartAttempt {
    val existing = entries[sessionId]
    return when {
      existing == null -> {
        val token = ReceiveToken(nextGeneration++)
        val handle = ReadWorkerHandle()
        entries[sessionId] = Entry(token, handle, active = true)
        StartAttempt.Started(token, handle)
      }
      existing.active -> StartAttempt.AlreadyActive
      else -> StartAttempt.Retiring(existing.handle)
    }
  }

  /**
   * Used by stopReading(): if [sessionId] currently has an *active* entry,
   * marks it inactive immediately (so [isCurrent] returns false from this
   * call onward - no further emission or error report) while deliberately
   * *keeping* the entry (and its [ReadWorkerHandle]) registered until the
   * worker itself calls [confirmRetired]. This is what lets a subsequent
   * [start] correctly report [StartAttempt.Retiring] instead of wrongly
   * allowing a new worker to start reading immediately. Idempotent: a
   * second call (or a call with no active entry at all) is a harmless
   * no-op. Returns whether this call actually performed the transition,
   * purely for test observability.
   */
  @Synchronized
  fun retire(sessionId: String): Boolean {
    val entry = entries[sessionId] ?: return false
    if (!entry.active) return false
    entry.active = false
    return true
  }

  /**
   * Called by a worker thread's own cleanup, unconditionally, once its
   * SerialReadLoop.run() call has returned - success, normal stop, or
   * unexpected failure alike - so that (a) any startReading() attempt
   * waiting on [handle] unblocks, and (b) [sessionId] becomes available for
   * a completely fresh [start]. Ownership-gated: if the currently-registered
   * entry's handle is not exactly [handle] (already removed by
   * removeSession()/removeAll(), or - structurally impossible given
   * [start]'s own guarantee, but handled defensively - already replaced),
   * the removal itself is skipped, but [handle]'s own [ReadWorkerHandle.markDone]
   * is still called unconditionally first, so nothing can ever wait on it
   * forever.
   */
  @Synchronized
  fun confirmRetired(sessionId: String, handle: ReadWorkerHandle) {
    handle.markDone()
    val entry = entries[sessionId]
    if (entry != null && entry.handle === handle) {
      entries.remove(sessionId)
    }
  }

  /**
   * True only if [token] is the current, *active* token for [sessionId] -
   * false if it was never started, has since been retired/removed, or has
   * been superseded by a newer attempt. A receive loop calls this before
   * its first read, after every read returns (successfully or not), and
   * immediately before emitting a chunk or reporting an error - never
   * emitting or continuing once this returns false.
   */
  @Synchronized
  fun isCurrent(sessionId: String, token: ReceiveToken): Boolean {
    val entry = entries[sessionId] ?: return false
    return entry.active && entry.token == token
  }

  /**
   * Unconditionally removes whatever entry exists for [sessionId],
   * regardless of active/retiring state - used by closeSession() and detach
   * handling, where the session (and its port) is going away entirely, so
   * there is no future startReading() attempt for this exact sessionId that
   * could ever need to wait on the removed handle. Those callers are
   * expected to unblock a real in-flight read by closing the port itself
   * (the dependency's own documented cancellation mechanism), not by
   * waiting here. Returns the removed handle, if any, purely for test
   * observability.
   */
  @Synchronized
  fun removeSession(sessionId: String): ReadWorkerHandle? = entries.remove(sessionId)?.handle

  /** Same as [removeSession] but for every session - module teardown only. */
  @Synchronized
  fun removeAll(): List<String> {
    val sessionIds = entries.keys.toList()
    entries.clear()
    return sessionIds
  }
}
