package com.fpvarbcon.transport

import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue

/**
 * Abstracts one blocking, timeout-bounded write call so write-queue
 * consumption can be unit-tested on the JVM without any real
 * UsbSerialPort/UsbDeviceConnection - mirrors [SerialReadSource]'s own
 * role for reads. Contract matches [UsbSerialSession.write] exactly:
 * attempts to write every byte of [buffer], waiting at most
 * [timeoutMillis], and returns the number of bytes actually written.
 *
 * PASS5.3-STEP0 confirmed the real implementation (backed by the pinned
 * usb-serial-for-android 3.10.0 UsbSerialPort.write(byte[], int) overload)
 * is all-or-nothing per its own contract - it either writes every byte and
 * returns normally, or throws (including SerialTimeoutException on a
 * partial write that timed out) - so it can only ever return the full
 * buffer size on success, never a smaller count. A fake implementation
 * used in tests can still return fewer bytes than requested to exercise
 * [performSerialWrite]'s own partial-write detection, which the real
 * implementation could never itself trigger - the defensive check stays
 * in place regardless.
 */
internal fun interface SerialWriteSink {
  fun write(buffer: ByteArray, timeoutMillis: Int): Int
}

/**
 * One write() attempt: the exact bytes to write, the timeout to apply,
 * and the completion callback - invoked exactly once, with the number of
 * bytes actually written on success or the failure exception otherwise -
 * whether this request ran to completion, failed mid-attempt, or was
 * rejected before ever starting (see
 * [UsbSerialWriteQueue.stopAndDrainPending]).
 */
internal class UsbSerialWriteRequest(
  val buffer: ByteArray,
  val timeoutMillis: Int,
  val onComplete: (Result<Int>) -> Unit,
)

/**
 * Performs exactly one write attempt against [sink] for [request], and
 * always calls [UsbSerialWriteRequest.onComplete] exactly once. Success
 * requires every byte of [UsbSerialWriteRequest.buffer] to have actually
 * been written - a partial write (fewer bytes than requested; see
 * [SerialWriteSink]'s own note on why the real implementation can never
 * legitimately produce this) is treated as a failure and never
 * auto-retried, matching [UsbSerialTransportModule.writeBytes]'s own
 * explicit, single-attempt contract.
 */
internal fun performSerialWrite(sink: SerialWriteSink, request: UsbSerialWriteRequest) {
  val result =
    try {
      val written = sink.write(request.buffer, request.timeoutMillis)
      if (written < request.buffer.size) {
        Result.failure(IOException("Partial write: $written of ${request.buffer.size} bytes written."))
      } else {
        Result.success(written)
      }
    } catch (error: Exception) {
      Result.failure(error)
    }
  request.onComplete(result)
}

/**
 * A bounded, strict-FIFO, single-consumer write queue for exactly one
 * session - never shared across sessions, so unrelated sessions' writes
 * are never serialized against each other (mirroring the same
 * cross-session independence already proven for RX in
 * UsbSerialRxRestartConcurrencyTest.kt). [performSerialWrite] runs on this
 * queue's own dedicated daemon thread - never the caller's thread, never
 * an RX worker thread, and never [UsbIoExecutor] (reserved for
 * open/close work) - one request at a time, strictly in enqueue order.
 *
 * [enqueue] never blocks: it returns immediately with an [EnqueueResult]
 * so a caller always knows synchronously whether its write was accepted -
 * [EnqueueResult.QueueFull] if [capacity] requests are already waiting,
 * [EnqueueResult.Stopped] if [stopAndDrainPending] already ran for this
 * queue - never silently dropped, never blocked past that immediate
 * decision.
 *
 * [stopAndDrainPending] is idempotent and deliberately performs no
 * rejection or callback invocation itself - it only stops accepting
 * further requests and returns every request still waiting (never one
 * already handed to [performSerialWrite]) so the caller can reject them
 * from outside whatever lock this was called under (see
 * UsbSerialTransportModule's closeSession()/handleDeviceDetached()/
 * invalidate(), which all call this immediately - at the same point they
 * already clear that session's RX state - but defer the actual
 * onComplete/Promise-rejection calls to after releasing lifecycleLock,
 * the same convention already used for every other Promise settlement in
 * this module).
 *
 * A request already handed to [performSerialWrite] when a concurrent
 * close/detach/invalidate happens is not interrupted or cancelled here -
 * it either completes normally or fails on its own (e.g. because the
 * underlying port/connection was closed out from under it), and
 * [performSerialWrite]'s own try/catch reports that failure through the
 * request's own onComplete exactly as any other write failure would be -
 * this queue's consumer thread is never crashed or stopped by it, letting
 * it continue past a stop only to find the queue already empty (drained
 * by that same stop). See UsbSerialWriteQueueTest.kt for the concurrent
 * "already in progress when closed" scenario.
 */
internal class UsbSerialWriteQueue(
  sessionId: String,
  private val capacity: Int = DEFAULT_CAPACITY,
  private val sink: SerialWriteSink,
) {

  /** The outcome of a single [enqueue] call. */
  internal sealed class EnqueueResult {
    /** Accepted - now waiting behind whatever else was already queued. */
    object Accepted : EnqueueResult()

    /** Rejected: [capacity] requests are already waiting. */
    object QueueFull : EnqueueResult()

    /** Rejected: [stopAndDrainPending] already ran for this queue. */
    object Stopped : EnqueueResult()
  }

  private val queue = LinkedBlockingQueue<UsbSerialWriteRequest>(capacity)
  private val lock = Any()
  private var stopped = false

  private val thread = Thread({ runLoop() }, "UsbSerialTx-$sessionId").apply { isDaemon = true }

  init {
    thread.start()
  }

  fun enqueue(request: UsbSerialWriteRequest): EnqueueResult {
    synchronized(lock) {
      if (stopped) return EnqueueResult.Stopped
      return if (queue.offer(request)) EnqueueResult.Accepted else EnqueueResult.QueueFull
    }
  }

  private fun runLoop() {
    while (true) {
      val request =
        try {
          queue.take()
        } catch (_: InterruptedException) {
          return
        }
      try {
        performSerialWrite(sink, request)
      } catch (_: Exception) {
        // Best-effort safety net, matching UsbIoExecutor.submit's own
        // task-wrapper catch: performSerialWrite is expected to always
        // call request.onComplete itself, so this only guards against
        // that callback itself throwing unexpectedly - one request's
        // failure here must never crash this thread or stop it from
        // draining whatever is queued behind it.
      }
    }
  }

  /**
   * Idempotent. Stops accepting new requests and returns every request
   * still waiting (never one already in progress) - see this class's own
   * class-level note on why rejection itself is the caller's job. Also
   * interrupts this queue's own consumer thread so a call currently
   * idle-blocked in queue.take() (nothing left to do) wakes up and exits
   * promptly; a request currently inside [performSerialWrite] is
   * unaffected by this interrupt (see that method's own note).
   */
  fun stopAndDrainPending(): List<UsbSerialWriteRequest> {
    synchronized(lock) {
      if (stopped) return emptyList()
      stopped = true
      val drained = mutableListOf<UsbSerialWriteRequest>()
      queue.drainTo(drained)
      thread.interrupt()
      return drained
    }
  }

  private companion object {
    const val DEFAULT_CAPACITY = 16
  }
}
