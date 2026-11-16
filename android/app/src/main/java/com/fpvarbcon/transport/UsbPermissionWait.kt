package com.fpvarbcon.transport

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

internal data class PermissionOutcome(val granted: Boolean, val failureMessage: String?)

/**
 * Bridges the permission callback onto the open-attempt worker. Expiry or
 * interruption must retire this request as well as stop waiting for it;
 * otherwise each unanswered dialog leaves a receiver and callback behind.
 * The requester owns settle-once arbitration with broadcasts/invalidation.
 */
internal fun awaitUsbPermissionResult(
  timeoutMillis: Long,
  requestPermission: ((Boolean, String?) -> Unit) -> Long?,
  abandonRequest: (Long, UsbPermissionRequestCoordinator.SettleReason) -> Unit,
): PermissionOutcome {
  require(timeoutMillis >= 0) { "Permission timeout must be non-negative." }
  val latch = CountDownLatch(1)
  val outcome = AtomicReference(PermissionOutcome(false, "Permission result never arrived."))
  val requestId = requestPermission { granted, failureMessage ->
    outcome.set(PermissionOutcome(granted, failureMessage))
    latch.countDown()
  }
  var abandonedBecause: UsbPermissionRequestCoordinator.SettleReason? = null
  try {
    if (!latch.await(timeoutMillis, TimeUnit.MILLISECONDS)) {
      abandonedBecause = UsbPermissionRequestCoordinator.SettleReason.TIMEOUT
      return PermissionOutcome(false, "Timed out waiting for the USB permission result.")
    }
    return outcome.get()
  } catch (error: InterruptedException) {
    abandonedBecause = UsbPermissionRequestCoordinator.SettleReason.CANCELLED
    throw error
  } finally {
    val reason = abandonedBecause
    if (requestId != null && reason != null) {
      abandonRequest(requestId, reason)
    }
  }
}
