package com.fpvarbcon.transport

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves the fair-lock design PASS5.3-STEP1 requires for
 * UsbSerialSession's own ioLock - a real java.util.concurrent.locks.
 * ReentrantLock(true), exactly as UsbSerialSession itself constructs (see
 * its class-level note, PASS5.3-STEP0) - directly on the JVM, using fake
 * blocking read/write bodies rather than a real UsbSerialSession,
 * UsbDeviceConnection, or UsbSerialPort. None of those three real types
 * are meaningfully fakeable on the JVM without Robolectric or Mockito
 * (neither of which this project uses): UsbDeviceConnection is a concrete
 * Android SDK class with native internals, and UsbSerialPort is a large
 * interface with many methods unrelated to read/write. This mirrors
 * exactly why SerialReadLoop was earlier extracted as plain Kotlin,
 * decoupled from those same real types, for JVM testability - see its own
 * class-level note. [FakePort] below reproduces UsbSerialSession's exact
 * locking shape - ioLock.withLock { <blocking operation> } for both
 * directions - so these tests prove the real coordination mechanism
 * itself, not a reimplementation of it.
 */
class UsbSerialSessionIoLockTest {

  @Test
  fun `native timing policy cannot hide a quarter-second idle read in front of a motor or telemetry write`() {
    assertEquals(25, RX_READ_TIMEOUT_MILLIS)
    assertTrue(
      "one fair-lock RX quantum plus the write timeout must stay inside the native stop budget",
      NATIVE_IO_LOCK_WAIT_UPPER_BOUND_MILLIS <= MOTOR_STOP_NATIVE_WRITE_BUDGET_MILLIS,
    )
  }

  /** Mirrors UsbSerialSession's own ioLock usage exactly - see its class-level note. */
  private class FakePort {
    val ioLock = ReentrantLock(true)

    fun read(onBlocked: () -> Unit) {
      ioLock.withLock { onBlocked() }
    }

    fun write(onBlocked: () -> Unit) {
      ioLock.withLock { onBlocked() }
    }

    /** Mirrors UsbSerialSession.close()'s own ioLock usage exactly (PASS5.3-STEP1-CORRECTION3). */
    fun close(onBlocked: () -> Unit) {
      ioLock.withLock { onBlocked() }
    }
  }

  @Test
  fun `a write cannot proceed while a read holds the lock, and proceeds once the read releases it`() {
    val port = FakePort()
    val readStarted = CountDownLatch(1)
    val releaseRead = CountDownLatch(1)
    val writeProceeded = AtomicInteger(0)
    val writeStarted = CountDownLatch(1)

    val readThread =
      Thread({
        port.read {
          readStarted.countDown()
          // Not asserted here: an AssertionError on this background thread
          // would not be reported as a JUnit failure - the bounded
          // thread.join()s below are what actually enforce this.
          releaseRead.await(2, TimeUnit.SECONDS)
        }
      }, "test-read")
        .apply { isDaemon = true }
    readThread.start()
    assertTrue(readStarted.await(2, TimeUnit.SECONDS))

    val writeThread =
      Thread({
        port.write {
          writeStarted.countDown()
          writeProceeded.incrementAndGet()
        }
      }, "test-write")
        .apply { isDaemon = true }
    writeThread.start()

    // Absence, not presence: the write must not be able to proceed while
    // the read still genuinely holds the lock. writeStarted can only ever
    // fire after ioLock is released, which requires releaseRead to be
    // counted down first - this bounded wait cannot pass by coincidence.
    assertFalse(
      "write must not proceed while the read still holds the lock",
      writeStarted.await(300, TimeUnit.MILLISECONDS),
    )
    assertEquals(0, writeProceeded.get())

    releaseRead.countDown()
    readThread.join(2000)
    assertFalse(readThread.isAlive)

    assertTrue("write must proceed once the read releases the lock", writeStarted.await(2, TimeUnit.SECONDS))
    writeThread.join(2000)
    assertFalse(writeThread.isAlive)
    assertEquals(1, writeProceeded.get())
  }

