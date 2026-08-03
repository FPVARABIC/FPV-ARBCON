package com.fpvarbcon.transport

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers [UsbSerialWriteQueue]'s FIFO/bounded/rejection/drain/failure
 * behavior, and [performSerialWrite]'s own partial-write detection,
 * directly on the JVM against a fake [SerialWriteSink] - never a real
 * UsbSerialPort. Mirrors UsbIoExecutorTest.kt's own style for the same
 * reason: this queue's scheduling contract is fully provable without any
 * Android runtime.
 */
class UsbSerialWriteQueueTest {

  private fun request(
    buffer: ByteArray = byteArrayOf(1, 2, 3),
    timeoutMillis: Int = 1000,
    onComplete: (Result<Int>) -> Unit,
  ) = UsbSerialWriteRequest(buffer, timeoutMillis, onComplete)

  // ---- performSerialWrite: partial-write detection ----

  @Test
  fun `a full write reports success with the exact byte count`() {
    val sink = SerialWriteSink { buffer, _ -> buffer.size }
    val result = AtomicReference<Result<Int>>()

    performSerialWrite(sink, request(buffer = byteArrayOf(1, 2, 3, 4)) { result.set(it) })

    assertTrue(result.get().isSuccess)
    assertEquals(4, result.get().getOrNull())
  }

  @Test
  fun `a partial write (fewer bytes than requested) is treated as a failure, not auto-retried`() {
    var callCount = 0
    val sink =
      SerialWriteSink { buffer, _ ->
        callCount++
        buffer.size - 1 // simulates a fake sink reporting a short write
      }
    val result = AtomicReference<Result<Int>>()

    performSerialWrite(sink, request(buffer = byteArrayOf(1, 2, 3, 4)) { result.set(it) })

    assertTrue("a partial write must be reported as a failure", result.get().isFailure)
    assertEquals("sink.write must be called exactly once - no auto-retry", 1, callCount)
  }

  @Test
  fun `a write that throws reports failure with the original exception`() {
    val failure = IOException("simulated native write failure")
    val sink = SerialWriteSink { _, _ -> throw failure }
    val result = AtomicReference<Result<Int>>()

    performSerialWrite(sink, request { result.set(it) })

    assertTrue(result.get().isFailure)
    assertEquals(failure, result.get().exceptionOrNull())
  }

  // ---- UsbSerialWriteQueue: FIFO ordering ----

  @Test
  fun `writes complete in strict enqueue order even when submitted rapidly`() {
    val order = java.util.Collections.synchronizedList(mutableListOf<Int>())
    val allDone = CountDownLatch(5)
    // Deliberately instantaneous, no artificial per-item delay: FIFO
    // ordering here comes from the queue's single dedicated consumer
    // thread draining a strictly-ordered blocking queue, not from timing -
    // enqueuing all 5 before any of them can possibly have completed (the
    // test thread never yields in between) is what actually proves order
    // is preserved under real concurrent submission, not merely under a
    // convenient one-at-a-time calling pattern.
    val sink = SerialWriteSink { buffer, _ -> buffer.size }
    val queue = UsbSerialWriteQueue("s1", sink = sink)

    for (i in 1..5) {
      queue.enqueue(
        request(buffer = byteArrayOf(i.toByte())) {
          order.add(i)
          allDone.countDown()
        },
      )
    }

    assertTrue(allDone.await(2, TimeUnit.SECONDS))
    assertEquals(listOf(1, 2, 3, 4, 5), order)
    queue.stopAndDrainPending()
  }

  // ---- UsbSerialWriteQueue: queue-full rejection ----

  @Test
  fun `enqueue rejects immediately with QueueFull once capacity is reached, without blocking or silently dropping`() {
    val releaseFirst = CountDownLatch(1)
    val firstStarted = CountDownLatch(1)
    val sink =
      SerialWriteSink { buffer, _ ->
        firstStarted.countDown()
        releaseFirst.await(2, TimeUnit.SECONDS)
        buffer.size
      }
    val queue = UsbSerialWriteQueue("s1", capacity = 2, sink = sink)

    // Occupies the consumer thread, so nothing queued behind it can drain
    // until releaseFirst is counted down.
    queue.enqueue(request { })
    assertTrue(firstStarted.await(2, TimeUnit.SECONDS))

    // Fills the queue to its declared capacity (2).
    assertEquals(UsbSerialWriteQueue.EnqueueResult.Accepted, queue.enqueue(request { }))
    assertEquals(UsbSerialWriteQueue.EnqueueResult.Accepted, queue.enqueue(request { }))

    // The next attempt must be rejected immediately - not blocked, not
    // silently dropped.
    assertEquals(UsbSerialWriteQueue.EnqueueResult.QueueFull, queue.enqueue(request { }))

    releaseFirst.countDown()
    queue.stopAndDrainPending()
  }

