package com.fpvarbcon

import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.fpvarbcon.transport.UsbSerialTransportModule
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE TRANSPORT MODULE, RUNNING ON A DEVICE, AGAINST A REAL REACT HOST.
 *
 * WHY THIS FILE EXISTS. The coverage ledger classified
 * UsbSerialTransportModule.kt as UNMEASURED, because constructing it needs
 * a ReactApplicationContext and the generated Codegen spec, and neither
 * exists in a JVM test. That is true of a JVM test. It is not true on a
 * device: the application starts a React host, the host produces a real
 * context, and the module can be built on it and driven.
 *
 * So this stops being a file nothing executes. What it cannot become is a
 * file with a coverage NUMBER - instrumentation coverage would require
 * offline-instrumenting the release APK, which is the artifact whose
 * alignment, DEX contents, signing and size this campaign asserts. That
 * conflict is recorded in the ledger and in android/app/build.gradle, and
 * it is about measurement, not execution.
 *
 * WHAT IS DRIVEN HERE, AND WHAT IS NOT. Everything that does not need a
 * flight controller: construction, enumeration with nothing attached,
 * rejection of an unknown session, teardown, and repeated construction and
 * teardown. Everything that needs a board - open, permission, read, write,
 * DFU - is REAL_HARDWARE_REQUIRED and is named in the report rather than
 * skipped here, because a USB serial device cannot be conjured on an
 * emulator and pretending otherwise would be the fake evidence this
 * campaign exists to refuse.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
@RunWith(AndroidJUnit4::class)
class ReactHostCampaignTest {

  private companion object {
    const val CONTEXT_TIMEOUT_MILLIS = 60_000L
    const val SETTLE_TIMEOUT_SECONDS = 20L
    const val CYCLES = 12

    /** Threads the platform may add across a dozen build/teardown cycles. */
    const val THREAD_ALLOWANCE = 8
    const val DESCRIPTOR_ALLOWANCE = 24

    /**
     * Android declares an application not responding after five seconds of
     * input starvation. Answering well inside that is the property; the
     * bound here is deliberately the platform's own number.
     */
    const val ANR_BOUND_MILLIS = 5_000L
  }

  /**
   * Records exactly one settlement. Every overload of Promise funnels here,
   * so a module that settled twice, or settled through an overload nobody
   * expected, is visible rather than silently collapsed into one result.
   */
  private class RecordingPromise : Promise {
    val settled = CountDownLatch(1)
    val settlements = AtomicInteger(0)

    @Volatile
    var resolvedValue: Any? = null

    @Volatile
    var rejectedCode: String? = null

    @Volatile
    var rejectedMessage: String? = null

    private fun settle(code: String?, message: String?, value: Any?) {
      settlements.incrementAndGet()
      rejectedCode = code
      rejectedMessage = message
      resolvedValue = value
      settled.countDown()
    }

    fun await(): Boolean = settled.await(SETTLE_TIMEOUT_SECONDS, TimeUnit.SECONDS)

    override fun resolve(value: Any?) = settle(null, null, value)
    override fun reject(code: String?, message: String?) = settle(code, message, null)
    override fun reject(code: String?, throwable: Throwable?) =
      settle(code, throwable?.message, null)

    override fun reject(code: String?, message: String?, throwable: Throwable?) =
      settle(code, message ?: throwable?.message, null)

    override fun reject(throwable: Throwable) = settle(null, throwable.message, null)
    override fun reject(throwable: Throwable, userInfo: WritableMap) =
      settle(null, throwable.message, null)

    override fun reject(code: String?, userInfo: WritableMap) = settle(code, null, null)
    override fun reject(code: String?, throwable: Throwable?, userInfo: WritableMap) =
      settle(code, throwable?.message, null)

    override fun reject(code: String?, message: String?, userInfo: WritableMap) =
      settle(code, message, null)

    override fun reject(
      code: String?,
      message: String?,
      throwable: Throwable?,
      userInfo: WritableMap?,
    ) = settle(code, message ?: throwable?.message, null)

    override fun reject(message: String) = settle(null, message, null)
  }

  private fun liveThreads(): Int = Thread.getAllStackTraces().keys.count { it.isAlive }

  private fun openDescriptors(): Int = File("/proc/self/fd").listFiles()?.size ?: -1

  /**
   * The React host is application-scoped and produces its context once a
   * surface has started, so this launches an Activity and then polls for
   * the context with a deadline. Polling, not sleeping: the assertion is on
   * the context existing, never on how long it took.
   */
  private fun <T> withReactContext(block: (ReactApplicationContext) -> T): T =
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      val application = InstrumentationRegistry.getInstrumentation()
        .targetContext.applicationContext as MainApplication
      val host = application.reactHost

