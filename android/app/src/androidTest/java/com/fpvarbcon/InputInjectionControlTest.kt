package com.fpvarbcon

import android.graphics.Rect
import android.os.SystemClock
import android.view.View
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
 * Four more controls were added after run 34548620198, one for each thing
 * the harness now claims about a press. Each names the single mutation that
 * must break it, so none of them can quietly stop testing anything:
 *
 *   1  THE SCROLL       drop bringTagOnScreen from centreOfTag
 *   2  THE ANCESTOR     restore "|| everyView(hit).contains(target)"
 *   3  THE CLIP         hit-test with screenRectOf, not visibleScreenRectOf
 *   4  THE DESTINATION  await ADVANCED_DESTINATION where DESTINATION belongs
 *
 * Controls 2, 3 and 4 need no particular screen size and bite on every row.
 * Control 1 only bites where a probed control is below the fold, and says
 * so in words when it does not.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
@RunWith(AndroidJUnit4::class)
class InputInjectionControlTest {

  private companion object {
    const val START = "start-screen"
    const val CONTROL = "start-firmware"

    /**
     * WHERE "start-firmware" ACTUALLY GOES, which is not where this file
     * used to look.
     *
     * Run 34548620198 waited forty seconds for "firmware-flasher-screen"
     * and timed out with the screen open in front of it, listing the tags
     * that WERE present:
     *
     *   [firmware-flasher-simple-screen, flasher-advanced-mode,
     *    simple-auto-detect, simple-back, simple-build-configuration,
     *    simple-enter-dfu, simple-flash-firmware, simple-load-firmware,
     *    simple-release-placeholder, simple-target-selector]
     *
     * There are two flasher screens in the product -
     * FirmwareFlasherSimpleScreen.tsx:1495 carries
     * "firmware-flasher-simple-screen" and FirmwareFlasherScreen.tsx:2237
     * carries "firmware-flasher-screen" - and the application's own
     * navigation opens the simple one first, with the advanced one behind
     * the "flasher-advanced-mode" control. The application's behaviour is
     * the reference here; the constant was wrong, not the product.
     */
    const val DESTINATION = "firmware-flasher-simple-screen"
    const val TO_ADVANCED = "flasher-advanced-mode"
    const val ADVANCED_DESTINATION = "firmware-flasher-screen"

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
    /**
     * The root's own screen origin, PRINTED rather than assumed. Every row
     * so far has reported (0, 0), which is what makes the window-to-display
     * conversion invisible on this hardware - see CoordinateSpaceTest.
     */
    val rootOrigin: IntArray,
    /** The target's genuinely visible area, converted into display space. */
    val visibleRect: Rect?,
    val hitDescription: String,
    val landed: Boolean,
  ) {
    val centreText: String get() = "(${centre[0]}, ${centre[1]})"
    val originText: String get() = "(${rootOrigin[0]}, ${rootOrigin[1]})"

    /**
     * ONE LINE, SHORT ENOUGH NOT TO NEED CUTTING.
     *
     * display and rootOrigin are the same on every probe in a run, so they
     * are printed ONCE by [printGeometryHeader] instead of on every line.
     * That is not cosmetic: the evidence extract used to truncate these
     * lines at 220 characters and the value of `landed` fell off the end of
     * three of them in run 34653241507. A field that is sometimes present
     * is worse than a field that is always somewhere else.
     */
    override fun toString(): String =
      "\"$testId\" centre=$centreText rect=$targetRect visible=${visibleRect ?: "<none>"} " +
        "deepestViewThere=$hitDescription landed=$landed"
  }

  /**
   * The fields that are identical for every probe, printed once so the
   * per-probe lines stay short. Both are MEASURED - see CoordinateSpaceTest
   * for why the root origin is never assumed to be (0, 0).
   */
  private fun printGeometryHeader(scenario: ActivityScenario<MainActivity>, case: String) {
    val (display, origin) = scenario.readMain { activity ->
      val root = activity.window.decorView
      screenRectOf(root) to rootOriginOf(root)
    }
    println(
      "geometry header: $case display=$display rootOrigin=(${origin[0]}, ${origin[1]})",
    )
  }

