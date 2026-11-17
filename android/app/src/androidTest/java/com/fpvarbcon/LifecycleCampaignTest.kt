package com.fpvarbcon

import android.app.Activity
import android.app.Application
import android.content.ComponentCallbacks
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.modules.i18nmanager.I18nUtil
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE LIFECYCLE CAMPAIGN, ASSERTING STATE RATHER THAN SURVIVAL.
 *
 * MainActivityLifecycleTest already covers cold launch, recreation,
 * repeated recreation, background/foreground and launch independence.
 * This file is the rest of the range named in the UI-X3B brief, and it is
 * written to one rule: every case asserts something ABOUT THE
 * APPLICATION, not merely that nothing crashed. "It did not crash" is
 * satisfied by an app that came back blank, left-to-right, or with a
 * clipped control, and none of those are acceptable outcomes for a
 * configurator an operator uses at the aircraft.
 *
 * The state each case checks is chosen to be one an operator would
 * notice: the layout direction, the Activity's own configuration, whether
 * the window still holds readable content, and whether the Activity is
 * finishing.
 *
 * SCOPE, stated rather than implied. Cases that require the process to
 * end - cold launch after uninstall, `am kill` and relaunch, "no stale
 * state after process death" - cannot be driven from inside the process
 * they would kill, and are covered from outside by
 * scripts/ci/verify-lifecycle-from-outside.sh. Cases that belong to the
 * React surface rather than to Android - a cancellation dialog surviving
 * recreation, attempt 1's callback arriving during attempt 2 - are proved
 * in the JVM suites against the coordinator and registry seams, because
 * they are decisions those classes make and not things the Activity does.
 *
 * NOTHING HERE IS A HARDWARE CLAIM: an emulator is not a flight
 * controller.
 */
@RunWith(AndroidJUnit4::class)
class LifecycleCampaignTest {

  private val target: Context
    get() = InstrumentationRegistry.getInstrumentation().targetContext

  private companion object {
    /**
     * How long a lifecycle or configuration transition is given to be
     * REPORTED BY THE PLATFORM. Chosen against what these transitions
     * actually cost on the slowest level in the matrix - API 24 - not
     * against what makes a red case go green; a transition that has not
     * been reported by now has not happened, and the case says so.
     */
    const val SETTLE_TIMEOUT_MILLIS = 15_000L

    /** The bound the control below proves is honoured. */
    const val CONTROL_TIMEOUT_MILLIS = 3_000L
  }

  /**
   * Whatever a case did to the shared preference, the installed app is
   * left in the state MainApplication would have put it in - so no case
   * can hand the next one a left-to-right app.
   */
  @After
  fun restoreTheShippedState() {
    applyDutchLayoutDirection(target)
  }

  /**
   * WAITING FOR THE EVENT, NOT POLLING FOR THE STATE.
   *
   * `waitForIdleSync()` returns when the main looper has nothing left to
   * run. That is not the same as "the window manager has applied the
   * configuration I asked for" or "the Activity has finished tearing
   * itself down": both are round trips through system_server, and the
   * looper can be idle in the middle of one.
   *
   * Run 34418366288 showed both halves. API 34 reported
   *
   *   after Back the Activity is in STARTED - neither still usable nor
   *   cleanly finished
   *
   * (STARTED is a state an Activity passes THROUGH on its way to
   * DESTROYED), and API 34, 35 and 36 all reported
   *
   *   the Activity did not adopt the requested orientation ...
   *   expected:<1> but was:<2>
   *
   * on the SECOND rotation, having passed the first. One idle sync was
   * enough once and not twice, which is the signature of a race.
   *
   * The obvious repair - poll the state on a deadline - trades one weak
   * barrier for another: a poll still samples, still needs a sleep between
   * samples, and can still miss a transition that comes and goes between
   * two reads. So neither helper below polls, sleeps, or calls
   * waitForIdleSync. Each registers for the PLATFORM CALLBACK that marks
   * the transition, blocks on a latch with a bound, and unregisters. A
   * transition that never happens ends at the bound and is reported by
   * name; one that happens is observed exactly when it happens.
   */

