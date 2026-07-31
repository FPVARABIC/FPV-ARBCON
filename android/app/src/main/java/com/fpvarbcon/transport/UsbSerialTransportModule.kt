package com.fpvarbcon.transport

import android.content.Context
import android.hardware.usb.UsbDevice
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Thin TurboModule bridge for USB serial transport. listDevices(),
 * openDevice(), closeSession(), startReading(), stopReading(), and (Pass
 * 5.3) writeBytes() all have real behavior.
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
 * Steps 5-16 (the permission request onward) now (Pass 5.4) run entirely on
 * one dedicated, single-use, per-attempt background thread - never
 * [ioExecutor], and never whichever thread delivered the permission result
 * itself. Before Pass 5.4 this all ran as a task submitted to [ioExecutor],
 * the same single shared thread also used for every detach/invalidate-
 * triggered session close(); see that pass's own corrective note below for
 * why that was changed.
 *
 * Pass 5.4 corrective note (PASS5.4-CONNECT-TIMEOUT): a real-hardware
 * openDevice() hang was confirmed to be an unbounded, uninterruptible native
 * call (most likely UsbSerialPort.open()'s internal claimInterface(), which
 * has no Android-API-level timeout parameter at all) with no path back to
 * JS - the Promise simply never settled. Worse, because completeOpen() used
 * to run on [ioExecutor] - the exact same single-threaded executor
 * [handleDeviceDetached]/[invalidate] submit their own session-close work
 * to - one stuck open attempt would permanently starve every future open
 * *and* every future detach-triggered close for the remainder of the
 * process's life, since a single-threaded executor never runs a second
 * queued task until the first one's Runnable returns.
 *
 * The fix: [openDevice] now runs the permission wait (bridged back onto one
 * synchronous call via a [CountDownLatch] - see its own inline note) and the
 * entire native open/configure sequence as one [work] block on its own
 * dedicated, throwaway thread via [runOnDedicatedThreadWithTimeout], bounded
 * to [CONNECT_TIMEOUT_MILLIS] overall. [ioExecutor] is untouched by this -
 * it continues to be used only for detach/invalidate session closes, exactly
 * as before. A stuck attempt's abandoned thread can therefore never block or
 * poison any other connect attempt, or any close, ever again - it can only
 * ever leak itself (see [runOnDedicatedThreadWithTimeout]'s own note on why
 * that leaked thread is never interrupted or force-stopped: whether
 * UsbDeviceConnection.close() can reliably unblock a thread genuinely stuck
 * inside claimInterface() could not be confirmed via any available Android
 * source or documentation, and general Unix precedent suggests closing a
 * file descriptor from another thread does not reliably interrupt a
 * blocking syscall already using it - so this is honestly best-effort
 * cleanup, not a guaranteed unblock).
 *
 * A connect attempt that eventually completes after already having timed
 * out (CONNECT_TIMEOUT already rejected the Promise via
 * [UsbPromiseSettleOnce]) needs no special-casing to discard cleanly: the
 * timeout path already released this attempt's own [ReservationToken] (see
 * [UsbSerialSessionRegistry.releaseReservation]), so completeOpen()'s own
 * atomic acceptance step (steps 12-14 below) finds its token superseded and
 * takes the existing RESERVATION_SUPERSEDED path, closing the never-
 * published session - the same mechanism that already handled a stale,
 * superseded attempt before this pass, unchanged.
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
 *
 * Pass 5.2 corrective note (PASS5.2-AUDIT-F1): token invalidation alone (the
 * mechanism described above) stops a stale worker from *emitting*, but does
 * nothing to stop two real threads from both being inside the same session's
 * (unsynchronized, per the pinned usb-serial-for-android dependency's own
 * source) UsbSerialPort.read() at once during a rapid stopReading() ->
 * startReading() cycle on a still-open session. [startReading] now always
 * runs its own work off the calling thread (see [performStartReading]) and,
 * when the previous attempt's token is retired but its worker thread hasn't
 * yet confirmed exiting, waits - bounded, off the main thread - for that
 * confirmation (see [ReadWorkerHandle]/[UsbSerialReadRegistry.StartAttempt])
 * before ever starting a new worker, so at most one real read() call for a
 * given session is ever in flight, even across a rapid restart. This does
 * not change close/detach/invalidate: those paths remove a session entirely,
 * so there is no future startReading() for that exact sessionId that could
 * ever need to wait.
 *
 * Pass 5.3 (TX write path): [writeBytes] no longer stubs out - it decodes
 * the given Base64 payload and enqueues it on the target session's own
 * dedicated write queue (see [UsbSerialSession.enqueueWrite] and
 * [UsbSerialWriteQueue]), never on [ioExecutor] and never on an RX worker
 * thread, resolving the original Promise only once that specific write
 * actually completes. Every read()/write() call for one session's port is
 * now serialized through that session's own fair ioLock (see
 * [UsbSerialSession]'s own note, PASS5.3-STEP0): the pinned
 * usb-serial-for-android 3.10.0 library provides no synchronization
 * between a concurrent read() and write() on the same port, and neither
 * does the underlying UsbDeviceConnection.bulkTransfer() call both
 * ultimately make. closeSession()/handleDeviceDetached()/invalidate() all
 * now also stop each affected session's write queue immediately - at the
 * same point they already clear that session's RX state - rejecting every
 * still-queued (not yet started) write with SESSION_CLOSED before
 * performing the session's own (possibly deferred) native close(); a write
 * already in progress when this happens is not interrupted here, it fails
 * (or succeeds) on its own, exactly as any other write outcome would.
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
   * The one owned, lifecycle-scoped background thread for a detached
   * device's stale-session close() (see [handleDeviceDetached]) and for
   * every session drained at teardown (see [invalidate]) - so neither ever
   * runs on BroadcastReceiver.onReceive's calling thread (the Android main
   * thread). See UsbIoExecutor's class-level note for its Boolean submit()
   * contract. Shut down in [invalidate].
   *
   * PASS5.4-CONNECT-TIMEOUT: no longer used for the open/configure work that
   * follows a permission result - see the class-level Pass 5.4 note for why
   * that was moved onto its own dedicated per-attempt thread instead of this
   * shared one.
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

      // 5. Request/confirm permission, then continue steps 6-16 in
      // completeOpen() - all as one synchronous [work] block on its own
      // dedicated per-attempt thread, bounded overall to
      // CONNECT_TIMEOUT_MILLIS (see the class-level Pass 5.4 note and
      // runOnDedicatedThreadWithTimeout's own note). [awaitPermissionResult]
      // bridges requestPermission()'s own asynchronous callback back onto
      // this one thread via a CountDownLatch, so the permission wait and the
      // native open/configure sequence share a single overall bound instead
      // of each needing their own.
      val settle = UsbPromiseSettleOnce(promise)
      runOnDedicatedThreadWithTimeout(
        threadName = "UsbSerialOpen-$deviceId",
        timeoutMillis = CONNECT_TIMEOUT_MILLIS,
        work = {
          val permissionResult = awaitPermissionResult(device)
          completeOpen(
            identity,
            reservation,
            port,
            parsedConfig,
            permissionResult.granted,
            permissionResult.failureMessage,
            settle,
          )
        },
        onSettle = { outcome ->
          when (outcome) {
            is UsbAttemptOutcome.Completed ->
              outcome.result.exceptionOrNull()?.let { error ->
                // completeOpen() catches every exception it can throw and
                // always settles `settle` itself - this branch should be
                // unreachable in practice, but is still handled defensively
                // rather than silently leaving the Promise unsettled if it
                // ever is.
                sessionRegistry.releaseReservation(identity.deviceId, reservation)
                // Result intentionally ignored - this path never reaches the
                // point where a session could have been created, so there is
                // no resource to clean up on a loss (see UsbPromiseSettleOnce's
                // own note, PASS5.4-AUDIT-1).
                settle.reject(
                  UsbTransportException(
                    "OPEN_FAILED",
                    error.message ?: "Unexpected failure while opening device $deviceId.",
                  ),
                )
              }
            UsbAttemptOutcome.TimedOut -> {
              // Best-effort only: this frees the reservation so a fresh
              // connect attempt (or a detach) can proceed immediately - it
              // does not, and cannot, stop the abandoned worker thread's own
              // native call if it is genuinely stuck (see the class-level
              // Pass 5.4 note on why that thread is simply abandoned, never
              // interrupted or force-stopped).
              sessionRegistry.releaseReservation(identity.deviceId, reservation)
              // Result intentionally ignored - this path itself never creates
              // a session, so there is nothing here to clean up on a loss. If
              // the abandoned worker thread later DOES complete and insert a
              // session, completeOpen()'s own ACCEPTED branch is the one that
              // checks whether ITS settle.resolve() lost this exact race and
              // cleans that session up (see PASS5.4-AUDIT-1's note there).
              settle.reject(
                UsbTransportException(
                  "CONNECT_TIMEOUT",
                  "Timed out opening device $deviceId after ${CONNECT_TIMEOUT_MILLIS}ms.",
                ),
              )
            }
          }
        },
      )
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
   * Bridges UsbPermissionRequester.requestPermission()'s own asynchronous
   * callback - which may fire synchronously (permission already granted) or
   * later from a different thread entirely (a real dialog shown, its result
   * delivered via BroadcastReceiver.onReceive() on the Android main thread) -
   * back onto this one calling thread, so it can be awaited as a single
   * synchronous step inside [openDevice]'s `work` block.
   *
   * Deliberately has no timeout of its own: the overall
   * [runOnDedicatedThreadWithTimeout] bound covers however long this wait
   * (plus the native open/configure sequence that follows it) takes as one
   * combined budget - see the class-level Pass 5.4 note on why one shared
   * bound, rather than a separate one here, was chosen. `outcome`'s write
   * (from whichever thread calls onResult) happens-before this method's own
   * read of it once [latch] .await() returns, per CountDownLatch's own
   * documented memory-visibility guarantee - no additional synchronization
   * is needed for that single handoff.
   */
  private fun awaitPermissionResult(device: UsbDevice): PermissionOutcome {
    val latch = CountDownLatch(1)
    // AtomicReference (not a bare local): with the bounded await below the
    // callback thread may still write after this thread stops waiting, so
    // the handoff needs an explicitly safe cell rather than relying on
    // await()'s happens-before alone.
    val outcome =
      AtomicReference(
        PermissionOutcome(granted = false, failureMessage = "Permission result never arrived."),
      )
    permissionRequester.requestPermission(device) { granted, failureMessage ->
      outcome.set(PermissionOutcome(granted, failureMessage))
      latch.countDown()
    }
    // PASS 7.7: BOUNDED wait. The baseline used a bare latch.await() with
    // no bound of its own, so a permission result that never arrives left
    // this worker parked forever (the outer connect watchdog abandons the
    // thread but cannot stop it). The bound is the same overall connect
    // budget, so behavior for a normally-answered dialog is unchanged; on
    // expiry the wait returns a truthful timeout outcome and the abandoned
    // permission request can no longer open USB (the requester settles it
    // exactly once - see UsbPermissionRequestCoordinator).
    val answered = latch.await(CONNECT_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
    if (!answered) {
      return PermissionOutcome(
        granted = false,
        failureMessage = "Timed out waiting for the USB permission result.",
      )
    }
    return outcome.get()
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
   *
   * PASS5.4-CONNECT-TIMEOUT: [promise] is now settled only through [settle],
   * never directly - see [UsbPromiseSettleOnce]'s own note for why this
   * attempt's Promise can otherwise be settled twice (once from here, once
   * from the connect-timeout watchdog).
   */
  private fun completeOpen(
    identity: UsbDeviceIdentity,
    reservation: ReservationToken,
    port: UsbSerialPort,
    parsedConfig: ParsedSerialConfiguration,
    granted: Boolean,
    failureMessage: String?,
    settle: UsbPromiseSettleOnce,
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
      // Result intentionally ignored - this path has no resource to clean up
      // on a loss: no session exists yet at this point (see
      // UsbPromiseSettleOnce's own note, PASS5.4-AUDIT-1).
      settle.reject(UsbTransportException("PERMISSION_REQUEST_FAILED", failureMessage))
      return
    }
    if (!granted) {
      sessionRegistry.releaseReservation(identity.deviceId, reservation)
      // Result intentionally ignored - same reasoning as above: no session
      // exists yet, so there is nothing to clean up on a loss.
      settle.reject(UsbTransportException("PERMISSION_DENIED", "Permission denied for device ${identity.deviceId}."))
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
      //
      // PASS5.4-AUDIT-1 correction: ACCEPTED alone is no longer guaranteed to
      // mean "JS will learn this sessionId" - insert() succeeding (this
      // session is genuinely, correctly in sessionRegistry) and
      // settle.resolve() winning its own separate race against a concurrent
      // settle.reject(CONNECT_TIMEOUT) are two independent races with no
      // ordering tying them together (see the confirmed scenario in
      // UsbPromiseSettleOnce's own note). If resolve() loses, this session is
      // orphaned - correctly inserted, but with no sessionId JS was ever
      // told - and must be cleaned up here, by sessionId (never deviceId, a
      // newer attempt may already have replaced this deviceId's session by
      // now) and only if this exact removal call actually finds it (a null
      // result means a concurrent physical detach already claimed and likely
      // already closed it - closing again would double-close).
      when (outcome) {
        OpenCompletionOutcome.ACCEPTED -> {
          val settledHere = settle.resolve(sessionId)
          if (!settledHere) {
            val orphaned = sessionRegistry.remove(sessionId)
            if (orphaned != null) {
              try {
                orphaned.close()
              } catch (_: Exception) {
                // Best-effort - there is no live Promise left to report this
                // failure to, and JS was never told this sessionId existed
                // either way.
              }
            }
            // else: nothing removed - a concurrent handleDeviceDetached()
            // (matched by deviceId, not sessionId) already claimed and
            // presumably already closed this exact session. Deliberately not
            // calling close() again here - see this branch's own note above.
          }
        }
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
          // Result intentionally ignored - this session was never inserted
          // (insert() itself returned false), so there is nothing further to
          // clean up regardless of whether this reject() wins its race.
          settle.reject(
            UsbTransportException(
              "DEVICE_CHANGED_DURING_OPEN",
              "Device ${identity.deviceId} was reused by a newer connection attempt while this one was still opening.",
            ),
          )
        }
      }
    } catch (error: UsbTransportException) {
      sessionRegistry.releaseReservation(identity.deviceId, reservation)
      // Result intentionally ignored - every throw site above this catch
      // runs strictly before a session is created (session creation and
      // insertion happen together, with no throwing code in between), so
      // there is never a session here to clean up on a loss.
      settle.reject(error)
    } catch (error: Exception) {
      sessionRegistry.releaseReservation(identity.deviceId, reservation)
      // Result intentionally ignored - same reasoning as the catch above.
      settle.reject(
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
      closeSessionRejectingPendingWrites(
        session = session,
        rejectPendingWrites = { rejectPendingWrites(it, sessionId) },
        performClose = { session.close() },
      )
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("CLOSE_FAILED", error.message ?: "Failed to close session $sessionId.")
    }
  }

  /**
   * Decodes [dataBase64] and enqueues it on [sessionId]'s own write queue
   * (see [UsbSerialSession.enqueueWrite]/[UsbSerialWriteQueue]) - never
   * writing directly from whatever thread called this method. The
   * returned [promise] settles exactly once, from that queue's own
   * consumer thread, only once this specific write has actually completed
   * (success or failure) - never merely once it was enqueued. A full
   * queue rejects immediately with WRITE_QUEUE_FULL; a queue already
   * stopped (session closed/detached/module invalidated) rejects
   * immediately with SESSION_CLOSED. Neither case ever leaves anything
   * unresolved.
   */
  override fun writeBytes(sessionId: String, dataBase64: String, promise: Promise) {
    val session = sessionRegistry.get(sessionId)
    if (session == null) {
      promise.rejectTransportError(UsbTransportException("UNKNOWN_SESSION", "No active session with id $sessionId."))
      return
    }
    val buffer =
      try {
        Base64.decode(dataBase64, Base64.NO_WRAP)
      } catch (error: Exception) {
        promise.rejectTransportError(
          UsbTransportException("WRITE_FAILED", error.message ?: "Invalid Base64 write payload."),
        )
        return
      }
    val request =
      UsbSerialWriteRequest(buffer, TX_WRITE_TIMEOUT_MILLIS) { result ->
        result.fold(
          onSuccess = { promise.resolve(null) },
          onFailure = { error -> promise.rejectTransportError(toWriteFailureError(error)) },
        )
      }
    when (session.enqueueWrite(request)) {
      UsbSerialWriteQueue.EnqueueResult.Accepted -> Unit // settles later, via request.onComplete
      UsbSerialWriteQueue.EnqueueResult.QueueFull ->
        promise.rejectTransportError(
          UsbTransportException("WRITE_QUEUE_FULL", "The write queue for session $sessionId is full."),
        )
      UsbSerialWriteQueue.EnqueueResult.Stopped ->
        promise.rejectTransportError(UsbTransportException("SESSION_CLOSED", "Session $sessionId was closed."))
    }
  }

  /**
   * Starts a receive loop for an already-open session. Explicit and
   * idempotent-by-rejection: calling this while a receive loop is genuinely
   * active for the session fails immediately with RX_ALREADY_ACTIVE.
   *
   * Pass 5.2 corrective note (PASS5.2-AUDIT-F1): the entire attempt - including
   * a possible bounded wait for a still-retiring previous attempt on this
   * exact session (see [UsbSerialReadRegistry.StartAttempt.Retiring]) - runs
   * on its own dedicated, throwaway thread, never on whatever thread called
   * this method. This is required because a rapid stopReading() followed
   * immediately by startReading() for the *same still-open* session must
   * never let the new attempt begin reading before the old attempt's worker
   * thread has actually returned from UsbSerialPort.read() - the pinned
   * usb-serial-for-android dependency provides no internal synchronization
   * for concurrent read() calls on one port and documents shared,
   * unsynchronized read state, so two threads inside read() on the same
   * port at once is a genuine data race, not merely a stale-event risk.
   * Token invalidation alone (checked by [SerialReadLoop] via [isCurrent])
   * stops a stale worker from *emitting* but does nothing to stop its
   * thread from still being physically inside a blocking native call - only
   * an actual, confirmed thread exit (via [ReadWorkerHandle]) does that.
   */
  override fun startReading(sessionId: String, promise: Promise) {
    Thread({ performStartReading(sessionId, promise) }, "UsbSerialRxStart-$sessionId")
      .apply { isDaemon = true }
      .start()
  }

  /**
   * Attempts to claim [sessionId] for a new receive attempt, atomically
   * under [lifecycleLock] exactly as before (see [closeSession]'s own note
   * for the startReading-vs-closeSession race this closes). If the registry
   * reports [UsbSerialReadRegistry.StartAttempt.Retiring] - a previous
   * attempt's token is already inactive but its thread has not yet
   * confirmed it exited - waits, bounded, on this (already dedicated,
   * off-caller) thread for that confirmation, then makes exactly one more
   * attempt, re-validating [invalidated] and the session's continued
   * existence since real time has passed. Never retries more than once -
   * a second [StartAttempt.Retiring] on the retry (which would require
   * another attempt to have raced in during the wait) is treated as a
   * restart timeout rather than waiting again, keeping this method's own
   * worst-case latency bounded to one [RX_RESTART_WAIT_MILLIS] window.
   *
   * Pass 5.7 corrective note (PASS5.7-AUDIT): a Pass-6-prep audit found this
   * method had no top-level exception safety net, unlike every other public
   * method in this class (openDevice()/closeSession()/writeBytes() all
   * guarantee their Promise settles even on a genuinely unexpected
   * exception) - an uncaught exception on this method's dedicated thread
   * would previously have gone to the JVM's default
   * UncaughtExceptionHandler and left [promise] permanently unsettled, with
   * no live trigger identified but no defense either. Now wrapped in a
   * catch-all that rejects with NATIVE_OPERATION_FAILED - see its own note
   * below - and [attemptStartReading]'s own `Started` branch additionally
   * releases any readRegistry entry it just created if starting the real
   * worker thread itself fails, so a failure here can never leave
   * [sessionId] permanently stuck reporting RX_ALREADY_ACTIVE/Retiring for
   * every future startReading() attempt either.
   */
  private fun performStartReading(sessionId: String, promise: Promise) {
    try {
      when (val firstAttempt = attemptStartReading(sessionId)) {
        is StartReadingAttemptOutcome.NeedsRetirementWait -> {
          val finished = firstAttempt.handle.awaitDone(RX_RESTART_WAIT_MILLIS)
          val secondAttempt =
            if (!finished) {
              StartReadingAttemptOutcome.RestartTimedOut
            } else {
              when (val retryAttempt = attemptStartReading(sessionId)) {
                is StartReadingAttemptOutcome.NeedsRetirementWait -> StartReadingAttemptOutcome.RestartTimedOut
                else -> retryAttempt
              }
            }
          settleStartReading(sessionId, secondAttempt, promise)
        }
        else -> settleStartReading(sessionId, firstAttempt, promise)
      }
    } catch (error: Exception) {
      // PASS5.7-AUDIT: last-resort safety net only, mirroring openDevice()'s
      // own outer catch relative to completeOpen()'s specific error
      // handling - every NAMED StartReadingAttemptOutcome is already
      // exhaustively handled by settleStartReading() above (including the
      // deliberate `error(...)` assertion for the structurally-unreachable
      // NeedsRetirementWait case, which this catch now also converts into a
      // real rejection instead of a silent thread death). This exists so
      // this method - unlike before this pass - can never leave [promise]
      // permanently unsettled no matter what unexpected exception occurs
      // anywhere in this call graph, matching every other public method in
      // this class. attemptStartReading()'s own Started branch already
      // releases any readRegistry entry it created before rethrowing here -
      // see its own note - so this catch only needs to settle the Promise,
      // never to repeat that registry cleanup itself.
      promise.rejectTransportError(
        UsbTransportException(
          "NATIVE_OPERATION_FAILED",
          error.message ?: "Unexpected failure while starting the receive loop for session $sessionId.",
        ),
      )
    }
  }

  /**
   * One atomic lookup-and-claim attempt, reusable for both the initial try
   * and the single post-wait retry. Starting the worker thread itself is a
   * fast, non-blocking call (creating and starting a Thread does not run
   * its body synchronously) so doing it inside this short critical section
   * does not violate the "never hold this lock during native I/O" rule -
   * no native read happens until the new thread's own run() begins.
   */
  private fun attemptStartReading(sessionId: String): StartReadingAttemptOutcome =
    synchronized(lifecycleLock) {
      if (invalidated) {
        StartReadingAttemptOutcome.ModuleInvalidated
      } else {
        val session = sessionRegistry.get(sessionId)
        if (session == null) {
          StartReadingAttemptOutcome.UnknownSession
        } else {
          when (val attempt = readRegistry.start(sessionId)) {
            is UsbSerialReadRegistry.StartAttempt.Started -> {
              try {
                startReceiveWorker(sessionId, attempt.token, attempt.handle, session)
                StartReadingAttemptOutcome.Started
              } catch (error: Exception) {
                // PASS5.7-AUDIT: readRegistry.start() above already inserted
                // an "active" entry for this attempt before
                // startReceiveWorker() ever ran. If that call throws before
                // the real worker thread's own body begins - and therefore
                // before its own finally block could ever call
                // confirmRetired() - this exact sessionId would otherwise
                // stay permanently "active": every future startReading() for
                // it would see AlreadyActive/Retiring forever, a registry
                // leak independent of (and in addition to) the Promise
                // itself never settling. Release it here, ourselves - this
                // is the only code that still has this exact handle in
                // scope - then rethrow so performStartReading()'s own outer
                // catch (see its note) settles the Promise.
                readRegistry.confirmRetired(sessionId, attempt.handle)
                throw error
              }
            }
            UsbSerialReadRegistry.StartAttempt.AlreadyActive -> StartReadingAttemptOutcome.AlreadyActive
            is UsbSerialReadRegistry.StartAttempt.Retiring ->
              StartReadingAttemptOutcome.NeedsRetirementWait(attempt.handle)
          }
        }
      }
    }

  private fun settleStartReading(sessionId: String, outcome: StartReadingAttemptOutcome, promise: Promise) {
    when (outcome) {
      StartReadingAttemptOutcome.Started -> promise.resolve(null)
      StartReadingAttemptOutcome.ModuleInvalidated ->
        promise.rejectTransportError(
          UsbTransportException("MODULE_INVALIDATED", "The transport module is being torn down."),
        )
      StartReadingAttemptOutcome.UnknownSession ->
        promise.rejectTransportError(
          UsbTransportException("UNKNOWN_SESSION", "No active session with id $sessionId."),
        )
      StartReadingAttemptOutcome.AlreadyActive ->
        promise.rejectTransportError(
          UsbTransportException(
            "RX_ALREADY_ACTIVE",
            "A receive loop is already active for session $sessionId.",
          ),
        )
      StartReadingAttemptOutcome.RestartTimedOut ->
        promise.rejectTransportError(
          UsbTransportException(
            "RX_RESTART_TIMEOUT",
            "Timed out waiting for the previous receive loop for session $sessionId to stop.",
          ),
        )
      is StartReadingAttemptOutcome.NeedsRetirementWait ->
        error("NeedsRetirementWait must never reach settleStartReading directly")
    }
  }

  /**
   * Stops the receive loop for [sessionId], if one is active. Idempotent
   * and safe to call repeatedly or for a session with no active (or no
   * longer existing) receive loop - [UsbSerialReadRegistry.retire] is
   * itself a harmless no-op in that case. Never touches or closes the
   * underlying session - this method's contract is receive-loop lifecycle
   * only, matching the public API's separation of concerns.
   *
   * Resolves immediately, without waiting for the worker's thread to
   * actually exit - it only guarantees that worker will emit no further
   * chunks or errors for this attempt, within at most one read-timeout
   * window. Deliberately uses [UsbSerialReadRegistry.retire] rather than
   * [UsbSerialReadRegistry.removeSession]: retire() keeps this session's
   * entry (and its [ReadWorkerHandle]) registered until the worker itself
   * confirms it exited, which is exactly what lets a subsequent
   * startReading() for this same still-open session correctly wait for
   * that real thread to finish before reading the same port again (see
   * [startReading]'s own note, PASS5.2-AUDIT-F1). removeSession() remains
   * correct for closeSession()/detach/invalidate, where the session itself
   * is going away and no future startReading() for this exact sessionId can
   * ever occur.
   */
  override fun stopReading(sessionId: String, promise: Promise) {
    readRegistry.retire(sessionId)
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
   *
   * The finally block's [UsbSerialReadRegistry.confirmRetired] call runs
   * unconditionally, whatever the reason run() returned - normal stop,
   * detach/close/invalidate removing this session's entry, or an unexpected
   * read failure - so this exact sessionId is always eventually freed for a
   * fresh startReading() attempt, and any startReading() call currently
   * waiting on [handle] is always eventually unblocked (bounded by this
   * loop's own read-timeout-driven exit latency).
   */
  private fun startReceiveWorker(
    sessionId: String,
    token: ReceiveToken,
    handle: ReadWorkerHandle,
    session: UsbSerialSession,
  ) {
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
    Thread(
      {
        try {
          loop.run()
        } finally {
          readRegistry.confirmRetired(sessionId, handle)
        }
      },
      "UsbSerialRx-$sessionId",
    ).apply { isDaemon = true }.start()
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
          }
        }
      }
    // PASS5.3-STEP1-CORRECTION4: uses the same closeSessionRejectingPendingWrites
    // sequencing as closeSession()/invalidate() - the write queue is
    // stopped and its still-queued writes rejected strictly before
    // session.close() is even submitted to ioExecutor, not after, as an
    // earlier version of this method did (that earlier ordering meant the
    // close task could already be running on ioExecutor's own thread
    // before this thread ever reached the write-queue stop, leaving which
    // of the two "wins" a race - both individually safe/idempotent, but
    // needlessly non-deterministic in order).
    detachedSession?.let { session ->
      closeSessionRejectingPendingWrites(
        session = session,
        rejectPendingWrites = { rejectPendingWrites(it, session.sessionId) },
        performClose = { ioExecutor.submit { session.close() } },
      )
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

    val drainedSessions =
      synchronized(lifecycleLock) {
        if (invalidated) {
          null
        } else {
          invalidated = true
          readRegistry.removeAll()
          sessionRegistry.removeAll()
        }
      }

    if (drainedSessions == null) return

    drainedSessions.forEach { session ->
      closeSessionRejectingPendingWrites(
        session = session,
        rejectPendingWrites = { rejectPendingWrites(it, session.sessionId) },
        performClose = {
          ioExecutor.submit {
            try {
              session.close()
            } catch (_: Exception) {
              // Best-effort during teardown - there is no Promise left to report this to.
            }
          }
        },
      )
    }

    permissionRequester.cancelAll()
    ioExecutor.shutdown()
  }

  /**
   * Rejects every [pendingWrites] request (already drained from a
   * session's write queue by the caller - see
   * [UsbSerialSession.stopAndDrainPendingWrites]) with SESSION_CLOSED.
   * Deliberately a no-op loop over an already-drained list, never itself
   * touching any lock or registry - callers decide when it is safe to
   * call this (see closeSession()/handleDeviceDetached()/invalidate()'s
   * own notes on why it is always safe immediately after this exact
   * sessionId is removed from [sessionRegistry]).
   */
  private fun rejectPendingWrites(pendingWrites: List<UsbSerialWriteRequest>, sessionId: String) {
    pendingWrites.forEach { request ->
      request.onComplete(Result.failure(UsbTransportException("SESSION_CLOSED", "Session $sessionId was closed.")))
    }
  }

  /** Maps a write failure to a stable error code - preserves an existing UsbTransportException's own code, otherwise WRITE_FAILED. */
  private fun toWriteFailureError(error: Throwable): UsbTransportException =
    if (error is UsbTransportException) {
      error
    } else {
      UsbTransportException("WRITE_FAILED", error.message ?: "USB serial write failed.")
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

/** [UsbSerialTransportModule.awaitPermissionResult]'s single-value handoff result. */
private data class PermissionOutcome(val granted: Boolean, val failureMessage: String?)

/**
 * The outcome of one startReading() attempt (see
 * [UsbSerialTransportModule.attemptStartReading]/[UsbSerialTransportModule.settleStartReading]).
 * [NeedsRetirementWait] is an intermediate state, produced only by
 * `attemptStartReading` and consumed only by `performStartReading` - it must
 * never reach `settleStartReading` directly (enforced there defensively).
 */
private sealed class StartReadingAttemptOutcome {
  object Started : StartReadingAttemptOutcome()

  object ModuleInvalidated : StartReadingAttemptOutcome()

  object UnknownSession : StartReadingAttemptOutcome()

  object AlreadyActive : StartReadingAttemptOutcome()

  object RestartTimedOut : StartReadingAttemptOutcome()

  data class NeedsRetirementWait(val handle: ReadWorkerHandle) : StartReadingAttemptOutcome()
}

/**
 * How long a single native read call blocks waiting for data before
 * returning 0 bytes and letting the loop re-check whether it should keep
 * running - see SerialReadLoop's own note on why a finite, non-zero timeout
 * is required for cooperative cancellation. Chosen as a balance between
 * prompt stop responsiveness and not waking up needlessly often.
 *
 * SETUP ORIENTATION LATENCY CORRECTION. Real-device measurement had been
 * interpreted as an FC/link ceiling (~224ms median MSP_ATTITUDE RTT), but
 * this module itself imposed almost that entire delay: RX held the shared
 * read/write lock for up to 200ms while idle, so a newly queued telemetry
 * write frequently waited for that read quantum before it was even put on
 * USB. The same artificial wait also sat in front of emergency motor-stop
 * writes.
 *
 * 25ms keeps the receive loop blocking (40 idle wake-ups/s, not a busy
 * spin), still provides cooperative cancellation, and bounds the
 * lock-induced part of every TX latency to one short frame interval. The
 * fair-lock guarantee is unchanged: a queued writer still wins the very
 * next release. This value is internal rather than private so the JVM
 * timing-policy test can keep the responsiveness budget from silently
 * regressing.
 */
internal const val RX_READ_TIMEOUT_MILLIS = 25

/**
 * How long a startReading() attempt waits, at most, for a still-retiring
 * previous attempt on the same session to confirm its worker thread has
 * actually exited (see PASS5.2-AUDIT-F1's corrective note on
 * [UsbSerialTransportModule.startReading]) before giving up and rejecting
 * with RX_RESTART_TIMEOUT. Set to [RX_READ_TIMEOUT_MILLIS] plus a modest
 * margin: the retiring worker is guaranteed to notice its token is no
 * longer active and return from run() within one read-timeout window, so
 * this bound only needs to cover that plus ordinary thread-scheduling
 * overhead, not an unbounded or arbitrarily long wait.
 */
private const val RX_RESTART_WAIT_MILLIS = (RX_READ_TIMEOUT_MILLIS + 100).toLong()

/**
 * How long a single write() attempt blocks, at most, before this
 * project's own write queue treats it as failed (PASS5.3-STEP1).
 *
 * Two things can delay a write beyond the time it takes to physically
 * transmit: waiting to acquire UsbSerialSession's own fair ioLock behind
 * an in-progress RX read (bounded to at most one RX read cycle - see
 * [RX_READ_TIMEOUT_MILLIS] - by fairness itself, never more), and the
 * transmission itself. MSP command frames are small (typically well
 * under 256 bytes); at any realistic serial baud rate this project
 * configures, that takes well under this bound to physically transmit
 * even with no contention at all. No confirmed real-world MSP
 * responsiveness or throughput requirement is known yet at this pass -
 * the bound is chosen conservatively (generous headroom over both of the
 * above combined) rather than aggressively, so a momentarily busy link
 * does not spuriously fail a normal write, while still bounding a
 * genuinely stuck write so it can never block this session's write-queue
 * consumer thread - and therefore every write queued behind it -
 * indefinitely.
 *
 * R4 - WHY THIS IS 150ms AND NOT 1000ms.
 *
 * This constant is the REAL upper bound on how long an emergency motor
 * STOP can be delayed, and it is the only one that matters. The stop
 * cannot cancel a write already handed to the native layer: this queue is
 * strict-FIFO with a single consumer thread and UsbSerialSession.write()
 * additionally holds ioLock, so the stop's frame cannot begin execution
 * at the writer until the in-flight write returns or times out. Neither
 * the JS response timeout nor the motor-test safety read's 400ms response
 * bound constrains that at all - they bound waiting for an ANSWER, not
 * the preceding write.
 *
 * At 1000ms the worst-case stop delay was ~1000ms, four times the 250ms
 * maximum the motor-test safety contract requires. 150ms restores the
 * guarantee with large margin over physical reality: an MSP command frame
 * is 6-20 bytes, which a USB bulk transfer completes in well under a
 * millisecond, so 150ms is still ~100x the realistic duration. A write
 * that genuinely takes longer than this means the link is stalled - the
 * exact situation in which failing fast and faulting is correct and
 * waiting is not.
 *
 * The bound applies uniformly to every write rather than only to
 * motor-test traffic: a per-caller timeout would put the safety-critical
 * choice in the hands of each call site, and any site that got it wrong
 * would silently reintroduce the delay.
 */
private const val TX_WRITE_TIMEOUT_MILLIS = 150

/**
 * Product bound for the native portion of an emergency stop: at most one
 * in-flight RX lock quantum plus the write call's own timeout. Response
 * confirmation has a separate JS-side bound.
 */
internal const val MOTOR_STOP_NATIVE_WRITE_BUDGET_MILLIS = 250

/** Package-visible combined bound for the JVM timing-policy regression
 * test; the individual write timeout remains private because it is an
 * implementation detail already guarded by the JS stop-latency suite. */
internal const val NATIVE_IO_LOCK_WAIT_UPPER_BOUND_MILLIS =
  RX_READ_TIMEOUT_MILLIS + TX_WRITE_TIMEOUT_MILLIS

/**
 * The single overall bound (Pass 5.4, PASS5.4-CONNECT-TIMEOUT) covering an
 * entire connect attempt from the moment permission is requested through the
 * end of the native open/port-open/setParameters/setFlowControl sequence -
 * see [UsbSerialTransportModule.openDevice]'s own note and the class-level
 * Pass 5.4 note for why this was added (a confirmed real-hardware hang with
 * no existing bound at all).
 *
 * This one bound necessarily also counts ordinary human interaction time
 * with the real permission dialog against it - there is no way from here to
 * tell "waiting on a person to tap a dialog" apart from "stuck in a hung
 * native call" (see [UsbSerialTransportModule.awaitPermissionResult]'s own
 * note on why it has no separate bound of its own). 15 seconds is chosen to
 * make a spurious timeout during normal, attentive dialog interaction rare,
 * while still bounding a genuinely stuck attempt to a wait a real user will
 * actually tolerate rather than assume the app has frozen. No confirmed
 * real-world UX requirement pins this number down more precisely yet - this
 * is a considered starting point, not a measured one.
 */
private const val CONNECT_TIMEOUT_MILLIS = 15_000L

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

internal fun Promise.rejectTransportError(error: UsbTransportException) {
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
