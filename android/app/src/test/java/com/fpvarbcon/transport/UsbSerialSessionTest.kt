package com.fpvarbcon.transport

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import java.io.IOException
import java.util.EnumSet
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE REAL UsbSerialSession, CONSTRUCTED AND DRIVEN.
 *
 * =====================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================
 *
 * Run 34780928743 published, from CI's own coverage ledger:
 *
 *   com/fpvarbcon/transport -> UsbSerialSession.kt : 0/33 [sourcefile]
 *   ##[error]UsbSerialSession.kt is classified JVM_EXECUTED but zero of
 *   its 33 lines were executed by any JVM unit test
 *
 * Nought of thirty-three, for the class that owns the lock ordering
 * between reading, writing and closing a serial port. The file that names
 * it - UsbSerialSessionIoLockTest - says in its own header that it uses
 * "fake blocking read/write bodies rather than a real UsbSerialSession,
 * UsbDeviceConnection, or UsbSerialPort", with a private FakePort that
 * "reproduces UsbSerialSession's exact locking shape", and concludes that
 * it therefore proves "the real coordination mechanism itself, not a
 * reimplementation of it".
 *
 * A class that reproduces the locking shape IS a reimplementation. What
 * that file proves is that java.util.concurrent.locks.ReentrantLock(true)
 * is fair, which is a property of the JDK. Delete `ioLock.withLock` from
 * the real read() and every assertion in it still passes. That is why the
 * coverage is nought and the coverage was right.
 *
 * =====================================================================
 * WHAT WAS SUPPOSEDLY IMPOSSIBLE, AND WHAT ACTUALLY IS
 * =====================================================================
 *
 * The reason given was that "none of those three real types are
 * meaningfully fakeable on the JVM without Robolectric or Mockito", on
 * two grounds: UsbDeviceConnection is a concrete SDK class with native
 * internals, and UsbSerialPort is "a large interface with many methods
 * unrelated to read/write".
 *
 * The second ground is an inconvenience, not an impossibility.
 * com.hoho.android.usbserial.driver.UsbSerialPort at the pinned 3.10.0 is
 * `public interface UsbSerialPort extends Closeable` with 33 abstract
 * members. An interface is implementable; being large only means typing.
 * [RecordingPort] below implements every one of them - the six this class
 * actually uses with real behaviour, and the rest refusing to be called,
 * so a future change that starts using one of them fails here loudly
 * instead of silently passing through a stub that returned a zero.
 *
 * The first ground is real, and it was MEASURED rather than recalled. Run
 * 34785383699 put it to javac four times with a positive control and then
 * disassembled the class out of the only jar on the runner carrying it:
 *
 *   P0=COMPILED P1=REJECTED P2=REJECTED P3=COMPILED  stubBodies=16
 *
 *   android.hardware.usb.UsbDeviceConnection();   <- package-private, no-arg
 *     Code: ... 4: new java/lang/RuntimeException  8: ldc // String Stub!
 *          13: athrow
 *   public void close();
 *     Code: 0: new java/lang/RuntimeException  4: ldc // String Stub!  9: athrow
 *
 * A subclass declared inside android.hardware.usb COMPILES (P3) and still
 * cannot be constructed, because the constructor's body throws. That is
 * why the connection reaches UsbSerialSession as a UsbConnectionHandle -
 * one method, no body, no behaviour - and UsbDeviceConnectionStubTest
 * asserts the measurement in this same JVM on every run, so the seam
 * cannot outlive its reason.
 *
 * NOTHING WAS MOVED OUT OF THE CLASS TO MAKE THIS POSSIBLE. Every
 * decision UsbSerialSession makes - that read and write share one fair
 * lock, that close() drains the queue before taking that lock, that the
 * port is closed inside a try whose finally closes the connection, that
 * the baud rate is refused outside its range - is still in
 * UsbSerialSession.kt and is asserted here through the real class.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
class UsbSerialSessionTest {

  /**
   * One shared, ordered log across the port and the connection, because
   * the things worth asserting about this class are ORDERINGS - the
   * connection closed after the port, a write entering after a read
   * returned - and an ordering cannot be asserted from two separate
   * counters.
   */
  private val order = CopyOnWriteArrayList<String>()