  /**
   * The production rule, used here rather than a copy of it: a press counts
   * as landing on a control only when the view under the point IS that
   * control or is genuinely inside it. See landedOn in UiTree.kt.
   */
  private fun isWithin(hit: View?, target: View?): Boolean = landedOn(hit, target)

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
      printGeometryHeader(scenario, "scroll-and-press")

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
            rootOrigin = rootOriginOf(root),
            visibleRect = visibleScreenRectOf(root, target),
            hitDescription = hit?.let { "${it.javaClass.simpleName}[${it.tag}]" } ?: "<none>",
            landed = isWithin(hit, target),
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
        // THE VISIBLE RECTANGLE, ASSERTED RATHER THAN IMPLIED.
        //
        // The three checks above use the control's OWN rectangle and the
        // display's. Neither knows about clipping, so together they would
        // still pass for a control scrolled half out of a container. This
        // one uses the platform's clipped answer, converted into display
        // space by the root's measured origin, which is the rectangle a
        // finger could actually touch. The origin is printed above rather
        // than assumed, and CoordinateSpaceTest proves the conversion with
        // a non-zero origin - which no emulator row has yet reported.
        assertTrue(
          "the coordinate that would be pressed for \"$probe\", ${report.centreText}, is not " +
            "inside the control's VISIBLE rectangle ${report.visibleRect ?: "<nothing visible>"}. " +
            "Its own bounds are ${report.targetRect} and the root origin is " +
            "${report.originText}, so part of the control is clipped away by something between " +
            "it and the window and the press would land on whatever is doing the clipping.",
          report.visibleRect?.contains(centre[0].toInt(), centre[1].toInt()) == true,
        )
        assertTrue(
          "at ${report.centreText} the deepest drawn view is ${report.hitDescription}, which is " +
            "neither \"$probe\" nor inside it",
          report.landed,
        )
      }
    }
  }

  // ===================================================================
  // FOUR NEGATIVE CONTROLS, ONE PER REPAIR
  //
  // Each repair in the harness is a claim about cause. A claim about
  // cause is worth nothing until the thing it blames is put back and the
  // failure returns, so there is one control per repair and each names
  // the exact mutation that must break it:
  //
  //   1  drop bringTagOnScreen from centreOfTag
  //   2  restore "|| everyView(hit).contains(target)" in landedOn
  //   3  hit-test viewAt with screenRectOf instead of visibleScreenRectOf
  //   4  await ADVANCED_DESTINATION where DESTINATION belongs
  //
  // None of them presses anything by calling into React: every press in
  // this file is two MotionEvents through UiAutomation.
  // ===================================================================

  /**
   * CONTROL 1 - THE SCROLL. Mutation: delete the bringTagOnScreen call in
   * centreOfTag.
   *
   * With the screen at the top, a control below the fold sits at a
   * coordinate off the display; after the scroll the same control sits at
   * one on it. Both halves are measured for every probe, so the control
   * says which controls it applied to instead of implying it applied to
   * all of them.
   *
   * Whether it bites depends on the display: no row in the workflow sets a
   * hardware profile, so each system image's default device decides the
   * size, and where all three controls already fit there is nothing below
   * the fold. The count is printed either way, and a zero says in words
   * that nothing was proved on that row.
   */
  @Test
  fun withoutTheScrollTheControlStaysOffTheDisplay() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      for (probe in PROBES) scenario.awaitTag(probe)
      printGeometryHeader(scenario, "no-scroll")

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
            rootOrigin = rootOriginOf(root),
            visibleRect = visibleScreenRectOf(root, target),
            hitDescription = hit?.let { "${it.javaClass.simpleName}[${it.tag}]" } ?: "<none>",
            landed = isWithin(hit, target),
          )
        }
        val display = unscrolled.displayRect
        val offDisplay = !display.contains(
          unscrolled.centre[0].toInt(),
          unscrolled.centre[1].toInt(),
        )
        println("no-scroll control: $unscrolled offDisplay=$offDisplay")
        if (!offDisplay) continue
        bit++

        // The same control, the same arithmetic, with the scroll put back.
        val centre = scenario.centreOfTag(probe)
        println(
          "scrolled control: \"$probe\" moved from ${unscrolled.centreText} to " +
            "(${centre[0]}, ${centre[1]}) inside $display",
        )
        assertTrue(
          "\"$probe\" was at ${unscrolled.centreText}, off the display $display, and after " +
            "bringTagOnScreen its centre is (${centre[0]}, ${centre[1]}), which is STILL off " +
            "it. The scroll is not putting the control where the press is aimed.",
          display.contains(centre[0].toInt(), centre[1].toInt()),
        )
      }

      val verdict =
        if (bit == 0) {
          "NONE BIT ON THIS DISPLAY: every probed control already fits with the screen at the " +
            "top, so removing the scroll changes nothing here and this control proved nothing " +
            "on this row. Read this line, not the colour."
        } else {
          "each was off the display before the scroll and on it afterwards."
        }
      println(
        "sensitivity control 1 (scroll): $bit of ${PROBES.size} probed controls were below the " +
          "fold on this display - $verdict",
      )
    }
  }

  /**
   * CONTROL 2 - THE ANCESTOR. Mutation: restore the third clause,
   * "|| everyView(hit).contains(target)", in landedOn.
   *
   * Run 34548620198 reported a press landing on "start-firmware" at
   * (167.5, 910.0) - below the bottom of a 320x640 screen - because the
   * view found there was the ReactViewGroup the button scrolls inside, and
   * the old rule accepted any view that CONTAINED the target. A finger on
   * the scrolling surface is not a press on a button somewhere inside it.
   *
   * This asserts the rule directly on real views from the live tree: the
   * control itself counts, something inside it counts, its parent does
   * not. It needs no particular screen size, so unlike control 1 it bites
   * on every row.
   */
  @Test
  fun anAncestorOfTheControlIsNotAPressOnTheControl() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.awaitTag(CONTROL)
      scenario.centreOfTag(CONTROL)

      val report = scenario.readMain { activity ->
        val root = activity.window.decorView
        val target = findByTag(root, CONTROL)
          ?: throw AssertionError("cannot locate \"$CONTROL\": no such view")
        val parent = target.parent as? View
          ?: throw AssertionError("\"$CONTROL\" has no parent view to test the rule against")
        val inside = everyView(target).firstOrNull { it !== target }
          ?: throw AssertionError("\"$CONTROL\" has no child view to test the rule against")

        val itself = isWithin(target, target)
        val descendant = isWithin(inside, target)
        val ancestor = isWithin(parent, target)
        println(
          "ancestor control: target=${target.javaClass.simpleName} " +
            "parent=${parent.javaClass.simpleName} inner=${inside.javaClass.simpleName} " +
            "landedOn(self)=$itself landedOn(inner)=$descendant landedOn(parent)=$ancestor",
        )
        Triple(itself, descendant, ancestor)
      }

      assertTrue("landedOn rejected the control itself, which is the one case it must accept", report.first)
      assertTrue(
        "landedOn rejected a view genuinely inside \"$CONTROL\". A Pressable's inner Text " +
          "carries no testID of its own, so rejecting it would reject real presses.",
        report.second,
      )
      assertFalse(
        "landedOn accepted the PARENT of \"$CONTROL\" as a press on it. That is the rule that " +
          "made run 34548620198 report a press landing on this control at a coordinate below " +
          "the bottom of the screen: the view under the point was the scroll container, and " +
          "containing the target was treated as being it.",
        report.third,
      )
    }
  }

  /**
   * CONTROL 3 - THE CLIP. Mutation: hit-test viewAt with screenRectOf
   * instead of visibleScreenRectOf.
   *
   * A scroll container's own rectangle spans its entire content, so an
   * unclipped hit test answers "yes, there is a view here" for points far
   * below the screen. The clipped rectangle is the platform's own answer
   * to what survives every ancestor's bounds, and below the bottom of the
   * display nothing does - so the only honest answer there is no view.
   *
   * The point used is the display's own bottom edge plus a margin, derived
   * from the measured display rather than hard-coded, so this bites on any
   * screen size.
   */
  @Test
  fun nothingResolvesAtAPointBelowTheDisplay() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.awaitTag(CONTROL)
      scenario.scrollStartScreenToTop()

      val report = scenario.readMain { activity ->
        val root = activity.window.decorView
        val display = screenRectOf(root)
        val belowX = display.exactCenterX()
        val belowY = (display.bottom + 200).toFloat()
        val clipped = viewAt(root, belowX, belowY)
        val unclipped = everyView(root)
          .filter { view ->
            view.visibility == View.VISIBLE && view.isShown && view.alpha > 0f &&
              screenRectOf(view).contains(belowX.toInt(), belowY.toInt())
          }
          .lastOrNull()
        println(
          "clip control: display=$display probed=($belowX, $belowY) " +
            "clippedHit=${clipped?.javaClass?.simpleName ?: "<none>"} " +
            "unclippedHit=${unclipped?.javaClass?.simpleName ?: "<none>"}",
        )
        clipped?.let { "${it.javaClass.simpleName}[${it.tag}] at ${screenRectOf(it)}" }
      }

      assertNull(
        "a point 200 pixels below the bottom of the display resolved to a view ($report). " +
          "Nothing is visible there, so the hit test is reading unclipped bounds - which is " +
          "how run 34548620198 found a ReactViewGroup at (167.5, 910.0) on a 320x640 screen.",
        report,
      )
    }
  }

  /**
   * CONTROL 4 - THE DESTINATION. Mutation: await ADVANCED_DESTINATION
   * where DESTINATION belongs.
   *
   * Pressing "start-firmware" opens the SIMPLE flasher. The advanced one
   * is a second press away, behind "flasher-advanced-mode". Run
   * 34548620198 spent forty seconds per case waiting for the advanced tag
   * with the simple screen already drawn in front of it, so this asserts
   * both halves of the route and, in between, that the advanced screen is
   * NOT already present - which is what makes awaiting the wrong tag fail
   * rather than accidentally succeed.
   */
  @Test
  fun startFirmwareOpensTheSimpleFlasherAndAdvancedModeOpensTheOtherOne() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.awaitTag(CONTROL)

      scenario.tapTag(CONTROL)
      scenario.awaitTag(DESTINATION)
      println("destination control: \"$CONTROL\" opened \"$DESTINATION\"")

      assertFalse(
        "\"$ADVANCED_DESTINATION\" is already present on the screen \"$CONTROL\" opens, so " +
          "awaiting it there would pass without the advanced control ever being pressed and " +
          "this route would not be tested at all",
        scenario.hasTag(ADVANCED_DESTINATION),
      )

      scenario.awaitTag(TO_ADVANCED)
      scenario.tapTag(TO_ADVANCED)
      scenario.awaitTag(ADVANCED_DESTINATION)
      println("destination control: \"$TO_ADVANCED\" opened \"$ADVANCED_DESTINATION\"")
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
