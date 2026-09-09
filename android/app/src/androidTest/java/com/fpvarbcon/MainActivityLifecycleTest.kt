package com.fpvarbcon

import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE ANDROID LIFECYCLE, EXERCISED ON A REAL DEVICE.
 *
 * None of this is reachable from Jest: react-test-renderer has no Activity,
 * no configuration change and no process. The failures this file is meant
 * to catch are the ones that only exist on Android - an Activity that dies
 * on recreation, a React host that cannot be re-created, state from one
 * launch leaking into the next.
 *
 * ActivityScenario drives the real lifecycle rather than simulating it, and
 * every scenario is closed by `use {}` so one failing case cannot leave an
 * Activity resumed and poison the next.
 *
 * The manifest declares
 *   configChanges="keyboard|keyboardHidden|orientation|screenLayout|
 *                  screenSize|smallestScreenSize|uiMode"
 * so a rotation does NOT recreate this Activity - React Native handles it
 * in-process. `recreate()` below is therefore the stronger test: it forces
 * the destruction/recreation path that a real configuration change outside
 * that list, or a process-level restart, would take.
 */
@RunWith(AndroidJUnit4::class)
class MainActivityLifecycleTest {

  @Test
  fun coldLaunchReachesResumed() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      assertEquals(Lifecycle.State.RESUMED, scenario.state)
      scenario.onActivity { activity ->
        assertFalse("MainActivity finished during cold launch", activity.isFinishing)
        assertNotNull(activity.window)
      }
    }
  }

  @Test
  fun survivesRecreation() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.recreate()
      assertEquals(Lifecycle.State.RESUMED, scenario.state)
      scenario.onActivity { activity ->
        assertFalse("MainActivity finished after recreation", activity.isFinishing)
      }
    }
  }

  /** Two recreations in a row: the second must not inherit the first's state. */
  @Test
  fun survivesRepeatedRecreation() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      repeat(2) {
        scenario.recreate()
        assertEquals(Lifecycle.State.RESUMED, scenario.state)
      }
    }
  }

  /** Background then foreground - the transition a home-press makes. */
  @Test
  fun survivesBackgroundAndForeground() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.moveToState(Lifecycle.State.CREATED)
      assertEquals(Lifecycle.State.CREATED, scenario.state)
      scenario.moveToState(Lifecycle.State.RESUMED)
      assertEquals(Lifecycle.State.RESUMED, scenario.state)
      scenario.onActivity { activity ->
        assertFalse("MainActivity finished on returning to the foreground", activity.isFinishing)
      }
    }
  }

  /**
   * Attempt 2 must not inherit attempt 1. Launching, closing and launching
   * again is the cheapest honest check that nothing static survives a full
   * Activity teardown in a way that breaks the next launch.
   */
  @Test
  fun aSecondLaunchIsIndependentOfTheFirst() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
    }
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      assertEquals(Lifecycle.State.RESUMED, scenario.state)
      scenario.onActivity { activity ->
        assertFalse("the second launch inherited a finishing Activity", activity.isFinishing)
      }
    }
  }

  /**
   * The React host is created lazily by MainApplication and is what every
   * screen renders through. If it cannot be obtained the app is a blank
   * shell, however healthy the Activity looks.
   */
  @Test
  fun reactHostExistsAfterLaunch() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      val application = InstrumentationRegistry.getInstrumentation()
        .targetContext
        .applicationContext as MainApplication
      assertNotNull("MainApplication exposed no ReactHost", application.reactHost)
    }
  }
}