  /** Signalled by the fake port when a read has entered. */
  private val readEntered = CountDownLatch(1)

  /** Signalled by the fake port when a write has entered. */
  private val writeEntered = CountDownLatch(1)

  /** A read parks here until a test releases it. */
  private val readGate = CountDownLatch(1)

  /** A write parks here when [RecordingPort.parkWrites] is set. */
  private val writeGate = CountDownLatch(1)

  private val port = RecordingPort()

  private val connection = testConnectionHandle()

  private fun session(): UsbSerialSession =
    UsbSerialSession("session-1", deviceId = 42, connection = connection, port = port)

  // ===================================================================
  // Delegation
  // ===================================================================

  @Test
  fun `read goes through to the port and returns what the port read`() {
    port.readResult = 7
    val session = session()
    try {
      val got = session.read(ByteArray(16), 25)
      assertEquals("the session returned a different count than the port did", 7, got)
      assertTrue("the port never saw the read: $order", order.contains("read(timeout=25)"))
    } finally {
      closeQuietly(session)
    }
  }

  @Test
  fun `write writes every byte and reports the buffer size`() {
    val session = session()
    try {
      val written = session.write(byteArrayOf(1, 2, 3, 4), 100)
      assertEquals("write must report the whole buffer, not a partial count", 4, written)
      assertTrue("the port never saw the write: $order", order.contains("write(4 bytes, timeout=100)"))
    } finally {
      closeQuietly(session)
    }
  }

  @Test
  fun `the control lines are set in the order the bootloader needs, DTR then RTS`() {
    val session = session()
    try {
      session.setControlLines(dtr = true, rts = false)
      assertEquals(listOf("setDTR(true)", "setRTS(false)"), order.toList())
    } finally {
      closeQuietly(session)
    }
  }

  @Test
  fun `the baud rate reaches the port as eight data bits, one stop bit and no parity`() {
    val session = session()
    try {
      session.setBaudRate(115_200)
      assertEquals(
        listOf("setParameters(115200, 8, ${UsbSerialPort.STOPBITS_1}, ${UsbSerialPort.PARITY_NONE})"),
        order.toList(),
      )
    } finally {
      closeQuietly(session)
    }
  }

  @Test
  fun `a baud rate outside the supported range is refused before the port is touched`() {
    val session = session()
    try {
      for (rejected in listOf(0, 1_199, 3_000_001, Int.MAX_VALUE)) {
        val thrown = runCatching { session.setBaudRate(rejected) }.exceptionOrNull()
        assertNotNull("$rejected was accepted", thrown)
        assertTrue(
          "$rejected was refused with ${thrown!!.javaClass.simpleName}, not IllegalArgumentException",
          thrown is IllegalArgumentException,
        )
      }
      assertTrue("a refused baud rate still reached the port: $order", order.isEmpty())

      // And the ends of the range are accepted, so the check is a range
      // and not a blanket refusal.
      session.setBaudRate(1_200)
      session.setBaudRate(3_000_000)
      assertEquals(2, order.size)
    } finally {
      closeQuietly(session)
    }
  }

  // ===================================================================
  // The lock, on the real class
  // ===================================================================

