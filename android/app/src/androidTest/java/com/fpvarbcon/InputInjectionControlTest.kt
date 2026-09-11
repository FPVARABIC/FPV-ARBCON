package com.fpvarbcon

import android.graphics.Rect
import android.os.SystemClock
import android.view.View
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
     * The three controls run 34544271920 measured. One was on the display
     * and two were not, which is why all three are kept: a set where every
     * member behaves the same way could not have shown the difference.
     */
    val PROBES = listOf("start-firmware", "start-configure", "start-flight-style-guide")

    /**
     * How long the mutation control waits for a screen it expects never to
     * see. The positive control below reaches the same screen well inside
     * this, so a screen that has not appeared by now did not appear because
     * of anything this test did.
     */
    const val MUST_NOT_APPEAR_MILLIS = 8_000L
  }

  /**
   * One control's geometry at one moment. Deliberately a plain class and
   * not a data class: nothing compares these, and a generated equals over
   * a FloatArray member would compare array identities rather than values,
   * which is a trap for whoever reaches for it next.
   */
  private class Probe(
    val testId: String,
    val centre: FloatArray,
    val targetRect: Rect,
    val displayRect: Rect,
    val hitDescription: String,
    val landed: Boolean,
  ) {
    val centreText: String get() = "(${centre[0]}, ${centre[1]})"

    override fun toString(): String =
      "\"$testId\" centre=$centreText rect=$targetRect display=$displayRect " +
        "deepestViewThere=$hitDescription landed=$landed"
  }

  /**
   * Whether [hit] and [target] are the same view or one genuinely contains
   * the other. A Pressable's inner Text carries no testID of its own, so
   * "the tag at the point is not the control's tag" is not the question -
   * "is the view under the point part of the control" is.
   */
  private fun isWithin(hit: View, target: View): Boolean =
    hit === target || everyView(target).contains(hit) || everyView(hit).contains(target)

  /**
   * Puts the start screen back at the top and confirms it stayed there.
   *
   * A screen with nothing to scroll is already at the top, and that is a
   * legitimate answer rather than a failure - it simply means this device
   * has no below-the-fold control for the sensitivity control to use.
   */
  private fun ActivityScenario<MainActivity>.scrollStartScreenToTop() {
    val deadline = SystemClock.uptimeMillis() + SCROLL_SETTLE_TIMEOUT_MILLIS
    var lastOffset = -1
    while (SystemClock.uptimeMillis() < deadline) {
      val atTop = readMain { activity ->
        val scroll = outermostScroll(activity.window.decorView) ?: return@readMain true
        scroll.scrollTo(0, 0)
        lastOffset = scroll.scrollY
        lastOffset == 0
      }
      if (atTop) return
      SystemClock.sleep(100)
    }
    throw AssertionError(
      "the start screen would not stay scrolled to the top within " +
        "${SCROLL_SETTLE_TIMEOUT_MILLIS}ms - it is resting at $lastOffset. Without a known " +
        "starting offset, \"below the fold\" means something different for each control and " +
        "this control would be comparing two screens rather than two treatments of one.",
    )
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

  /**
   * THE REGRESSION GATE FOR WHAT RUN 34544271920 FOUND.
   *
   * That run measured three controls on a 320x640 display. One was at
   * y 530 and worked. The other two were at y 886 and y 1247 - past the
   * bottom of the display - and their presses were injected at (167, 910)
   * and (189, 1271), coordinates no window contains. Nothing happened, and
   * the harness reported that as the controls not being pressable.
   *
   * This asserts the property the repair establishes, for every one of
   * those three controls, on whatever display the row is running:
   *
   *   1  the coordinate that will be injected is inside the control's own
   *      rectangle on the display
   *   2  it is inside the display
   *   3  the deepest drawn view there is the control or genuinely inside it
   *
   * It is device-independent and it cannot go vacuous: three controls are
   * named, and a control that cannot be brought onto the display fails in
   * bringTagOnScreen with its rectangle and the display area attached.
   */
  @Test
  fun everyProbedControlIsOnTheDisplayAtTheCoordinateThatWillBePressed() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      for (probe in PROBES) scenario.awaitTag(probe)

      for (probe in PROBES) {
        val centre = scenario.centreOfTag(probe)
        val report = scenario.readMain { activity ->
          val root = activity.window.decorView
          val target = findByTag(root, probe)
            ?: throw AssertionError("cannot locate \"$probe\": no such view")
          val hit = viewAt(root, centre[0], centre[1])
          Probe(
            testId = probe,
            centre = centre,
            targetRect = screenRectOf(target),
            displayRect = screenRectOf(root),
            hitDescription = hit?.let { "${it.javaClass.simpleName}[${it.tag}]" } ?: "<none>",
            landed = hit != null && isWithin(hit, target),
          )
        }
        println("scroll-and-press control: $report")

        assertTrue(
          "the coordinate that would be pressed for \"$probe\", ${report.centreText}, is not " +
            "inside the control's own rectangle on the display, ${report.targetRect}",
          report.targetRect.contains(centre[0].toInt(), centre[1].toInt()),
        )
        assertTrue(
          "the coordinate that would be pressed for \"$probe\", ${report.centreText}, is outside " +
            "the display ${report.displayRect}. An event injected there reaches no window, so " +
            "the press would report nothing happening whether or not the control works.",
          report.displayRect.contains(centre[0].toInt(), centre[1].toInt()),
        )
        assertTrue(
          "at ${report.centreText} the deepest drawn view is ${report.hitDescription}, which is " +
            "neither \"$probe\" nor inside it",
          report.landed,
        )
      }
    }
  }

  /**
   * THE SENSITIVITY CONTROL: TAKE THE SCROLL AWAY AND THE FAILURE COMES BACK.
   *
   * The repair's causal claim is that scrolling the control onto the
   * display is what makes the press land. That is only established if NOT
   * scrolling makes it stop landing, at the same coordinate arithmetic, on
   * the same control, in the same run.
   *
   * So the screen is put back to the top - a deterministic state, not
   * whatever the previous test left - and each control's centre is
   * computed the way the harness computed it before this repair: straight
   * from the view's position, with no scroll. For every control that is
   * below the fold in that state, the press must NOT resolve onto it, and
   * then scrolling must make the very same control resolve.
   *
   * WHETHER IT BITES DEPENDS ON THE DISPLAY, AND THAT IS REPORTED RATHER
   * THAN HIDDEN. The workflow sets no hardware profile on any row, so the
   * default device of each system image decides the size, and on a display
   * tall enough to show all three controls at once there is nothing below
   * the fold and removing the scroll changes nothing. That is a fact about
   * the device, not a pass: the count of controls that bit is printed
   * either way, and a run where it is zero is a run where this control
   * proved nothing - read the transcript, do not read the colour.
   */
  @Test
  fun withoutTheScrollTheSameControlsStopBeingReachable() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      for (probe in PROBES) scenario.awaitTag(probe)

      var bit = 0
      for (probe in PROBES) {
        // Back to the top before EVERY control, not once before the loop:
        // the previous iteration scrolled down to reach its own control,
        // so without this "below the fold" would mean something different
        // each time round and the comparison would be between two
        // different screens rather than two treatments of one.
        scenario.scrollStartScreenToTop()

        val unscrolled = scenario.readMain { activity ->
          val root = activity.window.decorView
          val target = findByTag(root, probe)
            ?: throw AssertionError("cannot locate \"$probe\": no such view")
          val rect = screenRectOf(target)
          val centre = floatArrayOf(rect.exactCenterX(), rect.exactCenterY())
          val hit = viewAt(root, centre[0], centre[1])
          Probe(
            testId = probe,
            centre = centre,
            targetRect = rect,
            displayRect = screenRectOf(root),
            hitDescription = hit?.let { "${it.javaClass.simpleName}[${it.tag}]" } ?: "<none>",
            landed = hit != null && isWithin(hit, target),
          )
        }
        val offDisplay = !unscrolled.displayRect.contains(
          unscrolled.centre[0].toInt(),
          unscrolled.centre[1].toInt(),
        )
        println("no-scroll control: $unscrolled offDisplay=$offDisplay")
        if (!offDisplay) continue

        bit++
        assertFalse(
          "\"$probe\" is at ${unscrolled.centreText}, outside the display " +
            "${unscrolled.displayRect}, yet the harness still resolved a press there onto it " +
            "(${unscrolled.hitDescription}). The hit test is finding views no finger could " +
            "reach, so it cannot be used to say a press landed.",
          unscrolled.landed,
        )

        // The same control, the same arithmetic, with the scroll put back.
        val centre = scenario.centreOfTag(probe)
        val scrolled = scenario.readMain { activity ->
          val root = activity.window.decorView
          val target = findByTag(root, probe)!!
          val hit = viewAt(root, centre[0], centre[1])
          hit != null && isWithin(hit, target)
        }
        assertTrue(
          "\"$probe\" did not resolve onto itself even after being scrolled onto the display, " +
            "so the difference above is not the scroll",
          scrolled,
        )
      }

      val verdict =
        if (bit == 0) {
          "NONE BIT ON THIS DISPLAY: every probed control already fits with the screen at the " +
            "top, so removing the scroll changes nothing here and this control proved nothing " +
            "on this row. Read this line, not the colour."
        } else {
          "each of them resolved onto nothing without the scroll and onto itself with it."
        }
      println(
        "sensitivity control: $bit of ${PROBES.size} probed controls were below the fold on " +
          "this display - $verdict",
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
