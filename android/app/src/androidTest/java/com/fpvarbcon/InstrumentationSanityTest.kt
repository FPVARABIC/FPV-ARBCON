package com.fpvarbcon

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE LANE ITSELF, PROVED BEFORE ANYTHING IS BLAMED ON THE APP.
 *
 * This file launches nothing. It only asserts that instrumentation is
 * really running on a device against the real application package. That
 * separation is the point: if these pass and a launch test fails, the
 * failure is about the app; if these fail, the emulator lane is broken and
 * no other instrumentation result in the run means anything.
 *
 * It also guards the emptiest possible false positive - a connected-test
 * task that reports success having executed zero tests. The CI job asserts
 * a non-zero executed count separately, and this class is what makes that
 * count meaningful even when every other test is filtered out.
 *
 * NOTHING HERE IS A HARDWARE CLAIM: an emulator is not a flight controller.
 */
@RunWith(AndroidJUnit4::class)
class InstrumentationSanityTest {

  @Test
  fun instrumentationHasBothContexts() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    assertNotNull("no Instrumentation registered", instrumentation)
    assertNotNull("no target (app under test) context", instrumentation.targetContext)
    assertNotNull("no test context", instrumentation.context)
  }

  @Test
  fun targetsTheRealApplicationPackage() {
    val target = InstrumentationRegistry.getInstrumentation().targetContext
    assertEquals("com.fpvarbcon", target.packageName)
  }

  /**
   * The test APK and the app APK must be distinct packages; if they were
   * the same, "the app under test" would be the test harness itself.
   */
  @Test
  fun testPackageIsNotTheApplicationPackage() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    assertNotEquals(
      instrumentation.context.packageName,
      instrumentation.targetContext.packageName,
    )
  }

  @Test
  fun applicationClassIsTheProductApplication() {
    val target = InstrumentationRegistry.getInstrumentation().targetContext
    val application = target.applicationContext
    assertEquals(
      "the app under test is not MainApplication",
      MainApplication::class.java.name,
      application.javaClass.name,
    )
  }
}