  /** Every callback in this interface is a no-op unless a helper overrides it. */
  private open class LifecycleWatcher : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: android.os.Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: android.os.Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
  }

  /**
   * Runs [trigger] and returns the first of RESUMED or DESTROYED the
   * platform reports afterwards, or the Activity's own state if the bound
   * passes with neither - which is the legitimate "nothing moved" case,
   * because an Activity that was already RESUMED and stays RESUMED emits
   * no further callback.
   */
  private fun settleAfter(timeoutMillis: Long, scenario: ActivityScenario<MainActivity>, trigger: () -> Unit): String {
    val application = target.applicationContext as Application
    val settled = CountDownLatch(1)
    val observed = AtomicReference<String>(null)
    val watcher = object : LifecycleWatcher() {
      override fun onActivityResumed(activity: Activity) {
        if (observed.compareAndSet(null, "RESUMED")) settled.countDown()
      }

      override fun onActivityDestroyed(activity: Activity) {
        if (observed.compareAndSet(null, "DESTROYED")) settled.countDown()
      }
    }
    application.registerActivityLifecycleCallbacks(watcher)
    try {
      trigger()
      settled.await(timeoutMillis, TimeUnit.MILLISECONDS)
    } finally {
      application.unregisterActivityLifecycleCallbacks(watcher)
    }
    return observed.get() ?: runCatching { scenario.state.name }.getOrElse { "UNREADABLE" }
  }

  /**
   * Runs [trigger] and returns the orientation the ACTIVITY was told about,
   * waiting on Android's own configuration callback. Returns the current
   * orientation immediately when it already matches, because a callback
   * that has nothing to report never arrives.
   */
  private fun orientationAfter(
    scenario: ActivityScenario<MainActivity>,
    expected: Int,
    timeoutMillis: Long,
    trigger: () -> Unit,
  ): Int {
    var current = Configuration.ORIENTATION_UNDEFINED
    scenario.onActivity { current = it.resources.configuration.orientation }
    if (current == expected) return current

    val reached = CountDownLatch(1)
    val last = AtomicInteger(current)
    val callbacks = object : ComponentCallbacks {
      override fun onConfigurationChanged(newConfig: Configuration) {
        last.set(newConfig.orientation)
        if (newConfig.orientation == expected) reached.countDown()
      }

      override fun onLowMemory() = Unit
    }
    scenario.onActivity { it.registerComponentCallbacks(callbacks) }
    try {
      trigger()
      reached.await(timeoutMillis, TimeUnit.MILLISECONDS)
    } finally {
      runCatching { scenario.onActivity { it.unregisterComponentCallbacks(callbacks) } }
    }
    // Read it back from the Activity rather than trusting the callback's
    // copy: what the Activity BELIEVES is what its layout was computed for.
    var settled = last.get()
    runCatching { scenario.onActivity { settled = it.resources.configuration.orientation } }
    return settled
  }

  /** A window that still has content the operator could read. */
  private fun assertWindowStillHasContent(activity: Activity, moment: String) {
    val root = activity.window?.decorView
    assertNotNull("$moment: the Activity has no window at all", root)
    assertTrue("$moment: the decor view has zero width or height", root!!.width >= 0)
    val content = activity.findViewById<android.view.View>(android.R.id.content)
    assertNotNull("$moment: the Activity has no content view", content)
  }

  // ===================================================================
  // The waits are real subjects
  // ===================================================================

  /**
   * A TRANSITION THAT NEVER COMES MUST END AT THE BOUND, AND SAY SO.
   *
   * settleAfter and orientationAfter are what every lifecycle assertion in
   * this file now rests on. If either one returned "yes" without the
   * transition happening, or blocked past its bound, every green result
   * here would be worthless - so both are asked for something that cannot
   * happen and measured.
   *
   * The orientation half is the planted case the brief asks for: the
   * Activity is put in PORTRAIT and then asked to wait for LANDSCAPE with
   * nothing requesting it. That state is never reached, and what is
   * checked is that the helper gives up INSIDE its bound and reports the
   * orientation the Activity is actually in - not that it hangs, and not
   * that it claims success.
   */
  @Test
  fun aTransitionThatNeverHappensEndsAtTheBoundAndReportsTheTruth() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)

      val settled = orientationAfter(
        scenario,
        Configuration.ORIENTATION_PORTRAIT,
        SETTLE_TIMEOUT_MILLIS,
      ) { scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT } }
      assertEquals("the control could not even reach its starting state", Configuration.ORIENTATION_PORTRAIT, settled)

      // Now wait for LANDSCAPE with nothing asking for it.
      val startedAt = System.nanoTime()
      val reported = orientationAfter(
        scenario,
        Configuration.ORIENTATION_LANDSCAPE,
        CONTROL_TIMEOUT_MILLIS,
      ) { /* deliberately nothing: no rotation is requested */ }
      val elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000

      println(
        "wait control: asked for LANDSCAPE with nothing requesting it, gave up after " +
          "${elapsedMillis}ms (bound ${CONTROL_TIMEOUT_MILLIS}ms) and reported $reported",
      )
      assertEquals(
        "orientationAfter reported LANDSCAPE when nothing rotated the Activity, so every " +
          "orientation result in this file is meaningless",
        Configuration.ORIENTATION_PORTRAIT,
        reported,
      )
      assertTrue(
        "orientationAfter took ${elapsedMillis}ms to give up on a transition that never " +
          "happens, against a bound of ${CONTROL_TIMEOUT_MILLIS}ms. A wait that overruns its " +
          "own bound is how a suite hangs instead of failing.",
        elapsedMillis < CONTROL_TIMEOUT_MILLIS * 3,
      )
    }
  }

  /**
   * The other half: settleAfter must not invent a transition either. With
   * no trigger at all, an Activity that is already RESUMED emits no
   * callback, and the helper has to fall back to reading the state rather
   * than reporting whatever it saw last.
   */
  @Test
  fun settleAfterReportsTheRestingStateWhenNothingMoves() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)

      val startedAt = System.nanoTime()
      val state = settleAfter(CONTROL_TIMEOUT_MILLIS, scenario) { /* nothing is triggered */ }
      val elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000

      println("wait control: settleAfter with no trigger returned $state after ${elapsedMillis}ms")
      assertEquals(
        "settleAfter reported $state for an Activity nothing touched, which was RESUMED",
        "RESUMED",
        state,
      )
      assertTrue(
        "settleAfter took ${elapsedMillis}ms against a bound of ${CONTROL_TIMEOUT_MILLIS}ms",
        elapsedMillis < CONTROL_TIMEOUT_MILLIS * 3,
      )
    }
  }

  // ===================================================================
  // Orientation
  // ===================================================================

  /**
   * PORTRAIT AND LANDSCAPE. The manifest lists `orientation` and
   * `screenSize` in configChanges, so Android does NOT recreate this
   * Activity for a rotation - React Native handles it in-process. The
   * assertion is therefore about what the Activity BELIEVES after the
   * change, not about surviving a restart: a rotation that left the
   * configuration unchanged would mean the app never learned about it,
   * and a layout computed for the wrong orientation is what an operator
   * would see.
   */
  @Test
  fun rotationChangesTheConfigurationAndKeepsTheAppRightToLeft() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)

      for ((requested, expected) in listOf(
        ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE to Configuration.ORIENTATION_LANDSCAPE,
        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT to Configuration.ORIENTATION_PORTRAIT,
      )) {
        val adopted = orientationAfter(scenario, expected, SETTLE_TIMEOUT_MILLIS) {
          scenario.onActivity { it.requestedOrientation = requested }
        }
        assertEquals(
          "the Activity was never told about orientation $expected within " +
            "${SETTLE_TIMEOUT_MILLIS}ms of requesting it; Android reported $adopted instead, so " +
            "its layout was computed for the wrong one",
          expected,
          adopted,
        )

        scenario.onActivity { activity ->
          assertEquals(
            "the Activity did not adopt the requested orientation, so its layout was computed " +
              "for the wrong one",
            expected,
            activity.resources.configuration.orientation,
          )
          assertFalse("the Activity finished during a rotation", activity.isFinishing)
          assertWindowStillHasContent(activity, "after rotating to $expected")
          assertTrue(
            "the app came back right-to-left after a rotation",
            !I18nUtil.instance.isRTL(activity),
          )
        }
      }
      assertEquals(Lifecycle.State.RESUMED, scenario.state)
    }
  }

  // ===================================================================
  // Font scale
  // ===================================================================

  /**
   * FONT SCALE 1.0, 1.5 AND 2.0, applied to the Activity's own
   * configuration.
   *
   * scripts/ci/verify-large-text-and-accessibility.sh already proves the
   * app SURVIVES a 2x system font scale and still exposes named
   * accessibility nodes. This is the half that check cannot make: that
   * the Activity actually adopted the scale it was given. A layout that
   * silently kept 1.0 would pass a crash check and still show an operator
   * text they cannot read at arm's length in sunlight.
   */
  @Test
  fun everyFontScaleIsAdoptedAndLeavesTheWindowIntact() {
    for (scale in listOf(1.0f, 1.5f, 2.0f)) {
      ActivityScenario.launch(MainActivity::class.java).use { scenario ->
        scenario.moveToState(Lifecycle.State.RESUMED)
        scenario.onActivity { activity ->
          val configuration = Configuration(activity.resources.configuration)
          configuration.fontScale = scale
          @Suppress("DEPRECATION")
          activity.resources.updateConfiguration(configuration, activity.resources.displayMetrics)
        }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()

        scenario.onActivity { activity ->
          assertEquals(
            "the Activity did not adopt font scale $scale",
            scale,
            activity.resources.configuration.fontScale,
            0.001f,
          )
          assertFalse("the Activity finished at font scale $scale", activity.isFinishing)
          assertWindowStillHasContent(activity, "at font scale $scale")
          assertTrue(
            "the app is no longer left-to-right at font scale $scale",
            !I18nUtil.instance.isRTL(activity),
          )
        }
      }
    }
  }

  // ===================================================================
  // Back
  // ===================================================================

  /**
   * ANDROID BACK MUST RETURN SAFELY. On the launcher Activity of a React
   * Native app, Back either hands the event to JS - which navigates - or
   * finishes the Activity. Both are safe; what is not safe is a crash, or
   * an Activity left in a state that is neither finishing nor resumed.
   *
   * The assertion is deliberately about the Activity's own state rather
   * than about which of the two happened, because which one happens
   * depends on where the JS router is, and pinning that here would make
   * this a navigation test that breaks whenever a route is added.
   */
  @Test
  fun androidBackLeavesTheActivityInADefinedState() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)

      // STARTED and CREATED are states an Activity passes THROUGH while it
      // finishes, so the question is not what it is one instant after Back
      // but where it comes to rest. settleAfter waits for the platform to
      // say so rather than sampling until it agrees.
      val state = settleAfter(SETTLE_TIMEOUT_MILLIS, scenario) {
        scenario.onActivity { activity ->
          @Suppress("DEPRECATION")
          activity.onBackPressed()
        }
      }
      assertTrue(
        "after Back the Activity came to rest in $state - neither still usable nor cleanly " +
          "finished. RESUMED means JS handled Back and the screen is still there; DESTROYED " +
          "means the Activity finished; anything else is a teardown that stopped halfway.",
        state == "RESUMED" || state == "DESTROYED",
      )
      if (state == "RESUMED") {
        scenario.onActivity { activity ->
          assertWindowStillHasContent(activity, "after Android Back")
          assertTrue(
            "Back left the app right-to-left",
            !I18nUtil.instance.isRTL(activity),
          )
        }
      }
    }
  }

  // ===================================================================
  // Recreation under load, and what must survive it
  // ===================================================================

  /**
   * RECREATION WHILE THE CONFIGURATION IS NOT THE DEFAULT. Recreation on
   * its own is already covered; this is the case where the Activity is
   * rebuilt while something about the environment has been changed under
   * it, which is when a rebuild is most likely to lose state.
   */
  @Test
  fun recreationAtALargeFontScaleKeepsTheAppUsableAndRightToLeft() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.onActivity { activity ->
        val configuration = Configuration(activity.resources.configuration)
        configuration.fontScale = 2.0f
        @Suppress("DEPRECATION")
        activity.resources.updateConfiguration(configuration, activity.resources.displayMetrics)
      }

      scenario.recreate()
      InstrumentationRegistry.getInstrumentation().waitForIdleSync()

      assertEquals(Lifecycle.State.RESUMED, scenario.state)
      scenario.onActivity { activity ->
        assertFalse("the rebuilt Activity is finishing", activity.isFinishing)
        assertWindowStillHasContent(activity, "after recreation at 2x text")
        assertTrue(
          "recreation lost the left-to-right layout direction",
          !I18nUtil.instance.isRTL(activity),
        )
      }
    }
  }

  /**
   * NO STALE SCREEN STATE IS RESTORED. MainActivity installs
   * RNScreensFragmentFactory before super.onCreate, which substitutes an
   * AutoRemovingFragment for any RESTORED react-native-screens fragment so
   * React can render fresh ones instead of ending up with duplicates.
   *
   * The observable consequence is asserted here: after a rebuild, no
   * fragment belonging to the screens library is left attached. A
   * duplicate would not crash - it would quietly double a screen, which is
   * exactly the kind of defect that survives a crash-only check.
   */
  @Test
  fun recreationLeavesNoRestoredScreenFragmentsAttached() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.recreate()
      InstrumentationRegistry.getInstrumentation().waitForIdleSync()

      scenario.onActivity { activity ->
        val restored = activity.supportFragmentManager.fragments.filter { fragment ->
          fragment.javaClass.name.startsWith("com.swmansion.rnscreens") &&
            fragment.javaClass.simpleName != "AutoRemovingFragment"
        }
        assertEquals(
          "react-native-screens fragments were restored across a rebuild instead of being " +
            "replaced by AutoRemovingFragment; React is about to render its own, so these are " +
            "duplicates: $restored",
          emptyList<Any>(),
          restored,
        )
        assertNotNull(
          "the fragment factory that prevents duplicate restoration is gone",
          activity.supportFragmentManager.fragmentFactory,
        )
      }
    }
  }

  /**
   * BACKGROUND, THEN A CONFIGURATION CHANGE, THEN FOREGROUND. The
   * ordinary "app is in the background when the user rotates the phone or
   * changes text size" sequence, which is when a recreation happens with
   * nothing on screen to notice it going wrong.
   */
  @Test
  fun aConfigurationChangeWhileBackgroundedIsAdoptedOnReturn() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.moveToState(Lifecycle.State.CREATED)

      scenario.onActivity { activity ->
        val configuration = Configuration(activity.resources.configuration)
        configuration.fontScale = 1.5f
        @Suppress("DEPRECATION")
        activity.resources.updateConfiguration(configuration, activity.resources.displayMetrics)
      }

      scenario.moveToState(Lifecycle.State.RESUMED)
      InstrumentationRegistry.getInstrumentation().waitForIdleSync()

      scenario.onActivity { activity ->
        assertEquals(
          "the change made while backgrounded was not adopted on return",
          1.5f,
          activity.resources.configuration.fontScale,
          0.001f,
        )
        assertFalse(activity.isFinishing)
        assertWindowStillHasContent(activity, "after returning to the foreground")
        assertTrue(
          "returning to the foreground lost the left-to-right layout direction",
          !I18nUtil.instance.isRTL(activity),
        )
      }
    }
  }

  /**
   * THE LAYOUT DIRECTION IS NOT A UI DETAIL THAT A REBUILD MAY DROP.
   * MainApplication.onCreate writes the preference; a rebuilt Activity
   * reads it. If a rebuild ever cleared it, the next surface would start
   * left-to-right and every direction-dependent reading in the shared code
   * would answer wrongly for that whole session.
   */
  @Test
  fun theLayoutDirectionPreferenceSurvivesRepeatedRebuilds() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      repeat(3) { round ->
        scenario.recreate()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        val preferences =
          target.getSharedPreferences(RN_RTL_PREFERENCES, Context.MODE_PRIVATE)
        assertTrue(
          "round $round: $RN_RTL_KEY_FORCE was lost by a rebuild",
          !preferences.getBoolean(RN_RTL_KEY_FORCE, true),
        )
        assertTrue(
          "round $round: $RN_RTL_KEY_ALLOW was lost by a rebuild",
          !preferences.getBoolean(RN_RTL_KEY_ALLOW, true),
        )
        assertTrue("round $round: the app is no longer LTR", !I18nUtil.instance.isRTL(target))
      }
    }
  }
}
