package com.fpvarbcon.debug

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pass 7.7 - the app-log capture's process lifecycle, exercised against
 * REAL short-lived subprocesses on the JVM. Lives in src/testDebug so it
 * compiles only for the debug variant, exactly like the code it covers.
 */
class UsbAppLogCaptureCoreTest {
  private class RecordingOutcome : AppLogCaptureOutcome {
    val resolved = mutableListOf<String>()
    val rejected = mutableListOf<Pair<String, String>>()
    val settleCount = AtomicInteger(0)

    override fun resolve(output: String) {
      settleCount.incrementAndGet()
      resolved += output
    }

    override fun reject(code: String, message: String) {
      settleCount.incrementAndGet()
      rejected += code to message
    }
  }

  private fun shellProcess(vararg command: String): Process =
    ProcessBuilder(*command).redirectErrorStream(true).start()

  @Test
  fun `success resolves once, terminates the process and leaves nothing pending`() {
    val core = UsbAppLogCaptureCore(startProcess = { shellProcess("printf", "hello") }, timestampHeader = { "" })
    val outcome = RecordingOutcome()

    core.capture(outcome)

    assertEquals(listOf("hello"), outcome.resolved)
    assertEquals(1, outcome.settleCount.get())
    assertFalse(core.hasInFlightProcess())
  }

  @Test
  fun `a failure to even start the process rejects once and leaves nothing pending`() {
    val core =
      UsbAppLogCaptureCore(
        startProcess = { throw java.io.IOException("no such binary") },
        timestampHeader = { "" },
      )
    val outcome = RecordingOutcome()

    core.capture(outcome)

    assertEquals(1, outcome.settleCount.get())
    assertEquals(UsbAppLogCaptureCore.ERROR_FAILED, outcome.rejected.single().first)
    assertFalse(core.hasInFlightProcess())
  }

  @Test
  fun `a read error terminates the process, rejects once and clears the entry`() {
    val started = mutableListOf<Process>()
    val core =
      UsbAppLogCaptureCore(
        startProcess = {
          val process = shellProcess("sleep", "30")
          started += process
          // A closed stdin/stdout pair is not what fails here - the read
          // itself is made to fail by handing back a process whose stream
          // is closed underneath the reader.
          process.inputStream.close()
          process
        },
        timestampHeader = { "" },
      )
    val outcome = RecordingOutcome()

    core.capture(outcome)

    assertEquals(1, outcome.settleCount.get())
    assertFalse(core.hasInFlightProcess())
    assertFalse("the spawned process must not survive a read error", started.single().isAlive)
  }

  @Test
  fun `a timeout force-destroys the process, rejects exactly once with the timeout code`() {
    val started = mutableListOf<Process>()
    val core =
      UsbAppLogCaptureCore(
        startProcess = {
          val process = shellProcess("sleep", "30")
          started += process
          process
        },
        timeoutMillis = 150,
        timestampHeader = { "" },
      )
    val outcome = RecordingOutcome()

    core.capture(outcome)

    assertEquals(1, outcome.settleCount.get())
    assertEquals(UsbAppLogCaptureCore.ERROR_TIMEOUT, outcome.rejected.single().first)
    assertFalse(core.hasInFlightProcess())
    assertFalse("the spawned process must not survive a timeout", started.single().isAlive)
  }

  @Test
  fun `explicit cancellation from another thread terminates the process and settles exactly once`() {
    val started = CountDownLatch(1)
    val processes = mutableListOf<Process>()
    val core =
      UsbAppLogCaptureCore(
        startProcess = {
          val process = shellProcess("sleep", "30")
          synchronized(processes) { processes += process }
          started.countDown()
          process
        },
        timeoutMillis = 10_000,
        timestampHeader = { "" },
      )
    val outcome = RecordingOutcome()

    val worker = Thread { core.capture(outcome) }
    worker.start()
    assertTrue(started.await(5, TimeUnit.SECONDS))
    Thread.sleep(50)
    core.cancel()
    worker.join(5_000)

    assertFalse("the capture must not still be running", worker.isAlive)
    assertEquals(1, outcome.settleCount.get())
    assertFalse(core.hasInFlightProcess())
    assertFalse("the spawned process must not survive cancellation", processes.single().isAlive)
  }

  @Test
  fun `invalidation terminates a running capture and refuses every later one`() {
    val started = CountDownLatch(1)
    val processes = mutableListOf<Process>()
    val core =
      UsbAppLogCaptureCore(
        startProcess = {
          val process = shellProcess("sleep", "30")
          synchronized(processes) { processes += process }
          started.countDown()
          process
        },
        timeoutMillis = 10_000,
        timestampHeader = { "" },
      )
    val running = RecordingOutcome()

    val worker = Thread { core.capture(running) }
    worker.start()
    assertTrue(started.await(5, TimeUnit.SECONDS))
    Thread.sleep(50)
    core.invalidate()
    worker.join(5_000)

    assertFalse(worker.isAlive)
    assertEquals(1, running.settleCount.get())
    assertFalse(core.hasInFlightProcess())
    assertFalse("the spawned process must not survive invalidation", processes.single().isAlive)

    // Every later capture is refused without spawning anything at all.
    val afterwards = RecordingOutcome()
    core.capture(afterwards)
    assertEquals(1, afterwards.settleCount.get())
    assertEquals(UsbAppLogCaptureCore.ERROR_CANCELLED, afterwards.rejected.single().first)
    assertEquals("no new process may be spawned after invalidation", 1, processes.size)
  }

  @Test
  fun `cancel and invalidate are safe when nothing is running`() {
    val core = UsbAppLogCaptureCore(startProcess = { shellProcess("printf", "x") }, timestampHeader = { "" })
    core.cancel()
    core.invalidate()
    assertFalse(core.hasInFlightProcess())
  }

  @Test
  fun `output longer than the cap keeps the MOST RECENT characters and says so`() {
    val core =
      UsbAppLogCaptureCore(
        startProcess = { shellProcess("printf", "abcdefghij") },
        maxCapturedChars = 4,
        timestampHeader = { "" },
      )
    val outcome = RecordingOutcome()

    core.capture(outcome)

    val output = outcome.resolved.single()
    assertTrue(output.startsWith("[... truncated to the last 4 characters ...]"))
    assertTrue(output.endsWith("ghij"))
  }
}
