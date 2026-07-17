package com.fpvarbcon.transport

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers UsbSessionCloser's scheduling/rejection/shutdown behavior directly
 * on the JVM - deliberately generic over a plain close lambda (not a real
 * UsbSerialSession), so no Android runtime, Robolectric, or Mockito is
 * needed for any of this. Real thread-identity/off-main-thread proof still
 * requires a real device or emulator (see the Pass 4.7 fix report); what is
 * proven here is the scheduling and rejection-safety contract itself.
 */
class UsbSessionCloserTest {

  @Test
  fun `submit eventually runs the given close action`() {
    val closer = UsbSessionCloser()
    val done = CountDownLatch(1)

    closer.submit { done.countDown() }

    assertTrue(done.await(2, TimeUnit.SECONDS))
  }

  @Test
  fun `after shutdown, submit does not throw and the action never runs`() {
    val closer = UsbSessionCloser()
    closer.shutdown()

    var ran = false
    closer.submit { ran = true }

    // ExecutorService.execute() on an already-shutdown executor rejects
    // synchronously at the submission call itself - the action never gets
    // a chance to run, so this is deterministic without any wait.
    assertFalse(ran)
  }

  @Test
  fun `calling shutdown twice is safe`() {
    val closer = UsbSessionCloser()

    closer.shutdown()
    closer.shutdown()

    var ran = false
    closer.submit { ran = true }
    assertFalse(ran)
  }

  @Test
  fun `submitted work runs in submission order on one thread, never overlapping`() {
    val closer = UsbSessionCloser()
    val order = Collections.synchronizedList(mutableListOf<Int>())
    val done = CountDownLatch(2)

    closer.submit {
      order.add(1)
      done.countDown()
    }
    closer.submit {
      order.add(2)
      done.countDown()
    }

    assertTrue(done.await(2, TimeUnit.SECONDS))
    assertEquals(listOf(1, 2), order)
  }

  @Test
  fun `an exception thrown by the close action is swallowed rather than propagated`() {
    val closer = UsbSessionCloser()
    val done = CountDownLatch(1)

    closer.submit {
      done.countDown()
      throw IllegalStateException("simulated close() failure")
    }

    // The thrown exception must not escape the closer's worker thread in a
    // way that crashes it or breaks later submissions.
    assertTrue(done.await(2, TimeUnit.SECONDS))

    var ranAfter = false
    val doneAfter = CountDownLatch(1)
    closer.submit {
      ranAfter = true
      doneAfter.countDown()
    }
    assertTrue(doneAfter.await(2, TimeUnit.SECONDS))
    assertTrue(ranAfter)
  }
}
