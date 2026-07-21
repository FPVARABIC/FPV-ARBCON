package com.fpvarbcon.transport

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers [UsbPromiseSettleOnce]'s own Boolean-return race contract directly -
 * added as part of PASS5.4-AUDIT-1's fix for a confirmed session leak (see
 * that class's own note): completeOpen()'s ACCEPTED branch needs to know
 * whether its own settle.resolve() call actually won the race against a
 * concurrent settle.reject(CONNECT_TIMEOUT) from the connect-timeout
 * watchdog, so it can clean up an orphaned session on a loss. This test
 * proves the Boolean contract itself is race-safe - not the full
 * completeOpen()/registry interaction, which would need Robolectric and is
 * out of reach here.
 *
 * A minimal fake [Promise] is used since com.facebook.react.bridge.Promise
 * is a plain Kotlin interface with no Android-runtime dependency of its own
 * - directly instantiable on the JVM, same reasoning already established for
 * every other JVM-only test in this package (e.g. UsbBoundedAttemptTest.kt).
 */
class UsbPromiseSettleOnceTest {

  /**
   * Records only what this test needs: how many times resolve()/the
   * (code, message) reject() overload actually reached the Promise.
   * UsbSerialTransportModule's own rejectTransportError() extension only
   * ever calls that one reject() overload when the UsbTransportException has
   * no `field` set (see its own implementation) - every other overload is
   * unused by this class and fails loudly if ever hit, so a future change
   * that starts using a different overload is caught here rather than
   * silently under-tested.
   */
  private class RecordingPromise : Promise {
    val resolveCount = AtomicInteger(0)
    val rejectCount = AtomicInteger(0)

    override fun resolve(value: Any?) {
      resolveCount.incrementAndGet()
    }

    override fun reject(code: String?, message: String?) {
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

  @Test
  fun `a concurrent resolve and reject race exactly once - exactly one call wins, the loser reports false`() {
    repeat(50) { iteration ->
      val promise = RecordingPromise()
      val settle = UsbPromiseSettleOnce(promise)
      val resolveResult = AtomicReference<Boolean>()
      val rejectResult = AtomicReference<Boolean>()
      val bothDone = CountDownLatch(2)

      val resolveThread =
        Thread({
          resolveResult.set(settle.resolve("session-$iteration"))
          bothDone.countDown()
        }, "test-resolve-$iteration")
          .apply { isDaemon = true }

      val rejectThread =
        Thread({
          rejectResult.set(settle.reject(UsbTransportException("CONNECT_TIMEOUT", "timed out")))
          bothDone.countDown()
        }, "test-reject-$iteration")
          .apply { isDaemon = true }

      // Started back-to-back, deliberately with no synchronization between
      // them, so the two calls genuinely race for the shared `settled` guard
      // rather than running in a fixed, deterministic order.
      resolveThread.start()
      rejectThread.start()

      assertTrue("iteration $iteration: both calls must return within the bound", bothDone.await(2, TimeUnit.SECONDS))
      resolveThread.join(2000)
      rejectThread.join(2000)

      val resolveWon = resolveResult.get()
      val rejectWon = rejectResult.get()
      assertTrue(
        "iteration $iteration: exactly one of resolve()/reject() must report winning, got resolve=$resolveWon reject=$rejectWon",
        resolveWon != rejectWon,
      )

      // The returned Boolean must actually match what reached the Promise -
      // not just be internally consistent with itself.
      assertEquals(
        "iteration $iteration: total settlements reaching the Promise",
        1,
        promise.resolveCount.get() + promise.rejectCount.get(),
      )
      assertEquals(
        "iteration $iteration: resolve() reaching the Promise must match its own reported win",
        if (resolveWon) 1 else 0,
        promise.resolveCount.get(),
      )
      assertEquals(
        "iteration $iteration: reject() reaching the Promise must match its own reported win",
        if (rejectWon) 1 else 0,
        promise.rejectCount.get(),
      )
    }
  }
}