  @Test
  fun `a read cannot proceed while a write holds the lock, and proceeds once the write releases it`() {
    val port = FakePort()
    val writeStarted = CountDownLatch(1)
    val releaseWrite = CountDownLatch(1)
    val readProceeded = AtomicInteger(0)
    val readStarted = CountDownLatch(1)

    val writeThread =
      Thread({
        port.write {
          writeStarted.countDown()
          releaseWrite.await(2, TimeUnit.SECONDS)
        }
      }, "test-write")
        .apply { isDaemon = true }
    writeThread.start()
    assertTrue(writeStarted.await(2, TimeUnit.SECONDS))

    val readThread =
      Thread({
        port.read {
          readStarted.countDown()
          readProceeded.incrementAndGet()
        }
      }, "test-read")
        .apply { isDaemon = true }
    readThread.start()

    assertFalse(
      "read must not proceed while the write still holds the lock",
      readStarted.await(300, TimeUnit.MILLISECONDS),
    )
    assertEquals(0, readProceeded.get())

    releaseWrite.countDown()
    writeThread.join(2000)
    assertFalse(writeThread.isAlive)

    assertTrue("read must proceed once the write releases the lock", readStarted.await(2, TimeUnit.SECONDS))
    readThread.join(2000)
    assertFalse(readThread.isAlive)
    assertEquals(1, readProceeded.get())
  }

  // ---- PASS5.3-STEP1-CORRECTION3: close() also shares ioLock with read()/write() ----

  @Test
  fun `close cannot proceed while a read holds the lock, and proceeds once the read releases it`() {
    val port = FakePort()
    val readStarted = CountDownLatch(1)
    val releaseRead = CountDownLatch(1)
    val closeProceeded = AtomicInteger(0)
    val closeStarted = CountDownLatch(1)

    val readThread =
      Thread({
        port.read {
          readStarted.countDown()
          releaseRead.await(2, TimeUnit.SECONDS)
        }
      }, "test-read")
        .apply { isDaemon = true }
    readThread.start()
    assertTrue(readStarted.await(2, TimeUnit.SECONDS))

    val closeThread =
      Thread({
        port.close {
          closeStarted.countDown()
          closeProceeded.incrementAndGet()
        }
      }, "test-close")
        .apply { isDaemon = true }
    closeThread.start()

    // Absence, not presence: close() must not be able to proceed - and
    // therefore never runs port.close()/connection.close() concurrently
    // with the still in-flight read() - while the read still genuinely
    // holds the lock. This bounded wait cannot pass by coincidence.
    assertFalse(
      "close must not proceed while a read still holds the lock",
      closeStarted.await(300, TimeUnit.MILLISECONDS),
    )
    assertEquals(0, closeProceeded.get())

    releaseRead.countDown()
    readThread.join(2000)
    assertFalse(readThread.isAlive)

    // No deadlock: close() simply waited, then proceeded once the read
    // released the lock - never hung.
    assertTrue("close must proceed once the read releases the lock", closeStarted.await(2, TimeUnit.SECONDS))
    closeThread.join(2000)
    assertFalse(closeThread.isAlive)
    assertEquals(1, closeProceeded.get())
  }

  @Test
  fun `close cannot proceed while a write holds the lock, and proceeds once the write releases it`() {
    val port = FakePort()
    val writeStarted = CountDownLatch(1)
    val releaseWrite = CountDownLatch(1)
    val closeProceeded = AtomicInteger(0)
    val closeStarted = CountDownLatch(1)

    val writeThread =
      Thread({
        port.write {
          writeStarted.countDown()
          releaseWrite.await(2, TimeUnit.SECONDS)
        }
      }, "test-write")
        .apply { isDaemon = true }
    writeThread.start()
    assertTrue(writeStarted.await(2, TimeUnit.SECONDS))

    val closeThread =
      Thread({
        port.close {
          closeStarted.countDown()
          closeProceeded.incrementAndGet()
        }
      }, "test-close")
        .apply { isDaemon = true }
    closeThread.start()

    // Absence, not presence: close() must not be able to proceed - and
    // therefore never runs concurrently with the still in-flight write() -
    // while the write still genuinely holds the lock (this is exactly the
    // scenario CORRECTION3 exists to close: a write blocked inside
    // port.write()'s own native call while a concurrent close() attempt is
    // made).
    assertFalse(
      "close must not proceed while a write still holds the lock",
      closeStarted.await(300, TimeUnit.MILLISECONDS),
    )
    assertEquals(0, closeProceeded.get())

    releaseWrite.countDown()
    writeThread.join(2000)
    assertFalse(writeThread.isAlive)

    // No deadlock: close() simply waited, then proceeded once the write
    // released the lock - never hung. ioLock is a plain (non-reentrant-
    // across-threads) ReentrantLock, but close() is never called from the
    // same thread that is executing write() (see UsbSerialSession.close()'s
    // own doc comment), so there is no self-deadlock risk here either.
    assertTrue("close must proceed once the write releases the lock", closeStarted.await(2, TimeUnit.SECONDS))
    closeThread.join(2000)
    assertFalse(closeThread.isAlive)
    assertEquals(1, closeProceeded.get())
  }

