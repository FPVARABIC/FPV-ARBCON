package com.fpvarbcon.debug

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Covers [readProcessOutputBounded] directly on the JVM against a real,
 * short-lived subprocess - deliberately not against `captureAppLog()`
 * itself, which is hardcoded to invoke `logcat` and is not meaningfully
 * testable off a real Android device. [readProcessOutputBounded] is
 * generic over any already-started [Process], so a real subprocess here
 * exercises the exact same bounded-read/force-destroy logic
 * UsbAppLogCaptureModule.kt relies on, without needing Android at all.
 *
 * Uses `sh -c "..."` to launch these subprocesses - this project's CI
 * (android-validation.yml) runs on `ubuntu-latest`, where a POSIX shell is
 * always available; this is not asserted to be portable to every possible
 * environment these unit tests might run in, only confirmed for the one
 * this project's tests actually run in.
 */
class UsbBoundedProcessReaderTest {

  @Test
  fun `a fast subprocess completing well within the bound returns its output`() {
    val process = ProcessBuilder("sh", "-c", "printf hello").redirectErrorStream(true).start()

    val output = readProcessOutputBounded(process, timeoutMillis = 5_000L)

    assertEquals("hello", output)
  }

  @Test
  fun `a slow subprocess exceeding the bound is force-destroyed and reported as a timeout, without blocking for its full duration`() {
    // Deliberately sleeps far longer than the short test-only bound below -
    // the real 5s CAPTURE_TIMEOUT_MILLIS constant is not used here so this
    // test itself stays fast.
    val process = ProcessBuilder("sh", "-c", "sleep 5").redirectErrorStream(true).start()
    val shortTestTimeoutMillis = 500L

    val startNanos = System.nanoTime()
    try {
      readProcessOutputBounded(process, timeoutMillis = shortTestTimeoutMillis)
      fail("Expected readProcessOutputBounded to throw ProcessReadTimeoutException")
    } catch (_: ProcessReadTimeoutException) {
      // Expected.
    }
    val elapsedMillis = (System.nanoTime() - startNanos) / 1_000_000

    assertTrue(
      "must return promptly (well under the subprocess's 5s sleep), not block for its full duration - " +
        "took ${elapsedMillis}ms",
      elapsedMillis < 4_000L,
    )

    // destroyForcibly() takes effect asynchronously at the OS level - poll
    // briefly rather than asserting immediately, to avoid a flaky check.
    val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(2)
    while (process.isAlive && System.nanoTime() < deadline) {
      Thread.onSpinWait()
    }
    assertFalse("the timed-out subprocess must actually be destroyed, not left running", process.isAlive)
  }
}
