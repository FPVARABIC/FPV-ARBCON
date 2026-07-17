package com.fpvarbcon.transport

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Covers UsbIoExecutor's scheduling/thread/rejection/shutdown behavior
 * directly on the JVM - deliberately generic over plain lambdas (never a
 * real UsbSerialSession or Android type), so no Android runtime,
 * Robolectric, or Mockito is needed for any of this. These tests prove the
 * executor's own scheduling contract - not real Android USB behavior, and
 * not real BroadcastReceiver/main-thread identity. Real off-main-thread
 * proof for the actual open/close call chain still requires a real device
 * or emulator (see the Pass 5.1 report's physical acceptance checklist).
 *
 * Pass 5.1 correction (PASS5.1-AUDIT-2): [UsbIoExecutor.submit] now returns
 * a Boolean (true = accepted, false = rejected post-shutdown) instead of a
 * silent no-op either way - these tests assert on that return value
 * directly, not just on whether the task ran.
 */
class UsbIoExecutorTest {

  private lateinit var executor: UsbIoExecutor

  @Before
  fun setUp() {
    executor = UsbIoExecutor()
  }

  @After
  fun tearDown() {
    // Every test shuts down its own executor so no worker thread from this
    // test class is ever left running past the test that created it.
    executor.shutdown()
  }

  @Test
  fun `submit eventually runs the given action`() {
    val done = CountDownLatch(1)

    val accepted = executor.submit { done.countDown() }

    assertTrue(accepted)
    assertTrue(done.await(2, TimeUnit.SECONDS))
  }

  @Test
  fun `an accepted submission returns true`() {
    val accepted = executor.submit {}

    assertTrue(accepted)
  }

  @Test
  fun `a post-shutdown submission returns false`() {
    executor.shutdown()

    val accepted = executor.submit {}

    assertFalse(accepted)
  }

  @Test
  fun `submitted work runs on a different thread from the caller`() {
    val callerThread = Thread.currentThread()
    val workerThread = AtomicReference<Thread>()
    val done = CountDownLatch(1)

    executor.submit {
      workerThread.set(Thread.currentThread())
      done.countDown()
    }

    assertTrue(done.await(2, TimeUnit.SECONDS))
    assertNotEquals(callerThread, workerThread.get())
  }

  @Test
  fun `all submitted tasks run on the same single worker thread`() {
    val threads = Collections.synchronizedList(mutableListOf<Thread>())
    val done = CountDownLatch(3)

    repeat(3) {
      executor.submit {
        threads.add(Thread.currentThread())
        done.countDown()
      }
    }

    assertTrue(done.await(2, TimeUnit.SECONDS))
    assertEquals(1, threads.distinct().size)
  }

  @Test
  fun `after shutdown, submit returns false and the action never runs`() {
    executor.shutdown()

    var ran = false
    val accepted = executor.submit { ran = true }

    // ExecutorService.execute() on an already-shutdown executor rejects
    // synchronously at the submission call itself - the action never gets
    // a chance to run, so this is deterministic without any wait.
    assertFalse(accepted)
    assertFalse(ran)
  }

  @Test
  fun `calling shutdown twice is safe`() {
    executor.shutdown()
    executor.shutdown()

    var ran = false
    val accepted = executor.submit { ran = true }
    assertFalse(accepted)
    assertFalse(ran)
  }

  @Test
  fun `shutdown lets an already-queued task finish before the executor terminates`() {
    val done = CountDownLatch(1)

    val accepted = executor.submit { done.countDown() }
    executor.shutdown()

    // shutdown() (never shutdownNow()) lets already-queued work run to
    // completion - it only refuses new submissions from this point on.
    assertTrue(accepted)
    assertTrue(done.await(2, TimeUnit.SECONDS))
  }

  @Test
  fun `submitted work runs in submission order on one thread, never overlapping`() {
    val order = Collections.synchronizedList(mutableListOf<Int>())
    val done = CountDownLatch(2)

    executor.submit {
      order.add(1)
      done.countDown()
    }
    executor.submit {
      order.add(2)
      done.countDown()
    }

    assertTrue(done.await(2, TimeUnit.SECONDS))
    assertEquals(listOf(1, 2), order)
  }

  @Test
  fun `two submitted tasks never overlap even when the first blocks`() {
    val firstStarted = CountDownLatch(1)
    val releaseFirst = CountDownLatch(1)
    val firstFinished = AtomicBoolean(false)
    val secondSawFirstUnfinished = AtomicBoolean(false)
    val secondDone = CountDownLatch(1)

    executor.submit {
      firstStarted.countDown()
      releaseFirst.await(2, TimeUnit.SECONDS)
      firstFinished.set(true)
    }
    assertTrue(firstStarted.await(2, TimeUnit.SECONDS))

    executor.submit {
      if (!firstFinished.get()) {
        secondSawFirstUnfinished.set(true)
      }
      secondDone.countDown()
    }

    releaseFirst.countDown()

    assertTrue(secondDone.await(2, TimeUnit.SECONDS))
    assertFalse(secondSawFirstUnfinished.get())
  }

  @Test
  fun `open-shaped and close-shaped work submitted to the same executor still serialize`() {
    val order = Collections.synchronizedList(mutableListOf<String>())
    val done = CountDownLatch(2)

    executor.submit {
      // Simulates the blocking portion of an open/configure attempt.
      order.add("open")
      done.countDown()
    }
    executor.submit {
      // Simulates a session's blocking close() work.
      order.add("close")
      done.countDown()
    }

    assertTrue(done.await(2, TimeUnit.SECONDS))
    assertEquals(listOf("open", "close"), order)
  }

  @Test
  fun `an exception thrown by a submitted action is swallowed and does not stop future task processing`() {
    val done = CountDownLatch(1)

    executor.submit {
      done.countDown()
      throw IllegalStateException("simulated USB I/O failure")
    }

    // The thrown exception must not escape the executor's worker thread in
    // a way that crashes it or breaks later submissions.
    assertTrue(done.await(2, TimeUnit.SECONDS))

    var ranAfter = false
    val doneAfter = CountDownLatch(1)
    val acceptedAfter = executor.submit {
      ranAfter = true
      doneAfter.countDown()
    }
    assertTrue(acceptedAfter)
    assertTrue(doneAfter.await(2, TimeUnit.SECONDS))
    assertTrue(ranAfter)
  }
}
