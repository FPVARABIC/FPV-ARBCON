package com.fpvarbcon.transport

import android.content.Context
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.util.Base64
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
 * openDevice(), closeSession(), startReading(), and stopReading() have real
 * behavior. writeBytes() remains a temporary stub until its approved pass
 * lands - this module is still receive-only, no data transmission here yet.
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
 *
 * Pass 5.2 (receive-only): [startReading]/[stopReading] add a second,
 * independent per-session lifecycle - "is a receive loop currently allowed
 * to emit for this sessionId" - tracked entirely separately from the
 * open-attempt reservation above, in [readRegistry]. A receive loop never
 * runs on [ioExecutor]: a continuous blocking read would monopolize that
 * single shared thread and starve session close/detach/invalidate work, so
 * each active receive attempt gets its own dedicated, named daemon thread
 * instead (see [startReceiveWorker] and [SerialReadLoop]'s own note).
 * closeSession()/handleDeviceDetached()/invalidate() all clear a session's
 * receive state - via [readRegistry] - no later than the point they remove
 * or drain that same session, under the same [lifecycleLock] critical
 * section where applicable, so a receive worker can never outlive the
 * session it reads from in a way that produces a stale event.
 */
class UsbSerialTransportModule(reactContext: ReactApplicationContext) :
  NativeUsbSerialTransportSpec(reactContext) {

  private val usbManager: UsbManager by lazy {
    reactApplicationContext.getSystemService(Context.USB_SERVICE) as UsbManager
  }

  private val enumerator: UsbSerialDeviceEnumerator by lazy { UsbSerialDeviceEnumerator(usbManager) }

  private val prober = UsbSerialProber.getDefaultProber()

  private val sessionRegistry = UsbSerialSessionRegistry()

  /**
   * Tracks which sessionId currently owns an active receive loop (Pass
   * 5.2) - entirely separate from [sessionRegistry]'s open-attempt
   * reservations. See [UsbSerialReadRegistry]'s own class-level note for
   * why the two are deliberately independent.
   */
  private val readRegistry = UsbSerialReadRegistry()

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

  /**
   * Pass 5.2: removing this session's receive state (if any) and removing
   * the session itself now happen as one atomic step under [lifecycleLock]
   * - the same coordination point [startReading] uses to look up a session
   * and claim its receive token. This closes a narrow race that would
   * otherwise exist between an in-flight startReading() call and a
   * concurrent closeSession() call for the same sessionId: either
   * startReading() completes its entire check-and-claim before this method
   * can remove anything (so this method then correctly finds and clears
   * that just-started receive state too), or this method removes the
   * session first (so startReading(), running after, correctly finds no
   * such session and rejects UNKNOWN_SESSION) - never a window where a
   * receive worker starts against a session that is simultaneously being
   * closed out from under it. The actual native session.close() call stays
   * outside the lock, per the existing "never hold this lock during native
   * I/O" rule.
   */
  override fun closeSession(sessionId: String, promise: Promise) {
    val session =
      synchronized(lifecycleLock) {
        readRegistry.removeSession(sessionId)
        sessionRegistry.remove(sessionId)
      }
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
   * Starts a receive loop for an already-open session. Explicit and
   * idempotent-by-rejection: calling this twice for the same still-active
   * session fails with RX_ALREADY_ACTIVE rather than silently restarting or
   * merging with the existing loop (see [UsbSerialReadRegistry.start]).
   * Looking up the session and claiming its receive token happen atomically
   * under [lifecycleLock] (see [closeSession]'s own note for the race this
   * closes); starting the worker thread itself is a fast, non-blocking call
   * (creating and starting a Thread does not run its body synchronously)
   * so doing it inside this same short critical section does not violate
   * the "never hold this lock during native I/O" rule - no native read
   * happens until the new thread's own run() begins.
   */
  override fun startReading(sessionId: String, promise: Promise) {
    val outcome =
      synchronized(lifecycleLock) {
        if (invalidated) {
          StartReadingOutcome.MODULE_INVALIDATED
        } else {
          val session = sessionRegistry.get(sessionId)
          if (session == null) {
            StartReadingOutcome.UNKNOWN_SESSION
          } else {
            val token = readRegistry.start(sessionId)
            if (token == null) {
              StartReadingOutcome.ALREADY_ACTIVE
            } else {
              startReceiveWorker(sessionId, token, session)
              StartReadingOutcome.STARTED
            }
          }
        }
      }

    when (outcome) {
      StartReadingOutcome.STARTED -> promise.resolve(null)
      StartReadingOutcome.MODULE_INVALIDATED ->
        promise.rejectTransportError(
          UsbTransportException("MODULE_INVALIDATED", "The transport module is being torn down."),
        )
      StartReadingOutcome.UNKNOWN_SESSION ->
        promise.rejectTransportError(
          UsbTransportException("UNKNOWN_SESSION", "No active session with id $sessionId."),
        )
      StartReadingOutcome.ALREADY_ACTIVE ->
        promise.rejectTransportError(
          UsbTransportException(
            "RX_ALREADY_ACTIVE",
            "A receive loop is already active for session $sessionId.",
          ),
        )
    }
  }

  /**
   * Stops the receive loop for [sessionId], if one is active. Idempotent
   * and safe to call repeatedly or for a session with no active (or no
   * longer existing) receive loop - [UsbSerialReadRegistry.removeSession]
   * is itself a harmless no-op in that case. Never touches or closes the
   * underlying session - this method's contract is receive-loop lifecycle
   * only, matching the public API's separation of concerns. Does not wait
   * for the worker's thread to actually exit (see [SerialReadLoop]'s own
   * note on cooperative, non-blocking cancellation) - it only guarantees
   * that worker will emit no further chunks or errors for this attempt,
   * within at most one read-timeout window.
   */
  override fun stopReading(sessionId: String, promise: Promise) {
    readRegistry.removeSession(sessionId)
    promise.resolve(null)
  }

  /**
   * Builds the real UsbSerialPort-backed [SerialReadSource] for [session]
   * and starts exactly one dedicated, named daemon thread running its
   * [SerialReadLoop]. This thread is never [ioExecutor] - a continuous
   * blocking read loop must not be able to monopolize that single shared
   * executor and starve session close/detach/invalidate work queued behind
   * it (see the class-level Pass 5.2 note). Daemon so a lingering worker -
   * bounded to at most one [RX_READ_TIMEOUT_MILLIS] window after its token
   * is invalidated - can never keep the JVM process alive on its own.
   */
  private fun startReceiveWorker(sessionId: String, token: ReceiveToken, session: UsbSerialSession) {
    val loop =
      SerialReadLoop(
        sessionId = sessionId,
        token = token,
        source = SerialReadSource { buffer, timeoutMillis -> session.read(buffer, timeoutMillis) },
        registry = readRegistry,
        readTimeoutMillis = RX_READ_TIMEOUT_MILLIS,
        onChunk = { buffer, length -> emitDataReceived(sessionId, buffer, length) },
        onTerminalError = { error -> emitReadError(sessionId, error) },
      )
    Thread({ loop.run() }, "UsbSerialRx-$sessionId").apply { isDaemon = true }.start()
  }

  /**
   * Encodes exactly the [length] valid bytes of [buffer] (which may be
   * larger and is reused by the caller's loop on its next iteration - see
   * SerialReadLoop) to Base64 and emits them for JS, matching the already
   * locked onDataReceived/UsbSerialDataEvent bridge contract (dataBase64:
   * string) - not a new encoding choice made for this pass. Base64 encodes
   * raw bytes verbatim regardless of sign interpretation, so every value
   * 0-255 round-trips losslessly; no separate "unsigned conversion" step is
   * needed or performed. android.util.Base64 (not java.util.Base64, which
   * requires API 26) is used to stay compatible with this project's
   * minSdkVersion 24.
   */
  private fun emitDataReceived(sessionId: String, buffer: ByteArray, length: Int) {
    val dataBase64 = Base64.encodeToString(buffer, 0, length, Base64.NO_WRAP)
    emitOnDataReceived(
      Arguments.createMap().apply {
        putString("sessionId", sessionId)
        putString("dataBase64", dataBase64)
      },
    )
  }

  /**
   * Reports a receive loop's unexpected termination via the existing
   * onError/UsbSerialErrorEvent contract. Only ever called by
   * [SerialReadLoop] when this attempt's token was still current at
   * failure time - a failure caused by an intentional
   * stop/close/detach/invalidate (its token already gone) is never reported
   * here at all, so this always represents a genuine, unexpected native
   * read failure, reported at most once per attempt (the loop returns
   * immediately after calling this). recoverable is always false: this
   * pass has no retry/reconnect logic, so the caller must decide whether to
   * call startReading() again - nothing here will do so automatically.
   * error.message is used as-is (an IOException's own message, not a raw
   * stack trace or an internal path) to stay consistent with every other
   * rejection in this module.
   */
  private fun emitReadError(sessionId: String, error: Exception) {
    emitOnError(
      Arguments.createMap().apply {
        putString("sessionId", sessionId)
        putString("code", "READ_FAILED")
        putString("message", error.message ?: "USB serial read failed.")
        putBoolean("recoverable", false)
      },
    )
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
   *
   * Pass 5.2: also clears that session's receive state (if any) via
   * [readRegistry] in the same step, before its close() is even submitted -
   * a detached device's receive loop (if it was running) will independently
   * notice via its own token check within one read-timeout window, but
   * clearing the registry entry here immediately ensures no new chunk is
   * ever attributed to this sessionId again, and that a later
   * closeSession()/stopReading() call for it finds nothing left to clear.
   */
  private fun handleDeviceDetached(identity: UsbDeviceIdentity) {
    val detachedSession =
      synchronized(lifecycleLock) {
        if (invalidated) {
          null
        } else {
          sessionRegistry.invalidateReservationForDevice(identity.deviceId)
          sessionRegistry.removeByDeviceId(identity.deviceId)?.also { session ->
            readRegistry.removeSession(session.sessionId)
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
   *
   * Pass 5.2: [readRegistry].removeAll() runs in the same critical section,
   * invalidating every outstanding receive token atomically with
   * [invalidated] becoming true - no receive worker thread is explicitly
   * interrupted or joined here (see [SerialReadLoop]'s own note on
   * cooperative cancellation), but every one of them will independently
   * notice its token is gone and stop emitting within at most one
   * read-timeout window, without this method ever blocking to wait for
   * that.
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
          readRegistry.removeAll()
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

/** The outcome of startReading()'s atomic lookup-and-claim step (see [UsbSerialTransportModule.startReading]). */
private enum class StartReadingOutcome { STARTED, MODULE_INVALIDATED, UNKNOWN_SESSION, ALREADY_ACTIVE }

/**
 * How long a single native read call blocks waiting for data before
 * returning 0 bytes and letting the loop re-check whether it should keep
 * running - see SerialReadLoop's own note on why a finite, non-zero timeout
 * is required for cooperative cancellation. Chosen as a balance between
 * prompt stop responsiveness and not waking up needlessly often.
 */
private const val RX_READ_TIMEOUT_MILLIS = 200

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
