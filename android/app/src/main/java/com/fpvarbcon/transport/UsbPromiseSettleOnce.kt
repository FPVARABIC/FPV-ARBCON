package com.fpvarbcon.transport

import com.facebook.react.bridge.Promise
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Wraps a single [Promise] so it can only ever be resolved or rejected once,
 * race-safe under concurrent callers - the same single-shot AtomicBoolean
 * guard pattern UsbBoundedProcessReader.kt and UsbBoundedAttempt.kt already
 * use, applied here to a React Native Promise specifically.
 *
 * PASS5.4-CONNECT-TIMEOUT: this exists because openDevice()'s completeOpen()
 * can now settle a connect attempt's Promise directly from its own worker
 * thread (a real open succeeding or failing) at the same time
 * [runOnDedicatedThreadWithTimeout]'s watchdog thread tries to settle the
 * very same Promise with CONNECT_TIMEOUT - two independent call sites racing
 * to touch one Promise, which is exactly what this class makes safe.
 *
 * This is a distinct guard from [runOnDedicatedThreadWithTimeout]'s own
 * internal `settled` flag: that one only decides whether [work] or the
 * watchdog gets to classify the outcome as Completed vs TimedOut, and has no
 * visibility into completeOpen()'s own direct resolve/reject calls happening
 * from inside [work] itself. Both guards are necessary, at different layers.
 *
 * PASS5.4-AUDIT-1 (session-leak correction): [resolve]/[reject] now return
 * whether THIS call's own CAS actually won - a confirmed bug (not merely a
 * hypothetical) showed why the caller needs that signal, not just a fire-
 * and-forget settlement: completeOpen()'s ACCEPTED branch can insert a live,
 * fully-opened session into UsbSerialSessionRegistry and then lose its own
 * `settle.resolve(sessionId)` call to a concurrent
 * `settle.reject(CONNECT_TIMEOUT)` from the connect-timeout watchdog - the
 * registry insertion and the Promise settlement are two independent races
 * (one guarded by the registry's own monitor, this one guarded by [settled]
 * here) with no ordering tying them together. Without checking the returned
 * Boolean, that session would sit in the registry forever with no sessionId
 * JS was ever told about, and no code path would ever close it.
 *
 * Any caller that inserts a resource (a registry entry, an opened
 * connection, etc.) *before* calling [resolve] MUST check the returned
 * value and clean that resource up itself if it comes back `false` - a
 * `false` return means some other settlement already reached JS first, so
 * nothing this caller does after that point is visible to JS anymore.
 * Two easy-to-get-wrong details for that cleanup, learned directly from
 * fixing the completeOpen() case above:
 *  - Remove the resource by the exact identity this attempt created (e.g.
 *    sessionId), NEVER by a broader key it merely shares (e.g. deviceId) -
 *    a wholly different, newer attempt may already have inserted its own
 *    valid resource under that broader key by the time this cleanup runs.
 *  - Only actually close/dispose the resource if that identity-scoped
 *    removal call reports it actually found and removed this exact
 *    resource. If it reports nothing removed, some other path (e.g. a
 *    genuine device detach, matched by the broader key) has already
 *    claimed and very likely already closed it concurrently - closing it
 *    again here would double-close, which the underlying native resource
 *    is not guaranteed to tolerate.
 */
internal class UsbPromiseSettleOnce(private val promise: Promise) {
  private val settled = AtomicBoolean(false)

  /** Returns true if this call's own CAS won and [promise] was actually resolved - false if another settlement already won. */
  fun resolve(value: Any?): Boolean {
    if (settled.compareAndSet(false, true)) {
      promise.resolve(value)
      return true
    }
    return false
  }

  /** Returns true if this call's own CAS won and [promise] was actually rejected - false if another settlement already won. */
  fun reject(error: UsbTransportException): Boolean {
    if (settled.compareAndSet(false, true)) {
      promise.rejectTransportError(error)
      return true
    }
    return false
  }
}