  /**
   * THE ASSERTION IS AN ORDERING, NOT A DURATION.
   *
   * A read is parked inside the port while a write is requested from
   * another thread. If the two share one lock, the write cannot enter the
   * port until the read has returned - so "read-exit" must appear before
   * "write-enter" in the shared log. That is true whatever the machine's
   * load is, which a "the write did not happen within 300ms" assertion
   * would not be.
   *
   * Under extreme scheduling delay this test can become VACUOUS - the
   * write thread might not reach the lock until the read is already over -
   * but it cannot become wrong, and the companion case below proves the
   * ordering check has teeth by showing an unlocked delegate violating it.
   */
  @Test
  fun `a read in progress holds the port until it returns, and only then does a write enter`() {
    port.parkReads = true
    val session = session()
    val writeFailure = AtomicReference<Throwable?>(null)
    val reader = Thread({ runCatching { session.read(ByteArray(8), 25) } }, "test-reader")
    val writer = Thread(
      {
        runCatching { session.write(byteArrayOf(9), 100) }
          .onFailure { writeFailure.set(it) }
      },
      "test-writer",
    )
    try {
      reader.start()
      assertTrue("the fake port never received a read", readEntered.await(5, TimeUnit.SECONDS))
      writer.start()
      // Reported, not asserted: under load a thread may simply not have
      // been scheduled yet, and a timing claim would be a claim about the
      // runner rather than about the lock.
      val enteredWhileHeld = writeEntered.await(300, TimeUnit.MILLISECONDS)
      println("io lock: write entered while the read was still in flight = $enteredWhileHeld")
      readGate.countDown()
      reader.join(5_000)
      writer.join(5_000)
      assertFalse("the reader thread never finished", reader.isAlive)
      assertFalse("the writer thread never finished", writer.isAlive)
      assertNull("the write failed: ${writeFailure.get()}", writeFailure.get())

      val readExit = order.indexOf("read-exit")
      val writeEnter = order.indexOf("write(1 bytes, timeout=100)")
      assertTrue("the read never left the port: $order", readExit >= 0)
      assertTrue("the write never reached the port: $order", writeEnter >= 0)
      assertTrue(
        "the write entered the port at position $writeEnter, before the read left it at " +
          "$readExit - the two are not holding one lock: $order",
        readExit < writeEnter,
      )
    } finally {
      readGate.countDown()
      closeQuietly(session)
    }
  }

  /**
   * THE ORDERING CHECK HAS TEETH, shown in band rather than by editing the
   * production file.
   *
   * The same scenario is run against a delegate that calls the port with
   * NO lock at all. The write then enters while the read is still parked,
   * and the ordering above is violated - so the check above is capable of
   * failing, which is the only thing that makes its passing worth
   * anything.
   */
  @Test
  fun `the same ordering check fails for a delegate that does not hold a lock`() {
    port.parkReads = true
    val unlocked = object {
      fun read(buffer: ByteArray, timeoutMillis: Int): Int = port.read(buffer, timeoutMillis)

      fun write(buffer: ByteArray, timeoutMillis: Int): Int {
        port.write(buffer, timeoutMillis)
        return buffer.size
      }
    }
    val reader = Thread({ runCatching { unlocked.read(ByteArray(8), 25) } }, "control-reader")
    val writer = Thread({ runCatching { unlocked.write(byteArrayOf(9), 100) } }, "control-writer")
    reader.start()
    assertTrue("the fake port never received a read", readEntered.await(5, TimeUnit.SECONDS))
    writer.start()
    assertTrue(
      "even with no lock the write never entered the port, so this control proves nothing",
      writeEntered.await(5, TimeUnit.SECONDS),
    )
    readGate.countDown()
    reader.join(5_000)
    writer.join(5_000)

    val readExit = order.indexOf("read-exit")
    val writeEnter = order.indexOf("write(1 bytes, timeout=100)")
    assertTrue("the write never reached the port: $order", writeEnter >= 0)
    assertTrue(
      "with no lock the write should have entered before the read returned, and the ordering " +
        "check should therefore have been violated: $order",
      readExit < 0 || writeEnter < readExit,
    )
  }

  // ===================================================================
  // close
  // ===================================================================

  @Test
  fun `close closes the port first and the connection after it`() {
    val session = session()
    session.close()
    assertEquals(listOf("port.close", "connection.close"), order.toList())
  }

  @Test
  fun `close still closes the connection when closing the port throws`() {
    port.closeFailure = IOException("the port refused to close")
    val session = session()
    val thrown = runCatching { session.close() }.exceptionOrNull()
    assertNotNull("closing swallowed the port's failure", thrown)
    assertSame(port.closeFailure, thrown)
    assertEquals(
      "the connection was not closed after the port threw, so it is left dangling",
      listOf("port.close", "connection.close"),
      order.toList(),
    )
  }

