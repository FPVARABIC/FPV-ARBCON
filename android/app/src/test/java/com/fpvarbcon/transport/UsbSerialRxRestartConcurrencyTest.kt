package com.fpvarbcon.transport

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The direct, instrumented proof for PASS5.2-AUDIT-F1's required safety
 * property: for any one session, at most one real read() call may be in
 * flight at a time - across a rapid stopReading()->startReading() cycle on
 * the *same* still-open session - while two genuinely different sessions
 * remain free to read concurrently (the fix must not become a global lock).
 *
 * Deliberately built only from [UsbSerialReadRegistry] + [SerialReadLoop] +
 * real background Thread objects - no Android types, no Mockito/Robolectric -
 * mirroring exactly the coordination UsbSerialTransportModule.startReading()/
 * stopReading()/startReceiveWorker() perform for real (start() -> if
 * Retiring, bounded awaitDone() then retry once; every worker's own thread
 * confirms its retirement in a finally block after SerialReadLoop.run()
 * returns).
 */
class UsbSerialRxRestartConcurrencyTest {

  /** Wraps a [SerialReadSource] to track how many reads are in flight at once. */
  private class CountingReadSource(
    private val activeReadCount: AtomicInteger,
    private val maximumConcurrentReadCount: AtomicInteger,
    private val onRead: (buffer: ByteArray) -> Int,
  ) : SerialReadSource {
    override fun read(buffer: ByteArray, timeoutMillis: Int): Int {
      val current = activeReadCount.incrementAndGet()
      maximumConcurrentReadCount.updateAndGet { max -> maxOf(max, current) }
      try {
        return onRead(buffer)
      } finally {
        activeReadCount.decrementAndGet()
      }
    }
  }

  /**
   * Mirrors UsbSerialTransportModule's attemptStartReading()+performStartReading()
   * restart-wait logic exactly: a fresh Started is returned as-is; an
   * AlreadyActive attempt yields no worker (null); a Retiring attempt waits,
   * bounded, for the previous worker to confirm before retrying exactly
   * once - never fabricating a second worker while the first is still
   * running, and never waiting unboundedly.
   */
  private fun startWithRetry(
    registry: UsbSerialReadRegistry,
    sessionId: String,
    waitMillis: Long,
  ): UsbSerialReadRegistry.StartAttempt.Started? {
    val first = registry.start(sessionId)
    val resolved =
      if (first is UsbSerialReadRegistry.StartAttempt.Retiring) {
        first.handle.awaitDone(waitMillis)
        registry.start(sessionId)
      } else {
        first
      }
    return resolved as? UsbSerialReadRegistry.StartAttempt.Started
  }

  /** Mirrors startReceiveWorker(): runs the loop, then confirms retirement unconditionally. */
  private fun spawnWorker(
    registry: UsbSerialReadRegistry,
    sessionId: String,
    started: UsbSerialReadRegistry.StartAttempt.Started,
    source: SerialReadSource,
  ): Thread {
    val loop =
      SerialReadLoop(
        sessionId = sessionId,
        token = started.token,
        source = source,
        registry = registry,
        readTimeoutMillis = 1000,
        onChunk = { _, _ -> },
        onTerminalError = { },
      )
    val thread =
      Thread({
        try {
          loop.run()
        } finally {
          registry.confirmRetired(sessionId, started.handle)
        }
      }, "test-rx-worker-$sessionId")
        .apply { isDaemon = true }
    thread.start()
    return thread
  }

  @Test
  fun `rapid same-session stop-restart cycles never allow more than one concurrent read`() {
    val registry = UsbSerialReadRegistry()
    val activeReadCount = AtomicInteger(0)
    val maximumConcurrentReadCount = AtomicInteger(0)
    val sessionId = "s1"

    repeat(5) { cycle ->
      val readStarted = CountDownLatch(1)
      val releaseRead = CountDownLatch(1)
      val source =
        CountingReadSource(activeReadCount, maximumConcurrentReadCount) { buffer ->
          readStarted.countDown()
          // See SerialReadLoopTest's no-assert note: an AssertionError on this
          // background thread would not fail the test - the bounded
          // thread.join()s below are what actually enforce this.
          releaseRead.await(2, TimeUnit.SECONDS)
          buffer[0] = cycle.toByte()
          1
        }

      val started = registry.start(sessionId) as? UsbSerialReadRegistry.StartAttempt.Started
        ?: error("cycle $cycle: expected a fresh Started attempt, previous cycle left stale state")
      val worker = spawnWorker(registry, sessionId, started, source)
      assertTrue(readStarted.await(2, TimeUnit.SECONDS))

      // Simulates stopReading() immediately followed by startReading() for
      // the same session, while the old worker's read is still blocked.
      // retire() happens-before this thread is started, so the restart
      // attempt below is guaranteed to observe Retiring, never AlreadyActive
      // or a fresh Started - deterministically, not by scheduling luck.
      registry.retire(sessionId)
      val restartResult = AtomicReference<UsbSerialReadRegistry.StartAttempt.Started?>()
      val restartThread =
        Thread({ restartResult.set(startWithRetry(registry, sessionId, waitMillis = 300)) }, "test-restart-$sessionId")
          .apply { isDaemon = true }
      restartThread.start()

      // Let the old, superseded read return - this is what allows the old
      // worker's finally block to confirm retirement and unblock the
      // waiting restart attempt above.
      releaseRead.countDown()
      worker.join(2000)
      assertFalse("old worker for cycle $cycle must have exited", worker.isAlive)

      restartThread.join(2000)
      assertFalse(restartThread.isAlive)
      val restarted =
        restartResult.get() ?: error("cycle $cycle: restart must succeed once the old worker confirmed retirement")

      // Retire the new worker's session before starting the next cycle so
      // the following iteration begins from a clean, fully-retired state.
      registry.retire(sessionId)
      registry.confirmRetired(sessionId, restarted.handle)
    }

    assertEquals(
      "same-session restarts must never allow two concurrent real reads",
      1,
      maximumConcurrentReadCount.get(),
    )
  }

