package com.fpvarbcon.transport

import android.content.Context
import android.hardware.usb.UsbManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import java.util.UUID

/**
 * Thin TurboModule bridge for USB serial transport. listDevices(),
 * openDevice(), and closeSession() have real behavior in this pass.
 * writeBytes() remains a temporary stub until its approved pass lands - no
 * read loop, no data transmission here yet.
 *
 * Session creation order (locked, see Pass 4 correction) is exactly:
 * 1. validate SerialConfiguration
 * 2. find and preserve device identity (deviceId/vendorId/productId)
 * 3. validate driver and port
 * 4. reserve device
 * 5. request/confirm permission (async)
 * 6. re-fetch and revalidate device identity
 * 7. open UsbDeviceConnection
 * 8. open UsbSerialPort
 * 9. apply setParameters
 * 10. apply setFlowControl
 * 11. create the completed local session and its UUID sessionId
 * 12. enter the lifecycle gate
 * 13. if the module is still valid, insert the session atomically
 * 14. exit the lifecycle gate
 * 15. if accepted, resolve openDevice(sessionId)
 * 16. if invalidated, close the unaccepted local session without settling
 *     the Promise
 * No sessionId is generated and no registry insertion happens before step 10
 * succeeds. No registry insertion is possible once invalidated becomes true,
 * because both that check and the insertion happen inside the same
 * lifecycle-lock critical section as invalidate()'s own drain (see
 * [lifecycleLock] and [invalidate] below) - there is no timing window where
 * invalidate() can drain first and a session gets inserted afterward.
 */
