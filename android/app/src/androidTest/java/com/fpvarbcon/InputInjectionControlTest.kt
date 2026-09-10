package com.fpvarbcon

import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * WHY THE PRESSES IN THIS SUITE ARE INJECTED THE WAY THEY ARE.
 *
 * Run 34418366288 failed seven cases on API 34 and seven on API 36 with one
 * message, identical on both:
 *
 *   java.lang.IllegalArgumentException: Targeted input event injection from
 *   pid 5448 was not directed at a window owned by uid 10216.
 *
 * The repair was to inject through UiAutomation instead of through
 * Instrumentation.sendPointerSync. A repair chosen from an error message is
 * a guess until the device says so, and a suite whose presses might not be
 * arriving is worse than no suite at all - every "the screen opened"
 * assertion in it would be vacuous.
 *
 * So this file is the control, and it runs on every API level in the matrix:
 *
 *   NEGATIVE (mechanism)  the old path, at the same coordinate, must still
 *                         be rejected - if it is not, the cause blamed in
 *                         the comment above is not the cause, and this test
 *                         says so instead of letting a comment stand.
 *
 *   POSITIVE (delivery)   the new path must make the APPLICATION move: the
 *                         firmware screen has to appear. Nothing short of
 *                         the app responding counts as a delivered press.
 *
 *   MUTATION (attribution) without the press, that screen must NOT appear.
 *                         Otherwise the positive result above would be a
 *                         coincidence of timing rather than a consequence
 *                         of the touch.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
@RunWith(AndroidJUnit4::class)
class InputInjectionControlTest {

  private companion object {
    const val START = "start-screen"
    const val CONTROL = "start-firmware"
    const val DESTINATION = "firmware-flasher-screen"

    /**
     * How long the mutation control waits for a screen it expects never to
     * see. The positive control below reaches the same screen well inside
     * this, so a screen that has not appeared by now did not appear because
     * of anything this test did.
     */
    const val MUST_NOT_APPEAR_MILLIS = 8_000L
  }

  @Test
  fun theTargetedInjectionPathIsStillRejectedAtTheSameCoordinate() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.awaitTag(CONTROL)

      val centre = scenario.centreOfTag(CONTROL)
      val atControl = probeTargetedInjection(centre[0], centre[1])
      val bounds = scenario.displayBounds()
      val atStatusBar = probeTargetedInjection((bounds.width() / 2).toFloat(), 1f)

      println("===== UI-X3B INPUT INJECTION CONTROL =====")
      println("  control \"$CONTROL\" centre  : ${centre[0]}, ${centre[1]}")
      println("  display bounds             : $bounds")
      println("  sendPointerSync at control : $atControl")
      println("  sendPointerSync at y=1     : $atStatusBar")
      println("  ${activeWindowReport()}")
      println("==========================================")

      assertTrue(
        "Instrumentation.sendPointerSync was ACCEPTED at the control's own centre. The seven " +
          "failures in run 34418366288 were blamed on targeted injection being rejected there, " +
          "and that has not reproduced - so the reason recorded in UiTree.kt is wrong and the " +
          "real one is still unknown. Probe at the control: $atControl. Probe at y=1: " +
          "$atStatusBar. On screen: ${activeWindowReport()}",
        atControl.startsWith("REJECTED"),
      )
      assertTrue(
        "sendPointerSync was rejected, but not by the window-ownership check this repair is " +
          "based on. Message: $atControl",
        atControl.contains("Targeted input event injection"),
      )

      // The rejected injection must also have changed nothing: a rejection
      // that still delivered the press would make the mutation control
      // below untrustworthy.
      assertFalse(
        "the rejected injection still opened $DESTINATION",
        scenario.hasTag(DESTINATION),
      )
    }
  }

  @Test
  fun theUntargetedInjectionPathMakesTheApplicationMove() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.awaitTag(CONTROL)

      val started = SystemClock.uptimeMillis()
      scenario.tapTag(CONTROL)
      scenario.awaitTag(DESTINATION)
      println(
        "positive control: pressing \"$CONTROL\" opened \"$DESTINATION\" in " +
          "${SystemClock.uptimeMillis() - started}ms",
      )
    }
  }

  @Test
  fun withoutThePressThatScreenNeverAppears() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.awaitTag(CONTROL)

      val deadline = SystemClock.uptimeMillis() + MUST_NOT_APPEAR_MILLIS
      var appeared = false
      while (SystemClock.uptimeMillis() < deadline) {
        if (scenario.hasTag(DESTINATION)) {
          appeared = true
          break
        }
        SystemClock.sleep(100)
      }
      println(
        "mutation control: after ${MUST_NOT_APPEAR_MILLIS}ms with no press, " +
          "\"$DESTINATION\" present = $appeared",
      )
      assertFalse(
        "\"$DESTINATION\" appeared without anything pressing \"$CONTROL\", so every test in " +
          "this suite that concludes a press worked from that screen appearing is measuring " +
          "nothing",
        appeared,
      )
      assertTrue("the start screen went away on its own", scenario.hasTag(START))
    }
  }
}
