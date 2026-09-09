package com.fpvarbcon

import android.content.Context
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.modules.i18nmanager.I18nUtil
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE FIRST LAUNCH, NOT THE SECOND.
 *
 * An Arabic-first configurator that renders its first session
 * left-to-right and every session after that right-to-left is not
 * "mostly correct" - it is wrong exactly once per install, which is the
 * one time an operator has no prior expectation to correct it against.
 *
 * Jest cannot reach this: the whole mechanism is an Android
 * SharedPreference read by native code at surface start. So it lives
 * here, on a device, where the preference and I18nUtil are real.
 *
 * NOTHING HERE IS A HARDWARE CLAIM: an emulator is not a flight
 * controller.
 */
@RunWith(AndroidJUnit4::class)
class ArabicLayoutDirectionTest {

  private val target: Context = InstrumentationRegistry.getInstrumentation().targetContext
  private val preferences = target.getSharedPreferences(RN_RTL_PREFERENCES, Context.MODE_PRIVATE)

  /**
   * Whatever a case did to the preference, the installed app is left in
   * the state MainApplication would have put it in. Taken after every
   * case, including a failing one, so no case can hand the next a
   * left-to-right app.
   */
  @After
  fun restoreTheShippedState() {
    applyArabicLayoutDirection(target)
  }

  /** The installed app, as it stands, is right-to-left. */
  @Test
  fun theInstalledAppIsRightToLeft() {
    assertTrue(
      "I18nUtil reports the app is not RTL, so the surface would be laid out left-to-right",
      I18nUtil.instance.isRTL(target),
    )
  }

  /**
   * The fresh-install case, built rather than assumed. Clearing React
   * Native's own preference file IS what a first install looks like to
   * I18nUtil, and the assertion in the middle is what stops this passing
   * vacuously if the clear ever silently stops working.
   *
   * This is deliberately asserted on the preference rather than on
   * I18nUtil.isRTL alone: isRTL also consults
   * `Locale.getAvailableLocales()[0]`, whose value is not specified by
   * the platform, so a cleared-state isRTL assertion would be resting on
   * something no contract guarantees.
   */
  @Test
  fun theBootstrapMakesAFreshInstallRightToLeft() {
    preferences.edit().clear().commit()
    assertFalse(
      "the fixture is not a fresh install: the forceRTL preference survived a clear",
      preferences.getBoolean(RN_RTL_KEY_FORCE, false),
    )

    applyArabicLayoutDirection(target)

    assertTrue(
      "MainApplication's bootstrap did not persist forceRTL, so the next fresh " +
        "install would render its first session left-to-right",
      preferences.getBoolean(RN_RTL_KEY_FORCE, false),
    )
    assertTrue(
      "the bootstrap did not persist allowRTL",
      preferences.getBoolean(RN_RTL_KEY_ALLOW, false),
    )
    assertTrue(
      "a fresh install would still not be RTL after the bootstrap ran",
      I18nUtil.instance.isRTL(target),
    )
  }

  /**
   * A configuration change that destroys and rebuilds the Activity must
   * not land the operator in a left-to-right session. The manifest's
   * configChanges list means a rotation does NOT recreate this Activity,
   * so recreate() is the stronger path: it forces the destruction and
   * rebuild that a change outside that list, or a process-level restart,
   * would take.
   *
   * The fresh-install and process-relaunch halves of this claim cannot be
   * made from inside the app process at all - MainApplication.onCreate
   * has already run by the time this class is loaded. They are proved
   * separately, from outside, by scripts/ci/verify-rtl-cold-launch.sh.
   */
  @Test
  fun rightToLeftSurvivesActivityRecreation() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      assertTrue("the app was not RTL before recreation", I18nUtil.instance.isRTL(target))

      scenario.recreate()

      assertEquals(Lifecycle.State.RESUMED, scenario.state)
      assertTrue("Activity recreation left the app laying out left-to-right", I18nUtil.instance.isRTL(target))
      scenario.onActivity { activity ->
        assertFalse("MainActivity finished during recreation", activity.isFinishing)
      }
    }
  }

  /**
   * FLAG_SUPPORTS_RTL is a precondition of the whole mechanism -
   * I18nUtil.isRTL returns false without it however the preferences are
   * set - so it is worth failing here, with that reason named, rather
   * than only as a manifest assertion elsewhere.
   */
  @Test
  fun rightToLeftCannotBeDefeatedByAMissingManifestFlag() {
    preferences.edit()
      .putBoolean(RN_RTL_KEY_FORCE, true)
      .putBoolean(RN_RTL_KEY_ALLOW, true)
      .commit()
    assertTrue(
      "forceRTL is set and I18nUtil still reports LTR, which means the merged " +
        "manifest lost android:supportsRtl",
      I18nUtil.instance.isRTL(target),
    )
  }
}