class UsbSerialTransportModule(reactContext: ReactApplicationContext) :
  NativeUsbSerialTransportSpec(reactContext) {

  private val usbManager: UsbManager by lazy {
    reactApplicationContext.getSystemService(Context.USB_SERVICE) as UsbManager
  }

  private val enumerator: UsbSerialDeviceEnumerator by lazy { UsbSerialDeviceEnumerator(usbManager) }

  private val prober = UsbSerialProber.getDefaultProber()

  private val sessionRegistry = UsbSerialSessionRegistry()

  private val permissionRequester: UsbPermissionRequester by lazy {
    UsbPermissionRequester(reactApplicationContext, usbManager)
  }

  /**
   * Registered eagerly (not lazily) so hot-plug is observed for this
   * module's entire lifetime, starting at construction - not merely from
   * whenever JS happens to first call listDevices() or subscribe to an
   * event. Stopped in [invalidate]. See UsbHotplugMonitor's own class-level
   * note for what is and is not unit-testable about this wiring.
   */
  private val hotplugMonitor: UsbHotplugMonitor =
    UsbHotplugMonitor(
      context = reactApplicationContext,
      onAttached = ::handleDeviceAttached,
      onDetached = ::handleDeviceDetached,
    ).also { it.start() }

  /**
   * Runs a detached device's stale-session close() off handleDeviceDetached
   * (and therefore off BroadcastReceiver.onReceive / the main thread) - see
   * UsbSessionCloser's own class-level note. Shut down in [invalidate].
   */
  private val sessionCloser = UsbSessionCloser()

  @Volatile private var invalidated = false

  /**
   * Guards only the short, non-blocking compound state transitions below -
   * never held during permission dialogs or any native USB I/O (open,
   * setParameters, setFlowControl, close). Lock order: this lock is always
   * acquired *before* (never after) UsbSerialSessionRegistry's own internal
   * monitor (its @Synchronized methods lock on the registry instance
   * itself) - reserveDevice()/releaseReservation()/remove() are called
   * independently elsewhere without holding this lock at all, so there is
   * no path that acquires the registry's monitor first and then requests
   * this lock. A single, consistent acquisition order cannot deadlock.
   */
  private val lifecycleLock = Any()

  override fun listDevices(promise: Promise) {
    try {
      val result: WritableArray = Arguments.createArray()
      enumerator.enumerate().forEach { descriptor -> result.pushMap(descriptor.toWritableMap()) }
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject(
        "DEVICE_ENUMERATION_FAILED",
        error.message ?: "Failed to enumerate attached USB devices.",
      )
    }
  }

  override fun openDevice(
    deviceIdArg: Double,
    portIndexArg: Double,
    configuration: ReadableMap,
    promise: Promise,
  ) {
    val deviceId = deviceIdArg.toInt()
    val portIndex = portIndexArg.toInt()

    try {
      // 1. Validate the requested configuration before touching USB state at all.
      val parsedConfig = SerialConfigurationMapper.parse(configuration)

      // 2. Find the device and preserve its identity for later revalidation.
      val device =
        usbManager.deviceList.values.find { it.deviceId == deviceId }
          ?: throw UsbTransportException("UNSUPPORTED_DEVICE", "No attached USB device with id $deviceId.")
      val identity = UsbDeviceIdentity(device.deviceId, device.vendorId, device.productId)

      // 3. Validate driver and port.
      val driver =
        prober.probeDevice(device)
          ?: throw UsbTransportException("UNSUPPORTED_DEVICE", "No serial driver available for device $deviceId.")
      val port =
        driver.ports.getOrNull(portIndex)
          ?: throw UsbTransportException(
            "INVALID_PORT_INDEX",
            "Port index $portIndex is out of range for device $deviceId.",
          )

      // 4. Reserve the device before the (asynchronous) permission request.
      if (!sessionRegistry.reserveDevice(deviceId)) {
        throw UsbTransportException(
          "DEVICE_ALREADY_IN_USE",
          "A session is already open (or opening) for device $deviceId.",
        )
      }

      // 5. Request/confirm permission; steps 6-13 continue in completeOpen().
      permissionRequester.requestPermission(device) { granted, failureMessage ->
        completeOpen(identity, port, parsedConfig, granted, failureMessage, promise)
      }
    } catch (error: UsbTransportException) {
      promise.rejectTransportError(error)
    } catch (error: Exception) {
      promise.rejectTransportError(
        UsbTransportException(
          "NATIVE_OPERATION_FAILED",
          error.message ?: "Unexpected failure while opening device $deviceId.",
        ),
      )
    }
  }

  /**
   * Runs after the (possibly asynchronous) permission result is known. The
   * device's reservation is already held and must be released on every exit
   * path below that doesn't end in a registered session.
   */
  private fun completeOpen(
    identity: UsbDeviceIdentity,
    port: UsbSerialPort,
    parsedConfig: ParsedSerialConfiguration,
    granted: Boolean,
    failureMessage: String?,
    promise: Promise,
  ) {
    // The module was torn down while this permission request was pending.
    // invalidate() already drained the registry (including this reservation)
    // and cancelled the requester - do not resolve/reject through a dead host.
    if (invalidated) {
      return
    }

    if (failureMessage != null) {
      sessionRegistry.releaseReservation(identity.deviceId)
      promise.rejectTransportError(UsbTransportException("PERMISSION_REQUEST_FAILED", failureMessage))
      return
    }
    if (!granted) {
      sessionRegistry.releaseReservation(identity.deviceId)
      promise.rejectTransportError(UsbTransportException("PERMISSION_DENIED", "Permission denied for device ${identity.deviceId}."))
      return
    }

    try {
      // 6. Re-fetch and revalidate the full device identity - not deviceId alone.
      val currentDevice =
        usbManager.deviceList.values.find {
          it.deviceId == identity.deviceId && it.vendorId == identity.vendorId && it.productId == identity.productId
        }
          ?: throw UsbTransportException(
            "DEVICE_CHANGED_DURING_OPEN",
            "Device ${identity.deviceId} was detached or changed while permission was pending.",
          )

      // 7. Open the USB connection.
      val connection =
        usbManager.openDevice(currentDevice)
          ?: throw UsbTransportException("OPEN_FAILED", "Failed to open USB connection for device ${identity.deviceId}.")

      // 8. Open the serial port.
      try {
        port.open(connection)
      } catch (error: Exception) {
        connection.close()
        throw UsbTransportException("OPEN_FAILED", error.message ?: "Failed to open serial port.")
      }

      // 9-10. Apply serial parameters and flow control.
      try {
        port.setParameters(parsedConfig.baudRate, parsedConfig.dataBits, parsedConfig.stopBits, parsedConfig.parity)
        port.setFlowControl(parsedConfig.flowControl)
      } catch (error: Exception) {
        closeQuietly(port)
        connection.close()
        throw UsbTransportException(
          "UNSUPPORTED_SERIAL_CONFIGURATION",
          error.message ?: "Driver rejected the requested serial configuration.",
        )
      }

      // 11. Build the completed local session and its id - not registered yet.
      val sessionId = UUID.randomUUID().toString()
      val session = UsbSerialSession(sessionId, identity.deviceId, connection, port)

      // 12-14. Atomic acceptance: invalidate() drains under this same lock,
      // so this check and the insertion can never straddle a drain - either
      // this runs entirely before invalidate()'s drain, or entirely after
      // (in which case invalidated is already true and nothing is inserted).
      val accepted =
        synchronized(lifecycleLock) {
          if (invalidated) {
            false
          } else {
            sessionRegistry.insert(session)
            true
          }
        }

      // 15-16. Resolve only if accepted; otherwise close the never-registered
      // session and settle nothing - the React host is being torn down.
      // UsbSerialSession.close() is the single owner of releasing the port
      // and connection - no cleanup logic is duplicated here.
      if (accepted) {
        promise.resolve(sessionId)
      } else {
        try {
          session.close()
        } catch (_: Exception) {
          // Best-effort - this session was never accepted, and there is no
          // live host to report a close failure to either way.
        }
        sessionRegistry.releaseReservation(identity.deviceId)
      }
    } catch (error: UsbTransportException) {
      sessionRegistry.releaseReservation(identity.deviceId)
      promise.rejectTransportError(error)
    } catch (error: Exception) {
      sessionRegistry.releaseReservation(identity.deviceId)
      promise.rejectTransportError(
        UsbTransportException("OPEN_FAILED", error.message ?: "Failed to open device ${identity.deviceId}."),
      )
    }
  }

  override fun closeSession(sessionId: String, promise: Promise) {
    val session = sessionRegistry.remove(sessionId)
    if (session == null) {
      promise.reject("UNKNOWN_SESSION", "No active session with id $sessionId.")
      return
    }

    try {
      session.close()
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("CLOSE_FAILED", error.message ?: "Failed to close session $sessionId.")
    }
  }

  override fun writeBytes(sessionId: String, dataBase64: String, promise: Promise) {
    promise.reject("NOT_IMPLEMENTED", "writeBytes is not implemented yet.")
  }

  /**
   * Called from [hotplugMonitor] when Android reports a new USB device
   * attach. Only reports the device's identity to JS via the Codegen event
   * emitter - never opens a port, never requests permission, never creates
   * a session. Enumeration and the safe auto-selection policy live entirely
   * on the JS side (UsbConnectionScreen), which reacts to this event by
   * re-running its existing listDevices() path - the exact same one the
   * initial mount scan and manual تحديث already use.
   */
  private fun handleDeviceAttached(identity: UsbDeviceIdentity) {
    if (invalidated) return
    emitOnDeviceAttached(identity.toWritableMap())
  }

  /**
   * Called from [hotplugMonitor] when Android reports a USB device detach.
   * A physical detach is not a close failure: if the detached device owned
   * an active session, that session is removed from the registry
   * immediately (synchronous, in-memory only) and its close() I/O is
   * handed to [sessionCloser] to run on its own background thread - never
   * synchronously here, since this method still runs on
   * BroadcastReceiver.onReceive's calling thread (the main thread) and
   * must stay short and non-blocking. The onSessionDetached event is
   * reported immediately, without waiting for that close() to actually
   * finish, so JS can clear its connected state without a fake
   * CLOSE_FAILED/requiresCableReset path. The general onDeviceDetached
   * event is always emitted afterward regardless, so JS can reconcile its
   * device list even when no session was involved.
   */
  private fun handleDeviceDetached(identity: UsbDeviceIdentity) {
    if (invalidated) return
    sessionRegistry.removeByDeviceId(identity.deviceId)?.let { session ->
      sessionCloser.submit { session.close() }
      emitOnSessionDetached(
        Arguments.createMap().apply {
          putString("sessionId", session.sessionId)
          putInt("deviceId", session.deviceId)
        },
      )
    }
    emitOnDeviceDetached(identity.toWritableMap())
  }

  /**
   * Called before the React Native instance is destroyed (NativeModule's
   * confirmed, non-deprecated teardown hook - see Pass 4 report for the
   * installed-source evidence). Ensures no later async permission callback
   * can resolve/reject a Promise or create a session, and that every
   * outstanding receiver/reservation/session is cleaned up.
   *
   * Idempotent: a second call finds [invalidated] already true under the
   * same [lifecycleLock] and does nothing further. Setting the flag and
   * draining the registry happen inside one critical section so no session
   * can be inserted (see completeOpen's atomic acceptance step) between
   * "invalidated becomes true" and "the registry is drained" - closing the
   * exact race this correction exists to fix. Slow native I/O (closing each
   * drained session's port/connection, and cancelling the permission
   * requester) happens outside the lock, per the "never hold this lock
   * during native I/O" rule.
   */
  override fun invalidate() {
    super.invalidate()

    hotplugMonitor.stop()
    sessionCloser.shutdown()

    val orphanedSessions =
      synchronized(lifecycleLock) {
        if (invalidated) {
          null
        } else {
          invalidated = true
          sessionRegistry.removeAll()
        }
      }
        ?: return

    permissionRequester.cancelAll()
    orphanedSessions.forEach { session ->
      try {
        session.close()
      } catch (_: Exception) {
        // Best-effort during teardown - there is no Promise left to report this to.
      }
    }
  }
}

private fun closeQuietly(port: UsbSerialPort) {
  try {
    port.close()
  } catch (_: Exception) {
  }
}

private fun Promise.rejectTransportError(error: UsbTransportException) {
  val field = error.field
  val message = error.message ?: "USB transport operation failed."
  if (field != null) {
    val userInfo = Arguments.createMap().apply { putString("field", field) }
    reject(error.code, message, userInfo)
  } else {
    reject(error.code, message)
  }
}

private fun UsbDeviceIdentity.toWritableMap(): WritableMap {
  val map = Arguments.createMap()
  map.putInt("deviceId", deviceId)
  map.putInt("vendorId", vendorId)
  map.putInt("productId", productId)
  return map
}

private fun UsbSerialDeviceDescriptor.toWritableMap(): WritableMap {
  val map = Arguments.createMap()
  map.putInt("deviceId", deviceId)
  map.putInt("vendorId", vendorId)
  map.putInt("productId", productId)
  productName?.let { map.putString("productName", it) }
  manufacturerName?.let { map.putString("manufacturerName", it) }
  map.putString("driverType", driverType)
  map.putInt("portCount", portCount)
  return map
}
