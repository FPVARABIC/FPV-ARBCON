package com.fpvarbcon.transport

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log

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
 * PASS5.5-DIAGNOSTIC-LOG (temporary): three android.util.Log.d lines, tag
 * [DIAGNOSTIC_TAG], mark exactly where execution reaches - (a)
 * [requestPermission] being called at all, (b) [UsbManager.requestPermission]
 * actually being invoked (the permission broadcast request handed to the
 * system), and (c) the registered receiver's onReceive() actually firing
 * with a result. Added to give a correctly-timed real-device log capture
 * (see UsbAppLogCaptureModule.kt's PASS5.5-CAPTURE-TIMESTAMP note) a direct
 * answer to Hypothesis A - "the permission broadcast is never delivered" -
 * instead of an inference: if (a)/(b) appear in a capture but (c) never
 * does, the broadcast is confirmed lost, not merely suspected.
 *
 * Safe to leave permanently as far as cost goes - three Log.d calls on a
 * user-driven, once-per-connect-attempt path, never a hot loop - but these
 * are intended to be stripped once Hypothesis A is either confirmed or
 * ruled out and any real fix is in place, to keep debug-only diagnostic
 * noise out of the log for the shipped app long-term. Not stripped in this
 * pass since the investigation is still open.
 */
internal class UsbPermissionRequester(
  private val context: Context,
  private val usbManager: UsbManager,
) {

  private val permissionAction = "${context.packageName}.transport.USB_PERMISSION"
  private val pendingReceivers = mutableSetOf<BroadcastReceiver>()

  @Volatile private var cancelled = false

  /** onResult(granted, failureMessage). failureMessage set only for infrastructure failures. */
  fun requestPermission(device: UsbDevice, onResult: (granted: Boolean, failureMessage: String?) -> Unit) {
    Log.d(DIAGNOSTIC_TAG, "(a) requestPermission() called for device ${device.deviceId}")
    if (cancelled) return

    if (usbManager.hasPermission(device)) {
      onResult(true, null)
      return
    }

    var settled = false
    lateinit var receiver: BroadcastReceiver
    receiver =
      object : BroadcastReceiver() {
        override fun onReceive(receivedContext: Context, intent: Intent) {
          if (intent.action != permissionAction) return
          if (!unregister(this) || settled) return
          settled = true
          val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
          Log.d(DIAGNOSTIC_TAG, "(c) onReceive() fired for device ${device.deviceId}, granted=$granted")
          onResult(granted, null)
        }
      }

    synchronized(pendingReceivers) { pendingReceivers.add(receiver) }

    val filter = IntentFilter(permissionAction)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(receiver, filter)
    }

    val permissionIntent =
      PendingIntent.getBroadcast(context, 0, Intent(permissionAction), PendingIntent.FLAG_IMMUTABLE)

    try {
      Log.d(DIAGNOSTIC_TAG, "(b) usbManager.requestPermission() invoking for device ${device.deviceId}")
      usbManager.requestPermission(device, permissionIntent)
    } catch (error: Exception) {
      if (unregister(receiver) && !settled) {
        settled = true
        onResult(false, error.message ?: "Failed to request USB permission.")
      }
    }
  }

  /**
   * Removes [receiver] from the tracked set and unregisters it with the
   * system, but only the caller that actually performs the removal (returns
   * true) may proceed to settle its callback - guarantees exactly one
   * settlement per request even under concurrent unregister attempts.
   */
  private fun unregister(receiver: BroadcastReceiver): Boolean {
    val removed = synchronized(pendingReceivers) { pendingReceivers.remove(receiver) }
    if (removed) {
      try {
        context.unregisterReceiver(receiver)
      } catch (_: Exception) {
        // Already unregistered by the system (e.g. context torn down) - safe to ignore.
      }
    }
    return removed
  }

  /**
   * Unregisters every outstanding receiver and prevents any new request from
   * starting. Used by module invalidation. Does not call any pending
   * onResult callback - the owning open attempt's cleanup (releasing its
   * device reservation) is the caller's responsibility, not this class's.
   */
  fun cancelAll() {
    cancelled = true
    val receivers =
      synchronized(pendingReceivers) {
        val copy = pendingReceivers.toList()
        pendingReceivers.clear()
        copy
      }
    receivers.forEach { receiver ->
      try {
        context.unregisterReceiver(receiver)
      } catch (_: Exception) {
      }
    }
  }

  private companion object {
    const val DIAGNOSTIC_TAG = "UsbPermissionRequester"
  }
}