  @Test
  fun `fairness guarantees a pending write wins the very next lock release, never losing to repeated RX re-acquisition`() {
    val port = FakePort()
    val holdFirstRead = CountDownLatch(1)
    val firstCycleEntered = CountDownLatch(1)
    val rxCycleCount = AtomicInteger(0)
    val writeWonAtCycle = AtomicInteger(-1)
    val writeAcquired = CountDownLatch(1)
    val keepGoing = AtomicBoolean(true)

    val rxThread =
      Thread({
        var first = true
        while (keepGoing.get()) {
          port.read {
            rxCycleCount.incrementAndGet()
            if (first) {
              first = false
              // Signals the exact moment being waited for below - no
              // polling needed, this is the real event itself.
              firstCycleEntered.countDown()
              // Hold this first acquisition open until the write thread is
              // confirmed to be genuinely registered as a queued waiter on
              // the lock (see the deterministic handshake below) - so the
              // write is guaranteed to already be waiting before this
              // thread's own next re-acquisition attempt can even happen.
              holdFirstRead.await(2, TimeUnit.SECONDS)
            }
          }
        }
      }, "test-rx")
        .apply { isDaemon = true }
    rxThread.start()

    // Deterministic handshake (a real CountDownLatch, not a poll): wait
    // until the RX thread has genuinely entered its first held acquisition.
    assertTrue(firstCycleEntered.await(2, TimeUnit.SECONDS))
    assertEquals(1, rxCycleCount.get())

    val writeThread =
      Thread({
        port.write {
          writeWonAtCycle.set(rxCycleCount.get())
          keepGoing.set(false)
          writeAcquired.countDown()
        }
      }, "test-write")
        .apply { isDaemon = true }
    writeThread.start()

    // Deterministic handshake: wait until the write thread is genuinely
    // registered as a queued waiter on the fair lock (ReentrantLock's own
    // hasQueuedThreads(), a real, meaningful signal - not a guess) before
    // letting the RX thread's held first acquisition continue.
    // hasQueuedThreads() has no corresponding "became queued" event to
    // latch on, so a bounded poll is unavoidable here - Thread.onSpinWait()
    // is used as a CPU-yielding hint between checks instead of spinning at
    // full, un-yielding speed, which matters on a constrained/single-core
    // runner where this very check could otherwise starve the write
    // thread it is waiting on.
    val queuedDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
    while (!port.ioLock.hasQueuedThreads() && System.nanoTime() < queuedDeadline) {
      Thread.onSpinWait()
    }
    assertTrue("write must have genuinely registered as a waiter on the fair lock", port.ioLock.hasQueuedThreads())

    holdFirstRead.countDown()

    assertTrue(
      "a fair lock must let the already-queued write win at the very next release",
      writeAcquired.await(2, TimeUnit.SECONDS),
    )
    rxThread.join(2000)
    writeThread.join(2000)
    assertFalse(rxThread.isAlive)
    assertFalse(writeThread.isAlive)
    assertEquals(
      "the write must win at the release immediately following its registration - cycle 1 - never later",
      1,
      writeWonAtCycle.get(),
    )
  }
}
