package com.fpvarbcon.transport

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build

/**
 * Wraps Android's asynchronous USB permission request/response broadcast
 * into a single callback. No retries, no persistence across calls.
 *
 * Every registered receiver is tracked so it can be force-unregistered by
 * [cancelAll] (module invalidation). Unregistering is idempotent and
 * concurrency-safe: it's gated on successfully removing the receiver from
 * the tracked set, so exactly one of {the broadcast arriving, a request
 * failure, cancelAll} performs the actual unregister and callback for any
 * given request - a late broadcast arriving after cancelAll finds its
 * receiver already removed and does nothing.
 *
 * PASS5.6 correction (confirmed root cause, verified fixed on real
 * hardware): the permission PendingIntent below uses FLAG_MUTABLE and
 * calls intent.setPackage(context.packageName) on its base Intent -
 * matching the pinned usb-serial-for-android 3.10.0 dependency's own
 * official TerminalFragment.java example exactly. A prior version of this
 * class used FLAG_IMMUTABLE and no setPackage(), which caused the
 * permission-result broadcast to silently fail to reach this class's own
 * onReceive() on real hardware - openDevice() would hang indefinitely with
 * no error at all (confirmed via temporary diagnostic logging and a real
 * connect attempt that only succeeded on an immediate, unplug-free second
 * retry - permission had in fact already been granted; only the first
 * attempt's broadcast delivery was broken). Switching to this exact,
 * library-proven pattern was subsequently confirmed fixed via repeated
 * real-device retest: first-attempt connects now succeed consistently.
 * RECEIVER_NOT_EXPORTED (below) was already independently verified correct
 * against the same library example and is unaffected by this correction.
 */
internal class UsbPermissionRequester(
  private val context: Context,
  private val usbManager: UsbManager,
) {

  /**
   * PASS 7.7: the action is now PER REQUEST
   * ("<pkg>.transport.USB_PERMISSION.<uniqueId>") instead of one shared
   * string, and every broadcast is validated against the exact requesting
   * device before it may settle anything - see
   * [UsbPermissionRequestCoordinator] for the confirmed baseline defects
   * (no request identity, no EXTRA_DEVICE validation, no device
   * comparison, duplicate/foreign broadcasts accepted) this closes.
   */
  private val coordinator = UsbPermissionRequestCoordinator("${context.packageName}.transport.USB_PERMISSION")
  private val pendingReceivers = mutableMapOf<Long, BroadcastReceiver>()

  /** onResult(granted, failureMessage). failureMessage set only for infrastructure failures. */
  fun requestPermission(device: UsbDevice, onResult: (granted: Boolean, failureMessage: String?) -> Unit) {
    if (coordinator.isCancelled()) return

    if (usbManager.hasPermission(device)) {
      onResult(true, null)
      return
    }

    val identity = UsbDeviceIdentity(device.deviceId, device.vendorId, device.productId)
    val requestId = coordinator.register(identity, onResult) ?: return
    val action = coordinator.actionFor(requestId)

    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(receivedContext: Context, intent: Intent) {
          // Validate the exact action, the presence of EXTRA_DEVICE and
          // the device identity itself. A wrong-device, stale, duplicate
          // or spoofed broadcast matches nothing and settles nothing.
          val received = extractDevice(intent)
          val matched =
            coordinator.matchResult(
              intent.action,
              requestId,
              received?.let { UsbDeviceIdentity(it.deviceId, it.vendorId, it.productId) },
            ) ?: return
          unregister(requestId)
          val granted =
            intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) &&
              !coordinator.isCancelled()
          matched.onResult(granted, null)
        }
      }

    synchronized(pendingReceivers) { pendingReceivers[requestId] = receiver }

    val filter = IntentFilter(action)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      // API 33+ requires an explicit export flag for dynamically
      // registered receivers; this receiver is internal to the app only.
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(receiver, filter)
    }

    // FLAG_MUTABLE + setPackage() - retained verbatim from the Pass 5.6
    // real-hardware fix (see the file history note below): the USB
    // framework fills EXTRA_DEVICE/EXTRA_PERMISSION_GRANTED into this
    // intent, so it must remain mutable, and setPackage() keeps delivery
    // scoped to this app. minSdkVersion is 24 (android/build.gradle), so
    // no pre-M branch is needed.
    val permissionRequestIntent = Intent(action).apply { setPackage(context.packageName) }
    val permissionIntent =
      PendingIntent.getBroadcast(
        context,
        // A distinct requestCode per request: two concurrent requests must
        // not collide onto one cached PendingIntent.
        requestId.toInt(),
        permissionRequestIntent,
        PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )

    try {
      usbManager.requestPermission(device, permissionIntent)
    } catch (error: Exception) {
      val failed = coordinator.settle(requestId, UsbPermissionRequestCoordinator.SettleReason.REQUEST_FAILURE)
      unregister(requestId)
      failed?.onResult(false, error.message ?: "Failed to request USB permission.")
    }
  }

  /**
   * PASS 7.7: gives the caller a bounded way out of a permission wait that
   * never answers. Settles the request exactly once (nothing else can
   * settle it afterwards - a late grant finds no pending entry and cannot
   * open USB) and unregisters its receiver.
   */
  fun abandonRequest(requestId: Long, reason: UsbPermissionRequestCoordinator.SettleReason) {
    val abandoned = coordinator.settle(requestId, reason)
    unregister(requestId)
    abandoned?.onResult(false, "USB permission request was cancelled before a result arrived.")
  }

  @Suppress("DEPRECATION")
  private fun extractDevice(intent: Intent): UsbDevice? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
    } else {
      intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
    }

  /** Unregisters (idempotently) the receiver owned by [requestId]. */
  private fun unregister(requestId: Long) {
    val receiver = synchronized(pendingReceivers) { pendingReceivers.remove(requestId) } ?: return
    try {
      context.unregisterReceiver(receiver)
    } catch (_: Exception) {
      // Already unregistered by the system (e.g. context torn down) - safe to ignore.
    }
  }

  /**
   * Unregisters every outstanding receiver and prevents any new request
   * from starting. Used by module invalidation. Pending callbacks are
   * settled as not-granted so no caller can wait forever, and a late grant
   * arriving afterwards can never open USB.
   */
  fun cancelAll() {
    val drained = coordinator.cancelAll()
    val receivers =
      synchronized(pendingReceivers) {
        val copy = pendingReceivers.values.toList()
        pendingReceivers.clear()
        copy
      }
    receivers.forEach { receiver ->
      try {
        context.unregisterReceiver(receiver)
      } catch (_: Exception) {
      }
    }
    drained.forEach { request ->
      request.onResult(false, "USB permission request was cancelled (module invalidated).")
    }
  }

  /** Test/diagnostic seam: how many permission requests are still pending. */
  fun pendingRequestCount(): Int = coordinator.pendingCount()
}
