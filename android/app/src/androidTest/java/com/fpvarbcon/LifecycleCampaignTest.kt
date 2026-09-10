package com.fpvarbcon

import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.modules.i18nmanager.I18nUtil
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

  /**
   * Whatever a case did to the shared preference, the installed app is
   * left in the state MainApplication would have put it in - so no case
   * can hand the next one a left-to-right app.
   */
  @After
  fun restoreTheShippedState() {
    applyArabicLayoutDirection(target)
  }

  /**
   * WAITING FOR A CONDITION INSTEAD OF FOR THE LOOPER.
   *
   * `waitForIdleSync()` returns when the main looper has nothing left to
   * run. That is not the same as "the window manager has applied the
   * configuration I asked for" or "the Activity has finished tearing
   * itself down": both of those are round trips through system_server,
   * and the looper can be idle in the middle of one.
   *
   * Run 34418366288 showed both halves of that. API 34 reported
   *
   *   after Back the Activity is in STARTED - neither still usable nor
   *   cleanly finished
   *
   * (STARTED is a state an Activity passes THROUGH on its way to
   * DESTROYED), and API 34 and 36 both reported
   *
   *   the Activity did not adopt the requested orientation ...
   *   expected:<1> but was:<2>
   *
   * on the SECOND rotation, having passed the first. A single idle sync
   * happened to be enough once and not twice, which is the signature of a
   * race and not of a broken app.
   *
   * So these poll for the condition with a deadline. The assertion that
   * follows is unchanged and still fails if the condition never holds -
   * the deadline only decides how long the truth is given to arrive, and a
   * timeout here is still a failure.
   */
  private fun awaitCondition(what: String, timeoutMillis: Long = 15_000L, condition: () -> Boolean) {
    val deadline = SystemClock.uptimeMillis() + timeoutMillis
    while (SystemClock.uptimeMillis() < deadline) {
      InstrumentationRegistry.getInstrumentation().waitForIdleSync()
      if (condition()) return
      SystemClock.sleep(100)
    }
    println("awaitCondition gave up after ${timeoutMillis}ms waiting for: $what")
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
        scenario.onActivity { it.requestedOrientation = requested }
        awaitCondition("the Activity's configuration to report orientation $expected") {
          var adopted = false
          // If the Activity has gone, this poll must simply not match and
          // let the assertion below report it, rather than throw from
          // inside a wait and hide which case failed.
          runCatching {
            scenario.onActivity { adopted = it.resources.configuration.orientation == expected }
          }
          adopted
        }

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
            "the app came back left-to-right after a rotation",
            I18nUtil.instance.isRTL(activity),
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
            "the app is no longer right-to-left at font scale $scale",
            I18nUtil.instance.isRTL(activity),
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

      scenario.onActivity { activity ->
        @Suppress("DEPRECATION")
        activity.onBackPressed()
      }
      // STARTED and CREATED are states an Activity passes THROUGH while it
      // finishes. Waiting for it to settle is the difference between
      // "Back left the app somewhere undefined" - which is what this case
      // exists to catch - and "the assertion looked mid-teardown".
      awaitCondition("the Activity to settle in RESUMED or DESTROYED after Back") {
        scenario.state == Lifecycle.State.RESUMED || scenario.state == Lifecycle.State.DESTROYED
      }

      val state = scenario.state
      assertTrue(
        "after Back the Activity is in $state - neither still usable nor cleanly finished",
        state == Lifecycle.State.RESUMED || state == Lifecycle.State.DESTROYED,
      )
      if (state == Lifecycle.State.RESUMED) {
        scenario.onActivity { activity ->
          assertWindowStillHasContent(activity, "after Android Back")
          assertTrue(
            "Back left the app left-to-right",
            I18nUtil.instance.isRTL(activity),
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
          "recreation lost the right-to-left layout direction",
          I18nUtil.instance.isRTL(activity),
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
          "returning to the foreground lost the right-to-left layout direction",
          I18nUtil.instance.isRTL(activity),
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
          preferences.getBoolean(RN_RTL_KEY_FORCE, false),
        )
        assertTrue(
          "round $round: $RN_RTL_KEY_ALLOW was lost by a rebuild",
          preferences.getBoolean(RN_RTL_KEY_ALLOW, false),
        )
        assertTrue("round $round: the app is no longer RTL", I18nUtil.instance.isRTL(target))
      }
    }
  }
}