  @Test
  fun `two different sessions may read concurrently - the fix does not serialize unrelated sessions`() {
    val registry = UsbSerialReadRegistry()
    val activeReadCount = AtomicInteger(0)
    val maximumConcurrentReadCount = AtomicInteger(0)
    val bothStarted = CountDownLatch(2)
    val release = CountDownLatch(1)

    fun source() =
      CountingReadSource(activeReadCount, maximumConcurrentReadCount) { buffer ->
        bothStarted.countDown()
        release.await(2, TimeUnit.SECONDS)
        buffer[0] = 1
        1
      }

    val startedA = registry.start("s1") as UsbSerialReadRegistry.StartAttempt.Started
    val startedB = registry.start("s2") as UsbSerialReadRegistry.StartAttempt.Started
    val threadA = spawnWorker(registry, "s1", startedA, source())
    val threadB = spawnWorker(registry, "s2", startedB, source())

    assertTrue(
      "both unrelated sessions must be able to enter read() at the same time",
      bothStarted.await(2, TimeUnit.SECONDS),
    )

    // Retire both before releasing the reads so each loop exits cleanly
    // after this one read, instead of looping forever.
    registry.retire("s1")
    registry.retire("s2")
    release.countDown()

    threadA.join(2000)
    threadB.join(2000)
    assertFalse(threadA.isAlive)
    assertFalse(threadB.isAlive)

    assertTrue(
      "global concurrent reads must reach at least 2 across different sessions - the fix must not be a global lock",
      maximumConcurrentReadCount.get() >= 2,
    )
  }

  @Test
  fun `a restart that times out waiting for the previous worker to retire does not create a second worker`() {
    val registry = UsbSerialReadRegistry()
    registry.start("s1")
    registry.retire("s1")
    // The old worker never confirms retirement (simulates a stuck worker) -
    // startWithRetry must give up after its bounded wait, not fabricate a
    // second worker on top of the still-registered old one.

    val result = startWithRetry(registry, "s1", waitMillis = 50)

    assertNull("must not create a second worker while the previous one has not confirmed retirement", result)
    assertTrue(
      "exactly one (still-retiring) entry must remain for the session, never two",
      registry.start("s1") is UsbSerialReadRegistry.StartAttempt.Retiring,
    )
  }

  @Test
  fun `an old worker that fails unexpectedly still frees its session for a fresh restart`() {
    val registry = UsbSerialReadRegistry()
    val activeReadCount = AtomicInteger(0)
    val maximumConcurrentReadCount = AtomicInteger(0)
    val readStarted = CountDownLatch(1)
    val releaseRead = CountDownLatch(1)

    val source =
      CountingReadSource(activeReadCount, maximumConcurrentReadCount) { _ ->
        readStarted.countDown()
        releaseRead.await(2, TimeUnit.SECONDS)
        throw java.io.IOException("simulated unexpected native read failure")
      }

    val started = registry.start("s1") as UsbSerialReadRegistry.StartAttempt.Started
    val worker = spawnWorker(registry, "s1", started, source)
    assertTrue(readStarted.await(2, TimeUnit.SECONDS))

    registry.retire("s1")
    releaseRead.countDown()
    worker.join(2000)
    assertFalse(worker.isAlive)

    // The failing worker's own finally block must have confirmed retirement
    // even though it exited via an exception path, not a normal return.
    val restarted = registry.start("s1")
    assertTrue(
      "an unexpected worker failure must not permanently block future restarts of this session",
      restarted is UsbSerialReadRegistry.StartAttempt.Started,
    )
  }
}
