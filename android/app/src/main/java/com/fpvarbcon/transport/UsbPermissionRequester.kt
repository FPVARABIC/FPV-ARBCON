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
 * pass since the investigation is still open. A fourth line, "(a2)", now
 * also marks the [UsbManager.hasPermission] already-granted branch, which
 * real-device evidence (a first attempt timing out with no (c) line at
 * all, followed by an immediate-success second attempt on the same,
 * still-plugged-in device) strongly suggests is exactly what let that
 * second attempt succeed - the system had already granted permission; only
 * the first attempt's *broadcast delivery* was ever actually broken.
 *
 * PASS5.6-HYPOTHESIS-A-FIX (honest status, not overstated): the permission
 * PendingIntent below now matches the pinned usb-serial-for-android 3.10.0
 * dependency's own official TerminalFragment.java example exactly -
 * FLAG_MUTABLE instead of FLAG_IMMUTABLE, and intent.setPackage(context.
 * packageName) added to the base Intent - RECEIVER_NOT_EXPORTED above is
 * unchanged, already independently verified to match that same example.
 *
 * What this fix is CONFIRMED to address: nothing yet, on its own reasoning
 * merits - see the honest gap below. What it is well-justified to try:
 * matching, exactly, a widely-used dependency's own real-device-proven
 * pattern for the identical PendingIntent/broadcast/receiver triangle this
 * class implements, on the reasonable assumption that pattern is unlikely
 * to be broken for the library's own userbase.
 *
 * The gap, stated plainly: FLAG_IMMUTABLE's own documented and (this pass)
 * source-verified behavior - confirmed directly from PendingIntent.java's
 * real send(Context, int, Intent) implementation, not just its javadoc -
 * is to silently ignore the fillIn Intent's extras while still dispatching
 * the underlying broadcast normally. That predicts onReceive() still
 * firing, just with EXTRA_PERMISSION_GRANTED missing (defaulting to
 * false) - a fast, WRONG PERMISSION_DENIED - not the complete absence of
 * any (c) log line that was actually observed. No mechanism was found by
 * which FLAG_IMMUTABLE, specifically, could cause the whole broadcast
 * dispatch to be skipped rather than merely stripped of its extras.
 * Similarly, no citable, technically-verified mechanism was found by which
 * a missing intent.setPackage() specifically causes total non-delivery to
 * a dynamically ([Context.registerReceiver]-registered, not
 * manifest-declared) receiver for an already package-name-prefixed custom
 * action - the Android implicit-broadcast delivery restrictions this
 * general advice usually addresses are documented to exempt dynamically
 * registered receivers. Honest classification: **a real bug worth fixing,
 * matching a proven working pattern exactly, but not confirmed to be the
 * full explanation for the total-non-delivery symptom observed** - the
 * (a)/(b)/(c) diagnostic logs above are kept active specifically because
 * this fix's actual effect on real hardware is still unconfirmed.
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
      Log.d(DIAGNOSTIC_TAG, "(a2) permission already granted, resolving synchronously for device ${device.deviceId}")
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

    // PASS5.6-HYPOTHESIS-A-FIX: setPackage() + FLAG_MUTABLE, matching the
    // pinned usb-serial-for-android 3.10.0 dependency's own official
    // example (TerminalFragment.java) exactly for this identical PendingIntent
    // - see this class's own class-level note for what this is confirmed vs.
    // suspected to fix. minSdkVersion is 24 (> Build.VERSION_CODES.M / 23),
    // so every device this app runs on is unconditionally past that
    // library example's own `SDK_INT >= M` guard - verified against
    // android/build.gradle's minSdkVersion, not assumed - so no version
    // check is needed here; FLAG_MUTABLE is used unconditionally.
    val permissionRequestIntent = Intent(permissionAction).apply { setPackage(context.packageName) }
    val permissionIntent =
      PendingIntent.getBroadcast(context, 0, permissionRequestIntent, PendingIntent.FLAG_MUTABLE)

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
