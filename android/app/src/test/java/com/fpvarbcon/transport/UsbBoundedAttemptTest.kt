package com.fpvarbcon.transport

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers [runOnDedicatedThreadWithTimeout] directly on the JVM, using plain
 * lambdas rather than any real USB type - see its own class-level note for
 * why it is deliberately generic and decoupled from open-attempt types
 * specifically, mirroring UsbBoundedProcessReaderTest.kt's own reasoning for
 * testing its bounded mechanism against a real, generic subprocess rather
 * than through captureAppLog() itself.
 */
class UsbBoundedAttemptTest {

  @Test
  fun `work completing well within the bound reports Completed with its result, promptly`() {
    val settleLatch = CountDownLatch(1)
    val outcomeRef = AtomicReference<UsbAttemptOutcome<String>>()

    val startNanos = System.nanoTime()
    runOnDedicatedThreadWithTimeout(
      threadName = "test-attempt-fast",
      timeoutMillis = 5_000L,
      work = { "hello" },
      onSettle = { outcome ->
        outcomeRef.set(outcome)
        settleLatch.countDown()
      },
    )

    assertTrue(settleLatch.await(2, TimeUnit.SECONDS))
    val elapsedMillis = (System.nanoTime() - startNanos) / 1_000_000
    assertTrue(
      "must settle promptly once work() actually finishes, not wait out the full bound - took ${elapsedMillis}ms",
      elapsedMillis < 4_000L,
    )

    val outcome = outcomeRef.get()
    assertTrue("expected Completed, got $outcome", outcome is UsbAttemptOutcome.Completed<*>)
    val completed = outcome as UsbAttemptOutcome.Completed<String>
    assertEquals("hello", completed.result.getOrNull())
  }

  @Test
  fun `work that never completes is reported TimedOut within the bound, without ever blocking the calling thread`() {
    val settleLatch = CountDownLatch(1)
    val outcomeRef = AtomicReference<UsbAttemptOutcome<Unit>>()
    // Never counted down - simulates a genuinely stuck native call (e.g.
    // claimInterface() with no timeout of its own - see
    // UsbSerialTransportModule's own class-level Pass 5.4 note).
    val neverRelease = CountDownLatch(1)

    val callStartNanos = System.nanoTime()
    runOnDedicatedThreadWithTimeout(
      threadName = "test-attempt-stuck",
      timeoutMillis = 500L,
      work = { neverRelease.await() },
      onSettle = { outcome ->
        outcomeRef.set(outcome)
        settleLatch.countDown()
      },
    )
    val callElapsedMillis = (System.nanoTime() - callStartNanos) / 1_000_000
    assertTrue(
      "runOnDedicatedThreadWithTimeout itself must return immediately, never block the calling thread - took ${callElapsedMillis}ms",
      callElapsedMillis < 200L,
    )

    assertTrue(
      "the watchdog must fire onSettle(TimedOut) within the bound even though work() never returns",
      settleLatch.await(2, TimeUnit.SECONDS),
    )
    assertEquals(UsbAttemptOutcome.TimedOut, outcomeRef.get())
  }

  @Test
  fun `onSettle fires exactly once even when the worker finishes at nearly the same moment the watchdog times out`() {
    repeat(50) { iteration ->
      val settleCount = AtomicInteger(0)
      val doneLatch = CountDownLatch(1)

      runOnDedicatedThreadWithTimeout(
        threadName = "test-attempt-race-$iteration",
        timeoutMillis = 20L,
        work = {
          // Deliberately close to the bound on both sides of it, alternating
          // per iteration, so completion and the watchdog genuinely race to
          // settle first across this loop - not just one deterministic order.
          Thread.sleep(if (iteration % 2 == 0) 15L else 25L)
        },
        onSettle = {
          settleCount.incrementAndGet()
          doneLatch.countDown()
        },
      )

      assertTrue("iteration $iteration must settle", doneLatch.await(2, TimeUnit.SECONDS))
      // onSettle's own compareAndSet guard is what makes exactly-once true,
      // not timing - but a brief grace period after the first settlement is
      // still given here so a losing side's own (harmless, no-op) attempt to
      // settle has a chance to run and be observed as a no-op, rather than
      // this check racing ahead of it.
      Thread.sleep(50L)
      assertEquals("iteration $iteration must settle exactly once, never twice", 1, settleCount.get())
    }
  }

  @Test
  fun `a stuck attempt on its own dedicated thread does not block a concurrent attempt for a different session`() {
    val stuckStarted = CountDownLatch(1)
    val neverRelease = CountDownLatch(1)
    val stuckSettled = CountDownLatch(1)

    // Timeout is deliberately far longer than this whole test - this attempt
    // is never expected to settle before the test itself finishes; only
    // that starting it never delays the second, independent attempt below.
    runOnDedicatedThreadWithTimeout(
      threadName = "test-attempt-stuck-concurrent",
      timeoutMillis = 60_000L,
      work = {
        stuckStarted.countDown()
        neverRelease.await()
      },
      onSettle = { stuckSettled.countDown() },
    )
    assertTrue(stuckStarted.await(2, TimeUnit.SECONDS))

    val secondSettleLatch = CountDownLatch(1)
    val secondOutcome = AtomicReference<UsbAttemptOutcome<String>>()
    val startNanos = System.nanoTime()
    runOnDedicatedThreadWithTimeout(
      threadName = "test-attempt-concurrent-other",
      timeoutMillis = 5_000L,
      work = { "unblocked" },
      onSettle = { outcome ->
        secondOutcome.set(outcome)
        secondSettleLatch.countDown()
      },
    )

    assertTrue(
      "a second, independent attempt must complete on its own thread, unaffected by the first attempt's stuck one",
      secondSettleLatch.await(2, TimeUnit.SECONDS),
    )
    val elapsedMillis = (System.nanoTime() - startNanos) / 1_000_000
    assertTrue(
      "the second attempt must not be delayed by the first attempt's stuck thread - took ${elapsedMillis}ms",
      elapsedMillis < 2_000L,
    )
    val completed = secondOutcome.get() as UsbAttemptOutcome.Completed<String>
    assertEquals("unblocked", completed.result.getOrNull())

    // Deliberately not awaited to true: this attempt's own 60s watchdog is
    // not expected to fire during this test's lifetime - it is left to leak
    // as a daemon thread (see runOnDedicatedThreadWithTimeout's own note on
    // why an abandoned worker thread can never block anything else).
    assertFalse(
      "this attempt's watchdog must not have already fired",
      stuckSettled.await(0, TimeUnit.MILLISECONDS),
    )
  }
}
