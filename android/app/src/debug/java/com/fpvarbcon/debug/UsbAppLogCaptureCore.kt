package com.fpvarbcon.debug

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Pass 7.7 - the DEBUG-ONLY process-lifecycle core of the app-log
 * capture, split out of [UsbAppLogCaptureModule] so every termination
 * path is a plain JVM object that can be unit-tested against real,
 * short-lived subprocesses (UsbAppLogCaptureCoreTest.kt) instead of
 * being reachable only through the React Native bridge.
 *
 * GUARANTEES, each covered by its own test:
 *  - the spawned process is terminated on SUCCESS (it has already exited
 *    normally; destroyForcibly() on an exited process is a documented
 *    no-op, so the call is unconditional and harmless);
 *  - terminated on READ ERROR;
 *  - terminated on TIMEOUT (readProcessOutputBounded already force-
 *    destroys it, and the finally block is idempotent);
 *  - terminated on explicit CANCELLATION from another thread;
 *  - terminated on module INVALIDATION;
 *  - the reader worker thread terminates in every one of those cases -
 *    it is a single-use, daemon, shut-down-in-finally executor, and a
 *    destroyed process unblocks its in-flight read;
 *  - the outcome settles EXACTLY once, enforced here rather than assumed;
 *  - no zombie process and no pending entry survives teardown: the
 *    in-flight reference is always cleared in the same finally block.
 *
 * This file lives in android/app/src/debug/... and is therefore absent
 * from the release variant entirely.
 */
internal interface AppLogCaptureOutcome {
  fun resolve(output: String)

  fun reject(code: String, message: String)
}

internal class UsbAppLogCaptureCore(
  private val startProcess: () -> Process,
  private val timeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS,
  private val maxCapturedChars: Int = DEFAULT_MAX_CAPTURED_CHARS,
  private val timestampHeader: () -> String = ::defaultTimestampHeader,
) {
  /** The one process this core may currently own; null when idle. */
  private val inFlight = AtomicReference<Process?>(null)
  private val invalidated = AtomicBoolean(false)
  private val cancelRequested = AtomicBoolean(false)

  /** True only while a spawned process is owned - teardown proof. */
  fun hasInFlightProcess(): Boolean = inFlight.get() != null

  fun capture(outcome: AppLogCaptureOutcome) {
    val settled = AtomicBoolean(false)
    val settleOnce = object : AppLogCaptureOutcome {
      override fun resolve(output: String) {
        if (settled.compareAndSet(false, true)) {
          outcome.resolve(output)
        }
      }

      override fun reject(code: String, message: String) {
        if (settled.compareAndSet(false, true)) {
          outcome.reject(code, message)
        }
      }
    }

    if (invalidated.get()) {
      settleOnce.reject(ERROR_CANCELLED, "The app-log capture module was invalidated.")
      return
    }

    var process: Process? = null
    try {
      process = startProcess()
      // A cancel()/invalidate() racing us here must still win: publish
      // the process first, then re-check, and destroy it ourselves if the
      // teardown already ran.
      inFlight.set(process)
      if (invalidated.get()) {
        process.destroyForcibly()
        settleOnce.reject(ERROR_CANCELLED, "The app-log capture module was invalidated.")
        return
      }
      val output = readProcessOutputBounded(process, timeoutMillis)
      val truncated = if (output.length > maxCapturedChars) output.takeLast(maxCapturedChars) else output
      val prefix =
        if (output.length > maxCapturedChars) {
          "[... truncated to the last $maxCapturedChars characters ...]\n"
        } else {
          ""
        }
      settleOnce.resolve(timestampHeader() + prefix + truncated)
    } catch (error: ProcessReadTimeoutException) {
      settleOnce.reject(ERROR_TIMEOUT, error.message ?: "Timed out capturing this app's own logcat output.")
    } catch (error: Exception) {
      val code = if (invalidated.get() || cancelRequested.getAndSet(false)) ERROR_CANCELLED else ERROR_FAILED
      settleOnce.reject(code, error.message ?: "Failed to capture this app's own logcat output.")
    } finally {
      // One place terminates the process and clears the entry, whichever
      // path got here - success, error, timeout, cancel or invalidation.
      val owned = process
      if (owned != null) {
        terminateAndAwait(owned)
      }
      inFlight.compareAndSet(process, null)
    }
  }

  /**
   * destroyForcibly() only DELIVERS the kill. java.lang.Process documents
   * that isAlive() may still report true for a brief period afterwards,
   * and tells callers who need the process to actually be gone to use
   * destroyForcibly().waitFor().
   *
   * This core CLAIMS ownership of the process it spawned ("no zombie
   * process and no pending entry survives teardown", above), so it must
   * not release that ownership - clear inFlight and return - while the
   * child may still be running. Without this wait the guarantee is only
   * EVENTUALLY true, and whether an observer immediately after capture()
   * sees a live child is decided purely by how fast the OS reaps the
   * SIGKILL. That is what made
   * UsbAppLogCaptureCoreTest's timeout case fail intermittently under CI
   * load: a real, if brief, window in which this core had already
   * disowned a process that was still alive.
   *
   * SIGKILL cannot be blocked or handled, so the wait is bounded by
   * reaping latency rather than by anything the child does. An interrupt
   * is re-asserted rather than swallowed, so a caller that interrupted
   * this thread still observes it.
   *
   * cancel() and invalidate() deliberately do NOT wait: they run on a
   * different thread from the capture they are tearing down, and the
   * capture thread's own finally - this method - is what completes the
   * termination. Blocking them would add a new blocking call on the
   * React Native bridge thread for no additional guarantee.
   */
  private fun terminateAndAwait(process: Process) {
    process.destroyForcibly()
    try {
      process.waitFor()
    } catch (interrupted: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  /** Explicit cancellation: force-destroys the in-flight process, which
   * unblocks the reader's in-flight read. Safe when nothing is running. */
  fun cancel() {
    cancelRequested.set(true)
    inFlight.getAndSet(null)?.destroyForcibly()
  }

  /** Module invalidation (React context teardown): terminates anything
   * running and refuses every later capture. */
  fun invalidate() {
    invalidated.set(true)
    inFlight.getAndSet(null)?.destroyForcibly()
  }

  internal companion object {
    const val DEFAULT_TIMEOUT_MILLIS = 5_000L
    const val DEFAULT_MAX_CAPTURED_CHARS = 20_000
    const val ERROR_TIMEOUT = "LOG_CAPTURE_TIMEOUT"
    const val ERROR_FAILED = "LOG_CAPTURE_FAILED"
    const val ERROR_CANCELLED = "LOG_CAPTURE_CANCELLED"
  }
}

/**
 * A fresh [java.text.SimpleDateFormat] per call, deliberately not a
 * shared/cached instance - SimpleDateFormat is documented as not
 * thread-safe, and a manual debug button press is not a hot path.
 */
internal fun defaultTimestampHeader(): String {
  val formatted = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())
  return "[Captured at: $formatted]\n"
}
