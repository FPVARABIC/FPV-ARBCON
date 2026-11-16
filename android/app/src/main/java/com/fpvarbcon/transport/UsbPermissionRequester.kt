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
/**
 * Runs the steps that hand a permission request over to Android -
 * registering the broadcast receiver, building the PendingIntent, asking
 * UsbManager - so that a failure in ANY of them ends in [onFailure]
 * rather than as an exception thrown back at whoever asked for
 * permission.
 *
 * It is deliberately free of Android types. UsbPermissionRequester cannot
 * be exercised off-device: Context, UsbManager, PendingIntent and
 * UsbDevice are all framework classes, and UsbDevice in particular has no
 * constructor an emulator test could call. This function is the part of
 * that class whose behaviour is a decision rather than a framework call,
 * so it is the part that can carry a real regression test - see
 * UsbPermissionHandshakeTest.
 *
 * [onFailure] runs at most once, and only for a failure: a handshake that
 * completes leaves the request pending on purpose, waiting for the
 * broadcast that will settle it.
 */
internal fun withPermissionHandshake(onFailure: (Exception) -> Unit, handshake: () -> Unit) {
  try {
    handshake()
  } catch (error: Exception) {
    onFailure(error)
  }
}

/**
 * RELEASE A RECEIVER AT MOST ONCE, AND SURVIVE A REFUSAL TO RELEASE IT.
 *
 * Two things have to be true of receiver cleanup and neither is obvious
 * from the call site:
 *
 *  1. EXACTLY ONCE. Three different things can decide a request is over -
 *     the broadcast arriving, the handover to Android failing, and
 *     cancelAll during module invalidation - and they can race. The
 *     ownership test is the REMOVAL from the pending map, not a flag read
 *     beforehand: whoever removes the receiver owns unregistering it, and
 *     everyone else finds nothing and does nothing.
 *
 *  2. A FAILURE TO UNREGISTER IS NOT A FAILURE. Android throws
 *     IllegalArgumentException from unregisterReceiver when the receiver
 *     is already gone - a torn-down Context has already dropped it - and
 *     that is the normal shape of teardown, not an error to propagate
 *     into a caller who is only trying to settle a promise. The receiver
 *     has still been removed from the map by then, so the cleanup did
 *     happen; only the platform call declined.
 *
 * Returns whether THIS call was the one that owned the removal, which is
 * what makes "exactly once" observable to a test.
 *
 * Deliberately free of Android types so the ownership and the swallowed
 * failure can both be proved off-device; UsbPermissionRequester cannot be
 * instantiated in a JVM test, and UsbDevice has no constructor an
 * instrumentation test could call either.
 */
internal fun <R : Any> unregisterReceiverOnce(take: () -> R?, unregister: (R) -> Unit): Boolean {
  val receiver = take() ?: return false
  try {
    unregister(receiver)
  } catch (_: Exception) {
    // Already unregistered by the system (e.g. context torn down) - safe to ignore.
  }
  return true
}

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

  /**
   * Returns the request id so a bounded waiter can abandon exactly this
   * request. Immediate outcomes have no registered request and return null.
   * onResult(granted, failureMessage): message is set for infrastructure failures.
   */
  fun requestPermission(device: UsbDevice, onResult: (granted: Boolean, failureMessage: String?) -> Unit): Long? {
    // EVERY EXIT FROM HERE CALLS BACK.
    //
    // UsbPermissionRequestCoordinator.register states the contract for a
    // null return: "the caller must then send nothing to Android and
    // settle its own promise". This used to do only the first half - both
    // cancelled paths returned silently - which leaves whoever called
    // requestPermission waiting on a callback that can no longer arrive.
    // Nothing was registered in that case, so cancelAll() has nothing to
    // drain and cannot settle it either.
    //
    // Calling back here cannot double-settle: the request never entered
    // the coordinator's pending map, so no other path owns it.
    if (coordinator.isCancelled()) {
      onResult(false, CANCELLED_MESSAGE)
      return null
    }

    if (usbManager.hasPermission(device)) {
      onResult(true, null)
      return null
    }

    val identity = UsbDeviceIdentity(device.deviceId, device.vendorId, device.productId)
    val requestId = coordinator.register(identity, onResult)
    if (requestId == null) {
      // Cancelled between the check above and the registration.
      onResult(false, CANCELLED_MESSAGE)
      return null
    }
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

    // THE WHOLE HANDSHAKE IS COVERED, NOT JUST ITS LAST STEP.
    //
    // Only usbManager.requestPermission used to be inside a try. The two
    // steps before it can throw as well - Context.registerReceiver raises
    // IllegalStateException once an app has accumulated too many
    // receivers, and either call can fail outright against a torn-down
    // context - and when one of them did, the exception left this method
    // while the coordinator still held the request. Nothing settled it and
    // nothing could: the broadcast it was waiting for is one this method
    // never asked Android to send.
    //
    // The caller was not left hanging forever, because
    // UsbSerialTransportModule.awaitPermissionResult waits on a bounded
    // latch, so the visible symptom was a connect attempt that spent the
    // whole connect budget before reporting "Permission result never
    // arrived" - a timeout standing in for an error that was already
    // known, with its real message thrown away. But this file's own
    // contract, three comments above, is "EVERY EXIT FROM HERE CALLS
    // BACK", and that exit did not.
    //
    // Nothing is swallowed here. The failure is delivered through the
    // same settle-once path and with the same message the throwing call
    // produced, exactly as the requestPermission failure already was.
    // withPermissionHandshake is a seam, not a policy: it exists so the
    // ordering above can be proved on the JVM without an Android device.
    withPermissionHandshake(
      onFailure = { error ->
        val failed = coordinator.settle(requestId, UsbPermissionRequestCoordinator.SettleReason.REQUEST_FAILURE)
        unregister(requestId)
        failed?.onResult(false, error.message ?: "Failed to request USB permission.")
      },
    ) {
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

      usbManager.requestPermission(device, permissionIntent)
    }
    return requestId
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
    unregisterReceiverOnce(
      take = { synchronized(pendingReceivers) { pendingReceivers.remove(requestId) } },
      unregister = context::unregisterReceiver,
    )
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

  private companion object {
    /**
     * Worded to match cancelAll()'s own drain message, so a caller cannot
     * tell - and does not need to - whether its request was refused before
     * or after it reached the coordinator.
     */
    const val CANCELLED_MESSAGE = "USB permission request was cancelled (module invalidated)."
  }
}
