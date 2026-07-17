package com.fpvarbcon.transport

import android.content.Context
import android.hardware.usb.UsbDeviceConnection
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
 * 4. reserve device (yields this attempt's own [ReservationToken])
 * 5. request/confirm permission (async)
 * 6. re-fetch and revalidate device identity
 * 7. open UsbDeviceConnection
 * 8. open UsbSerialPort
 * 9. apply setParameters
 * 10. apply setFlowControl
 * 11. create the completed local session and its UUID sessionId
 * 12. enter the lifecycle gate
 * 13. if the module is still valid, insert the session atomically - only if
 *     this attempt's token still owns the reservation (see step 4's note)
 * 14. exit the lifecycle gate
 * 15. if accepted, resolve openDevice(sessionId)
 * 16. if invalidated, or if this attempt's token was superseded, close the
 *     unaccepted local session
 * No sessionId is generated and no registry insertion happens before step 10
 * succeeds. No registry insertion is possible once invalidated becomes true,
 * because both that check and the insertion happen inside the same
 * lifecycle-lock critical section as invalidate()'s own drain (see
 * [lifecycleLock] and [invalidate] below) - there is no timing window where
 * invalidate() can drain first and a session gets inserted afterward.
 *
 * Steps 6-16 (everything from the permission result onward) always run on
 * [ioExecutor]'s single background thread, never on whichever thread
 * delivered the permission result itself. This matters because that
 * delivering thread is not always the same one: when permission was already
 * granted, UsbPermissionRequester.requestPermission() calls back
 * synchronously on whatever thread called openDevice(); when a real
 * permission dialog was shown, the callback instead runs from
 * UsbPermissionRequester's BroadcastReceiver.onReceive(), which - since that
 * receiver is registered without a Handler - is always the Android main
 * thread. Submitting completeOpen() to ioExecutor makes the execution
 * thread consistent across both cases and keeps this method's real blocking
 * native I/O (openDevice/port.open/setParameters/setFlowControl) off the
 * main thread in both cases, not just one of them.
 *
 * Pass 5.1 corrective note (PASS5.1-AUDIT-1 / PASS5.1-AUDIT-2): step 4's
 * reservation now yields a [ReservationToken] unique to this one attempt,
 * threaded through to every later release/insert call for it (see
 * [completeOpen]). This is what stops an old attempt's stale, delayed
 * permission callback from ever releasing or overwriting a *newer* attempt's
 * reservation for the same deviceId - see [ReservationToken]'s own note and
 * [UsbSerialSessionRegistry]'s class-level note for the full scenario. A
 * genuine physical detach still unconditionally invalidates whatever
 * reservation currently exists for its deviceId (see [handleDeviceDetached])
 * because a detach targets a single, ordered hardware event, not a
 * possibly-stale callback - that call and this module's own detach-session
 * cleanup are now one atomic step under [lifecycleLock], so a claimed
 * session's close() submission can never lose a race against
 * [ioExecutor]'s shutdown in [invalidate].
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
   * The one owned, lifecycle-scoped background thread for every blocking
   * USB I/O operation this module performs - both the open/configure work
   * that follows a permission result and a detached device's stale-session
   * close() - so neither ever runs on BroadcastReceiver.onReceive's calling
   * thread (the Android main thread, whenever permission was not already
   * granted - see completeOpen's own note). See UsbIoExecutor's class-level
   * note for why one shared single-thread executor is used for both, rather
   * than two separate executors, and for its Boolean submit() contract.
   * Shut down in [invalidate].
   */
  private val ioExecutor = UsbIoExecutor()

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
   *
   * Pass 5.1 correction: also now the single coordination point for
   * "claim a detached device's session/reservation" and "submit its close
   * work to ioExecutor" (see [handleDeviceDetached]) and for "drain every
   * session at teardown" and "submit their close work" (see [invalidate]) -
   * both happen as one atomic step under this lock, so [ioExecutor]'s
   * shutdown() (called only after that step releases the lock) can never
   * race ahead of a submission that step made.
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
      // The returned token belongs only to this attempt - it is threaded
      // through completeOpen() and is what stops a stale/delayed callback
      // from this attempt from ever releasing or overwriting a *different*
      // (later) attempt's reservation for the same deviceId (see
      // UsbSerialSessionRegistry's class-level note).
      val reservation =
        sessionRegistry.reserveDevice(deviceId)
          ?: throw UsbTransportException(
            "DEVICE_ALREADY_IN_USE",
            "A session is already open (or opening) for device $deviceId.",
          )

      // 5. Request/confirm permission; steps 6-13 continue in completeOpen(),
      // always on ioExecutor's background thread regardless of which thread
      // this callback itself fires on (see the class-level note above).
      permissionRequester.requestPermission(device) { granted, failureMessage ->
        ioExecutor.submit {
          completeOpen(identity, reservation, port, parsedConfig, granted, failureMessage, promise)
        }
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
   * Runs after the (possibly asynchronous) permission result is known. This
   * attempt's own [reservation] token is already held and must be released
   * - using that exact token, never a bare deviceId - on every exit path
   * below that doesn't end in a registered session. Using the token (rather
   * than the deviceId alone) guarantees this attempt can only ever affect
   * its own reservation: if a detach has since invalidated it, or a newer
   * attempt has since reserved this deviceId again, every release/insert
   * call below simply becomes a harmless no-op instead of disturbing that
   * newer attempt (see PASS5.1-AUDIT-1's fix in UsbSerialSessionRegistry).
   */
  private fun completeOpen(
    identity: UsbDeviceIdentity,
    reservation: ReservationToken,
    port: UsbSerialPort,
    parsedConfig: ParsedSerialConfiguration,
    granted: Boolean,
    failureMessage: String?,
    promise: Promise,
  ) {
    // The module was torn down while this permission request was pending.
    // invalidate() already drained the registry (including this reservation
    // if it was still current) and cancelled the requester - do not
    // resolve/reject through a dead host.
    if (invalidated) {
      return
    }

    if (failureMessage != null) {
      sessionRegistry.releaseReservation(identity.deviceId, reservation)
      promise.rejectTransportError(UsbTransportException("PERMISSION_REQUEST_FAILED", failureMessage))
      return
    }
    if (!granted) {
      sessionRegistry.releaseReservation(identity.deviceId, reservation)
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
        closeQuietly(connection)
        throw UsbTransportException("OPEN_FAILED", error.message ?: "Failed to open serial port.")
      }

      // 9-10. Apply serial parameters and flow control. Both cleanup calls
      // are best-effort (closeQuietly swallows their own failures) so that
      // a secondary close failure here can never replace the real
      // UNSUPPORTED_SERIAL_CONFIGURATION cause with a less specific one.
      try {
        port.setParameters(parsedConfig.baudRate, parsedConfig.dataBits, parsedConfig.stopBits, parsedConfig.parity)
        port.setFlowControl(parsedConfig.flowControl)
      } catch (error: Exception) {
        closeQuietly(port)
        closeQuietly(connection)
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
      // (in which case invalidated is already true and nothing is
      // inserted). insert() additionally only succeeds if [reservation] is
      // still the current reservation for this deviceId - if a detach
      // invalidated it, or a newer attempt has since reserved this deviceId
      // again (this attempt's own permission callback was stale/delayed -
      // see the class-level Pass 5.1 note), insert() returns false and
      // touches neither the newer reservation nor any session it may have
      // already produced.
      val outcome =
        synchronized(lifecycleLock) {
          if (invalidated) {
            OpenCompletionOutcome.MODULE_INVALIDATED
          } else if (sessionRegistry.insert(reservation, session)) {
            OpenCompletionOutcome.ACCEPTED
          } else {
            OpenCompletionOutcome.RESERVATION_SUPERSEDED
          }
        }

      // 15-16. Resolve only if accepted. Otherwise close the never-registered
      // session and, for the invalidated case, settle nothing (the React
      // host is being torn down); for the superseded case, reject this
      // attempt's own Promise without touching whatever now legitimately
      // owns this deviceId. UsbSerialSession.close() is the single owner of
      // releasing the port and connection - no cleanup logic is duplicated
      // here.
      when (outcome) {
        OpenCompletionOutcome.ACCEPTED -> promise.resolve(sessionId)
        OpenCompletionOutcome.MODULE_INVALIDATED -> {
          try {
            session.close()
          } catch (_: Exception) {
            // Best-effort - this session was never accepted, and there is no
            // live host to report a close failure to either way.
          }
        }
        OpenCompletionOutcome.RESERVATION_SUPERSEDED -> {
          try {
            session.close()
          } catch (_: Exception) {
            // Best-effort - this attempt's session was never accepted, and
            // whatever now owns this deviceId's reservation must be left
            // untouched either way.
          }
          promise.rejectTransportError(
            UsbTransportException(
              "DEVICE_CHANGED_DURING_OPEN",
              "Device ${identity.deviceId} was reused by a newer connection attempt while this one was still opening.",
            ),
          )
        }
      }
    } catch (error: UsbTransportException) {
      sessionRegistry.releaseReservation(identity.deviceId, reservation)
      promise.rejectTransportError(error)
    } catch (error: Exception) {
      sessionRegistry.releaseReservation(identity.deviceId, reservation)
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
   * handed to [ioExecutor] to run on its own background thread - never
   * synchronously here, since this method still runs on
   * BroadcastReceiver.onReceive's calling thread (the main thread) and
   * must stay short and non-blocking. The onSessionDetached event is
   * reported immediately, without waiting for that close() to actually
   * finish, so JS can clear its connected state without a fake
   * CLOSE_FAILED/requiresCableReset path. The general onDeviceDetached
   * event is always emitted afterward regardless, so JS can reconcile its
   * device list even when no session was involved.
   *
   * Also unconditionally invalidates any pending *reservation* for this
   * device - not just a registered session - via
   * [UsbSerialSessionRegistry.invalidateReservationForDevice], which is
   * deliberately not token-gated: a detach is a single, ordered hardware
   * event that always targets whichever one attempt currently occupies
   * this deviceId's slot (see that method's own note). Without this, a
   * device detached while its own connect attempt is still waiting on the
   * permission dialog would stay reserved (openDevice()'s step 4) until
   * that pending completeOpen() call eventually runs, which could
   * otherwise make a fast detach-then-reattach spuriously fail with
   * DEVICE_ALREADY_IN_USE.
   *
   * Pass 5.1 correction (PASS5.1-AUDIT-2): checking [invalidated], claiming
   * this device's reservation/session, and submitting the session's
   * close() to [ioExecutor] are now one atomic step under [lifecycleLock] -
   * the same lock [invalidate] holds while draining every other session
   * and only then shutting [ioExecutor] down. This closes a narrow but real
   * race in the previous version of this method: it used to check
   * [invalidated] on its own, separately from (and before) calling
   * ioExecutor.submit() a few lines later, leaving a small window where
   * invalidate() could run its entire body - including shutting the
   * executor down - in between, silently dropping this detach's close
   * submission. Sharing [lifecycleLock] with [invalidate] means that by the
   * time this method could reach its own submission, it is guaranteed to
   * either run entirely before invalidate()'s drain (and its submission is
   * guaranteed accepted, since shutdown() only ever happens after that
   * drain releases the lock) or entirely after it (in which case
   * [invalidated] is already true here and this method does nothing,
   * because invalidate()'s own drain already claimed and submitted the
   * close for this exact session, if one existed).
   */
  private fun handleDeviceDetached(identity: UsbDeviceIdentity) {
    val detachedSession =
      synchronized(lifecycleLock) {
        if (invalidated) {
          null
        } else {
          sessionRegistry.invalidateReservationForDevice(identity.deviceId)
          sessionRegistry.removeByDeviceId(identity.deviceId)?.also { session ->
            ioExecutor.submit { session.close() }
          }
        }
      }
    detachedSession?.let { session ->
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
   * same [lifecycleLock] and does nothing further. Setting the flag,
   * draining the registry, and submitting every drained session's close()
   * to [ioExecutor] all happen inside one critical section, so: (a) no
   * session can be inserted (see completeOpen's atomic acceptance step)
   * between "invalidated becomes true" and "the registry is drained" -
   * closing the original race this correction exists to fix; and (b) no
   * detach (see [handleDeviceDetached]) can ever observe [invalidated] as
   * false, claim a session, and then lose its own close() submission to a
   * shutdown() that already happened - closing PASS5.1-AUDIT-2's race,
   * since [ioExecutor].shutdown() below only ever runs after this entire
   * critical section (including every submission it makes) has already
   * completed and released the lock.
   *
   * The actual blocking session.close() calls never run inside this lock -
   * only claiming the sessions and submitting their close tasks does; the
   * submitted closures themselves run later, on ioExecutor's own thread,
   * per the "never hold this lock during native I/O" rule.
   */
  override fun invalidate() {
    super.invalidate()

    hotplugMonitor.stop()

    val alreadyInvalidated =
      synchronized(lifecycleLock) {
        if (invalidated) {
          true
        } else {
          invalidated = true
          sessionRegistry.removeAll().forEach { session ->
            ioExecutor.submit {
              try {
                session.close()
              } catch (_: Exception) {
                // Best-effort during teardown - there is no Promise left to report this to.
              }
            }
          }
          false
        }
      }

    if (alreadyInvalidated) return

    permissionRequester.cancelAll()
    ioExecutor.shutdown()
  }
}

/**
 * The outcome of completeOpen()'s atomic acceptance step (see [ReservationToken]
 * and [UsbSerialSessionRegistry.insert]). RESERVATION_SUPERSEDED is distinct
 * from MODULE_INVALIDATED because they require different Promise handling:
 * an invalidated module settles nothing (the host is gone), while a
 * superseded reservation must still reject this attempt's own Promise.
 */
private enum class OpenCompletionOutcome { ACCEPTED, MODULE_INVALIDATED, RESERVATION_SUPERSEDED }

private fun closeQuietly(port: UsbSerialPort) {
  try {
    port.close()
  } catch (_: Exception) {
  }
}

private fun closeQuietly(connection: UsbDeviceConnection) {
  try {
    connection.close()
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
