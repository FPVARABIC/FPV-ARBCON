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
 *
 * PASS5.2-AUDIT-F2 correction: the same-session restart test below now
 * launches a genuine successor [Thread] via [spawnWorker] for every
 * [UsbSerialReadRegistry.StartAttempt.Started] result it obtains from a
 * restart, and that successor becomes the "old" worker being retired in the
 * next cycle - a real chain of worker threads, not a single worker with its
 * restart outcome immediately discarded. This is what lets the test actually
 * detect a regression in the retiring-worker coordination itself, rather
 * than only exercising [UsbSerialReadRegistry]'s state machine in isolation
 * (already covered by UsbSerialReadRegistryTest.kt).
 */
class UsbSerialRxRestartConcurrencyTest {

  /** Wraps a [SerialReadSource] to track how many reads are in flight at once. */
  private class CountingReadSource(
    private val activeReadCount: AtomicInteger,
    private val maximumConcurrentReadCount: AtomicInteger,
    private val totalReadEntryCount: AtomicInteger = AtomicInteger(0),
    private val onRead: (buffer: ByteArray) -> Int,
  ) : SerialReadSource {
    override fun read(buffer: ByteArray, timeoutMillis: Int): Int {
      val current = activeReadCount.incrementAndGet()
      maximumConcurrentReadCount.updateAndGet { max -> maxOf(max, current) }
      totalReadEntryCount.incrementAndGet()
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

  /**
   * Mirrors startReceiveWorker(): runs the loop, then confirms retirement
   * unconditionally. [onFailure] records anything unexpected that escapes
   * [SerialReadLoop.run] itself (e.g. a misbehaving callback) so no
   * background-thread failure can be silently lost - see
   * [assertNoBackgroundFailure].
   */
  private fun spawnWorker(
    registry: UsbSerialReadRegistry,
    sessionId: String,
    started: UsbSerialReadRegistry.StartAttempt.Started,
    source: SerialReadSource,
    onChunk: (buffer: ByteArray, length: Int) -> Unit = { _, _ -> },
    onFailure: (Throwable) -> Unit = {},
  ): Thread {
    val loop =
      SerialReadLoop(
        sessionId = sessionId,
        token = started.token,
        source = source,
        registry = registry,
        readTimeoutMillis = 1000,
        onChunk = onChunk,
        onTerminalError = { },
      )
    val thread =
      Thread({
        try {
          loop.run()
        } catch (error: Throwable) {
          onFailure(error)
        } finally {
          registry.confirmRetired(sessionId, started.handle)
        }
      }, "test-rx-worker-$sessionId")
        .apply { isDaemon = true }
    thread.start()
    return thread
  }

  /** First-failure-wins recorder for exceptions raised on a background thread. */
  private fun recordFailure(failureRef: AtomicReference<Throwable?>, error: Throwable) {
    failureRef.compareAndSet(null, error)
  }

  /** Fails the test - with the original throwable preserved as the cause - if any background thread recorded a failure. */
  private fun assertNoBackgroundFailure(failureRef: AtomicReference<Throwable?>) {
    val failure = failureRef.get()
    if (failure != null) {
      throw AssertionError("a background thread recorded an unexpected failure", failure)
    }
  }

  /** One worker's live coordination handles within the restart chain below. */
  private class ChainWorker(
    val thread: Thread,
    val readEntered: CountDownLatch,
    val releaseRead: CountDownLatch,
    val handle: ReadWorkerHandle,
  )

  /**
   * Launches one real worker for [started], using fresh, per-call latches so
   * no cycle can ever observe or consume another cycle's entry/release
   * signal. [cycleTag] is written into the read buffer purely so a failure
   * dump would show which cycle's worker produced which data - it plays no
   * synchronization role.
   */
  private fun launchChainWorker(
    registry: UsbSerialReadRegistry,
    sessionId: String,
    started: UsbSerialReadRegistry.StartAttempt.Started,
    activeReadCount: AtomicInteger,
    maximumConcurrentReadCount: AtomicInteger,
    totalReadEntryCount: AtomicInteger,
    emittedChunks: AtomicInteger,
    backgroundFailure: AtomicReference<Throwable?>,
    cycleTag: Int,
  ): ChainWorker {
    val readEntered = CountDownLatch(1)
    val releaseRead = CountDownLatch(1)
    val source =
      CountingReadSource(activeReadCount, maximumConcurrentReadCount, totalReadEntryCount) { buffer ->
        readEntered.countDown()
        // Bounded wait only - see the no-assert note on background-thread
        // assertions in SerialReadLoopTest; failures here are still caught
        // via assertNoBackgroundFailure below, not lost.
        releaseRead.await(2, TimeUnit.SECONDS)
        buffer[0] = cycleTag.toByte()
        1
      }
    val thread =
      spawnWorker(
        registry = registry,
        sessionId = sessionId,
        started = started,
        source = source,
        onChunk = { _, _ -> emittedChunks.incrementAndGet() },
        onFailure = { error -> recordFailure(backgroundFailure, error) },
      )
    return ChainWorker(thread, readEntered, releaseRead, started.handle)
  }

  /**
   * T1 (also subsumes T2 and T5, proven every cycle rather than once - see
   * each assertion's own note): a genuine chain of real worker threads for
   * the *same* session, across [RESTART_CYCLE_COUNT] rapid stop-then-restart
   * cycles. Every [UsbSerialReadRegistry.StartAttempt.Started] result this
   * test obtains is passed to [launchChainWorker] - never retired/confirmed
   * without first owning a real, running worker - and that worker becomes
   * the "old" worker being retired in the very next cycle. This is the
   * PASS5.2-AUDIT-F2 correction: the previous version of this test obtained
   * a fresh Started result after each restart and immediately retired +
   * confirmed it without ever launching a worker for it, so only the
   * original worker ever genuinely entered read() - the restart handshake
   * itself was never exercised end-to-end with two real threads.
   */
  @Test
  fun `rapid same-session stop-restart cycles never allow more than one concurrent read`() {
    val registry = UsbSerialReadRegistry()
    val sessionId = "s1"
    val activeReadCount = AtomicInteger(0)
    val maximumConcurrentReadCount = AtomicInteger(0)
    val totalReadEntryCount = AtomicInteger(0)
    val emittedChunks = AtomicInteger(0)
    val backgroundFailure = AtomicReference<Throwable?>(null)
    var workerLaunchCount = 0

    val initialStarted = registry.start(sessionId) as UsbSerialReadRegistry.StartAttempt.Started
    var current =
      launchChainWorker(
        registry, sessionId, initialStarted, activeReadCount, maximumConcurrentReadCount,
        totalReadEntryCount, emittedChunks, backgroundFailure, cycleTag = 0,
      )
    workerLaunchCount++
    assertTrue("worker 0 must genuinely enter read()", current.readEntered.await(2, TimeUnit.SECONDS))
    assertEquals(1, totalReadEntryCount.get())

    for (cycle in 0 until RESTART_CYCLE_COUNT) {
      // Simulates stopReading() immediately followed by startReading() for
      // the same still-open session, while the current worker's read is
      // still genuinely blocked.
      registry.retire(sessionId)

      // Requirement: the restart request must encounter the real
      // retiring-worker coordination path. start() has no side effect for
      // the Retiring case (it only reads the existing entry), so probing it
      // here does not disturb the restartThread's own subsequent call.
      assertTrue(
        "cycle $cycle: a restart attempted while the old worker is still running " +
          "must observe Retiring, not a fresh Started or AlreadyActive - this is the " +
          "exact coordination path the F1 fix depends on",
        registry.start(sessionId) is UsbSerialReadRegistry.StartAttempt.Retiring,
      )

      val restartResult = AtomicReference<UsbSerialReadRegistry.StartAttempt.Started?>()
      val restartThread =
        Thread({
          try {
            restartResult.set(startWithRetry(registry, sessionId, waitMillis = 300))
          } catch (error: Throwable) {
            recordFailure(backgroundFailure, error)
          }
        }, "test-restart-$sessionId-$cycle")
          .apply { isDaemon = true }
      restartThread.start()

      // Before releasing the old worker: no successor may have entered
      // read() yet - the count must still reflect only the workers that
      // have already run in prior cycles plus this cycle's still-blocked
      // worker, never one more.
      assertEquals(
        "cycle $cycle: no successor may enter read() before the old worker is released",
        cycle + 1,
        totalReadEntryCount.get(),
      )

      // Release the old, superseded worker's exact read cycle - and only
      // that cycle's own latch, never a later one, since each cycle's
      // latches are freshly created.
      current.releaseRead.countDown()
      current.thread.join(2000)
      assertFalse("cycle $cycle: old worker must have exited", current.thread.isAlive)

      restartThread.join(2000)
      assertFalse(restartThread.isAlive)
      val restarted =
        restartResult.get() ?: error("cycle $cycle: restart must succeed once the old worker confirmed retirement")

      // The corrective step for PASS5.2-AUDIT-F2: launch a genuine successor
      // worker for this Started result - never retire/confirm a Started
      // attempt that never owned a real running worker.
      val successor =
        launchChainWorker(
          registry, sessionId, restarted, activeReadCount, maximumConcurrentReadCount,
          totalReadEntryCount, emittedChunks, backgroundFailure, cycleTag = cycle + 1,
        )
      workerLaunchCount++
      assertTrue(
        "cycle $cycle: the successor worker must genuinely enter read()",
        successor.readEntered.await(2, TimeUnit.SECONDS),
      )
      assertEquals(cycle + 2, totalReadEntryCount.get())

      current = successor
    }

    // Final deterministic cleanup (T5): retire the last successor, release
    // its exact blocked read, join it with a bounded timeout, and confirm
    // every relevant piece of state has settled.
    registry.retire(sessionId)
    current.releaseRead.countDown()
    current.thread.join(2000)
    assertFalse("final worker must have exited", current.thread.isAlive)

    assertEquals(RESTART_CYCLE_COUNT + 1, workerLaunchCount)
    assertEquals(RESTART_CYCLE_COUNT + 1, totalReadEntryCount.get())
    assertEquals(
      "same-session restarts must never allow two concurrent real reads",
      1,
      maximumConcurrentReadCount.get(),
    )
    assertEquals("no worker may still be counted as reading after final cleanup", 0, activeReadCount.get())
    assertEquals(
      "a retired worker's late-returning data must never be emitted (T3)",
      0,
      emittedChunks.get(),
    )
    assertNull(
      "the registry must retain no entry for this session after the final worker's own finally block ran",
      registry.removeSession(sessionId),
    )
    assertNoBackgroundFailure(backgroundFailure)
  }

  /**
   * T4: two callers race a restart while the current worker is still
   * genuinely blocked in read(). Exactly one may obtain Started; the other
   * must receive null (AlreadyActive, once the first caller's fresh entry
   * is visible to it) - never two real successor workers, and never a
   * ghost registry entry left behind.
   */
  @Test
  fun `two concurrent restart callers - exactly one wins and no ghost worker is created`() {
    val registry = UsbSerialReadRegistry()
    val sessionId = "s1"
    val activeReadCount = AtomicInteger(0)
    val maximumConcurrentReadCount = AtomicInteger(0)
    val totalReadEntryCount = AtomicInteger(0)
    val emittedChunks = AtomicInteger(0)
    val backgroundFailure = AtomicReference<Throwable?>(null)

    val started = registry.start(sessionId) as UsbSerialReadRegistry.StartAttempt.Started
    val original =
      launchChainWorker(
        registry, sessionId, started, activeReadCount, maximumConcurrentReadCount,
        totalReadEntryCount, emittedChunks, backgroundFailure, cycleTag = 0,
      )
    assertTrue(original.readEntered.await(2, TimeUnit.SECONDS))

    registry.retire(sessionId)

    val resultA = AtomicReference<UsbSerialReadRegistry.StartAttempt.Started?>()
    val resultB = AtomicReference<UsbSerialReadRegistry.StartAttempt.Started?>()
    val callerA =
      Thread({
        try {
          resultA.set(startWithRetry(registry, sessionId, waitMillis = 300))
        } catch (error: Throwable) {
          recordFailure(backgroundFailure, error)
        }
      }, "test-restart-caller-A")
        .apply { isDaemon = true }
    val callerB =
      Thread({
        try {
          resultB.set(startWithRetry(registry, sessionId, waitMillis = 300))
        } catch (error: Throwable) {
          recordFailure(backgroundFailure, error)
        }
      }, "test-restart-caller-B")
        .apply { isDaemon = true }
    callerA.start()
    callerB.start()

    original.releaseRead.countDown()
    original.thread.join(2000)
    assertFalse(original.thread.isAlive)

    callerA.join(2000)
    callerB.join(2000)
    assertFalse(callerA.isAlive)
    assertFalse(callerB.isAlive)

    val winners = listOfNotNull(resultA.get(), resultB.get())
    assertEquals("exactly one of the two racing restart callers must obtain Started", 1, winners.size)
    val winner = winners.single()

    val successor =
      launchChainWorker(
        registry, sessionId, winner, activeReadCount, maximumConcurrentReadCount,
        totalReadEntryCount, emittedChunks, backgroundFailure, cycleTag = 1,
      )
    assertTrue(
      "exactly one real successor worker must be launched from the winning caller",
      successor.readEntered.await(2, TimeUnit.SECONDS),
    )

    registry.retire(sessionId)
    successor.releaseRead.countDown()
    successor.thread.join(2000)
    assertFalse(successor.thread.isAlive)

    assertEquals("no two same-session reads may ever have overlapped", 1, maximumConcurrentReadCount.get())
    assertEquals(0, activeReadCount.get())
    assertNull("no ghost registry entry may remain", registry.removeSession(sessionId))
    assertNoBackgroundFailure(backgroundFailure)
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

  private companion object {
    const val RESTART_CYCLE_COUNT = 5
  }
}
