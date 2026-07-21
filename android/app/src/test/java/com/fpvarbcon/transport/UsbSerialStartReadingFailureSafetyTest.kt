package com.fpvarbcon.transport

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Covers PASS5.7-AUDIT's fix for a confirmed gap: startReading()'s async
 * work previously had no top-level exception safety net, unlike every other
 * public method in UsbSerialTransportModule.kt - an unexpected exception
 * anywhere inside attemptStartReading()/settleStartReading() could leave the
 * Promise permanently unsettled, and (if it happened after
 * readRegistry.start() had already inserted an "active" entry but before the
 * real worker thread ever began running) could ALSO leave that sessionId
 * permanently stuck reporting RX_ALREADY_ACTIVE/Retiring forever - a
 * registry leak independent of the Promise itself.
 *
 * UsbSerialTransportModule itself extends ReactContextBaseJavaModule and
 * needs a real ReactApplicationContext to construct - its own
 * performStartReading()/attemptStartReading() cannot be called directly
 * without Robolectric, which this project does not use anywhere (the same
 * pre-existing boundary already applies to openDevice()/completeOpen() -
 * this is not a gap introduced by this fix). What IS directly testable on
 * the JVM, and is exercised here:
 *  - [UsbSerialReadRegistryTest]'s own new test proves the registry-cleanup
 *    half directly against the real UsbSerialReadRegistry class.
 *  - This file reproduces the exact two-layer try/catch CONTROL-FLOW SHAPE
 *    performStartReading()/attemptStartReading() now use - an inner
 *    catch that releases a registry entry before rethrowing, wrapped by an
 *    outer catch that rejects a real com.facebook.react.bridge.Promise (a
 *    plain Kotlin interface, no Android runtime needed - see
 *    UsbPromiseSettleOnceTest.kt's own note) - against the real
 *    UsbSerialReadRegistry, proving the PATTERN itself is sound: an
 *    unexpected exception always rejects rather than hangs, and never
 *    leaves the session permanently blocked for a subsequent attempt. This
 *    is a deliberate parallel reproduction of the fix's shape, not a call
 *    into UsbSerialTransportModule's own private methods.
 */
class UsbSerialStartReadingFailureSafetyTest {

  /** Records only what these tests need: how many times resolve()/the (code, message) reject() overload fired. */
  private class RecordingPromise : Promise {
    val resolveCount = AtomicInteger(0)
    val rejectCount = AtomicInteger(0)
    var lastRejectCode: String? = null

    override fun resolve(value: Any?) {
      resolveCount.incrementAndGet()
    }

    override fun reject(code: String?, message: String?) {
      lastRejectCode = code
      rejectCount.incrementAndGet()
    }

    override fun reject(code: String?, throwable: Throwable?) = unexpectedOverload()

    override fun reject(code: String?, message: String?, throwable: Throwable?) = unexpectedOverload()

    override fun reject(throwable: Throwable) = unexpectedOverload()

    override fun reject(throwable: Throwable, userInfo: WritableMap) = unexpectedOverload()

    override fun reject(code: String?, userInfo: WritableMap) = unexpectedOverload()

    override fun reject(code: String?, throwable: Throwable?, userInfo: WritableMap) = unexpectedOverload()

    override fun reject(code: String?, message: String?, userInfo: WritableMap) = unexpectedOverload()

    override fun reject(code: String?, message: String?, throwable: Throwable?, userInfo: WritableMap?) =
      unexpectedOverload()

    override fun reject(message: String) = unexpectedOverload()

    private fun unexpectedOverload(): Nothing =
      throw AssertionError("only the (code, message) reject() overload is expected to be used in this test")
  }

  /**
   * Reproduces PASS5.7-AUDIT's exact two-layer shape from
   * attemptStartReading()'s Started branch (inner try/catch, releasing the
   * just-created registry entry before rethrowing) and
   * performStartReading()'s own outer try/catch (rejecting with
   * NATIVE_OPERATION_FAILED on anything unexpected) - using the real
   * [UsbSerialReadRegistry] and a real [Promise], but a fake [startWorker]
   * callback standing in for startReceiveWorker() so its failure can be
   * controlled directly, without needing a real Android Thread/Context.
   */
  private fun performStartReadingLike(
    registry: UsbSerialReadRegistry,
    sessionId: String,
    promise: Promise,
    startWorker: (ReceiveToken, ReadWorkerHandle) -> Unit,
  ) {
    try {
      when (val attempt = registry.start(sessionId)) {
        is UsbSerialReadRegistry.StartAttempt.Started -> {
          try {
            startWorker(attempt.token, attempt.handle)
            promise.resolve(null)
          } catch (error: Exception) {
            registry.confirmRetired(sessionId, attempt.handle)
            throw error
          }
        }
        UsbSerialReadRegistry.StartAttempt.AlreadyActive ->
          promise.reject("RX_ALREADY_ACTIVE", "A receive loop is already active for session $sessionId.")
        is UsbSerialReadRegistry.StartAttempt.Retiring ->
          promise.reject("RX_RESTART_TIMEOUT", "Timed out waiting for the previous receive loop to stop.")
      }
    } catch (error: Exception) {
      promise.reject(
        "NATIVE_OPERATION_FAILED",
        error.message ?: "Unexpected failure while starting the receive loop for session $sessionId.",
      )
    }
  }

  @Test
  fun `an unexpected exception starting the worker rejects the Promise instead of leaving it pending forever`() {
    val registry = UsbSerialReadRegistry()
    val promise = RecordingPromise()

    performStartReadingLike(registry, "session-1", promise) { _, _ ->
      throw RuntimeException("simulated unexpected startReceiveWorker() failure")
    }

    assertEquals("the Promise must reject, not remain pending", 1, promise.rejectCount.get())
    assertEquals(0, promise.resolveCount.get())
    assertEquals("NATIVE_OPERATION_FAILED", promise.lastRejectCode)
  }

  @Test
  fun `after that failure, a fresh startReading attempt for the same session still succeeds - the registry is not left poisoned`() {
    val registry = UsbSerialReadRegistry()
    val firstPromise = RecordingPromise()
    performStartReadingLike(registry, "session-1", firstPromise) { _, _ ->
      throw RuntimeException("simulated unexpected startReceiveWorker() failure")
    }
    assertEquals(1, firstPromise.rejectCount.get())

    val secondPromise = RecordingPromise()
    performStartReadingLike(registry, "session-1", secondPromise) { _, _ ->
      // Simulates a normal, successful worker start this time.
    }

    assertEquals(
      "a subsequent attempt for the same session must succeed, not report RX_ALREADY_ACTIVE forever",
      1,
      secondPromise.resolveCount.get(),
    )
    assertEquals(0, secondPromise.rejectCount.get())
  }

  @Test
  fun `a successful start still resolves normally - the safety net does not interfere with the happy path`() {
    val registry = UsbSerialReadRegistry()
    val promise = RecordingPromise()

    performStartReadingLike(registry, "session-1", promise) { _, _ -> /* succeeds, no exception */ }

    assertEquals(1, promise.resolveCount.get())
    assertEquals(0, promise.rejectCount.get())
  }
}
