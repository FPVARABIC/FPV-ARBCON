package com.fpvarbcon.transport

import java.util.concurrent.atomic.AtomicLong

/**
 * Pass 7.7 - the PURE, framework-free decision core extracted out of
 * [UsbPermissionRequester], so the permission lifecycle rules can be unit
 * tested on the JVM without Android, Robolectric or any new dependency
 * (this project's existing native tests are plain JUnit - see
 * UsbBoundedAttemptTest/UsbPromiseSettleOnceTest for the same pattern).
 *
 * CONFIRMED baseline defects this seam fixes (all read from the Pass 7.6c
 * baseline source of UsbPermissionRequester.kt, not assumed):
 *
 *  1. NO REQUEST IDENTITY. Every request registered a receiver for the
 *     same action string and accepted ANY broadcast carrying that action.
 *     Two concurrent requests (two attached devices) could therefore
 *     consume each other's result.
 *  2. NO DEVICE VALIDATION. onReceive() never read
 *     UsbManager.EXTRA_DEVICE and never compared it with the device the
 *     request was made for, so a result for device B could settle the
 *     request for device A.
 *  3. NO EXTRA VALIDATION. A broadcast with the right action but no
 *     EXTRA_DEVICE (or a replayed/duplicate one) was accepted as an
 *     authoritative answer.
 *  4. UNBOUNDED WAIT. The caller bridged the callback with
 *     CountDownLatch.await() with no timeout of its own
 *     (UsbSerialTransportModule.awaitPermissionResult), relying entirely
 *     on an outer watchdog that abandons - but cannot stop - the worker.
 *
 * The coordinator below owns exactly those decisions:
 *  - it mints a unique, monotonically increasing request id per request
 *    and binds it to ONE [UsbDeviceIdentity];
 *  - [matchResult] accepts a broadcast only when the action, the request
 *    id and the device identity all match a still-pending request;
 *  - every request settles EXACTLY ONCE ([settle] returns the callback
 *    only to the first caller - broadcast, timeout, cancel or invalidate);
 *  - after [cancelAll] no new request may start and nothing pending can
 *    settle as granted.
 *
 * It deliberately contains no Android imports: UsbDeviceIdentity is this
 * project's own plain data class.
 */
internal class UsbPermissionRequestCoordinator(private val actionPrefix: String) {

  /** Per-request action string: package-scoped prefix + unique id, so two
   * concurrent requests can never share a broadcast filter. */
  fun actionFor(requestId: Long): String = "$actionPrefix.$requestId"

  internal data class PendingRequest(
    val requestId: Long,
    val device: UsbDeviceIdentity,
    val onResult: (granted: Boolean, failureMessage: String?) -> Unit,
  )

  /** Why a pending request stopped being pending - reported for logging
   * and for the caller's own cleanup decisions. */
  internal enum class SettleReason {
    BROADCAST,
    REQUEST_FAILURE,
    TIMEOUT,
    CANCELLED,
    INVALIDATED,
  }

  private val nextRequestId = AtomicLong(1)
  private val pending = LinkedHashMap<Long, PendingRequest>()

  @Volatile private var cancelled = false

  /** True once [cancelAll] has run: no new request may be registered and
   * no late grant may open USB. */
  fun isCancelled(): Boolean = cancelled

  fun pendingCount(): Int = synchronized(pending) { pending.size }

  /**
   * Registers a new request. Returns its unique id, or null when the
   * coordinator has already been cancelled/invalidated (the caller must
   * then send nothing to Android and settle its own promise).
   */
  fun register(
    device: UsbDeviceIdentity,
    onResult: (granted: Boolean, failureMessage: String?) -> Unit,
  ): Long? {
    if (cancelled) return null
    val requestId = nextRequestId.getAndIncrement()
    synchronized(pending) {
      if (cancelled) return null
      pending[requestId] = PendingRequest(requestId, device, onResult)
    }
    return requestId
  }

  /**
   * Validates a received broadcast against the still-pending request set.
   * Returns the request ONLY when every check passes; the request is
   * simultaneously removed, so a duplicate/replayed broadcast for the same
   * id returns null and settles nothing.
   *
   * Rejects: wrong/unknown action, unknown or already-settled request id,
   * missing device identity (caller passes null when
   * UsbManager.EXTRA_DEVICE is absent), and a device that is not the exact
   * device this request was made for.
   */
  fun matchResult(action: String?, requestId: Long, device: UsbDeviceIdentity?): PendingRequest? {
    if (action == null || action != actionFor(requestId)) return null
    if (device == null) return null
    synchronized(pending) {
      val request = pending[requestId] ?: return null
      if (request.device != device) return null
      pending.remove(requestId)
      return request
    }
  }

  /**
   * Removes a pending request for a non-broadcast reason (timeout, cancel,
   * request failure, module invalidation). Returns it to exactly one
   * caller; every later attempt gets null.
   */
  fun settle(requestId: Long, reason: SettleReason): PendingRequest? {
    val request = synchronized(pending) { pending.remove(requestId) } ?: return null
    lastSettleReason = reason
    return request
  }

  /** Diagnostic only - the reason of the most recent non-broadcast settle. */
  @Volatile var lastSettleReason: SettleReason? = null
    private set

  /**
   * Invalidates the coordinator and drains every pending request. Returns
   * them so the caller can unregister receivers and settle callbacks; a
   * late grant arriving afterwards can never match (the pending map is
   * empty and [cancelled] blocks re-registration).
   */
  fun cancelAll(): List<PendingRequest> {
    cancelled = true
    val drained = synchronized(pending) {
      val copy = pending.values.toList()
      pending.clear()
      copy
    }
    if (drained.isNotEmpty()) {
      lastSettleReason = SettleReason.CANCELLED
    }
    return drained
  }
}
