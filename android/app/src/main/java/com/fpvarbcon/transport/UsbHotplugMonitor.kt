package com.fpvarbcon.transport

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * The only three outcomes of classifying a broadcast action, reduced to a
 * plain enum so the mapping is a pure function of a String - this is what
 * makes it unit-testable on the JVM without any Android runtime (see
 * UsbHotplugMonitorTest.kt).
 */
internal enum class UsbHotplugAction { ATTACHED, DETACHED, IGNORED }

internal fun classifyUsbHotplugAction(action: String?): UsbHotplugAction =
  when (action) {
    UsbManager.ACTION_USB_DEVICE_ATTACHED -> UsbHotplugAction.ATTACHED
    UsbManager.ACTION_USB_DEVICE_DETACHED -> UsbHotplugAction.DETACHED
    else -> UsbHotplugAction.IGNORED
  }

/** What UsbHotplugMonitor.onReceive should do for one received broadcast. */
internal sealed class UsbHotplugDecision {
  internal data class Attached(val identity: UsbDeviceIdentity) : UsbHotplugDecision()

  internal data class Detached(val identity: UsbDeviceIdentity) : UsbHotplugDecision()

  internal object Ignore : UsbHotplugDecision()
}

/**
 * Pure decision function: given the broadcast's action and the device
 * identity Android's UsbDevice extra already resolved to (or null if the
 * extra was missing/malformed), decides what this monitor should do.
 *
 * Deliberately takes a plain nullable [UsbDeviceIdentity] - not an
 * Intent, not a UsbDevice - so it needs no Android runtime to test and has
 * no path to derive identity from anything other than the three canonical
 * fields (there is no alternative arbitrary-extra identity path: this
 * function cannot see any other extra even if one existed). The only
 * Android-specific work (reading intent.action and extracting/mapping the
 * UsbDevice extra) happens in onReceive below, which forwards its result
 * here unchanged - keeping the untestable Android glue to two lines.
 */
internal fun decideUsbHotplugAction(
  action: String?,
  identity: UsbDeviceIdentity?,
): UsbHotplugDecision {
  if (identity == null) return UsbHotplugDecision.Ignore
  return when (classifyUsbHotplugAction(action)) {
    UsbHotplugAction.ATTACHED -> UsbHotplugDecision.Attached(identity)
    UsbHotplugAction.DETACHED -> UsbHotplugDecision.Detached(identity)
    UsbHotplugAction.IGNORED -> UsbHotplugDecision.Ignore
  }
}

