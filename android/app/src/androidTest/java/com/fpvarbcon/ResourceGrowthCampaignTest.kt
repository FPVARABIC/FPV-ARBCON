package com.fpvarbcon

import android.app.Activity
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.lang.ref.WeakReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * REPEATED CYCLES, AND WHAT MUST NOT GROW ACROSS THEM.
 *
 * A leak does not announce itself. One launch, one recreation and one
 * teardown all look identical whether or not each of them left a thread,
 * a file descriptor or an Activity behind - the difference only appears
 * when the cycle is repeated, which is what an operator does over a
 * session and what this file does deliberately.
 *
 * HOW GROWTH IS JUDGED. Counts on Android are noisy: the platform starts
 * and retires its own threads, binder pools resize, and the garbage
 * collector runs when it feels like it. So the test does not demand an
 * exact number. It takes a baseline AFTER a warm-up cycle - so one-time
 * initialisation is not counted as a leak - and then requires that the
 * count after many more cycles has not risen by more than a stated
 * allowance. A genuine per-cycle leak grows LINEARLY and blows through any
 * fixed allowance; platform noise does not.
 *
 * That allowance is written as a number with a reason next to it, not
 * tuned until the test passed. If one of these ever fails, the honest
 * first question is whether the allowance was too tight, and the second
 * is whether something is leaking - and the printed per-cycle numbers are
 * there so that question can be answered from the log rather than guessed.
 *
 * ANRs are NOT judged here. A test process that is being deliberately
 * hammered is not a fair place to look for one, and logcat is scanned for
 * ANRs by verify-instrumentation-results.sh over the whole run instead.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
@RunWith(AndroidJUnit4::class)
class ResourceGrowthCampaignTest {

  private companion object {
    /** Enough repetitions that a per-cycle leak becomes unmistakable. */
    const val CYCLES = 12

    /** The cycle at which the second measurement is taken. */
    const val HALFWAY = CYCLES / 2

    /**
     * WHAT IS MEASURED, AND WHY IT IS NOT AN ABSOLUTE ALLOWANCE.
     *
     * The claim is "nothing ACCUMULATES", and an absolute allowance cannot
     * test that. React Native, Hermes, Skia and Reanimated add threads and
     * descriptors the first time a surface exists, and those are a
     * one-time cost, not a leak - but they are indistinguishable from a
     * leak if all you compare is "before the first cycle" against "after
     * the last one". Picking a number big enough to absorb them is exactly
     * the tuning-until-green this campaign refuses.
     *
     * So the comparison is between the FIRST half of the cycles and the
     * SECOND half. One-time initialisation lands entirely in the first
     * half and cancels; a leak of k per cycle shows up as k * 6 in the
     * second half, whatever the absolute numbers are. The allowance below
     * therefore only has to absorb platform noise between two identical
     * halves, which is a small number that can be justified rather than
     * tuned.
     *
     * Absolute counts are printed either way, so a reader can see the
     * one-time cost and judge it separately.
     */
    const val THREAD_DRIFT_ALLOWANCE = 3

    /** Descriptors, same reasoning: a socket or an inotify handle may come and go. */
    const val DESCRIPTOR_DRIFT_ALLOWANCE = 8
  }

  private fun liveThreads(): Int = Thread.getAllStackTraces().keys.count { it.isAlive }

  private fun threadNames(): List<String> =
    Thread.getAllStackTraces().keys.filter { it.isAlive }.map { it.name }.sorted()

  /** Open descriptors of this process, which is where a stream leak shows. */
  private fun openDescriptors(): Int =
    File("/proc/self/fd").listFiles()?.size ?: -1

  private fun settle() {
    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
  }

  /**
   * Encourage collection without pretending it is deterministic. System.gc
   * is a request, so this asks several times with a yield in between and
   * the callers treat the result as evidence only when it is POSITIVE -
   * an object that HAS been collected is proof it was collectable.
   */
  private fun encourageCollection() {
    repeat(6) {
      Runtime.getRuntime().gc()
      System.runFinalization()
      Thread.yield()
    }
  }

  // ===================================================================

  /**
   * ACTIVITY LIFECYCLE CYCLES. Launch, resume, recreate, destroy - twelve
   * times - and neither the thread count nor the descriptor count may
   * climb with them.
   */
  @Test
  fun repeatedActivityCyclesAccumulateNothing() {
    // Warm-up: the first launch initialises React Native, Hermes, Skia and
    // the rest. Counting that as growth would report every app that works
    // as leaking.
    oneCycle()
    settle()
    encourageCollection()

    val startThreads = liveThreads()
    val startDescriptors = openDescriptors()
    val startNames = threadNames().toSet()

    repeat(HALFWAY) { oneCycle() }
    settle()
    encourageCollection()
    val midThreads = liveThreads()
    val midDescriptors = openDescriptors()
    val midNames = threadNames().toSet()

    repeat(CYCLES - HALFWAY) { oneCycle() }
    settle()
    encourageCollection()
    val endThreads = liveThreads()
    val endDescriptors = openDescriptors()
    val endNames = threadNames().toSet()

    val threadDrift = endThreads - midThreads
    val descriptorDrift = endDescriptors - midDescriptors

    println("===== UI-X3B ACTIVITY CYCLE RESOURCE CENSUS =====")
    println("  threads     start=$startThreads  after $HALFWAY=$midThreads  after $CYCLES=$endThreads")
    println("  descriptors start=$startDescriptors  after $HALFWAY=$midDescriptors  after $CYCLES=$endDescriptors")
    println("  one-time cost (first half) : threads ${midThreads - startThreads}, descriptors ${midDescriptors - startDescriptors}")
    println("  ACCUMULATION (second half) : threads $threadDrift, descriptors $descriptorDrift")
    println("  threads present at the end that were not there at the start:")
    (endNames - startNames).sorted().forEach { println("    $it") }
    println("  threads that appeared only in the SECOND half (the leak signature):")
    (endNames - midNames).sorted().forEach { println("    $it") }
    println("=================================================")

    assertTrue(
      "the live thread count rose by $threadDrift between the halfway mark ($midThreads) and " +
        "the end ($endThreads) of $CYCLES identical Activity cycles. One-time initialisation " +
        "cannot explain that, because it already happened before the halfway mark. Threads " +
        "that appeared only in the second half: ${(endNames - midNames).sorted()}",
      threadDrift <= THREAD_DRIFT_ALLOWANCE,
    )
    if (midDescriptors > 0 && endDescriptors > 0) {
      assertTrue(
        "open file descriptors rose by $descriptorDrift between the halfway mark " +
          "($midDescriptors) and the end ($endDescriptors) of $CYCLES identical cycles",
        descriptorDrift <= DESCRIPTOR_DRIFT_ALLOWANCE,
      )
    }
  }

