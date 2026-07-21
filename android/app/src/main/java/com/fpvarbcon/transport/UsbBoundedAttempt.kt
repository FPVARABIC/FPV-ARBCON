package com.fpvarbcon.transport

/**
 * The outcome of one [runOnDedicatedThreadWithTimeout] call: either [work]
 * completed (with its own success/failure result), or the bound elapsed
 * first.
 */
internal sealed class UsbAttemptOutcome<out T> {
  internal data class Completed<T>(val result: Result<T>) : UsbAttemptOutcome<T>()

  internal object TimedOut : UsbAttemptOutcome<Nothing>()
}

/**
 * PASS5.4-CONNECT-TIMEOUT: runs [work] to completion on one dedicated,
 * single-use, daemon-flagged background thread - mirroring UsbIoExecutor's/
 * UsbSerialWriteQueue's own ThreadFactory pattern
 * (`Thread(runnable, name).apply { isDaemon = true }`), not inventing a
 * different one - and guarantees [onSettle] is invoked exactly once: either
 * with [work]'s own result once it completes, or with
 * [UsbAttemptOutcome.TimedOut] if [timeoutMillis] elapses first, whichever
 * happens first, race-safe via a single-shot guard (`settled`).
 *
 * Never blocks the calling thread: this function itself returns
 * immediately. [onSettle] always fires later, asynchronously, from either
 * the worker thread (on normal completion) or a separate watchdog thread
 * (on timeout) - never from the calling thread synchronously.
 *
 * Deliberately generic over any [work]/[onSettle] pair (see
 * UsbBoundedAttemptTest.kt) rather than coupled to USB open-attempt types,
 * so this mechanism is directly unit-testable on the JVM without any
 * Android runtime - exactly the same reasoning UsbBoundedProcessReader.kt
 * (the logcat-capture fix) already established for its own bounded-read
 * mechanism.
 *
 * If [work] times out, its thread is NOT interrupted or joined. A thread
 * genuinely stuck inside a blocking native call (see
 * UsbSerialTransportModule's own openDevice()/completeOpen() note on why
 * UsbDeviceConnection.close() cannot be relied on to unblock a thread
 * stuck inside claimInterface() specifically) cannot reliably be woken -
 * it is simply abandoned. Because this function's worker thread is
 * dedicated to this one call only - never shared, never pooled, never
 * UsbIoExecutor - an abandoned/leaked thread here can never block or
 * poison any other concurrent call to this same function, unlike the
 * single shared ioExecutor thread this mechanism replaces for connect
 * attempts specifically.
 */
internal fun <T> runOnDedicatedThreadWithTimeout(
  threadName: String,
  timeoutMillis: Long,
  work: () -> T,
  onSettle: (UsbAttemptOutcome<T>) -> Unit,
) {
  val settled = java.util.concurrent.atomic.AtomicBoolean(false)
  lateinit var watchdog: Thread

  val worker =
    Thread({
      val result =
        try {
          Result.success(work())
        } catch (error: Exception) {
          Result.failure(error)
        }
      if (settled.compareAndSet(false, true)) {
        // The work finished first - the watchdog is no longer needed. It
        // is merely sleeping (see below), so interrupting it only wakes it
        // early to exit promptly instead of lingering for the rest of
        // timeoutMillis; it never touches a blocking native call itself.
        watchdog.interrupt()
        onSettle(UsbAttemptOutcome.Completed(result))
      }
    }, threadName).apply { isDaemon = true }

  watchdog =
    Thread({
      try {
        Thread.sleep(timeoutMillis)
      } catch (_: InterruptedException) {
        return@Thread
      }
      if (settled.compareAndSet(false, true)) {
        onSettle(UsbAttemptOutcome.TimedOut)
      }
    }, "$threadName-watchdog").apply { isDaemon = true }

  worker.start()
  watchdog.start()
}
