package com.fpvarbcon.debug

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * TEMPORARY DEBUG SCAFFOLDING (Pass 5.3) - NOT part of the transport layer,
 * NOT a production feature. Exists solely so Ahmed can capture this app's
 * own process logcat output (including usb-serial-for-android's internal
 * Log.d calls, tags "CdcAcmSerialDriver"/"CommonUsbSerialPort") directly
 * from the device, without a working adb connection, while debugging the
 * openDevice() hang. Deliberately a plain (non-TurboModule) NativeModule -
 * registered via [UsbAppLogCapturePackage] - rather than any addition to
 * UsbSerialTransportModule/NativeUsbSerialTransportSpec, so the real
 * transport contract is never touched by this scaffolding.
 *
 * PASS5.3-DEBUG-LOGCAT: only ever reads THIS app's own process log, never
 * any other app's or the system-wide log. Achieved by passing
 * `--pid=<this process's own android.os.Process.myPid()>` to `logcat -d`
 * (a one-shot dump-and-exit, never a continuous stream) - no
 * android.permission.READ_LOGS is declared or required, and none is added
 * to AndroidManifest.xml for this.
 *
 * Verified (not assumed) that this works without READ_LOGS, per Android's
 * own logging daemon (logd) access model: a process may always read log
 * entries logd recorded for its own UID without any additional permission
 * - READ_LOGS (a privileged/system permission ordinary apps cannot hold,
 * per developer.android.com/privacy-and-security/risks/log-info-disclosure:
 * "Since Android 4.1 (API level 16), only privileged system apps can be
 * granted access to read logcat, by declaring the READ_LOGS permission")
 * is what gates reading OTHER apps' or system-wide log entries, not an
 * app's own. This is the same mechanism widely-used crash/diagnostic
 * libraries (e.g. ACRA's LogcatCollector) rely on to attach a device's own
 * recent log output without any elevated permission.
 *
 * IMPORTANT CAVEAT, found during this same investigation and not silently
 * worked around: on Android 13 (API 33) and above, a newer
 * LogcatManagerService layer was introduced that can additionally gate ANY
 * app's attempt to invoke logcat - including reading its own log - behind
 * a one-time system consent dialog ("Allow this app to access system
 * logs?"), per publicly-filed Android platform issues (issuetracker.
 * google.com/issues/243904932 and .../232206670) describing exactly this
 * behavior. This project's targetSdk (36) is well within the affected
 * range. No official developer.android.com page was found pinning down
 * this dialog's exact trigger conditions precisely enough to code
 * defensively against it here - this is reported as a known, credible risk
 * for real-device testing on Android 13+, not as a confirmed, fully-
 * understood mechanism. If this dialog appears on Ahmed's device, this
 * method's Promise will simply reject or return empty/incomplete output
 * once logcat itself fails or produces nothing - see [captureAppLog]'s own
 * bounded-wait handling below, which never hangs indefinitely regardless.
 */
internal class UsbAppLogCaptureModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val core =
    UsbAppLogCaptureCore(
      startProcess = {
        val ownPid = android.os.Process.myPid()
        ProcessBuilder("logcat", "-d", "--pid=$ownPid").redirectErrorStream(true).start()
      },
    )

  override fun getName(): String = NAME

  /**
   * Captures this process's own recent logcat output as a single string
   * and resolves [promise] with it. Never reads any other process's log.
   *
   * Pass 7.7: the whole process lifecycle (success, read error, timeout,
   * explicit cancellation and module invalidation, plus the settle-once
   * rule) now lives in [UsbAppLogCaptureCore], a plain JVM object with
   * its own unit tests - this method is only the bridge adapter.
   */
  @ReactMethod
  fun captureAppLog(promise: Promise) {
    core.capture(
      object : AppLogCaptureOutcome {
        override fun resolve(output: String) {
          promise.resolve(output)
        }

        override fun reject(code: String, message: String) {
          promise.reject(code, message)
        }
      },
    )
  }

  /** Explicit cancellation - terminates any in-flight capture process. */
  @ReactMethod
  fun cancelAppLogCapture() {
    core.cancel()
  }

  /** React context teardown: nothing may survive it. */
  override fun invalidate() {
    core.invalidate()
    super.invalidate()
  }

  private companion object {
    const val NAME = "UsbAppLogCapture"
  }
}