  private fun oneCycle() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.recreate()
      scenario.moveToState(Lifecycle.State.CREATED)
      scenario.moveToState(Lifecycle.State.RESUMED)
    }
    settle()
  }

  /**
   * NO LEAKED ACTIVITY. A destroyed Activity that is still reachable keeps
   * its whole view tree, and with it every bitmap and every listener, for
   * the life of the process. This is the classic Android leak and it is
   * invisible to any count.
   *
   * The assertion is one-directional on purpose: a reference that HAS been
   * cleared proves the Activity was collectable. A reference that has not
   * been cleared could mean a leak or could mean the collector simply did
   * not run, so that case is reported rather than failed - claiming a leak
   * from a non-deterministic collector would be a false accusation as
   * often as a true one.
   */
  @Test
  fun destroyedActivitiesBecomeCollectable() {
    val references = mutableListOf<WeakReference<Activity>>()

    repeat(4) {
      ActivityScenario.launch(MainActivity::class.java).use { scenario ->
        scenario.moveToState(Lifecycle.State.RESUMED)
        scenario.onActivity { references += WeakReference(it) }
      }
      settle()
    }

    encourageCollection()
    settle()
    encourageCollection()

    val cleared = references.count { it.get() == null }
    println("destroyed Activities collected: $cleared of ${references.size}")

    assertTrue(
      "not one of ${references.size} destroyed Activities became collectable. That is the " +
        "shape of a leaked Activity: a destroyed one that is still reachable holds its entire " +
        "view tree, every bitmap in it and every listener registered on it, for the life of " +
        "the process.",
      cleared > 0,
    )
    if (cleared < references.size) {
      println(
        "NOTE: ${references.size - cleared} of ${references.size} were still reachable. " +
          "System.gc is a request, not a command, so this is reported rather than failed - " +
          "the assertion above is that collection is POSSIBLE, which is the falsifiable half.",
      )
    }
  }

  /**
   * THE ONE THREAD THAT MUST NOT DO DEVICE WORK. Android kills an app that
   * blocks the main looper, and every USB and file operation in this
   * module is asynchronous for that reason.
   *
   * What can be asserted from inside an instrumentation test is the
   * inverse and it is worth pinning: the test's own device-facing calls
   * are NOT on the main looper, and the main looper is alive and
   * responsive after the campaign above has finished with it.
   */
  @Test
  fun theMainLooperIsAliveAndTheseAssertionsAreNotRunningOnIt() {
    assertTrue(
      "instrumentation is running on the main looper, so nothing here could tell a blocked " +
        "main thread from a busy one",
      Looper.myLooper() != Looper.getMainLooper(),
    )

    val mainLooper = Looper.getMainLooper()
    assertTrue("the main looper has gone", mainLooper.thread.isAlive)

    // A round trip through the main looper, proving it is not merely alive
    // but still processing messages.
    val done = java.util.concurrent.CountDownLatch(1)
    android.os.Handler(mainLooper).post { done.countDown() }
    assertTrue(
      "the main looper did not process a posted message within 10 seconds, which is what a " +
        "blocked main thread looks like from outside",
      done.await(10, java.util.concurrent.TimeUnit.SECONDS),
    )
  }

  /**
   * REPEATED SHARED-PREFERENCE CYCLES. The layout-direction bootstrap
   * writes on every Application start; a preference file that grew an
   * editor, a listener or a descriptor per write would leak over a long
   * session.
   */
  @Test
  fun repeatedPreferenceWritesDoNotGrowDescriptors() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    applyDutchLayoutDirection(context)
    settle()
    val baseline = openDescriptors()

    repeat(CYCLES * 4) { applyDutchLayoutDirection(context) }
    settle()
    encourageCollection()

    val now = openDescriptors()
    println("descriptors across ${CYCLES * 4} preference writes: $baseline -> $now")
    if (baseline > 0 && now > 0) {
      assertTrue(
        "open descriptors rose from $baseline to $now across ${CYCLES * 4} preference writes",
        now - baseline <= DESCRIPTOR_DRIFT_ALLOWANCE,
      )
    }
    assertEquals(
      "the repeated writes did not leave the app right-to-left",
      true,
      context.getSharedPreferences(RN_RTL_PREFERENCES, android.content.Context.MODE_PRIVATE)
        .getBoolean(RN_RTL_KEY_FORCE, false),
    )
  }
}