  /**
   * THE DRAIN RETURNS THE QUEUED ONE AND LEAVES THE ONE IN FLIGHT ALONE.
   *
   * Two contracts are asserted here, and they are the two the lifecycle
   * note in UsbSerialSessionLifecycle.kt depends on:
   *
   *   the queued request is RETURNED, for the caller to reject; the one
   *   already inside the port is not in that list and is not completed by
   *   the drain;
   *
   *   that in-flight request resolves LATER, independently, through its
   *   own onComplete, exactly once.
   */
  @Test
  fun `a write queued and never started is returned by the drain rather than lost`() {
    port.parkWrites = true
    val session = session()
    try {
      val completions = CopyOnWriteArrayList<Result<Int>>()
      val firstSettled = CountDownLatch(1)
      // The port's write parks, so the queue's consumer thread is stuck on
      // the first request and everything after it stays queued.
      val first = UsbSerialWriteRequest(byteArrayOf(1), 100) {
        completions += it
        firstSettled.countDown()
      }
      val second = UsbSerialWriteRequest(byteArrayOf(2), 100) { completions += it }
      assertEquals(UsbSerialWriteQueue.EnqueueResult.Accepted, session.enqueueWrite(first))
      assertTrue("the queue's consumer never started the first write", writeEntered.await(5, TimeUnit.SECONDS))
      assertEquals(UsbSerialWriteQueue.EnqueueResult.Accepted, session.enqueueWrite(second))

      val drained = session.stopAndDrainPendingWrites()
      assertEquals(
        "the drain returned ${drained.size} request(s); the one in progress must not be " +
          "returned and the queued one must be",
        listOf(second),
        drained,
      )
      // And it rejected nothing itself. The production note is explicit
      // that the caller does the rejecting, which is what makes the
      // returned list meaningful rather than a courtesy copy.
      assertTrue(
        "the drain completed a request itself, so the caller is no longer the one deciding " +
          "what happens to a dropped write: $completions",
        completions.isEmpty(),
      )

      // Now let the in-flight native call finish. It must settle through
      // its OWN onComplete, once, and the drained one must still be
      // untouched - the caller owns that one.
      writeGate.countDown()
      assertTrue("the in-flight write never settled", firstSettled.await(5, TimeUnit.SECONDS))
      assertEquals(
        "the in-flight write did not settle exactly once through its own onComplete: " +
          "$completions",
        listOf(Result.success(1)),
        completions.toList(),
      )
    } finally {
      writeGate.countDown()
      closeQuietly(session)
    }
  }

  /**
   * WHAT A SECOND close() ACTUALLY DOES, recorded rather than asserted to
   * be safe. The class guards its write queue against a second stop and
   * does not guard the port or the connection, so both are closed twice.
   * Every caller in UsbSerialTransportModule closes a session once and
   * removes it from the registry in the same step, so this is an
   * observation about the class rather than a defect with a call site -
   * and it is written down here so that a change in either direction is
   * visible.
   */
  @Test
  fun `a second close reaches the port and the connection again`() {
    val session = session()
    session.close()
    session.close()
    assertEquals(
      listOf("port.close", "connection.close", "port.close", "connection.close"),
      order.toList(),
    )
  }

  private fun closeQuietly(session: UsbSerialSession) {
    runCatching { session.close() }
  }

