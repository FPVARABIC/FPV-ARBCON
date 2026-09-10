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
 *   NEGATIVE (mechanism)  the old path must still be rejected by the
 *                         ownership check SOMEWHERE on this device - at the
 *                         control's own centre or at the status-bar strip.
 *                         If it bites nowhere, the cause blamed in the
 *                         comment above is not established on this API
 *                         level and this test says so instead of letting a
 *                         comment stand. It is not asserted at every
 *                         coordinate, because run 34418366288 itself shows
 *                         some taps going through.
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

      // WHAT IS ASSERTED, AND WHY IT IS NOT "ALWAYS REJECTED".
      //
      // Run 34418366288 rejected fourteen injections across three API
      // levels - and on API 35 and API 34 the tap in
      // theWorkspaceStaysLockedWithoutABoard went through. So the honest
      // claim is that the ownership check EXISTS AND BITES, not that it
      // bites at every coordinate; asserting the stronger version would be
      // asserting something that run already contradicts.
      //
      // Both probes are printed verbatim either way, so the transcript
      // shows exactly where it bit on this device rather than a verdict.
      val rejections = listOf(atControl, atStatusBar).filter { it.startsWith("REJECTED") }
      assertTrue(
        "Instrumentation.sendPointerSync was ACCEPTED at BOTH the control's own centre and at " +
          "y=1, so the targeted-injection ownership check did not bite anywhere on this device. " +
          "That is the mechanism the repair in UiTree.kt is based on, and it has not reproduced " +
          "here - the reason recorded there is therefore not established on this API level. " +
          "Probe at the control: $atControl. Probe at y=1: $atStatusBar. " +
          "On screen: ${activeWindowReport()}",
        rejections.isNotEmpty(),
      )
      assertTrue(
        "sendPointerSync was rejected, but not by the window-ownership check this repair is " +
          "based on. Probe at the control: $atControl. Probe at y=1: $atStatusBar",
        rejections.any { it.contains("Targeted input event injection") },
      )

      // Whatever the probes did, they must not have navigated: a probe
      // that delivered a press would make the mutation control untrustworthy.
      assertFalse(
        "a bare ACTION_DOWN probe opened $DESTINATION, so the presses in this suite are not the " +
          "only thing moving the application",
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
