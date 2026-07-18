package com.fpvarbcon.transport

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Covers SerialReadLoop's read/emit/cancel/error behavior directly on the
 * JVM against a real [UsbSerialReadRegistry] and a fake [SerialReadSource] -
 * never a real UsbSerialPort. The first group of tests drives [run]
 * synchronously on the test thread (no real concurrency is being proven
 * there, only sequencing logic); the "lifecycle races" group runs [run] on
 * a real background Thread and uses CountDownLatch to force genuine,
 * deterministic interleavings against a concurrent registry mutation from
 * the test thread - proving the actual cross-thread race safety
 * UsbSerialTransportModule's stopReading()/closeSession()/detach/invalidate
 * paths rely on, not just single-threaded sequencing.
 */
class SerialReadLoopTest {

  @Test
  fun `received bytes are emitted unchanged, including values above 127`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    val expected = byteArrayOf(0x00, 0x01, 0x7f, 0x80.toByte(), 0xff.toByte())
    var callCount = 0
    val emittedChunks = mutableListOf<ByteArray>()

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source =
          SerialReadSource { buffer, _ ->
            callCount++
            if (callCount == 1) {
              expected.copyInto(buffer)
              expected.size
            } else {
              registry.removeSession("s1")
              0
            }
          },
        registry = registry,
        readTimeoutMillis = 10,
        onChunk = { buffer, length -> emittedChunks.add(buffer.copyOf(length)) },
        onTerminalError = { fail("unexpected terminal error: $it") },
      )

    loop.run()

    assertEquals(1, emittedChunks.size)
    assertArrayEquals(expected, emittedChunks[0])
  }

  @Test
  fun `byte order within a chunk is preserved`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    val expected = byteArrayOf(10, 20, 30, 40, 50)
    var callCount = 0
    var observed: ByteArray? = null

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source =
          SerialReadSource { buffer, _ ->
            callCount++
            if (callCount == 1) {
              expected.copyInto(buffer)
              expected.size
            } else {
              registry.removeSession("s1")
              0
            }
          },
        registry = registry,
        readTimeoutMillis = 10,
        onChunk = { buffer, length -> observed = buffer.copyOf(length) },
        onTerminalError = { fail("unexpected terminal error: $it") },
      )

    loop.run()

    assertArrayEquals(expected, observed)
  }

  @Test
  fun `a zero-byte read (timeout with no data) emits nothing`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    var callCount = 0
    var emitted = false

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source =
          SerialReadSource { _, _ ->
            callCount++
            if (callCount >= 3) registry.removeSession("s1")
            0
          },
        registry = registry,
        readTimeoutMillis = 5,
        onChunk = { _, _ -> emitted = true },
        onTerminalError = { fail("unexpected terminal error: $it") },
      )

    loop.run()

    assertFalse(emitted)
    assertEquals(3, callCount)
  }

  @Test
  fun `the loop does not busy-spin - it calls read exactly once per iteration using the given timeout`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    var callCount = 0
    val observedTimeouts = mutableListOf<Int>()

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source =
          SerialReadSource { _, timeoutMillis ->
            callCount++
            observedTimeouts.add(timeoutMillis)
            if (callCount >= 5) registry.removeSession("s1")
            0
          },
        registry = registry,
        readTimeoutMillis = 42,
        onChunk = { _, _ -> fail("no data was ever produced") },
        onTerminalError = { fail("unexpected terminal error: $it") },
      )

    loop.run()

    assertEquals(5, callCount)
    assertEquals(List(5) { 42 }, observedTimeouts)
  }

  @Test
  fun `no event occurs once the token has already been removed before the loop starts`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    registry.removeSession("s1")
    var readCalled = false

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source = SerialReadSource { _, _ -> readCalled = true; 0 },
        registry = registry,
        readTimeoutMillis = 10,
        onChunk = { _, _ -> fail("must not emit for an already-stale token") },
        onTerminalError = { fail("must not error for an already-stale token") },
      )

    loop.run()

    assertFalse("the loop must check isCurrent before ever calling read()", readCalled)
  }

  @Test
  fun `an unexpected read failure while the token is still current emits exactly one terminal error`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    val errors = mutableListOf<Exception>()

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source = SerialReadSource { _, _ -> throw IOException("simulated native read failure") },
        registry = registry,
        readTimeoutMillis = 10,
        onChunk = { _, _ -> fail("no data was ever produced") },
        onTerminalError = { error -> errors.add(error) },
      )

    loop.run()

    assertEquals(1, errors.size)
    assertEquals("simulated native read failure", errors[0].message)
  }

  @Test
  fun `a read failure after the token was already removed (normal stop) emits no error`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    registry.removeSession("s1")

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source = SerialReadSource { _, _ -> throw IOException("port already closed") },
        registry = registry,
        readTimeoutMillis = 10,
        onChunk = { _, _ -> fail("no data was ever produced") },
        onTerminalError = { fail("a failure caused by an already-intentional stop must not be reported as an error") },
      )

    loop.run()
    // Reaching here without the onTerminalError fail() firing is the assertion.
  }

  @Test
  fun `a normal stop (token removed, no failure) never emits an error`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    var callCount = 0

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source =
          SerialReadSource { _, _ ->
            callCount++
            if (callCount == 1) registry.removeSession("s1")
            0
          },
        registry = registry,
        readTimeoutMillis = 10,
        onChunk = { _, _ -> fail("no data was ever produced") },
        onTerminalError = { fail("a normal stop must never emit an error") },
      )

    loop.run()

    assertEquals(1, callCount)
  }

  @Test
  fun `one loop's exception does not affect a second, independent loop`() {
    val registryA = UsbSerialReadRegistry()
    val registryB = UsbSerialReadRegistry()
    val tokenA = registryA.start("s1")!!
    val tokenB = registryB.start("s2")!!
    var errorsA = 0
    var chunksB = 0
    var callCountB = 0

    val loopA =
      SerialReadLoop(
        sessionId = "s1",
        token = tokenA,
        source = SerialReadSource { _, _ -> throw IOException("loop A failure") },
        registry = registryA,
        readTimeoutMillis = 10,
        onChunk = { _, _ -> fail("loop A never produces data") },
        onTerminalError = { errorsA++ },
      )
    val loopB =
      SerialReadLoop(
        sessionId = "s2",
        token = tokenB,
        source =
          SerialReadSource { buffer, _ ->
            callCountB++
            if (callCountB == 1) {
              buffer[0] = 7
              1
            } else {
              registryB.removeSession("s2")
              0
            }
          },
        registry = registryB,
        readTimeoutMillis = 10,
        onChunk = { _, _ -> chunksB++ },
        onTerminalError = { fail("loop B must not be affected by loop A's failure") },
      )

    loopA.run()
    loopB.run()

    assertEquals(1, errorsA)
    assertEquals(1, chunksB)
  }

  // ---- Lifecycle races: real concurrent threads, deterministic via latches ----

  @Test
  fun `stop racing with a blocked-but-successful read produces no stale event`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    val readStarted = CountDownLatch(1)
    val releaseRead = CountDownLatch(1)
    val emitted = AtomicInteger(0)
    val unexpectedErrors = AtomicInteger(0)

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source =
          SerialReadSource { buffer, _ ->
            readStarted.countDown()
            // Not asserted here: an AssertionError thrown on this background
            // thread would not be reported as a JUnit failure. thread.join(2000) +
            // assertFalse(thread.isAlive) below already fails the test if this
            // never unblocks.
            releaseRead.await(2, TimeUnit.SECONDS)
            buffer[0] = 0x42
            1
          },
        registry = registry,
        readTimeoutMillis = 1000,
        onChunk = { _, _ -> emitted.incrementAndGet() },
        // Counted, not fail()'d directly - this callback runs on the
        // background thread, where an AssertionError would not be reported
        // as a JUnit failure. Asserted on the main thread below instead.
        onTerminalError = { unexpectedErrors.incrementAndGet() },
      )

    val thread = Thread({ loop.run() }, "test-rx-stop-race").apply { isDaemon = true }
    thread.start()
    assertTrue(readStarted.await(2, TimeUnit.SECONDS))

    // Simulates stopReading() happening while the read is blocked in flight.
    registry.removeSession("s1")
    releaseRead.countDown()

    thread.join(2000)
    assertFalse(thread.isAlive)
    assertEquals(0, emitted.get())
    assertEquals(0, unexpectedErrors.get())
  }

  @Test
  fun `close racing with a blocked read that then throws produces no stale error`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    val readStarted = CountDownLatch(1)
    val releaseRead = CountDownLatch(1)
    val errors = AtomicInteger(0)
    val unexpectedChunks = AtomicInteger(0)

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source =
          SerialReadSource { _, _ ->
            readStarted.countDown()
            // See the no-assert note in the previous test - thread.join(2000)
            // below is what actually catches a failure to unblock.
            releaseRead.await(2, TimeUnit.SECONDS)
            // Simulates the underlying port throwing because close() ran
            // while this read was blocked.
            throw IOException("port closed mid-read")
          },
        registry = registry,
        readTimeoutMillis = 1000,
        // Counted, not fail()'d - see the stop-race test's own note on why.
        onChunk = { _, _ -> unexpectedChunks.incrementAndGet() },
        onTerminalError = { errors.incrementAndGet() },
      )

    val thread = Thread({ loop.run() }, "test-rx-close-race").apply { isDaemon = true }
    thread.start()
    assertTrue(readStarted.await(2, TimeUnit.SECONDS))

    // Simulates closeSession() removing this session's receive state
    // before its native close() actually runs.
    registry.removeSession("s1")
    releaseRead.countDown()

    thread.join(2000)
    assertFalse(thread.isAlive)
    assertEquals(0, errors.get())
    assertEquals(0, unexpectedChunks.get())
  }

  @Test
  fun `detach racing between two iterations produces no stale event`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    val firstReadDone = CountDownLatch(1)
    val detachApplied = CountDownLatch(1)
    val emitted = AtomicInteger(0)
    val unexpectedErrors = AtomicInteger(0)
    var callCount = 0

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source =
          SerialReadSource { buffer, _ ->
            callCount++
            if (callCount == 1) {
              buffer[0] = 1
              1
            } else {
              firstReadDone.countDown()
              // See the no-assert note above - thread.join(2000) below is
              // what actually catches a failure to unblock.
              detachApplied.await(2, TimeUnit.SECONDS)
              0
            }
          },
        registry = registry,
        readTimeoutMillis = 1000,
        onChunk = { _, _ -> emitted.incrementAndGet() },
        // Counted, not fail()'d - see the stop-race test's own note on why.
        onTerminalError = { unexpectedErrors.incrementAndGet() },
      )

    val thread = Thread({ loop.run() }, "test-rx-detach-race").apply { isDaemon = true }
    thread.start()
    assertTrue(firstReadDone.await(2, TimeUnit.SECONDS))

    // Simulates a detach removing this exact session's receive state
    // between two read iterations.
    registry.removeSession("s1")
    detachApplied.countDown()

    thread.join(2000)
    assertFalse(thread.isAlive)
    assertEquals(1, emitted.get())
    assertEquals(0, unexpectedErrors.get())
  }

  @Test
  fun `invalidate racing with a blocked read produces no stale event`() {
    val registry = UsbSerialReadRegistry()
    val token = registry.start("s1")!!
    val readStarted = CountDownLatch(1)
    val releaseRead = CountDownLatch(1)
    val emitted = AtomicInteger(0)
    val unexpectedErrors = AtomicInteger(0)

    val loop =
      SerialReadLoop(
        sessionId = "s1",
        token = token,
        source =
          SerialReadSource { buffer, _ ->
            readStarted.countDown()
            // See the no-assert note above - thread.join(2000) below is
            // what actually catches a failure to unblock.
            releaseRead.await(2, TimeUnit.SECONDS)
            buffer[0] = 9
            1
          },
        registry = registry,
        readTimeoutMillis = 1000,
        onChunk = { _, _ -> emitted.incrementAndGet() },
        // Counted, not fail()'d - see the stop-race test's own note on why.
        onTerminalError = { unexpectedErrors.incrementAndGet() },
      )

    val thread = Thread({ loop.run() }, "test-rx-invalidate-race").apply { isDaemon = true }
    thread.start()
    assertTrue(readStarted.await(2, TimeUnit.SECONDS))

    // Simulates module invalidate() draining every session's receive state.
    registry.removeAll()
    releaseRead.countDown()

    thread.join(2000)
    assertFalse(thread.isAlive)
    assertEquals(0, emitted.get())
    assertEquals(0, unexpectedErrors.get())
  }

  @Test
  fun `an old worker completing after a newer attempt started does not affect the new attempt`() {
    val registry = UsbSerialReadRegistry()
    val oldToken = registry.start("s1")!!
    val oldReadStarted = CountDownLatch(1)
    val releaseOldRead = CountDownLatch(1)
    val oldEmitted = AtomicInteger(0)
    val unexpectedErrors = AtomicInteger(0)

    val oldLoop =
      SerialReadLoop(
        sessionId = "s1",
        token = oldToken,
        source =
          SerialReadSource { buffer, _ ->
            oldReadStarted.countDown()
            // See the stop-race test's own note above - oldThread.join(2000)
            // below is what actually catches a failure to unblock.
            releaseOldRead.await(2, TimeUnit.SECONDS)
            buffer[0] = 5
            1
          },
        registry = registry,
        readTimeoutMillis = 1000,
        onChunk = { _, _ -> oldEmitted.incrementAndGet() },
        // Counted, not fail()'d - see the stop-race test's own note on why.
        onTerminalError = { unexpectedErrors.incrementAndGet() },
      )

    val oldThread = Thread({ oldLoop.run() }, "test-rx-old-worker").apply { isDaemon = true }
    oldThread.start()
    assertTrue(oldReadStarted.await(2, TimeUnit.SECONDS))

    // Simulates stopReading() followed immediately by a new startReading()
    // for the same session, while the old worker's read is still blocked.
    registry.removeSession("s1")
    val newToken = registry.start("s1")!!

    // Now let the old, superseded read finally return.
    releaseOldRead.countDown()
    oldThread.join(2000)

    assertFalse(oldThread.isAlive)
    assertEquals("the old worker must not have emitted for the newer attempt", 0, oldEmitted.get())
    assertEquals(0, unexpectedErrors.get())
    assertTrue("the newer attempt's token must remain the current one", registry.isCurrent("s1", newToken))
  }
}
