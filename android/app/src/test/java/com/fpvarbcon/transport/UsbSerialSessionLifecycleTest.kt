package com.fpvarbcon.transport

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves [closeSessionRejectingPendingWrites]'s own ordering contract
 * directly (PASS5.3-STEP1-CORRECTION4) - the exact function
 * UsbSerialTransportModule's closeSession(), handleDeviceDetached(), and
 * invalidate() now all delegate to identically (verified by reading those
 * three call sites directly: each passes its own `rejectPendingWrites`/
 * `performClose` closures into this one shared function, in the same
 * argument order). Proving the contract here, once, against a fake
 * [WriteQueueOwner] therefore proves it for all three real call sites at
 * once - a real UsbSerialTransportModule cannot be meaningfully
 * constructed on the JVM without Robolectric or Mockito (neither of which
 * this project uses), since its constructor requires a real
 * ReactApplicationContext/UsbManager (see UsbSerialSessionIoLockTest.kt's
 * own class-level note for the identical constraint applied to
 * UsbSerialSession's real dependencies).
 */
class UsbSerialSessionLifecycleTest {

  private class FakeWriteQueueOwner(private val queue: UsbSerialWriteQueue) : WriteQueueOwner {
    override fun stopAndDrainPendingWrites(): List<UsbSerialWriteRequest> = queue.stopAndDrainPending()
  }

  /** See UsbSerialWriteQueueTest.kt's own identical helper for why this is needed, not a plain await(). */
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
  fun `a genuinely queued write is rejected before performClose runs, in strict order`() {
    val releaseFirst = CountDownLatch(1)
    val firstStarted = CountDownLatch(1)
    val sink =
      SerialWriteSink { buffer, _ ->
        firstStarted.countDown()
        awaitUninterruptibly(releaseFirst)
        buffer.size
      }
    val queue = UsbSerialWriteQueue("s1", sink = sink)
    val session = FakeWriteQueueOwner(queue)

    // Occupies the queue's own consumer thread so the second write below
    // is genuinely still queued (not yet started) when
    // closeSessionRejectingPendingWrites runs.
    queue.enqueue(UsbSerialWriteRequest(byteArrayOf(1), 1000) { })
    assertTrue(firstStarted.await(2, TimeUnit.SECONDS))

    val queuedResult = AtomicReference<Result<Int>>()
    queue.enqueue(UsbSerialWriteRequest(byteArrayOf(2), 1000) { queuedResult.set(it) })

    val events = java.util.Collections.synchronizedList(mutableListOf<String>())
    closeSessionRejectingPendingWrites(
      session = session,
      rejectPendingWrites = { pending ->
        events.add("reject:${pending.size}")
        pending.forEach { it.onComplete(Result.failure(IOException("SESSION_CLOSED"))) }
      },
      performClose = { events.add("close") },
    )

    assertEquals(
      "the queued write must be rejected before performClose runs, in that exact order",
      listOf("reject:1", "close"),
      events,
    )
    assertTrue("the genuinely queued write must be rejected", queuedResult.get().isFailure)

    releaseFirst.countDown()
    queue.stopAndDrainPending()
  }

  @Test
  fun `a write already in progress is never part of the rejected set and resolves independently, exactly once`() {
    val releaseInProgress = CountDownLatch(1)
    val inProgressStarted = CountDownLatch(1)
    val inProgressCompleted = CountDownLatch(1)
    val inProgressResult = AtomicReference<Result<Int>>()
    val sink =
      SerialWriteSink { buffer, _ ->
        inProgressStarted.countDown()
        awaitUninterruptibly(releaseInProgress)
        buffer.size
      }
    val queue = UsbSerialWriteQueue("s1", sink = sink)
    val session = FakeWriteQueueOwner(queue)

    queue.enqueue(
      UsbSerialWriteRequest(byteArrayOf(1), 1000) {
        inProgressResult.set(it)
        inProgressCompleted.countDown()
      },
    )
    assertTrue(inProgressStarted.await(2, TimeUnit.SECONDS))

    var rejectedCount = -1
    var closeRan = false
    closeSessionRejectingPendingWrites(
      session = session,
      rejectPendingWrites = { pending -> rejectedCount = pending.size },
      performClose = { closeRan = true },
    )

    assertEquals("the in-progress write must never be part of the rejected set", 0, rejectedCount)
    assertTrue("performClose must still run even though a write is in progress", closeRan)
    assertEquals(
      "the in-progress write must not have been resolved yet - it is untouched by this function",
      1L,
      inProgressCompleted.count,
    )

    releaseInProgress.countDown()

    assertTrue(
      "the in-progress write must still resolve on its own, exactly once, regardless of performClose",
      inProgressCompleted.await(2, TimeUnit.SECONDS),
    )
    assertTrue(inProgressResult.get().isSuccess)

    queue.stopAndDrainPending()
  }
}
