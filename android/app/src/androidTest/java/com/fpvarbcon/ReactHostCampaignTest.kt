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

    const val HALFWAY = CYCLES / 2

    /**
     * Measured as accumulation between two identical halves, not as an
     * absolute allowance - see ResourceGrowthCampaignTest for the full
     * reasoning. One-time cost lands in the first half and cancels; a leak
     * of k per cycle shows as k * 6 in the second half whatever the
     * absolute numbers are.
     */
    const val THREAD_DRIFT_ALLOWANCE = 3
    const val DESCRIPTOR_DRIFT_ALLOWANCE = 8

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

  private fun threadNames(): List<String> =
    Thread.getAllStackTraces().keys.filter { it.isAlive }.map { it.name }.sorted()

  private fun openDescriptors(): Int = File("/proc/self/fd").listFiles()?.size ?: -1

  /**
   * WHO OWNS A THREAD, NAMED HERE RATHER THAN POINTED AT.
   *
   * A census that prints thread names and says "look the owner up
   * elsewhere" is not a census.
   *
   * This is the RUNTIME half of a pair. scripts/ci/native-thread-census.py
   * reads the source and requires all thirteen construction sites to be
   * declared, owned and terminated - it is what stops a new thread being
   * added without a decision. This map is what stops one being SEEN on a
   * live device without an owner, and the two must agree: every entry below
   * is one of the thirteen names that census prints, with the file and line
   * it is constructed at.
   *
   * A module-shaped thread name that is NOT in this map fails
   * theResourceCensusNamesEveryOwnerItReports, so the map cannot quietly
   * fall behind the code.
   */
  private fun moduleOwnerOf(threadName: String): String? {
    // UsbBoundedAttempt names its watchdog after the thread it is watching,
    // so the pair share an owner.
    val base = threadName.removeSuffix("-watchdog")
    val owner = when {
      base == "UsbIoExecutor" ->
        "UsbIoExecutor.kt:57 - the module's single serialised I/O thread"
      base == "FirmwareFileRead" ->
        "UsbSerialTransportModule.kt:672 - reads a firmware file off the device"
      base == "FirmwareFileSave" ->
        "UsbSerialTransportModule.kt:697 - writes a firmware file to the device"
      base.startsWith("UsbSerialTx-") ->
        "UsbSerialWriteQueue.kt:130 - one write queue per open session"
      base.startsWith("UsbSerialRxStart-") ->
        "UsbSerialTransportModule.kt:1307 - starts a session's read loop"
      base.startsWith("UsbSerialRx-") ->
        "UsbSerialTransportModule.kt:1523 - one read loop per open session"
      base.startsWith("UsbSerialControl-") ->
        "UsbSerialTransportModule.kt:1247 - a bounded control-line change"
      base.startsWith("UsbSerialBaud-") ->
        "UsbSerialTransportModule.kt:1269 - a bounded baud-rate change"
      base.startsWith("DfuFlash-") ->
        "UsbSerialTransportModule.kt:353 - the DFU flash worker"
      base.startsWith("DfuExit-") ->
        "UsbSerialTransportModule.kt:436 - the DFU exit worker"
      base.startsWith("DfuUnprotect-") ->
        "UsbSerialTransportModule.kt:504 - the DFU read-unprotect worker"
      else -> null
    } ?: return null
    return if (threadName.endsWith("-watchdog")) "$owner (watchdog, UsbBoundedAttempt.kt:76)"
    else owner
  }

  /**
   * HOW MANY BROADCAST RECEIVERS THE PLATFORM HAS REGISTERED FOR THIS APP.
   *
   * Asked of the platform, not of the module: the module registers a
   * hotplug receiver on construction and one receiver per pending USB
   * permission request, and if invalidate() ever stopped unregistering
   * them, only ActivityManager would know. `dumpsys activity broadcasts`
   * lists them under ReceiverList entries carrying the owning package.
   *
   * A parse that silently matched nothing would report "no growth" forever,
   * so theResourceCensusCanActuallySeeAReceiver proves this function sees
   * the module's own receiver appear and disappear.
   */
  private fun registeredReceivers(): List<String> =
    shell("dumpsys activity broadcasts")
      .lineSequence()
      .map { it.trim() }
      // Matched on the substring rather than on a leading "* ", because the
      // bullet is a formatting detail that has differed between platform
      // versions and this suite runs on four of them. The package name is
      // what makes the line ours.
      .filter { it.contains("ReceiverList{") && it.contains("com.fpvarbcon") }
      .toList()

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
  fun repeatedModuleConstructionAndTeardownAccumulatesNothing() {
    withReactContext { context ->
      fun cycle(index: Int) {
        val module = UsbSerialTransportModule(context)
        val promise = RecordingPromise()
        module.listDevices(promise)
        assertTrue("cycle $index: listDevices never settled", promise.await())
        module.invalidate()
      }

      fun quiesce() {
        Runtime.getRuntime().gc()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
      }

      // Warm-up, so one-time initialisation is not counted as a leak.
      cycle(-1)
      quiesce()
      val startThreads = liveThreads()
      val startDescriptors = openDescriptors()
      val startNames = threadNames()

      repeat(HALFWAY) { cycle(it) }
      quiesce()
      val midThreads = liveThreads()
      val midDescriptors = openDescriptors()
      val midNames = threadNames()

      repeat(CYCLES - HALFWAY) { cycle(it + HALFWAY) }
      quiesce()
      val endThreads = liveThreads()
      val endDescriptors = openDescriptors()
      val endNames = threadNames()

      val threadDrift = endThreads - midThreads
      val descriptorDrift = endDescriptors - midDescriptors

      println("===== UI-X3B MODULE BUILD/TEARDOWN CENSUS =====")
      println("  threads     start=$startThreads  after $HALFWAY=$midThreads  after $CYCLES=$endThreads")
      println("  descriptors start=$startDescriptors  after $HALFWAY=$midDescriptors  after $CYCLES=$endDescriptors")
      println("  one-time cost (first half) : threads ${midThreads - startThreads}")
      println("  ACCUMULATION (second half) : threads $threadDrift, descriptors $descriptorDrift")
      println("  module-owned threads still alive at the end (name -> declared owner):")
      for (name in endNames.filter { moduleOwnerOf(it) != null }) {
        println("    $name -> ${moduleOwnerOf(name)}")
      }
      println("  threads that appeared only in the SECOND half (the leak signature):")
      (endNames.toSet() - midNames.toSet()).sorted().forEach { println("    $it") }
      println("===============================================")

      assertTrue(
        "live threads rose by $threadDrift between the halfway mark ($midThreads) and the end " +
          "($endThreads) of $CYCLES identical module build/teardown cycles - invalidate() is " +
          "not shutting something down. Threads new in the second half: " +
          "${(endNames.toSet() - midNames.toSet()).sorted()}",
        threadDrift <= THREAD_DRIFT_ALLOWANCE,
      )
      if (midDescriptors > 0 && endDescriptors > 0) {
        assertTrue(
          "open descriptors rose by $descriptorDrift between the halfway mark " +
            "($midDescriptors) and the end ($endDescriptors) of $CYCLES cycles",
          descriptorDrift <= DESCRIPTOR_DRIFT_ALLOWANCE,
        )
      }

      // The module's own named threads must not survive its teardown. This
      // is the specific claim the thread census makes about UsbIoExecutor
      // and the write queues, asked of a live process rather than of the
      // source.
      val survivors = endNames.filter { it == "UsbIoExecutor" || it.startsWith("UsbSerialTx-") }
      assertTrue(
        "these module-owned threads outlived every invalidate(): $survivors",
        survivors.isEmpty(),
      )
    }
  }

  /**
   * THE BEFORE AND AFTER CENSUS, ON EVERY AXIS THE MODULE CAN LEAK ON.
   *
   * repeatedModuleConstructionAndTeardownAccumulatesNothing measures
   * threads and descriptors. Those are the two that show a leaked executor,
   * and they are blind to the other three things a build/teardown cycle
   * owns: a broadcast receiver the platform still holds, a permission
   * request still pending, and a React context replaced rather than reused.
   *
   * All five are counted before and after twelve cycles here, printed with
   * names and owners rather than as totals, and required not to grow.
   */
  @Test
  fun theBeforeAndAfterCensusShowsNothingAccumulating() {
    withReactContext { context ->
      val contextIdentity = System.identityHashCode(context)

      fun cycle() {
        val module = UsbSerialTransportModule(context)
        val promise = RecordingPromise()
        module.listDevices(promise)
        assertTrue("listDevices never settled", promise.await())
        module.invalidate()
      }

      fun quiesce() {
        Runtime.getRuntime().gc()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        SystemClock.sleep(200)
      }

      cycle()
      quiesce()
      val beforeThreads = threadNames()
      val beforeReceivers = registeredReceivers()
      val beforeDescriptors = openDescriptors()

      repeat(CYCLES) { cycle() }
      quiesce()
      val afterThreads = threadNames()
      val afterReceivers = registeredReceivers()
      val afterDescriptors = openDescriptors()
      val afterContext = (
        InstrumentationRegistry.getInstrumentation().targetContext
          .applicationContext as MainApplication
        ).reactHost.currentReactContext

      println("===== UI-X3B BEFORE/AFTER RESOURCE CENSUS ($CYCLES cycles) =====")
      println("  threads              before=${beforeThreads.size}  after=${afterThreads.size}")
      println("  module-owned threads before:")
      beforeThreads.filter { moduleOwnerOf(it) != null }
        .forEach { println("    $it -> ${moduleOwnerOf(it)}") }
      println("  module-owned threads after:")
      afterThreads.filter { moduleOwnerOf(it) != null }
        .forEach { println("    $it -> ${moduleOwnerOf(it)}") }
      println("  registered receivers before=${beforeReceivers.size} after=${afterReceivers.size}")
      afterReceivers.forEach { println("    $it") }
      println("  open descriptors     before=$beforeDescriptors after=$afterDescriptors")
      println("  ReactContext identity before=$contextIdentity " +
        "after=${afterContext?.let { System.identityHashCode(it) }}")
      println("  threads new since the baseline:")
      (afterThreads.toSet() - beforeThreads.toSet()).sorted().forEach { println("    $it") }
      println("================================================================")

      assertTrue(
        "live threads grew from ${beforeThreads.size} to ${afterThreads.size} across $CYCLES " +
          "identical cycles. New: ${(afterThreads.toSet() - beforeThreads.toSet()).sorted()}",
        afterThreads.size - beforeThreads.size <= THREAD_DRIFT_ALLOWANCE,
      )
      assertTrue(
        "the platform holds ${afterReceivers.size} registered receivers for this app after " +
          "$CYCLES build/teardown cycles, against ${beforeReceivers.size} before - invalidate() " +
          "is leaving receivers registered. Current: $afterReceivers",
        afterReceivers.size <= beforeReceivers.size,
      )
      if (beforeDescriptors > 0 && afterDescriptors > 0) {
        assertTrue(
          "open descriptors grew from $beforeDescriptors to $afterDescriptors",
          afterDescriptors - beforeDescriptors <= DESCRIPTOR_DRIFT_ALLOWANCE,
        )
      }
      assertEquals(
        "the React host handed out a DIFFERENT context after $CYCLES cycles, so each cycle is " +
          "leaving a context behind rather than reusing one",
        contextIdentity,
        afterContext?.let { System.identityHashCode(it) },
      )
    }
  }

  /**
   * THE CENSUS IS A REAL SUBJECT. A receiver counter that matched nothing
   * would report "no growth" forever and every clean result above would be
   * worthless. So: count, build a module - which registers its hotplug
   * receiver - count again, tear it down, count again. The middle count has
   * to be higher than both.
   */
  @Test
  fun theResourceCensusCanActuallySeeAReceiver() {
    withReactContext { context ->
      val before = registeredReceivers()
      val module = UsbSerialTransportModule(context)
      val promise = RecordingPromise()
      module.listDevices(promise)
      assertTrue(promise.await())
      val during = registeredReceivers()
      module.invalidate()
      InstrumentationRegistry.getInstrumentation().waitForIdleSync()
      SystemClock.sleep(500)
      val after = registeredReceivers()

      println("receiver census control: before=${before.size} during=${during.size} after=${after.size}")
      during.forEach { println("  during: $it") }

      assertTrue(
        "dumpsys activity broadcasts reported ${during.size} receivers for this app while a " +
          "transport module was alive and ${before.size} before it was built. The module " +
          "registers a hotplug receiver on construction, so this counter is not seeing it - " +
          "which means every 'receivers did not grow' result it produces is meaningless.",
        during.size > before.size,
      )
      assertTrue(
        "the hotplug receiver was still registered after invalidate(): during=${during.size} " +
          "after=${after.size}",
        after.size < during.size,
      )
    }
  }

  /** Every module-shaped thread name the census meets has a declared owner. */
  @Test
  fun theResourceCensusNamesEveryOwnerItReports() {
    withModule { module ->
      val promise = RecordingPromise()
      module.listDevices(promise)
      assertTrue(promise.await())

      val moduleShaped = threadNames().filter { name ->
        name.startsWith("Usb") || name.startsWith("Dfu") || name.startsWith("Firmware")
      }
      val unowned = moduleShaped.filter { moduleOwnerOf(it) == null }
      println("module-shaped threads seen: $moduleShaped")
      assertEquals(
        "these threads look like this module's and have no declared owner in moduleOwnerOf, so " +
          "the census would print them without saying who is responsible for shutting them down",
        emptyList<String>(),
        unowned,
      )
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
