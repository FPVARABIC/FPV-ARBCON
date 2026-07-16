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
}
