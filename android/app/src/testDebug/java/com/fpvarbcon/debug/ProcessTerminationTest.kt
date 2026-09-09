package com.fpvarbcon.debug

import android.os.Build
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE API 24/25 BRANCH, EXERCISED RATHER THAN ASSUMED.
 *
 * `Process.destroyForcibly()` arrived in API 26 and this application
 * declares minSdkVersion 24, so [terminateForcibly] has to take a
 * different path on the two oldest levels it claims to support. Under
 * plain JVM unit tests `Build.VERSION.SDK_INT` reads as 0, which puts
 * this test on exactly that legacy path - so the case that could never
 * be reached from an API 34 emulator is the one running here.
 *
 * That is a property of the harness, not of the product, so it is
 * ASSERTED rather than relied on. If a future toolchain ever reports a
 * real SDK_INT to unit tests, this fails loudly and says so instead of
 * quietly starting to test the other branch and proving nothing about
 * this one.
 *
 * The API 26+ branch is covered by Android Lint: the guard is written
 * against Build.VERSION.SDK_INT in the shape NewApi understands, so
 * removing it puts the error back.
 */
class ProcessTerminationTest {

  private class RecordingProcess : Process() {
    var destroyCalls = 0
    var destroyForciblyCalls = 0

    override fun destroy() {
      destroyCalls += 1
    }

    override fun destroyForcibly(): Process {
      destroyForciblyCalls += 1
      return this
    }

    override fun waitFor(): Int = 0

    override fun exitValue(): Int = 0

    override fun getInputStream(): InputStream = ByteArrayInputStream(ByteArray(0))

    override fun getErrorStream(): InputStream = ByteArrayInputStream(ByteArray(0))

    override fun getOutputStream(): OutputStream =
      object : OutputStream() {
        override fun write(b: Int) = Unit
      }
  }

  @Test
  fun belowApiTwentySixTheLegacyDestroyIsUsed() {
    assertTrue(
      "this case only means something below API 26, and SDK_INT here is " +
        "${Build.VERSION.SDK_INT}; the legacy branch is no longer the one under test",
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O,
    )

    val process = RecordingProcess()
    terminateForcibly(process)

    assertEquals("destroy() was not called on the API 24/25 path", 1, process.destroyCalls)
    assertEquals(
      "destroyForcibly() was called below API 26, which is a NoSuchMethodError on a real device",
      0,
      process.destroyForciblyCalls,
    )
  }

  /** Terminating twice must stay a plain repeat, not an escalation. */
  @Test
  fun repeatedTerminationStaysOnTheSameBranch() {
    val process = RecordingProcess()
    terminateForcibly(process)
    terminateForcibly(process)

    assertEquals(2, process.destroyCalls)
    assertEquals(0, process.destroyForciblyCalls)
  }
}