/**
 * Observes Android's system USB hot-plug broadcasts
 * (USB_DEVICE_ATTACHED/USB_DEVICE_DETACHED) for the lifetime of the owning
 * TurboModule. Mirrors UsbPermissionRequester's dynamic-registration
 * *pattern* (tracked receiver, idempotent start/stop) but is otherwise a
 * fully independent mechanism: separate BroadcastReceiver instance, separate
 * action filter, separate lifecycle field, separate purpose. Changing this
 * class does not alter UsbPermissionRequester or the existing permission
 * flow in any way - the permission dialog still only appears from inside
 * openDevice(), never from here.
 *
 * [start] registers at most one receiver (idempotent - a second call is a
 * no-op while one is already registered) and [stop] unregisters it at most
 * once (idempotent - a second call finds nothing left to unregister).
 * Never requests permission, never opens a device, never creates a session -
 * it only reports the canonical identity (deviceId/vendorId/productId) of
 * the device that was just attached or detached to its owner's callbacks.
 * No polling and no timers: every call to [onAttached]/[onDetached] is
 * driven directly by a real system broadcast.
 *
 * ── Why RECEIVER_NOT_EXPORTED is the correct flag here (not
 * RECEIVER_EXPORTED) ──
 *
 * Both android.hardware.usb.action.USB_DEVICE_ATTACHED and
 * ...USB_DEVICE_DETACHED are declared `<protected-broadcast>` entries in the
 * Android platform's own framework manifest. A protected-broadcast action
 * can only ever be sent by the system (system_server / UID
 * android.uid.system) - the platform's broadcast-queue rejects any attempt
 * by a third-party app to send an Intent carrying one of these exact
 * actions with a SecurityException, regardless of what any receiver's
 * export flag is. This is the same category as ACTION_BATTERY_CHANGED,
 * CONNECTIVITY_ACTION, BOOT_COMPLETED, etc.
 *
 * RECEIVER_EXPORTED vs RECEIVER_NOT_EXPORTED (the flag Android has required
 * for context-registered receivers since API 33/Tiramisu) governs one thing
 * only: whether *other apps installed on the device* may successfully
 * target this receiver with their own broadcast Intent. It has no bearing
 * on whether the system's own broadcasts reach this receiver - those are
 * always delivered to any matching context-registered receiver, exported or
 * not, exactly as they always were before API 33 introduced this flag.
 *
 * Because no other app on the device can ever legally send
 * USB_DEVICE_ATTACHED/DETACHED in the first place, RECEIVER_EXPORTED would
 * add same-device attack surface (allowing other installed apps to attempt
 * to target this receiver with a spoofed - and, thanks to the strict
 * identity validation in [decideUsbHotplugAction], harmless - Intent) for
 * zero functional benefit: the real system broadcasts this monitor actually
 * needs are unaffected by the flag either way. RECEIVER_NOT_EXPORTED is
 * therefore both correct and the more conservative choice, and is not
 * merely copied from UsbPermissionRequester's own (different-purpose,
 * application-owned-action) receiver.
 *
 * Registration/cleanup correctness (no duplicate receiver, safe unregister
 * under concurrent teardown) and the Android-specific extraction step in
 * [onReceive] (reading intent.action, resolving the UsbDevice extra) cannot
 * be exercised by this project's plain-JUnit Kotlin unit tests - there is no
 * Robolectric or other Android runtime dependency in this Gradle module (see
 * app/build.gradle's testImplementation list), so Context/Intent/
 * UsbManager/UsbDevice cannot be instantiated or invoked off a real device
 * or emulator, and no Mockito/Robolectric was added to work around that (see
 * Pass 4.7 review). Everything that can be pulled out of that Android-only
 * shell into a plain function - action classification and the
 * attach/detach/ignore decision - is unit tested in
 * UsbHotplugMonitorTest.kt; the rest is verified by source review here and
 * the Pass 4.7 report's physical test checklist.
 */
internal class UsbHotplugMonitor(
  private val context: Context,
  private val onAttached: (UsbDeviceIdentity) -> Unit,
  private val onDetached: (UsbDeviceIdentity) -> Unit,
) {
  private var receiver: BroadcastReceiver? = null

  @Synchronized
  fun start() {
    if (receiver != null) return

    val newReceiver =
      object : BroadcastReceiver() {
        override fun onReceive(receivedContext: Context, intent: Intent) {
          val device: UsbDevice? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
            } else {
              @Suppress("DEPRECATION") intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
            }
          val identity = device?.let { UsbDeviceIdentity(it.deviceId, it.vendorId, it.productId) }

          when (val decision = decideUsbHotplugAction(intent.action, identity)) {
            is UsbHotplugDecision.Attached -> onAttached(decision.identity)
            is UsbHotplugDecision.Detached -> onDetached(decision.identity)
            UsbHotplugDecision.Ignore -> Unit
          }
        }
      }

    val filter =
      IntentFilter().apply {
        addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
        addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
      }

    // ContextCompat.registerReceiver translates this single call to the
    // correct real registerReceiver overload on every API level this app
    // supports (minSdk 24) - the flag is simply dropped pre-33, matching
    // what the manual Build.VERSION.SDK_INT branch used to do by hand.
    ContextCompat.registerReceiver(context, newReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    receiver = newReceiver
  }

  @Synchronized
  fun stop() {
    val current = receiver ?: return
    receiver = null
    try {
      context.unregisterReceiver(current)
    } catch (_: Exception) {
      // Already unregistered by the system (e.g. context torn down) - safe to ignore.
    }
  }
}