      val deadline = SystemClock.uptimeMillis() + CONTEXT_TIMEOUT_MILLIS
      var context = host.currentReactContext
      while (context == null && SystemClock.uptimeMillis() < deadline) {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        SystemClock.sleep(200)
        context = host.currentReactContext
      }
      assertNotNull(
        "the React host produced no context within ${CONTEXT_TIMEOUT_MILLIS}ms, so nothing " +
          "below could run",
        context,
      )
      assertTrue(
        "the React context is a ${context!!.javaClass.name}, not a ReactApplicationContext, " +
          "so the transport module cannot be built on it",
        context is ReactApplicationContext,
      )
      block(context as ReactApplicationContext)
    }

  private fun <T> withModule(block: (UsbSerialTransportModule) -> T): T =
    withReactContext { context ->
      val module = UsbSerialTransportModule(context)
      try {
        block(module)
      } finally {
        module.invalidate()
      }
    }

  // ===================================================================

  @Test
  fun theReactHostHandsOutAContextTheTransportModuleCanBeBuiltOn() {
    val name = withModule { module -> module.name }
    println("transport module built on a device, registered as: $name")
    assertTrue("the module reported no name", name.isNotBlank())
  }

  /**
   * ENUMERATION WITH NOTHING ATTACHED. The emulator has no USB serial
   * device, so the correct answer is an empty list delivered promptly -
   * not a rejection, and above all not a promise that never settles, which
   * is the one outcome a caller cannot recover from.
   */
  @Test
  fun listDevicesResolvesWithAnEmptyListRatherThanHangingOrFailing() {
    val promise = RecordingPromise()
    withModule { module -> module.listDevices(promise) }

    assertTrue("listDevices never settled - the caller would wait forever", promise.await())
    assertEquals("listDevices settled more than once", 1, promise.settlements.get())
    assertNull(
      "listDevices rejected with ${promise.rejectedCode} when there is simply no device",
      promise.rejectedCode,
    )
    val value = promise.resolvedValue
    assertNotNull("listDevices resolved with nothing at all", value)
    val size = (value as? ReadableArray)?.size()
    println("listDevices resolved with ${size ?: "a non-array value"} device(s)")
    assertEquals("an emulator with no USB device reported devices", 0, size)
  }

  @Test
  fun listDfuDevicesResolvesWithAnEmptyListToo() {
    val promise = RecordingPromise()
    withModule { module -> module.listDfuDevices(promise) }

    assertTrue("listDfuDevices never settled", promise.await())
    assertEquals(1, promise.settlements.get())
    assertNull(promise.rejectedCode)
    assertEquals(0, (promise.resolvedValue as? ReadableArray)?.size())
  }

  /**
   * A SESSION THAT DOES NOT EXIST. The module must refuse with its own
   * stable code rather than throwing into the bridge, because that code is
   * what the Arabic catalogue is keyed on.
   */
  @Test
  fun writingToAnUnknownSessionIsRefusedWithTheDocumentedCode() {
    val promise = RecordingPromise()
    withModule { module -> module.writeBytes("no-such-session", "AAEC", promise) }

    assertTrue("writeBytes never settled for an unknown session", promise.await())
    assertEquals(1, promise.settlements.get())
    assertEquals("UNKNOWN_SESSION", promise.rejectedCode)
    assertTrue(
      "the refusal carried no message: ${promise.rejectedMessage}",
      !promise.rejectedMessage.isNullOrBlank(),
    )
  }

  @Test
  fun closingASessionThatDoesNotExistIsRefusedRatherThanCrashing() {
    val promise = RecordingPromise()
    withModule { module -> module.closeSession("no-such-session", promise) }

    assertTrue(promise.await())
    assertEquals(1, promise.settlements.get())
    assertEquals("UNKNOWN_SESSION", promise.rejectedCode)
  }

  /**
   * BUILD AND TEAR DOWN, TWELVE TIMES. Each construction registers a
   * hotplug receiver and starts the module's single I/O executor; each
   * invalidate() must unregister and shut them down. A cycle that leaked
   * either would show as linear growth here, which is the shape the thread
   * census predicts and this measures.
   */
  @Test
  fun repeatedModuleConstructionAndTeardownDoesNotGrowThreadsOrDescriptors() {
    withReactContext { context ->
      // Warm-up, so one-time initialisation is not counted as a leak.
      UsbSerialTransportModule(context).invalidate()
      Runtime.getRuntime().gc()
      InstrumentationRegistry.getInstrumentation().waitForIdleSync()

      val baselineThreads = liveThreads()
      val baselineDescriptors = openDescriptors()

      repeat(CYCLES) {
        val module = UsbSerialTransportModule(context)
        val promise = RecordingPromise()
        module.listDevices(promise)
        assertTrue("cycle $it: listDevices never settled", promise.await())
        module.invalidate()
      }

      Runtime.getRuntime().gc()
      InstrumentationRegistry.getInstrumentation().waitForIdleSync()
      val threadsNow = liveThreads()
      val descriptorsNow = openDescriptors()
      println(
        "module cycles: threads $baselineThreads -> $threadsNow, " +
          "descriptors $baselineDescriptors -> $descriptorsNow over $CYCLES cycles",
      )

      assertTrue(
        "live threads rose from $baselineThreads to $threadsNow across $CYCLES module " +
          "build/teardown cycles - invalidate() is not shutting something down",
        threadsNow - baselineThreads <= THREAD_ALLOWANCE,
      )
      if (baselineDescriptors > 0 && descriptorsNow > 0) {
        assertTrue(
          "open descriptors rose from $baselineDescriptors to $descriptorsNow across " +
            "$CYCLES cycles",
          descriptorsNow - baselineDescriptors <= DESCRIPTOR_ALLOWANCE,
        )
      }
    }
  }

  /**
   * THE CLASSIC ANDROID LEAK, ASKED OF THE REACT CONTEXT DIRECTLY. A
   * destroyed Activity that the React context still calls "current" holds
   * its whole view tree, and every native module that reads currentActivity
   * would hand it to the platform.
   */
  @Test
  fun theReactContextDoesNotKeepADestroyedActivityAsItsCurrentOne() {
    val application = InstrumentationRegistry.getInstrumentation()
      .targetContext.applicationContext as MainApplication

    repeat(3) {
      ActivityScenario.launch(MainActivity::class.java).use { scenario ->
        scenario.moveToState(Lifecycle.State.RESUMED)
      }
      InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    val context = application.reactHost.currentReactContext
    assertNotNull("the React host lost its context entirely", context)
    val current = context!!.currentActivity
    println("react context currentActivity after three destroyed Activities: $current")
    assertTrue(
      "the React context still points at a DESTROYED Activity ($current), which keeps its " +
        "entire view tree alive for the life of the process",
      current == null || !current.isDestroyed,
    )
  }

  /**
   * NO ANR. Not "logcat contained no ANR during one launch" - a round trip
   * through the main looper after the campaign above, bounded by the
   * platform's own five seconds.
   */
  @Test
  fun theMainLooperStillAnswersInsideTheAnrBoundAfterTheCampaign() {
    withModule { module ->
      repeat(4) {
        val promise = RecordingPromise()
        module.listDevices(promise)
        assertTrue(promise.await())
      }
    }

    val answered = CountDownLatch(1)
    val started = SystemClock.uptimeMillis()
    android.os.Handler(android.os.Looper.getMainLooper()).post { answered.countDown() }
    val ok = answered.await(ANR_BOUND_MILLIS, TimeUnit.MILLISECONDS)
    val elapsed = SystemClock.uptimeMillis() - started
    println("main looper round trip after the campaign: ${elapsed}ms")
    assertTrue(
      "the main looper did not answer within Android's own ${ANR_BOUND_MILLIS}ms ANR bound - " +
        "that is what an ANR is",
      ok,
    )
  }

  /**
   * The boundaries this file deliberately does not cross, named so the
   * report's count is this list rather than a guess.
   */
  @Test
  fun theHardwareBoundariesAreNamedRatherThanQuietlyOmitted() {
    val required = listOf(
      "openDevice - needs an enumerated USB serial device to open",
      "requestPermission - needs a UsbDevice to request permission for",
      "startReading/stopReading - needs an open port",
      "writeBytes on a live session - needs an open port",
      "setControlLines/setBaudRate - needs an open port",
      "flashDfuFirmware - needs a board in DFU mode",
      "exitDfuMode/unprotectDfuDevice - needs a board in DFU mode",
      "hotplug attach/detach - needs a device to be plugged in and out",
    )
    println("REAL_HARDWARE_REQUIRED module entry points (${required.size}):")
    required.forEach { println("  $it") }
    assertEquals("this list is the report's number and must not drift silently", 8, required.size)
  }
}
