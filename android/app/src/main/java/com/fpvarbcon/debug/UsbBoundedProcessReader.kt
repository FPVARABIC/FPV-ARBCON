package com.fpvarbcon.debug

import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Thrown by [readProcessOutputBounded] when [Process]'s output does not
 * finish being read (and the process does not finish exiting) within the
 * given bound.
 */
internal class ProcessReadTimeoutException(message: String) : Exception(message)

/**
 * Reads all of an already-started [process]'s stdout to completion (EOF)
 * and then waits for it to exit, on one dedicated, single-use, daemon-
 * flagged background thread - mirroring UsbIoExecutor's own ThreadFactory
 * pattern (`Thread(runnable, name).apply { isDaemon = true }`), not
 * inventing a different one - and bounds the wait for that whole sequence
 * to at most [timeoutMillis]. Generic over any started [Process] (not
 * coupled to `logcat` specifically), so this is directly unit-testable on
 * the JVM against a real, short-lived subprocess - see
 * UsbBoundedProcessReaderTest.kt.
 *
 * PASS5.3-DEBUG-LOGCAT-CORRECTION: the original version of this capture
 * feature bounded only the wait for the process to *exit*, after an
 * unbounded `reader.readText()` call had already returned - meaning a
 * stdout stream that never reached EOF (for any reason) would hang this
 * indefinitely, the exact same class of bug this entire debug feature
 * exists to diagnose in openDevice(). This function instead bounds the
 * read itself.
 *
 * Plain (non-NIO) `InputStream.read()` - which is exactly what a
 * `BufferedReader` backing `readText()` performs - cannot be unblocked by
 * `Thread.interrupt()`; the only reliable way to unblock a thread
 * genuinely stuck inside it is to force-close the stream it is reading
 * from, which is exactly what [Process.destroyForcibly] does. On timeout,
 * this function calls [Process.destroyForcibly] on [process] to unblock
 * the reader thread's in-flight read (which then fails with an
 * IOException this function's own reader task catches and discards - the
 * thread was already abandoned, its result is no longer wanted) and
 * throws [ProcessReadTimeoutException] - it never returns a partial read:
 * a single `readText()` call has no naturally available partial result on
 * timeout, so timing out is reported as its own distinct outcome, never
 * silently downgraded to an incomplete "success".
 *
 * [settled] guards which single outcome - the read+exit completing, or
 * the bound elapsing first - is allowed to call
 * [Process.destroyForcibly]/decide the final result: explicit, not
 * "probably fine because timing works out", even though today's only
 * caller is one synchronous calling thread.
 */
internal fun readProcessOutputBounded(process: Process, timeoutMillis: Long): String {
  val executor =
    Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "UsbAppLogCaptureReader").apply { isDaemon = true }
    }
  val settled = AtomicBoolean(false)
  try {
    // No manual try/catch is needed inside this Callable around the
    // destroyForcibly()-induced IOException an abandoned (timed-out) read
    // can throw: ExecutorService.submit(Callable)'s own contract captures
    // any exception the task throws into the returned Future, and never
    // rethrows it on this executor's own thread - it only ever surfaces via
    // Future.get(), which the timeout path below never calls again once it
    // has already thrown ProcessReadTimeoutException. So an abandoned
    // reader's failure is inherently swallowed by the JDK itself, not by
    // anything bespoke here.
    val future =
      executor.submit(
        Callable {
          val text = BufferedReader(InputStreamReader(process.inputStream)).use { reader -> reader.readText() }
          process.waitFor()
          text
        },
      )
    return try {
      val output = future.get(timeoutMillis, TimeUnit.MILLISECONDS)
      settled.set(true)
      output
    } catch (_: TimeoutException) {
      if (settled.compareAndSet(false, true)) {
        process.destroyForcibly()
      }
      future.cancel(true)
      throw ProcessReadTimeoutException("Timed out reading process output after ${timeoutMillis}ms.")
    } catch (error: ExecutionException) {
      throw (error.cause as? Exception) ?: error
    }
  } finally {
    executor.shutdown()
  }
}
