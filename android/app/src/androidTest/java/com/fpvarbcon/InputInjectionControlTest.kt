package com.fpvarbcon

import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
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

  /**
   * THE FOUR THINGS A PRESS HAS TO ESTABLISH.
   *
   * "The screen changed after I injected an event" is not proof that the
   * press worked - the screen could have changed for any reason, and the
   * event could have gone anywhere. So all four are recorded:
   *
   *   1  it entered the right WINDOW      the active window belongs to
   *                                       com.fpvarbcon, not the launcher
   *                                       and not a system dialog
   *   2  it reached the right VIEW        the topmost drawn view at the
   *                                       coordinate is the control, or is
   *                                       inside it
   *   3  the platform ACCEPTED it         both injections returned true
   *   4  a PRODUCTION state changed       the firmware screen appeared,
   *                                       which is the app's own navigation
   *                                       and not something this test set
   *
   * Nothing in this file calls a React handler, a navigation method or
   * performClick. The only thing done to the application is two
   * MotionEvents put into InputDispatcher at a coordinate - which is why
   * theSamePressDoesNothingWhenTheControlIsCovered can exist at all.
   */
  @Test
  fun theUntargetedInjectionPathMakesTheApplicationMove() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.awaitTag(CONTROL)

      val started = SystemClock.uptimeMillis()
      val evidence = scenario.tapTagWithEvidence(CONTROL)
      println("positive control: $evidence")

      assertEquals(
        "the press went into a window owned by ${evidence.activeWindowPackage}, not the " +
          "application. Whatever it did, it did not press this control. ${activeWindowReport()}",
        "com.fpvarbcon",
        evidence.activeWindowPackage,
      )
      assertTrue(
        "at (${evidence.x}, ${evidence.y}) the topmost drawn view was " +
          "\"${evidence.topmostTagAtPoint}\", which is neither \"$CONTROL\" nor inside it, so " +
          "the coordinate was not on the control",
        evidence.landedOnTarget,
      )
      assertTrue(
        "UiAutomation refused the events: down=${evidence.downAccepted} up=${evidence.upAccepted}",
        evidence.downAccepted && evidence.upAccepted,
      )

      scenario.awaitTag(DESTINATION)
      println(
        "positive control: pressing \"$CONTROL\" opened \"$DESTINATION\" in " +
          "${SystemClock.uptimeMillis() - started}ms",
      )
    }
  }

  /**
   * THE SAME PRESS, THE SAME COORDINATE, SOMETHING ELSE ON TOP.
   *
   * withoutThePressThatScreenNeverAppears already shows the screen does not
   * open on its own. This is the stronger half: it presses the exact
   * coordinate that just worked, with a clickable view covering the
   * content, and requires nothing to happen.
   *
   * Occluding rather than moving the coordinate is deliberate. Pressing
   * somewhere else would leave open the possibility that the coordinate was
   * never what mattered; pressing the SAME point and getting a different
   * outcome can only be explained by what was under it.
   *
   * The occluder is removed afterwards and the press is repeated to show
   * the screen still opens - so a failure here is about occlusion and not
   * about the app having been left broken.
   */
  @Test
  fun theSamePressDoesNothingWhenTheControlIsCovered() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.awaitTag(CONTROL)
      val centre = scenario.centreOfTag(CONTROL)

      val whileCovered = scenario.withContentOccluded {
        tapAt(centre[0], centre[1])
        val deadline = SystemClock.uptimeMillis() + MUST_NOT_APPEAR_MILLIS
        var appeared = false
        while (SystemClock.uptimeMillis() < deadline) {
          if (scenario.hasTag(DESTINATION)) {
            appeared = true
            break
          }
          SystemClock.sleep(100)
        }
        appeared
      }

      println(
        "occlusion control: pressed (${centre[0]}, ${centre[1]}) with the content covered, " +
          "\"$DESTINATION\" present = $whileCovered",
      )
      assertFalse(
        "pressing (${centre[0]}, ${centre[1]}) opened \"$DESTINATION\" while a clickable view " +
          "covered the entire content. The press is therefore not reaching the application " +
          "through the view under the coordinate, and every result in this suite that concludes " +
          "\"the control was pressed\" is measuring something else.",
        whileCovered,
      )

      // And with the cover gone the same coordinate still works, so the
      // result above is about the occluder and not about a broken app.
      scenario.awaitTag(CONTROL)
      tapAt(centre[0], centre[1])
      scenario.awaitTag(DESTINATION)
      println("occlusion control: with the cover removed, the same coordinate opened \"$DESTINATION\"")
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