  // ---- UsbSerialWriteQueue: draining pending (not yet started) writes ----

  /**
   * Blocks the calling thread until [releaseSignal] fires, exactly like
   * [CountDownLatch.await] - except it never returns early due to
   * [stopAndDrainPending]'s own [Thread.interrupt] call (meant only to
   * wake an idle consumer waiting in queue.take(), not to abort a request
   * genuinely in progress - see UsbSerialWriteQueue's own class-level
   * note). This matches how the real underlying native bulkTransfer() call
   * behaves in production: Thread.interrupt() does not abort it either.
   */
  private fun awaitUninterruptibly(releaseSignal: CountDownLatch) {
    var released = false
    while (!released) {
      released =
        try {
          releaseSignal.await(2, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
          false
        }
    }
  }

  @Test
  fun `stopAndDrainPending returns only requests not yet started, and further enqueue attempts are rejected as Stopped`() {
    val releaseFirst = CountDownLatch(1)
    val firstStarted = CountDownLatch(1)
    val firstCompleted = AtomicInteger(0)
    val sink =
      SerialWriteSink { buffer, _ ->
        firstStarted.countDown()
        awaitUninterruptibly(releaseFirst)
        buffer.size
      }
    val queue = UsbSerialWriteQueue("s1", sink = sink)
    val firstCompletedLatch = CountDownLatch(1)

    queue.enqueue(
      request {
        firstCompleted.incrementAndGet()
        firstCompletedLatch.countDown()
      },
    )
    assertTrue(firstStarted.await(2, TimeUnit.SECONDS))

    val secondCompleted = AtomicInteger(0)
    val thirdCompleted = AtomicInteger(0)
    queue.enqueue(request { secondCompleted.incrementAndGet() })
    queue.enqueue(request { thirdCompleted.incrementAndGet() })

    val pending = queue.stopAndDrainPending()

    assertEquals("only the two not-yet-started requests must be returned", 2, pending.size)
    assertEquals(0, firstCompleted.get())
    assertEquals(0, secondCompleted.get())
    assertEquals(0, thirdCompleted.get())

    assertEquals(
      "a further enqueue attempt after stopAndDrainPending must be rejected, never accepted",
      UsbSerialWriteQueue.EnqueueResult.Stopped,
      queue.enqueue(request { }),
    )

    releaseFirst.countDown()

    // The in-progress first request must still complete on its own - it
    // was never part of the drained/rejected set, and the queue being
    // stopped must not leave it hanging. A real latch counted down from
    // inside onComplete itself, not a poll on the counter it also sets.
    assertTrue(
      "the in-progress request must still resolve, not be left hanging",
      firstCompletedLatch.await(2, TimeUnit.SECONDS),
    )
    assertEquals(1, firstCompleted.get())
    assertEquals(0, secondCompleted.get())
    assertEquals(0, thirdCompleted.get())
  }

  @Test
  fun `consumer thread terminates after an in-progress write settles even when the sink consumed the stop interrupt`() {
    val sessionId = "stop-termination-${System.nanoTime()}"
    val threadName = "UsbSerialTx-$sessionId"
    val releaseWrite = CountDownLatch(1)
    val writeStarted = CountDownLatch(1)
    val writeCompleted = CountDownLatch(1)
    val queue =
      UsbSerialWriteQueue(
        sessionId,
        sink =
          SerialWriteSink { buffer, _ ->
            writeStarted.countDown()
            // This helper deliberately consumes InterruptedException,
            // matching native USB calls that do not preserve the flag.
            awaitUninterruptibly(releaseWrite)
            buffer.size
          },
      )

    queue.enqueue(request { writeCompleted.countDown() })
    assertTrue(writeStarted.await(2, TimeUnit.SECONDS))
    queue.stopAndDrainPending()
    releaseWrite.countDown()
    assertTrue(writeCompleted.await(2, TimeUnit.SECONDS))

    val deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
    while (
      Thread.getAllStackTraces().keys.any { it.name == threadName } &&
        System.nanoTime() < deadlineNanos
    ) {
      Thread.sleep(10)
    }
    assertTrue(
      "the stopped session must not retain a blocked USB writer thread",
      Thread.getAllStackTraces().keys.none { it.name == threadName },
    )
  }

  @Test
  fun `stopAndDrainPending is idempotent`() {
    val queue = UsbSerialWriteQueue("s1", sink = SerialWriteSink { buffer, _ -> buffer.size })

    val first = queue.stopAndDrainPending()
    val second = queue.stopAndDrainPending()

    assertEquals(0, first.size)
    assertEquals(0, second.size)
  }

  // ---- Item 8: a write already in progress when the session is closed concurrently ----

  @Test
  fun `a write already in progress when the session closes fails safely and the queue survives to process what is queued behind it`() {
    val releaseInProgress = CountDownLatch(1)
    val inProgressStarted = CountDownLatch(1)
    val sink =
      SerialWriteSink { _, _ ->
        inProgressStarted.countDown()
        awaitUninterruptibly(releaseInProgress)
        // Simulates the underlying port throwing because a concurrent
        // closeSession()/detach/invalidate closed it out from under this
        // in-flight write.
        throw IOException("port closed mid-write")
      }
    val queue = UsbSerialWriteQueue("s1", sink = sink)

    val inProgressResult = AtomicReference<Result<Int>>()
    val inProgressCompleted = CountDownLatch(1)
    queue.enqueue(
      request {
        inProgressResult.set(it)
        inProgressCompleted.countDown()
      },
    )
    assertTrue(inProgressStarted.await(2, TimeUnit.SECONDS))

    // Simulates closeSession(): the module would call stopAndDrainPending()
    // here to reject anything not yet started, but this exact request is
    // already in progress, so it is not part of that drained list (see the
    // dedicated drain test above) - it must fail on its own instead.
    val pendingAtCloseTime = queue.stopAndDrainPending()
    assertEquals(0, pendingAtCloseTime.size)

    releaseInProgress.countDown()

    // The in-progress write's own onComplete must still fire, with the
    // real failure, even though the queue has already been stopped. A real
    // latch counted down from inside onComplete itself, not a poll.
    assertTrue(
      "the in-progress write must still be resolved, not left hanging",
      inProgressCompleted.await(2, TimeUnit.SECONDS),
    )
    assertTrue(inProgressResult.get().isFailure)

    // A second, independent queue for a different session must be entirely
    // unaffected by the first queue's failure/stop.
    val otherResult = AtomicReference<Result<Int>>()
    val otherCompleted = CountDownLatch(1)
    val otherQueue = UsbSerialWriteQueue("s2", sink = SerialWriteSink { buffer, _ -> buffer.size })
    otherQueue.enqueue(
      request {
        otherResult.set(it)
        otherCompleted.countDown()
      },
    )
    assertTrue(otherCompleted.await(2, TimeUnit.SECONDS))
    assertTrue(otherResult.get().isSuccess)
    otherQueue.stopAndDrainPending()
  }

  // ---- Cross-session independence ----

  @Test
  fun `two different sessions' write queues never serialize against each other`() {
    val releaseA = CountDownLatch(1)
    val startedA = CountDownLatch(1)
    val queueA =
      UsbSerialWriteQueue(
        "s1",
        sink =
          SerialWriteSink { buffer, _ ->
            startedA.countDown()
            releaseA.await(2, TimeUnit.SECONDS)
            buffer.size
          },
      )
    val queueB = UsbSerialWriteQueue("s2", sink = SerialWriteSink { buffer, _ -> buffer.size })

    val resultA = AtomicReference<Result<Int>>()
    queueA.enqueue(request { resultA.set(it) })
    assertTrue(startedA.await(2, TimeUnit.SECONDS))

    // Queue B must complete promptly - never blocked behind queue A's own
    // still-in-progress write, since each queue has its own dedicated
    // consumer thread. A real latch counted down from inside onComplete
    // itself, not a poll on the value it also sets.
    val resultB = AtomicReference<Result<Int>>()
    val resultBCompleted = CountDownLatch(1)
    queueB.enqueue(
      request {
        resultB.set(it)
        resultBCompleted.countDown()
      },
    )
    assertTrue(
      "session s2's write must not be blocked by session s1's still-in-progress write",
      resultBCompleted.await(2, TimeUnit.SECONDS),
    )
    assertTrue(resultB.get().isSuccess)

    releaseA.countDown()
    queueA.stopAndDrainPending()
    queueB.stopAndDrainPending()
  }
}
