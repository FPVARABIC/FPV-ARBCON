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
import org.junit.Test
import org.junit.runner.RunWith

/** Dutch first paint, including a device carrying stale RTL preferences. */
@RunWith(AndroidJUnit4::class)
class DutchLayoutDirectionTest {
  private val target: Context = InstrumentationRegistry.getInstrumentation().targetContext
  private val preferences = target.getSharedPreferences(RN_RTL_PREFERENCES, Context.MODE_PRIVATE)

  @After
  fun restoreTheShippedState() = applyDutchLayoutDirection(target)

  private fun assertDutchDirection() {
    assertFalse("Dutch must not force RTL", preferences.getBoolean(RN_RTL_KEY_FORCE, true))
    assertFalse("Dutch must not inherit device RTL", preferences.getBoolean(RN_RTL_KEY_ALLOW, true))
    assertFalse("Dutch surface must be LTR", I18nUtil.instance.isRTL(target))
  }

  @Test
  fun theInstalledAppIsLeftToRight() = assertDutchDirection()

  @Test
  fun aFreshInstallStartsLeftToRight() {
    preferences.edit().clear().commit()
    applyDutchLayoutDirection(target)
    assertDutchDirection()
  }

  @Test
  fun staleArabicPreferencesAreOverriddenBeforeTheFirstSurface() {
    preferences.edit()
      .putBoolean(RN_RTL_KEY_FORCE, true)
      .putBoolean(RN_RTL_KEY_ALLOW, true)
      .commit()
    applyDutchLayoutDirection(target)
    assertDutchDirection()
  }

  @Test
  fun leftToRightSurvivesActivityRecreation() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      assertDutchDirection()
      scenario.recreate()
      assertEquals(Lifecycle.State.RESUMED, scenario.state)
      assertDutchDirection()
      scenario.onActivity { assertFalse(it.isFinishing) }
    }
  }
}