  /**
   * EVERY MEMBER OF THE LIBRARY'S OWN PORT INTERFACE, IMPLEMENTED.
   *
   * The six UsbSerialSession uses record what they were given, in the
   * shared ordered log, and park where a test needs them to. The other
   * twenty-seven refuse: a session that starts calling one of them must
   * fail here and be looked at, rather than quietly receiving a zero from
   * a stub that agreed to everything.
   */
  private inner class RecordingPort : UsbSerialPort {
    var readResult = 0
    var closeFailure: IOException? = null
    var parkReads = false
    var parkWrites = false

    override fun read(dest: ByteArray, timeout: Int): Int {
      order += "read(timeout=$timeout)"
      readEntered.countDown()
      if (parkReads) parkLikeANativeCall(readGate)
      order += "read-exit"
      return readResult
    }

    override fun write(src: ByteArray, timeout: Int) {
      order += "write(${src.size} bytes, timeout=$timeout)"
      writeEntered.countDown()
      if (parkWrites) parkLikeANativeCall(writeGate)
    }

    /**
     * WAITING THE WAY THE REAL PORT WAITS: NOT INTERRUPTIBLE.
     *
     * This parked on the latch directly and the drain case failed with
     * `Failure(java.lang.InterruptedException)` - because
     * UsbSerialWriteQueue.stopAndDrainPending() interrupts its consumer
     * thread, and CountDownLatch.await throws when interrupted.
     *
     * A REAL UsbSerialPort.write() does not. It bottoms out in
     * UsbDeviceConnection.bulkTransfer, a native call Thread.interrupt()
     * cannot break, which is exactly why the queue's own note can say "a
     * request currently inside performSerialWrite is unaffected by this
     * interrupt". A double that IS interruptible reports a failure the
     * device could never produce, and makes the production contract look
     * broken when it is not.
     *
     * So the interrupt is absorbed and re-raised on the way out: the flag
     * is restored, so the consumer thread still sees it and exits, while
     * the simulated native call runs to completion first.
     */
    private fun parkLikeANativeCall(gate: CountDownLatch) {
      var interrupted = false
      try {
        while (true) {
          try {
            gate.await(10, TimeUnit.SECONDS)
            return
          } catch (_: InterruptedException) {
            interrupted = true
          }
        }
      } finally {
        if (interrupted) Thread.currentThread().interrupt()
      }
    }

    override fun close() {
      order += "port.close"
      closeFailure?.let { throw it }
    }

    override fun setDTR(value: Boolean) {
      order += "setDTR($value)"
    }

    override fun setRTS(value: Boolean) {
      order += "setRTS($value)"
    }

    override fun setParameters(baudRate: Int, dataBits: Int, stopBits: Int, parity: Int) {
      order += "setParameters($baudRate, $dataBits, $stopBits, $parity)"
    }

    // ---- everything this class does not use ----
    private fun refuse(name: String): Nothing =
      throw AssertionError(
        "UsbSerialSession called UsbSerialPort.$name, which it did not use when this test was " +
          "written. Decide what the right behaviour is and assert it here.",
      )

    override fun getDriver(): UsbSerialDriver = refuse("getDriver")

    override fun getDevice(): UsbDevice = refuse("getDevice")

    override fun getPortNumber(): Int = refuse("getPortNumber")

    override fun getWriteEndpoint(): UsbEndpoint = refuse("getWriteEndpoint")

    override fun getReadEndpoint(): UsbEndpoint = refuse("getReadEndpoint")

    override fun getSerial(): String = refuse("getSerial")

    override fun setReadQueue(bufferCount: Int, bufferSize: Int): Unit = refuse("setReadQueue")

    override fun getReadQueueBufferCount(): Int = refuse("getReadQueueBufferCount")

    override fun getReadQueueBufferSize(): Int = refuse("getReadQueueBufferSize")

    override fun open(connection: UsbDeviceConnection): Unit = refuse("open")

    override fun read(dest: ByteArray, length: Int, timeout: Int): Int = refuse("read/3")

    override fun write(src: ByteArray, length: Int, timeout: Int): Unit = refuse("write/3")

    override fun getCD(): Boolean = refuse("getCD")

    override fun getCTS(): Boolean = refuse("getCTS")

    override fun getDSR(): Boolean = refuse("getDSR")

    override fun getDTR(): Boolean = refuse("getDTR")

    override fun getRI(): Boolean = refuse("getRI")

    override fun getRTS(): Boolean = refuse("getRTS")

    override fun getControlLines(): EnumSet<UsbSerialPort.ControlLine> = refuse("getControlLines")

    override fun getSupportedControlLines(): EnumSet<UsbSerialPort.ControlLine> =
      refuse("getSupportedControlLines")

    override fun setFlowControl(flowControl: UsbSerialPort.FlowControl): Unit =
      refuse("setFlowControl")

    override fun getFlowControl(): UsbSerialPort.FlowControl = refuse("getFlowControl")

    override fun getSupportedFlowControl(): EnumSet<UsbSerialPort.FlowControl> =
      refuse("getSupportedFlowControl")

    override fun getXON(): Boolean = refuse("getXON")

    override fun purgeHwBuffers(purgeWriteBuffers: Boolean, purgeReadBuffers: Boolean): Unit =
      refuse("purgeHwBuffers")

    override fun setBreak(value: Boolean): Unit = refuse("setBreak")

    override fun isOpen(): Boolean = refuse("isOpen")
  }

  /**
   * The connection, as the session sees it: one method. It records into
   * the same ordered log as the port, because "the connection was closed
   * AFTER the port" is the assertion, and an ordering cannot be asserted
   * from two separate counters.
   */
  private fun testConnectionHandle(): UsbConnectionHandle = UsbConnectionHandle {
    order += "connection.close"
  }
}
