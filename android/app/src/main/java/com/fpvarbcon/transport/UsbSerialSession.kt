package com.fpvarbcon.transport

import android.hardware.usb.UsbDeviceConnection
import com.hoho.android.usbserial.driver.UsbSerialPort
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * One successfully opened and configured serial port session. Holds
 * everything needed to close it again, to read from it, and (Pass 5.3) to
 * write to it - through the exact same [ioLock] guarding both directions.
 */
internal class UsbSerialSession(
  val sessionId: String,
  val deviceId: Int,
  private val connection: UsbDeviceConnection,
  private val port: UsbSerialPort,
) : WriteQueueOwner {
  /**
   * Guards every call into [port]'s read()/write() methods for this
   * session. PASS5.3-STEP0 confirmed, by direct source inspection of the
   * pinned usb-serial-for-android 3.10.0 library and of
   * android.hardware.usb.UsbDeviceConnection itself, that concurrent
   * read()/write() on one UsbSerialPort is unsafe: the library's own
   * read() never acquires its mWriteBufferLock (which only serializes
   * writes against each other), and the underlying
   * UsbDeviceConnection.bulkTransfer() call both directions ultimately
   * make has no synchronization or documented thread-safety guarantee of
   * its own either. Without this lock, the RX worker thread's continuous
   * read() calls and any write() attempt could enter native bulkTransfer()
   * calls concurrently on the same port - a confirmed data race, not a
   * hypothetical one.
   *
   * A FAIR lock (constructor argument `true`) is required, not merely
   * correctness-preserving mutual exclusion. The RX worker thread
   * re-acquires this lock once per read cycle, continuously, for the
   * entire lifetime of an active receive loop - far more often than any
   * write is ever attempted. An unfair lock (the default for both
   * ReentrantLock and plain `synchronized`) permits barging: a thread
   * arriving at the lock at the exact moment it becomes free may acquire
   * it immediately, ahead of a thread that has already been waiting - so
   * under sustained RX activity, a waiting write could in principle keep
   * losing that race to the RX thread's very next read cycle,
   * indefinitely. A fair lock instead grants the lock in strict FIFO
   * order among waiters, so a write already queued when the RX thread
   * releases the lock is guaranteed to go next - bounding worst-case TX
   * lock-acquisition latency to at most one in-flight read call's
   * duration (see RX_READ_TIMEOUT_MILLIS in UsbSerialTransportModule),
   * never an unbounded number of them. See UsbSerialSessionIoLockTest.kt.
   */
  private val ioLock = ReentrantLock(true)

  /**
   * This session's own dedicated write queue - see [UsbSerialWriteQueue]'s
   * own class-level note for why writes are queued through a dedicated
   * per-session executor rather than calling [write] directly from
   * whatever thread requested it. [close] also stops this queue
   * defensively (idempotently) so its consumer thread is never leaked,
   * even for a session that is closed before ever being registered (see
   * completeOpen()'s MODULE_INVALIDATED/RESERVATION_SUPERSEDED outcomes)
   * - the normal, registered-session close paths in
   * UsbSerialTransportModule call [stopAndDrainPendingWrites] themselves,
   * immediately, for prompt Promise rejection; this call is then a
   * harmless idempotent no-op.
   */
  private val writeQueue =
    UsbSerialWriteQueue(
      sessionId,
      sink = SerialWriteSink { buffer, timeoutMillis -> write(buffer, timeoutMillis) },
    )

  /**
   * Delegates to the underlying UsbSerialPort's own blocking, timeout-bounded
   * read - this session remains the sole owner of [port], so
   * UsbSerialReadRegistry/SerialReadLoop never hold a UsbSerialPort
   * reference of their own (see SerialReadLoop's class-level note). If
   * [close] has already run, the underlying port is already closed and this
   * throws like any other post-close read would - SerialReadLoop's own
   * token check is what keeps that from ever being reported as an
   * unexpected error (see its class-level note), not any guard here.
   */
  fun read(buffer: ByteArray, timeoutMillis: Int): Int = ioLock.withLock { port.read(buffer, timeoutMillis) }

  /**
   * Delegates to the underlying UsbSerialPort's own blocking write, under
   * the same [ioLock] as [read] - see its own note.
   *
   * PASS5.3-STEP1-CORRECTION1 independently verified (this claim was not
   * part of Step 0's evidence, which covered only read/write concurrency,
   * not write()'s own return contract) that the real UsbSerialPort
   * write(byte[], int) overload used here is genuinely all-or-nothing, by
   * direct inspection of CommonUsbSerialPort.java at the pinned
   * usb-serial-for-android v3.10.0 tag (raw.githubusercontent.com/mik3y/
   * usb-serial-for-android/v3.10.0/usbSerialForAndroid/src/main/java/com/
   * hoho/android/usbserial/driver/CommonUsbSerialPort.java):
   * - Line 319: `public void write(byte[] src, int timeout) throws
   *   IOException {write(src, src.length, timeout);}` - the two-argument
   *   overload used by this project is void and delegates directly to the
   *   three-argument overload below with no interposed catching.
   * - Lines 322-377: `write(byte[] src, int length, int timeout)` runs a
   *   `while (offset < length)` loop (line 328) that only exits by either
   *   reaching `offset >= length` (every byte written, method returns
   *   normally) or, when a `bulkTransfer()` call returns `actualLength <=
   *   0` (line 364), throwing immediately - `SerialTimeoutException` (line
   *   369) if `timeout != 0` (this project always calls write() with
   *   TX_WRITE_TIMEOUT_MILLIS, non-zero), or a plain `IOException` (line
   *   371) if `timeout == 0`. There is no code path in this method that
   *   returns normally (no exception) with `offset < length` - confirmed
   *   by reading every statement in the loop body, not merely its
   *   entry/exit conditions.
   * - `SerialTimeoutException(msg, offset)` (line 369) does carry a
   *   partial-bytes-written count: its constructor sets the inherited
   *   `java.io.InterruptedIOException.bytesTransferred` field to `offset`
   *   (confirmed by fetching SerialTimeoutException.java at the same
   *   v3.10.0 tag). Since the two-argument overload's delegation (line
   *   319) never catches or wraps this exception, that field IS surfaced,
   *   unchanged, to any caller of write(byte[], int) specifically - not
   *   only to a different overload. This does not contradict "never
   *   itself returns a partial count": the count is only ever available
   *   via a thrown exception's field, never as a value returned by a
   *   successful call.
   *
   * CONFIRMED-AS-WRITTEN. It either writes every byte of [buffer] and
   * returns normally, or throws - it never itself returns a partial
   * count. Returning buffer.size here on success is therefore exact, not
   * assumed - a genuine partial-write signal (see [SerialWriteSink]'s own
   * note) can only ever come from a fake sink in tests, never from this
   * real implementation.
   */
  fun write(buffer: ByteArray, timeoutMillis: Int): Int =
    ioLock.withLock {
      port.write(buffer, timeoutMillis)
      buffer.size
    }

  /** DTR/RTS are native bootloader control lines and share the same port lock as RX/TX. */
  fun setControlLines(dtr: Boolean, rts: Boolean) {
    ioLock.withLock {
      port.setDTR(dtr)
      port.setRTS(rts)
    }
  }

  fun setBaudRate(baudRate: Int) {
    require(baudRate in 1_200..3_000_000) { "Baud rate is outside the supported range." }
    ioLock.withLock {
      port.setParameters(baudRate, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
    }
  }

  /** Enqueues [request] on this session's own write queue - see [UsbSerialWriteQueue.enqueue]. */
  fun enqueueWrite(request: UsbSerialWriteRequest): UsbSerialWriteQueue.EnqueueResult = writeQueue.enqueue(request)

  /**
   * Stops this session's write queue and returns every request still
   * waiting (never one already in progress) for the caller to reject -
   * see [UsbSerialWriteQueue.stopAndDrainPending]'s own note on why this
   * performs no rejection itself.
   */
  override fun stopAndDrainPendingWrites(): List<UsbSerialWriteRequest> = writeQueue.stopAndDrainPending()

  /**
   * Closes the port first (usb-serial-for-android releases its own claimed
   * interface as part of this), then always closes the connection - even if
   * closing the port throws - so the connection is never left dangling.
   * Also defensively (idempotently) stops [writeQueue] - see its own
   * property note on why that matters even though the normal close paths
   * already do this themselves, immediately, before this method runs.
   *
   * PASS5.3-STEP1-CORRECTION3: the actual close sequence now runs under
   * [ioLock], the same lock [read] and [write] hold for their own native
   * calls. Without this, close() could run port.close()/connection.close()
   * fully concurrently with an in-flight read() or write() still inside its
   * own native bulkTransfer() call on this same port - exactly the same
   * category of unsynchronized-concurrent-native-call risk ioLock exists to
   * eliminate between read() and write() themselves (PASS5.3-STEP0), just
   * with close() as the third party instead of one of read()/write().
   *
   * No new deadlock risk: close() is never invoked from either the RX
   * worker thread (which only ever calls [read]) or this session's own
   * write-queue consumer thread (which only ever calls [write]) - every
   * caller of close() (UsbSerialTransportModule's closeSession(), the
   * ioExecutor-submitted closures from handleDeviceDetached()/invalidate(),
   * and completeOpen()'s own defensive cleanup) runs on a thread distinct
   * from both. So this ioLock.withLock never re-enters on a thread that
   * already holds it via [read]/[write], and never contends with itself.
   * If a read or write genuinely holds ioLock when close() is called, this
   * simply blocks close() until that call returns (success or failure) and
   * releases the lock, exactly like a write blocking behind an in-progress
   * read already does - it does not deadlock, only delays close() by at
   * most one in-flight native call's duration. See
   * UsbSerialSessionIoLockTest.kt's close()-specific test.
   *
   * [writeQueue.stopAndDrainPending] deliberately stays OUTSIDE (before)
   * this lock, not inside it: draining not-yet-started queued writes never
   * touches the port/connection or ioLock at all (see
   * UsbSerialWriteQueue's own class-level note), so there is no reason to
   * make that immediate, lock-free rejection wait behind a possibly slow
   * in-progress native write() call that happens to be holding ioLock right
   * now. Calling it first keeps Promise rejection for queued writes exactly
   * as prompt as before this correction, while only the actual native close
   * sequence itself gains ioLock protection.
   */
  fun close() {
    writeQueue.stopAndDrainPending()
    ioLock.withLock {
      try {
        port.close()
      } finally {
        connection.close()
      }
    }
  }
}
