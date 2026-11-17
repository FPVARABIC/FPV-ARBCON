package com.fpvarbcon

import android.app.Activity
import android.graphics.Rect
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.facebook.react.modules.i18nmanager.I18nUtil
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * EVERY DESTINATION AN EMULATOR CAN REACH, DRIVEN ON THE DEVICE.
 *
 * =====================================================================
 * WHY FOUR AND NOT TWENTY-TWO
 * =====================================================================
 *
 * androidDestinationCensus.test.ts establishes that this application has
 * 22 Android-visible destinations. It is a map, not a measurement, and it
 * says so. This file is the measurement, and it can only cover what a
 * machine with no flight controller attached can actually open.
 *
 * The gate is in the product, not in this test:
 *
 *     configurationWorkspaceUnlocked(connection) =
 *         connection.kind === 'CONNECTED'
 *
 * and App.tsx does not even register <Stack.Screen name="Setup"> until
 * that is true. CONNECTED requires an enumerated USB serial device, a
 * granted USB permission, an opened port and a verified MSP identification
 * handshake with a real board. There is no demo mode, no simulator switch
 * and no debug bypass in the shipped application - the virtual flight
 * controllers in this repository live in __testUtils__ and are not
 * reachable from the app.
 *
 * So the honest split is:
 *
 *   REACHABLE HERE      4  Start, FirmwareFlasher, FlightStyleGuide,
 *                          FlightStyleCorner
 *   REAL_HARDWARE_REQUIRED 18  Setup and its seventeen tabs
 *
 * and the eighteen are not skipped. `theWorkspaceStaysLockedWithoutABoard`
 * asserts the gate holds, so if the workspace ever opened without a board
 * this file would fail rather than quietly cover less.
 *
 * =====================================================================
 * HOW IT DRIVES
 * =====================================================================
 *
 * Real MotionEvents at real screen coordinates, and condition polling with
 * a deadline rather than sleeps - see UiTree.kt for why neither Espresso's
 * idling nor performClick() is usable against React Native.
 *
 * NOT VERIFIED ON REAL HARDWARE: an emulator is not a phone and no flight
 * controller was attached to anything.
 */
@RunWith(AndroidJUnit4::class)
class DestinationInteractionTest {

  private data class Destination(
    val name: String,
    val marker: String,
    /** Presses that get there from a fresh Start screen. */
    val route: List<String>,
  )

  private companion object {
    const val START = "start-screen"

    val REACHABLE = listOf(
      Destination("Start", START, emptyList()),
      /**
       * ONE ROUTE, AND THE MARKER IT ACTUALLY RENDERS.
       *
       * Run 34548620198 failed all seven cases in this class waiting forty
       * seconds each for "firmware-flasher-screen" while the screen that
       * had actually opened sat in front of them, carrying
       * "firmware-flasher-simple-screen" and nine "simple-" controls.
       *
       * The product has two flasher screens -
       * FirmwareFlasherSimpleScreen.tsx:1495 and
       * FirmwareFlasherScreen.tsx:2237 - but App.tsx:145 declares ONE
       * route for them, `<Stack.Screen name="FirmwareFlasher">`. Arriving
       * there renders the simple one, and the advanced one is a state
       * inside it behind "flasher-advanced-mode", not a second
       * destination. So the name stays as the route's name - it is checked
       * against App.tsx by androidDestinationReachability.test.ts - and
       * only the marker is corrected to what the route draws.
       *
       * The advanced screen is not dropped: it is driven as its own step
       * by InputInjectionControlTest, which presses through to it and
       * asserts it was not already there.
       */
      Destination("FirmwareFlasher", "firmware-flasher-simple-screen", listOf("start-firmware")),
      Destination(
        "FlightStyleGuide",
        "flight-style-guide-screen",
        listOf("start-flight-style-guide"),
      ),
      Destination(
        "FlightStyleCorner",
        "flight-style-corner-screen",
        listOf("start-flight-style-guide", "guide-card-cinematic"),
      ),
    )

    /**
     * The eighteen behind the connection gate, named so the number in any
     * report is this list and not a guess.
     */
    val REAL_HARDWARE_REQUIRED = listOf(
      "Setup", "SETUP", "MOTORS", "PORTS", "GPS", "CONFIGURATIONS", "RECEIVER", "PID",
      "MODES", "FAILSAFE", "POWER", "OSD", "VTX", "LED", "SENSORS", "BLACKBOX",
      "PRESETS", "CLI",
    )

    /**
     * CONTROLS WHERE AN ELLIPSIS IS A DECISION SOMEBODY MADE, NOT A
     * CONTAINER THAT CAME OUT TOO SMALL.
     *
     * testID -> why it is allowed and how the full text still reaches the
     * operator.
     *
     * DELIBERATELY EMPTY. Everything the measurement finds fails until a
     * person puts it here, and nothing was pre-approved to make the first
     * run green - that would be deciding, sight unseen, that every
     * truncation the product happens to contain is intentional. The list
     * the next run prints is the list to argue about.
     *
     * TWO CONDITIONS FOR AN ENTRY, BOTH ON THE PERSON ADDING IT:
     *
     *   1  a reason naming the decision - not "it is fine", but what the
     *      control is and why shortening it there is right.
     *   2  the full text demonstrably reachable by an operator who cannot
     *      see the screen. Since ellipsised text is gone from the visual
     *      layout, that means the whole string exposed through the
     *      accessibility semantics of that control, asserted somewhere.
     *
     * That second condition is ACCESSIBILITY_SEMANTICS, not TalkBack.
     * Nothing in this suite enables TalkBack or measures what it
     * announced, so no entry here may be justified by claiming it did -
     * only by what the accessibility tree exposes.
     *
     * An unnamed control can never appear here: there is no testID to write
     * down, so there is nothing to exempt. Fix the container or give the
     * control a name.
     */
    val ELLIPSIS_ALLOWED: Map<String, String> = emptyMap()
  }

  /**
   * EVERY CASE STARTS AT A KNOWN TEXT SIZE, NOT AT WHATEVER THE LAST ONE
   * LEFT BEHIND.
   *
   * The font scale is SYSTEM state: one case setting it to 2.0 changes the
   * device for every case that runs afterwards. Restoring it in @After was
   * the only guard, which makes correctness depend on the previous case
   * having finished its restore - and on the order JUnit happens to pick,
   * which is not specified.
   *
   * Run 34649197028 failed everyClickableControlExposesAnAccessibilityName
   * with the guide control parked at Rect(-68, 29 - 0, 640) on a 320x640
   * display, in a run where atFontScaleOneAndTwoNoTextIsSilentlyClipped
   * had set 2.0. Whether those two facts are connected is NOT established
   * here and this does not claim they are. What is established is that a
   * case could inherit another case's system state, which makes any result
   * that depends on it unreliable in both directions - so it is pinned
   * before as well as restored after, and the scale each case ran at is no
   * longer a question about ordering.
   */
  @Before
  fun pinFontScale() {
    setSystemFontScale("1.0")
  }

  @After
  fun restoreFontScale() {
    setSystemFontScale("1.0")
  }

  private fun <T> onDestination(
    destination: Destination,
    block: (ActivityScenario<MainActivity>) -> T,
  ): T = ActivityScenario.launch(MainActivity::class.java).use { scenario ->
    scenario.moveToState(Lifecycle.State.RESUMED)
    scenario.awaitTag(START)
    for (step in destination.route) {
      scenario.awaitTag(step)
      scenario.tapTag(step)
    }
    scenario.awaitTag(destination.marker)
    block(scenario)
  }

  private fun clickableViews(scenario: ActivityScenario<MainActivity>): List<View> =
    scenario.readMain { activity ->
      drawnViews(activity.window.decorView).filter { it.isClickable }
    }

  // ===================================================================
  // The destinations open at all
  // ===================================================================

  @Test
  fun everyReachableDestinationOpensAndDrawsControls() {
    val report = StringBuilder("===== UI-X3B DESTINATION INTERACTION CENSUS =====\n")
    for (destination in REACHABLE) {
      val counts = onDestination(destination) { scenario ->
        val drawn = scenario.readMain { drawnViews(it.window.decorView).size }
        val clickable = clickableViews(scenario)
        val named = clickable.count { view ->
          scenario.readMain { !accessibleName(view).isNullOrBlank() }
        }
        val enabled = clickable.count { view -> scenario.readMain { view.isEnabled } }
        Triple(drawn, clickable.size, named to enabled)
      }
      report.append(
        "  ${destination.name.padEnd(20)} drawn=${counts.first} clickable=${counts.second} " +
          "named=${counts.third.first} enabled=${counts.third.second}\n",
      )
      assertTrue(
        "${destination.name} drew no controls at all - it opened but is not usable",
        counts.second > 0,
      )
    }
    report.append("  REACHABLE ON AN EMULATOR : ${REACHABLE.size}\n")
    report.append("  REAL_HARDWARE_REQUIRED   : ${REAL_HARDWARE_REQUIRED.size}\n")
    report.append("=================================================")
    println(report)
    assertEquals(
      "the reachable and hardware-gated sets must still add up to the 22 destinations " +
        "androidDestinationCensus.test.ts counts",
      22,
      REACHABLE.size + REAL_HARDWARE_REQUIRED.size,
    )
  }

  // ===================================================================
  // Right to left
  // ===================================================================

  /**
   * WHAT "LAID OUT RIGHT TO LEFT" IS MEASURED ON, AND WHAT IT IS NOT.
   *
   * This test used to assert on `window.decorView.layoutDirection`, and it
   * failed on API 34 and API 36 alike with `expected:<1> but was:<0>`. That
   * was the test being wrong, not the product: the decor view belongs to
   * the framework, and its direction is resolved from the CONFIGURATION
   * LOCALE. The emulator runs en-US, so the decor view is left-to-right and
   * would be left-to-right no matter what the application did.
   *
   * React Native's right-to-left is not the locale. I18nUtil.isRTL is
   *
   *     applicationHasRtlSupport(context) &&
   *         (isRTLForced(context) || (isRTLAllowed(context) && ...))
   *
   * and this application forces it at startup, deliberately, so the Arabic
   * UI is right-to-left on an English device too. That value is handed to
   * the surface (ReactSurfaceImpl passes isRTL(context) into the binding),
   * Yoga lays the tree out in that direction, and SurfaceMountingManager
   * writes the result onto each mounted view - `2 -> LAYOUT_DIRECTION_RTL`.
   *
   * So the subject is the mounted view the destination is made of, and the
   * decor view is recorded next to the locale as the explanation of why it
   * differs rather than asserted on.
   */
  @Test
  fun everyReachableDestinationIsLaidOutRightToLeft() {
    val notRightToLeft = mutableListOf<String>()
    for (destination in REACHABLE) {
      val report = onDestination(destination) { scenario ->
        scenario.readMain { activity ->
          val locale = activity.resources.configuration.locales[0]
          val localeDirection = TextUtils.getLayoutDirectionFromLocale(locale)
          val decor = activity.window.decorView.layoutDirection
          val marker = findByTag(activity.window.decorView, destination.marker)
            ?: throw AssertionError("${destination.name}: its own marker view is gone")

          if (marker.layoutDirection != View.LAYOUT_DIRECTION_RTL) {
            notRightToLeft += "${destination.name}: the view tagged \"${destination.marker}\" " +
              "resolves layoutDirection=${marker.layoutDirection}, not " +
              "${View.LAYOUT_DIRECTION_RTL}"
          }
          if (!!I18nUtil.instance.isRTL(activity)) {
            notRightToLeft += "${destination.name}: I18nUtil.isRTL is false, so React Native is " +
              "laying the whole application out left to right"
          }

          // The control for the claim above: the decor view is not a
          // measurement of the application, it is a measurement of the
          // device locale. If those two ever disagreed, this explanation
          // would be wrong and the reader should know.
          assertEquals(
            "${destination.name}: the decor view's direction ($decor) does not match the one " +
              "implied by the device locale $locale ($localeDirection). The reasoning above - " +
              "that the decor view reports the locale rather than the app - does not hold here.",
            localeDirection,
            decor,
          )

          val tagged = everyView(activity.window.decorView)
            .filter { it.tag is String && it.isShown }
            .joinToString(", ") { "${it.tag}=${it.layoutDirection}" }
          "  ${destination.name.padEnd(20)} marker=${marker.layoutDirection} " +
            "decor=$decor locale=$locale($localeDirection) " +
            "I18nUtil.isRTL=${!I18nUtil.instance.isRTL(activity)}\n      tagged: $tagged"
        }
      }
      println(report)
    }
    assertTrue(
      "these destinations are not laid out right to left, which is the whole product:\n" +
        notRightToLeft.joinToString("\n"),
      notRightToLeft.isEmpty(),
    )
  }

  // ===================================================================
  // Accessibility semantics - which is NOT a TalkBack test
  // ===================================================================

  /**
   * WHAT THIS PROVES, AND WHAT IT DOES NOT.
   *
   * It reads the semantics the view tree exposes: whether every pressable
   * control carries a contentDescription, or text a screen reader could
   * fall back on. A control that carries neither is unusable without sight,
   * and that is worth failing over.
   *
   * It is NOT a TalkBack test and must not be reported as one. TalkBack was
   * never enabled here, no focus traversal happened, no order was measured
   * and nothing was announced. The verdict this case supports is
   * ACCESSIBILITY_SEMANTICS_VERIFIED; a TalkBack claim would need TalkBack
   * actually running, with traversal order and announcements recorded, and
   * this run has none of that.
   */
  @Test
  fun everyClickableControlExposesAnAccessibilityName() {
    val nameless = mutableListOf<String>()
    for (destination in REACHABLE) {
      onDestination(destination) { scenario ->
        for (view in clickableViews(scenario)) {
          val described = scenario.readMain {
            val name = accessibleName(view)
            if (name.isNullOrBlank()) {
              "${destination.name}: ${view.javaClass.simpleName} tag=${view.tag} " +
                "at ${Rect().also { r -> view.getGlobalVisibleRect(r) }}"
            } else {
              null
            }
          }
          if (described != null) nameless += described
        }
      }
    }
    assertTrue(
      "these controls are pressable and expose no accessibility name at all, so a screen " +
        "reader has nothing to read from them and an operator without sight cannot tell what " +
        "they do:\n" + nameless.joinToString("\n"),
      nameless.isEmpty(),
    )
  }

  // ===================================================================
  // Nothing decorative
  // ===================================================================

  /**
   * A control that is drawn but cannot be pressed, or is pressable but
   * invisible, is worse than an absent one: the operator aims at it and
   * nothing happens. Disabled is a separate, legitimate state - a control
   * whose preconditions are unmet - so disabled controls are REPORTED with
   * their names rather than failed, and what fails is a decoy: pressable,
   * present in the tree, and impossible to hit.
   */
  @Test
  fun noControlIsAPressableDecoy() {
    val decoys = mutableListOf<String>()
    val disabled = mutableListOf<String>()
    for (destination in REACHABLE) {
      onDestination(destination) { scenario ->
        val all = scenario.readMain { everyView(it.window.decorView).filter { v -> v.isClickable } }
        for (view in all) {
          val verdict = scenario.readMain {
            val rect = Rect()
            val onScreen = view.getGlobalVisibleRect(rect)
            val name = accessibleName(view) ?: view.tag?.toString() ?: view.javaClass.simpleName
            when {
              view.visibility == View.VISIBLE && view.alpha == 0f ->
                "DECOY ${destination.name}: $name is pressable at alpha 0"
              view.visibility == View.VISIBLE && view.isShown && (view.width == 0 || view.height == 0) ->
                "DECOY ${destination.name}: $name is pressable with a zero size"
              view.visibility == View.VISIBLE && view.isShown && !onScreen && view.parent != null &&
                outermostScrollAbsent(scenario) ->
                "DECOY ${destination.name}: $name is pressable but has no on-screen area on a " +
                  "screen that does not scroll"
              !view.isEnabled -> "disabled ${destination.name}: $name"
              else -> null
            }
          }
          when {
            verdict == null -> Unit
            verdict.startsWith("DECOY") -> decoys += verdict
            else -> disabled += verdict
          }
        }
      }
    }
    println("disabled controls (a state, not a defect): ${disabled.size}")
    disabled.forEach { println("  $it") }
    assertTrue("pressable decoys found:\n" + decoys.joinToString("\n"), decoys.isEmpty())
  }

  private fun outermostScrollAbsent(scenario: ActivityScenario<MainActivity>): Boolean =
    scenario.readMain { outermostScroll(it.window.decorView) == null }

  // ===================================================================
  // The bottom action is reachable
  // ===================================================================

  @Test
  fun theLastActionOnEachDestinationCanBeScrolledTo() {
    for (destination in REACHABLE) {
      onDestination(destination) { scenario ->
        val scrolled = scenario.scrollToEnd()
        val bounds = scenario.displayBounds()
        val last = scenario.readMain { activity ->
          drawnViews(activity.window.decorView)
            .filter { it.isClickable && it.isEnabled }
            .maxByOrNull { view ->
              val rect = Rect()
              view.getGlobalVisibleRect(rect)
              rect.bottom
            }
        }
        assertNotNull(
          "${destination.name} has no enabled control on screen after scrolling to the end",
          last,
        )
        val rect = scenario.readMain {
          val r = Rect()
          last!!.getGlobalVisibleRect(r)
          r
        }
        println(
          "${destination.name}: scrollable=$scrolled last action at $rect within $bounds",
        )
        assertTrue(
          "${destination.name}: the last action sits at $rect, outside the display $bounds - " +
            "an operator cannot reach it",
          bounds.contains(rect) || Rect.intersects(bounds, rect),
        )
      }
    }
  }

  // ===================================================================
  // Back
  // ===================================================================

  /**
   * WHERE ONE BACK ACTUALLY GOES, WHICH IS ONE LEVEL - NOT ALWAYS START.
   *
   * This test used to press BACK once from every destination and require
   * the Start screen. That is right for a destination one push deep and
   * wrong for anything deeper, and run 34642729506 said so the moment the
   * firmware route started working and the loop finally reached the
   * three-deep one:
   *
   *   Back from FlightStyleCorner did not return to the start screen,
   *   and the app is in an undefined place
   *
   * The application is not at fault. App.tsx:141-147 declares Start,
   * FirmwareFlasher, FlightStyleGuide and FlightStyleCorner as four
   * separate routes in one stack, and FlightStyleGuideScreen.tsx:166
   * reaches the corner with navigation.navigate('FlightStyleCorner'), a
   * PUSH. So Start -> FlightStyleGuide -> FlightStyleCorner is three
   * entries deep and one BACK is supposed to land on FlightStyleGuide.
   * The old assertion demanded that a single key press unwind two of them.
   *
   * So the contract asserted here is the one the platform actually offers,
   * and it is asserted step by step rather than in one jump:
   *
   *   - after ONE back, the app is at the destination reached by this
   *     destination's route minus its last step - Start when the route is
   *     one step long
   *   - after as many backs as the route has steps, the app is at Start
   *
   * The parent is DERIVED by finding the destination whose route is this
   * one's route without its last step, so a new destination cannot be
   * added with a hand-written parent that quietly disagrees with its own
   * route.
   *
   * EVERY DESTINATION IS ITS OWN POSITIVE CONTROL, IN THIS RUN. The
   * one-step destinations still have to reach Start on a single back, so
   * a genuinely broken BACK key cannot pass this test by being generous
   * about where it lands - it would fail on them first.
   *
   * WHAT IS RECORDED AND WHAT IS NOT. The marker tag on screen, every
   * visible testID, the Activity lifecycle state and whether the platform
   * ACCEPTED the key are all printed, because "back did nothing" and "back
   * never arrived" look the same from the screen alone. The JS navigator's
   * own route name and the number of registered BackHandler callbacks are
   * NOT MEASURABLE from an instrumentation test - nothing native exposes
   * them - so neither is claimed here; the marker testID the product
   * itself renders is used as the observable instead.
   */
  @Test
  fun oneBackGoesUpExactlyOneLevelAndTheRouteUnwindsToStart() {
    for (destination in REACHABLE.filter { it.route.isNotEmpty() }) {
      val parent = REACHABLE.firstOrNull { it.route == destination.route.dropLast(1) }
        ?: throw AssertionError(
          "${destination.name} has route ${destination.route}, but no destination in REACHABLE " +
            "has route ${destination.route.dropLast(1)} - so there is nothing to call the place " +
            "one back from it, and this test cannot say where it should land",
        )

      onDestination(destination) { scenario ->
        val before = scenario.visibleTags()
        val accepted = pressBack()
        val landedOnParent = scenario.awaitTagOrNull(parent.marker)
        val after = scenario.visibleTags()
        println(
          "back control: from ${destination.name} (route=${destination.route}) one back " +
            "accepted=$accepted lifecycle=${scenario.state} expected=\"${parent.marker}\" " +
            "present=$landedOnParent",
        )
        println("back control:   tags before = $before")
        println("back control:   tags after  = $after")

        assertTrue(
          "one BACK from ${destination.name} did not land on \"${parent.marker}\", the place " +
            "one level up. The key was ${if (accepted) "ACCEPTED" else "REJECTED"} by the " +
            "platform, the activity is ${scenario.state}, and what is on screen now is " +
            "$after. If the key was accepted and the screen did not change, BACK is not " +
            "working; if it was rejected, nothing was ever delivered.",
          landedOnParent,
        )

        // And the whole route unwinds: one back per step reaches Start.
        repeat(destination.route.size - 1) { pressBack() }
        val atStart = scenario.awaitTagOrNull(START)
        println(
          "back control: ${destination.route.size} backs from ${destination.name} " +
            "reached start=$atStart",
        )
        assertTrue(
          "${destination.route.size} BACK presses from ${destination.name} did not unwind to " +
            "the start screen. On screen now: ${scenario.visibleTags()}",
          atStart,
        )
      }
    }
  }

  // ===================================================================
  // Font scale 2.0
  // ===================================================================

  /**
   * BOTH TEXT SIZES, NOT JUST THE LARGE ONE.
   *
   * Run 34642729506 measured the step badges in the firmware flasher being
   * cut off at scale 2.0 ("٤" needs 35px and has 28px). A repair for that
   * can break the ordinary size just as easily as the large one, so the
   * default is measured too and in the same run - a screen that is only
   * ever checked at one text size has only ever been checked for one
   * operator.
   */
  @Test
  fun atFontScaleOneAndTwoNoTextIsSilentlyClipped() {
    val clipped = mutableListOf<Complaint>()
    for (scale in listOf("1.0", "2.0")) {
      setSystemFontScale(scale)
      val applied = readSystemFontScale()
      println("system font_scale is now: $applied")
      assertTrue(
        "the system font scale did not become $scale, it is \"$applied\"",
        applied.startsWith(scale.take(1)),
      )

      for (destination in REACHABLE) {
        onDestination(destination) { scenario ->
          // Every scroll position, not just the end - see scrollSweep for
          // the three step badges the single-measurement version missed.
          scenario.scrollSweep {
            val found = scenario.readMain { activity ->
              assertEquals(
                "${destination.name} did not adopt the $scale font scale",
                scale.toFloat(),
                activity.resources.configuration.fontScale,
                0.01f,
              )
              drawnViews(activity.window.decorView)
                .filterIsInstance<TextView>()
                .filter { !it.text.isNullOrBlank() }
                .mapNotNull { view -> truncationComplaint("${destination.name}@$scale", view) }
            }
            clipped += found
          }
        }
      }
    }

    val byKind = clipped.groupBy { it.kind }
    for (kind in Loss.entries) {
      val found = byKind[kind].orEmpty()
      println("truncation census: $kind = ${found.size}")
      // MARKED, because an unmarked line is not evidence. These used to be
      // printed with two leading spaces and no marker, and the extraction
      // in run-instrumentation-on-emulator.sh greps for markers - so run
      // 34723764981 published "ELLIPSISED = 2" into tap-geometry.txt and
      // left both identities out of it. The count was the only thing a
      // reader could see, and the count is not the finding.
      found.forEach { println("truncation instance: $kind ${it.message}") }
    }

    // EVERY LOSS FAILS UNLESS IT IS DECLARED.
    //
    // An earlier version let ELLIPSISED pass on the reasoning that an
    // ellipsis is visible, so the operator knows the text continues. That
    // is true of an ellipsis somebody CHOSE. It is not true of one the
    // line breaker produced because a container was too small, and the
    // measurement cannot tell those apart - only a person can, per control,
    // which is what ELLIPSIS_ALLOWED is for. Until a case is declared there
    // with a reason, it is undeclared truncation and it fails.
    val undeclared = clipped.filter { !isDeclared(it, ELLIPSIS_ALLOWED) }
    val declared = clipped.filter { isDeclared(it, ELLIPSIS_ALLOWED) }
    declared.forEach { println("truncation allowed: ${it.testId} - ${ELLIPSIS_ALLOWED[it.testId]}") }

    assertTrue(
      "text is lost and nothing declares it:\n" +
        undeclared.joinToString("\n") { it.message } +
        "\n\nEllipsised text may be allowed one control at a time in ELLIPSIS_ALLOWED, by " +
        "testID, with a reason and with the full text proved to be exposed to accessibility " +
        "services. Text with no testID cannot be allowed at all - there is nothing to name it " +
        "by - and silently dropped or overflowing text is never allowed.",
      undeclared.isEmpty(),
    )
  }

  /**
   * THE RULE. A text view that was given no line limit must fit the box it
   * was drawn in. When it does not, the last line is drawn cut in half and
   * nothing anywhere reports it - which is exactly what a large font scale
   * does to a fixed-height container.
   *
   * A view with an explicit maxLines is NOT judged here: shortening long
   * text to a fixed number of lines is a deliberate design decision, and
   * React Native pairs it with an ellipsis so the operator can see there
   * is more.
   */
  /** The three ways a TextView can be showing less than it was given. */
  private enum class Loss {
    /**
     * The platform ellipsised it. Characters were dropped, but the operator
     * can SEE they were: there is a visible ellipsis. This is what a
     * deliberate numberOfLines is for.
     */
    ELLIPSISED,

    /**
     * Characters were dropped with NO ellipsis. Nothing on screen says the
     * text continues, so the operator cannot know they are reading half a
     * sentence.
     */
    DROPPED_SILENTLY,

    /** Every character was laid out, into a box too short to draw them. */
    OVERFLOWS_BOX,
  }

  /**
   * @param testId the control's own testID, or null when it has none. Only
   *   a named control can ever be declared in [ELLIPSIS_ALLOWED]: an
   *   unnamed one cannot be written down, so it cannot be exempted.
   */
  private data class Complaint(val kind: Loss, val testId: String?, val message: String)

  /**
   * WHAT A TEXT VIEW IS ACTUALLY SHOWING, ASKED SEMANTICALLY.
   *
   * The previous version measured one thing - laid-out height against box
   * height - and skipped any view with a maxLines, on the reasoning that
   * shortening text to a line count is a design decision. That left two
   * ways of losing text unmeasured, and a brief attempt to add a third
   * (comparing Layout.getLineWidth against the view's width) produced ten
   * false complaints of nought to five pixels on correctly wrapped Arabic
   * in run 34649197028, because that float is an advance width and not a
   * cut-off glyph. It is not reinstated.
   *
   * These three are asked of the LAYOUT, in characters, not in fractional
   * pixels:
   *
   *   1  getEllipsisCount(line) - the platform's own admission that it had
   *      to drop characters from that line.
   *   2  getLineEnd(last) against the text's own length - a layout that
   *      stops before the end of its text draws the remainder nowhere.
   *      Trailing whitespace is discounted, so a string ending in a newline
   *      is not reported as a character short.
   *   3  the vertical check, unchanged: every character laid out, into a
   *      box too short for them.
   *
   * The kinds are separated because they are not equally bad, and the
   * caller decides which fail. Ellipsised text is visibly ellipsised;
   * silently dropped text is invisible loss.
   *
   * WHAT CHECK 2 DOES NOT CATCH, MEASURED.
   *
   * This comment said "with a maxLines, Layout simply stops". Run
   * 34723764981 on API 34 proves that is wrong for a TextView: a view with
   * setMaxLines(1) and NO ellipsize was measured EXACTLY 40px tall and its
   * layout came back 109px, which is every line laid out. Because the
   * layout runs to the end of the text, getLineEnd(last) equals the text's
   * length, check 2 stays silent, and the clipping - which happens at draw
   * time, not at layout time - is caught by check 3 instead.
   *
   * So check 2 is not the maxLines check. It fires for a layout that
   * really does stop early, whatever made it stop. React Native's
   * numberOfLines sets an ellipsize as well, so on these screens check 1
   * gets there first; check 2 is the one that would catch a layout built
   * without one.
   */
  private fun truncationComplaint(destination: String, view: TextView): Complaint? {
    val layout = view.layout ?: return null
    val content = view.text ?: return null
    // The control's own testID if it has one, else the nearest named
    // ancestor's - a Pressable's inner Text carries no testID of its own,
    // and naming its parent is the only way an allowlist entry can point
    // at anything.
    val testId = generateSequence(view as View) { it.parent as? View }
      .mapNotNull { it.tag as? String }
      .firstOrNull()
    return truncationOf(
      destination = destination,
      testId = testId,
      layout = layout,
      content = content,
      maxLines = view.maxLines,
      availableHeightPx = view.height - view.paddingTop - view.paddingBottom,
    )
  }

  /**
   * THE DETECTOR ITSELF, OVER A LAYOUT AND NOTHING ELSE.
   *
   * Split out of [truncationComplaint] so that a control can hand it a
   * layout it built on purpose. Everything it decides comes from the six
   * parameters, so a case that a real TextView will not produce on this
   * platform - see check 2 above - can still be driven through the real
   * code rather than reasoned about in a comment.
   *
   * [availableHeightPx] at or below zero means the view was never given a
   * height, and nothing is judged.
   */
  private fun truncationOf(
    destination: String,
    testId: String?,
    layout: Layout,
    content: CharSequence,
    maxLines: Int,
    availableHeightPx: Int,
  ): Complaint? {
    val full = content.toString()
    if (full.isBlank()) return null
    val shown = full.take(60)
    // EVERY complaint names its control, not only the ellipsis one. The
    // overflow message used to carry the text and the two pixel counts and
    // nothing to find the control by, which is the one thing a reader needs
    // to go and look at it.
    val named = testId?.let { " [$it]" } ?: " [no testID]"

    for (line in 0 until layout.lineCount) {
      val dropped = layout.getEllipsisCount(line)
      if (dropped > 0) {
        return Complaint(
          Loss.ELLIPSISED,
          testId,
          "$destination: \"$shown\"$named line ${line + 1} of ${layout.lineCount} is " +
            "ellipsised, $dropped character(s) dropped (maxLines=$maxLines)",
        )
      }
    }

    if (layout.lineCount > 0) {
      val drawnTo = layout.getLineEnd(layout.lineCount - 1)
      // Trailing whitespace and newlines are not content: a layout that
      // ends short because the string ends in "\n" has lost nothing.
      val contentLength = full.trimEnd().length
      if (drawnTo < contentLength) {
        return Complaint(
          Loss.DROPPED_SILENTLY,
          testId,
          "$destination: \"$shown\"$named is drawn to character $drawnTo of $contentLength " +
            "after ${layout.lineCount} line(s) with NO ellipsis - ${contentLength - drawnTo} " +
            "character(s) appear nowhere (maxLines=$maxLines)",
        )
      }
    }

    if (availableHeightPx <= 0) return null
    if (layout.height <= availableHeightPx) return null
    return Complaint(
      Loss.OVERFLOWS_BOX,
      testId,
      "$destination: \"$shown\"$named needs ${layout.height}px and has ${availableHeightPx}px",
    )
  }

  /*
   * WHY THERE IS NO WIDTH CHECK HERE, HAVING BRIEFLY ADDED ONE.
   *
   * A width comparison was added alongside the height one, on the
   * reasoning that a box made tall enough and left too narrow would cut
   * the glyph off sideways. Run 34649197028 showed that reasoning is
   * wrong, and produced ten complaints that are all false:
   *
   *   FlightStyleGuide@1.0: "كل نمط ركن مستقل..." needs 284px wide and has 284px
   *   FlightStyleGuide@1.0: "الطيران خارج مدى البصر..." needs 247px wide and has 246px
   *   Start@2.0: "FPV Arabic Configurator" needs 193px wide and has 191px
   *   FlightStyleGuide@2.0: "كل رقم مأخوذ..." needs 263px wide and has 258px
   *
   * Nought to five pixels, on text that WRAPPED correctly. Text with no
   * line limit does not clip horizontally - it breaks to the next line -
   * and Layout.getLineWidth returns a float advance width that can exceed
   * the wrap constraint by a fraction for shaped Arabic. Comparing it
   * against the view's width measures the line breaker's rounding, not a
   * cut-off glyph.
   *
   * The height check already covers the case that motivated it: a box too
   * narrow for its text makes the text wrap to more lines, which makes it
   * taller than the box, which is exactly what this function detects. It
   * is what caught the step badges at "٤ needs 35px and has 28px".
   *
   * No tolerance was added instead. A threshold picked to make ten
   * complaints go away is a number chosen to produce a colour, and the
   * next real defect would have to be larger than whatever was picked.
   */

  /**
   * Whether this loss has been declared, and is therefore allowed.
   *
   * Only an ELLIPSISED loss can be, only when the control has a testID, and
   * only when that testID is written in [allowed]. Silently dropped text
   * and text overflowing its box are never declarable: there is nothing on
   * screen for an operator to notice, so there is no decision to record.
   *
   * A separate function rather than an inline filter so the policy can be
   * driven against a synthetic allowlist by
   * theEllipsisAllowlistOnlyExemptsNamedListedControls while the real one
   * stays empty.
   */
  private fun isDeclared(complaint: Complaint, allowed: Map<String, String>): Boolean =
    complaint.kind == Loss.ELLIPSISED &&
      complaint.testId != null &&
      complaint.testId in allowed

  /**
   * THE ALLOWLIST IS A GATE, SO IT IS TESTED LIKE ONE.
   *
   * Driven against a synthetic list, because the real ELLIPSIS_ALLOWED is
   * empty on purpose and must stay that way until a person fills it. Four
   * things have to hold, and the last two are the ones an allowlist
   * normally gets wrong:
   *
   *   a listed, named, ellipsised control    is declared
   *   an unlisted one                        is not
   *   an UNNAMED ellipsised control          is not, whatever is listed -
   *                                          there is no testID to write
   *                                          down, so there is nothing to
   *                                          exempt
   *   a silent drop or an overflow           is not, even when its testID
   *                                          appears in the list - an
   *                                          entry must not become a
   *                                          licence for every kind of
   *                                          loss on that control
   */
  @Test
  fun theEllipsisAllowlistOnlyExemptsNamedListedControls() {
    val allowed = mapOf("declared-control" to "shortened on purpose; full text in semantics")

    assertTrue(
      "a listed, named, ellipsised control was not treated as declared",
      isDeclared(Complaint(Loss.ELLIPSISED, "declared-control", "planted"), allowed),
    )
    assertFalse(
      "an ellipsised control that is NOT listed was treated as declared",
      isDeclared(Complaint(Loss.ELLIPSISED, "undeclared-control", "planted"), allowed),
    )
    assertFalse(
      "an UNNAMED ellipsised control was treated as declared. It has no testID, so no entry " +
        "can point at it and none may exempt it.",
      isDeclared(Complaint(Loss.ELLIPSISED, null, "planted"), allowed),
    )
    for (kind in listOf(Loss.DROPPED_SILENTLY, Loss.OVERFLOWS_BOX)) {
      assertFalse(
        "a $kind loss on a control whose testID is in the allowlist was treated as declared. " +
          "An entry declares an ELLIPSIS, not every way that control might lose text.",
        isDeclared(Complaint(kind, "declared-control", "planted"), allowed),
      )
    }

    assertTrue(
      "ELLIPSIS_ALLOWED is not empty. It starts empty on purpose: an entry added before the " +
        "measurement has run is a decision taken sight unseen that whatever the product happens " +
        "to truncate was intended. If a case genuinely belongs there, add it with its reason " +
        "and delete this assertion in the same commit, so the two are argued about together. " +
        "It currently holds: ${ELLIPSIS_ALLOWED.keys}",
      ELLIPSIS_ALLOWED.isEmpty(),
    )
  }

  /**
   * A TextView measured and laid out exactly as the detector will see it.
   *
   * [heightPx] null means "as tall as the text needs", which is the only
   * way to build a control that MUST NOT produce a complaint - a box of a
   * guessed height would be testing the guess.
   */
  private fun laidOut(
    activity: Activity,
    content: String,
    widthPx: Int,
    heightPx: Int? = null,
    lines: Int? = null,
    truncate: TextUtils.TruncateAt? = null,
  ): TextView {
    val view = TextView(activity)
    view.text = content
    view.setTextSize(20f)
    lines?.let { view.maxLines = it }
    truncate?.let { view.ellipsize = it }
    val widthSpec = View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY)
    val heightSpec = heightPx
      ?.let { View.MeasureSpec.makeMeasureSpec(it, View.MeasureSpec.EXACTLY) }
      ?: View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
    view.measure(widthSpec, heightSpec)
    view.layout(0, 0, widthPx, heightPx ?: view.measuredHeight)
    return view
  }

  /**
   * A LAYOUT THAT REALLY DOES STOP BEFORE ITS TEXT ENDS.
   *
   * StaticLayout.Builder.obtain(source, start, end, ...) lays out
   * [drawnCharacters] characters of [content] and no more - that is the
   * documented meaning of its range, not a behaviour being relied on - so
   * getLineEnd(lastLine) is [drawnCharacters] while the text it came from
   * is longer. No ellipsize is set, so getEllipsisCount is zero on every
   * line. That is exactly the state check 2 exists to name, and it is the
   * only way to reach it here: the TextView route that was expected to
   * produce it measurably does not on API 34 (see truncationComplaint).
   */
  private fun layoutStoppingBefore(
    content: String,
    drawnCharacters: Int,
    widthPx: Int,
  ): Layout {
    val paint = TextPaint().also { it.textSize = 20f }
    return StaticLayout.Builder
      .obtain(content, 0, drawnCharacters, paint, widthPx)
      .build()
  }

  /**
   * THE DETECTOR IS A SUBJECT, AND SO IS ITS SILENCE.
   *
   * Seven planted cases, all in one test. Four of them lose text and the
   * detector must name each; three are fully drawn and it must say nothing
   * about them. Both halves matter: a detector that complains about
   * everything is as useless as one that complains about nothing, and the
   * false-positive half is the half that was missing when a width
   * comparison was briefly added and produced ten complaints about
   * correctly wrapped Arabic.
   *
   * WHAT RUN 34723764981 CORRECTED HERE.
   *
   * "maxLines 1 with no ellipsis" was asserted to be DROPPED_SILENTLY on
   * the reasoning that a line limit makes Layout stop. On API 34 it came
   * back OVERFLOWS_BOX, with the layout needing 109px inside the 40px the
   * view was measured at: the line limit did not stop the layout, so every
   * character was laid out and the cut happens when it is drawn. The
   * expectation was wrong, not the detector - so the expectation is
   * corrected to what the platform does, and the case that the old one was
   * meant to cover is driven through [truncationOf] with a layout that
   * genuinely stops early. DROPPED_SILENTLY had no control at all until
   * that was added, and the assertion at the end of this test now says so
   * out loud: every kind must be exercised by something.
   *
   * Nothing here is left failing. The planted cuts are asserted to have
   * produced a complaint, which is a passing assertion about a detector
   * that works.
   */
  @Test
  fun theTruncationDetectorNamesEveryWayTextIsLostAndStaysSilentOtherwise() {
    val long =
      "سطر طويل جدًا لا يمكن أن يتسع في مربع بارتفاع سطر واحد فقط أبدًا ومعه كلمات أخرى تطيله"
    val stopsEarly = layoutStoppingBefore(long, long.length - 12, 200)
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.awaitTag(START)
      val results = scenario.readMain { activity ->
        linkedMapOf(
          "ellipsised at maxLines 1" to truncationComplaint(
            "control",
            laidOut(activity, long, 200, 40, lines = 1, truncate = TextUtils.TruncateAt.END),
          ),
          "maxLines 1 with no ellipsis" to truncationComplaint(
            "control",
            laidOut(activity, long, 200, 40, lines = 1),
          ),
          "wrapped inside a fixed height" to truncationComplaint(
            "control",
            laidOut(activity, long, 200, 20),
          ),
          // The height is deliberately far larger than anything this text
          // can need, so the overflow check CANNOT fire and the complaint
          // can only have come from the silent-drop check.
          "layout stops before the text ends" to truncationOf(
            destination = "control",
            testId = null,
            layout = stopsEarly,
            content = long,
            maxLines = 1,
            availableHeightPx = 10_000,
          ),
          "full multi-line Arabic" to truncationComplaint(
            "control",
            laidOut(activity, long, 200),
          ),
          "fully drawn, ends in a newline" to truncationComplaint(
            "control",
            laidOut(activity, "$long\n", 200),
          ),
          "fully drawn, ends in spaces" to truncationComplaint(
            "control",
            laidOut(activity, "$long   ", 200),
          ),
        )
      }
      results.forEach { (name, complaint) ->
        println("truncation control: $name -> ${complaint?.let { "${it.kind}: ${it.message}" } ?: "<silent>"}")
      }
      println(
        "truncation control: the early-stopping layout has ${stopsEarly.lineCount} line(s), " +
          "ends at character ${stopsEarly.getLineEnd(stopsEarly.lineCount - 1)} of " +
          "${long.length}, is ${stopsEarly.height}px tall",
      )

      for (name in listOf(
        "ellipsised at maxLines 1",
        "maxLines 1 with no ellipsis",
        "wrapped inside a fixed height",
        "layout stops before the text ends",
      )) {
        assertNotNull(
          "the detector said nothing about planted text that really is cut: $name. Every clean " +
            "result it produces on a real screen is worthless until it fires on this.",
          results[name],
        )
      }

      for (name in listOf(
        "full multi-line Arabic",
        "fully drawn, ends in a newline",
        "fully drawn, ends in spaces",
      )) {
        assertNull(
          "the detector complained about text that is fully drawn: $name -> " +
            "${results[name]?.message}. A detector that fires on correct text turns every " +
            "screen red and teaches the reader to ignore it.",
          results[name],
        )
      }

      // Each cut must be attributed to the mechanism that really produced
      // it, or one check could be doing all the work while another is dead.
      assertEquals(
        "the ellipsised control was not attributed to the ellipsis check",
        Loss.ELLIPSISED,
        results["ellipsised at maxLines 1"]?.kind,
      )
      assertEquals(
        "a layout that stops before the end of its text was not attributed to the silent-drop " +
          "check. It has ${stopsEarly.lineCount} line(s), ends at character " +
          "${stopsEarly.getLineEnd(stopsEarly.lineCount - 1)} of ${long.length} and reports " +
          "${stopsEarly.getEllipsisCount(stopsEarly.lineCount - 1)} ellipsised character(s) on " +
          "its last line",
        Loss.DROPPED_SILENTLY,
        results["layout stops before the text ends"]?.kind,
      )
      assertEquals(
        "the fixed-height control was not attributed to the overflow check",
        Loss.OVERFLOWS_BOX,
        results["wrapped inside a fixed height"]?.kind,
      )
      // Measured on API 34, not assumed: a TextView line limit without an
      // ellipsize lays every line out and clips at draw time, so this is
      // the overflow check's case too.
      assertEquals(
        "a TextView with maxLines and no ellipsize was not attributed to the overflow check. " +
          "Run 34723764981 measured it laying out every line inside a shorter box; if it now " +
          "stops the layout instead, the silent-drop check is what should fire and this " +
          "expectation is the thing to change.",
        Loss.OVERFLOWS_BOX,
        results["maxLines 1 with no ellipsis"]?.kind,
      )

      // NO CHECK MAY BE DEAD. Without this, a kind with no control could
      // sit unexercised for as long as the real screens happen not to
      // produce it - which is what happened to DROPPED_SILENTLY.
      val exercised = results.values.mapNotNull { it?.kind }.toSet()
      assertEquals(
        "not every way of losing text is exercised by a control here, so a check could be dead " +
          "and no result would say so. Unexercised: ${Loss.entries.toSet() - exercised}",
        Loss.entries.toSet(),
        exercised,
      )
    }
  }

  // ===================================================================
  // The eighteen that are not skipped, but asserted
  // ===================================================================

  /**
   * NOT A SKIP. With no flight controller attached the workspace must stay
   * shut, and this asserts it: pressing the configure card starts a
   * connection attempt that cannot succeed, and the tab host must never
   * appear. If a future change ever opened the workspace without a board -
   * a demo mode, a debug bypass, a mocked connection reaching production -
   * this fails, which is the only way "18 destinations need hardware" can
   * be a claim rather than an excuse.
   */
  @Test
  fun theWorkspaceStaysLockedWithoutABoardSoTheOtherEighteenAreUnreachableHere() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.awaitTag("start-configure")
      scenario.tapTag("start-configure")

      var appeared = false
      repeat(50) {
        if (scenario.hasTag("main-tabs")) appeared = true
        android.os.SystemClock.sleep(100)
      }
      assertTrue(
        "the configuration workspace opened with no flight controller attached - " +
          "configurationWorkspaceUnlocked is supposed to require kind === CONNECTED",
        !appeared,
      )
      assertTrue(
        "the start screen was left without opening the workspace, which is neither state",
        scenario.hasTag(START),
      )
      println(
        "REAL_HARDWARE_REQUIRED (${REAL_HARDWARE_REQUIRED.size}): " +
          REAL_HARDWARE_REQUIRED.joinToString(", "),
      )
    }
  }

  /**
   * WHY THE GATE CANNOT BE PASSED HERE, MEASURED RATHER THAN ASSERTED.
   *
   * The claim behind the eighteen is that the chain to CONNECTED starts at
   * an enumerated USB device and there is none. That is only worth
   * something if the emulator is asked. So this reads the platform's own
   * device list and prints it.
   *
   * If a device ever IS present, this fails - and it should, because the
   * whole classification in androidDestinationReachability.test.ts rests on
   * this being empty, and eighteen destinations would then be reachable
   * after all.
   *
   * The consequence of this fact, one layer up, is
   * ReactHostCampaignTest#listDevicesResolvesWithAnEmptyListRatherThanHangingOrFailing:
   * the shipped module asked on the same device answers with an empty list.
   */
  @Test
  fun theEmulatorHasNoUsbDeviceSoTheChainToConnectedCannotEvenStart() {
    val context = androidx.test.platform.app.InstrumentationRegistry
      .getInstrumentation().targetContext
    val usbManager =
      context.getSystemService(android.content.Context.USB_SERVICE) as android.hardware.usb.UsbManager
    val devices = usbManager.deviceList

    println("===== UI-X3B USB ENUMERATION ON THIS EMULATOR =====")
    println("  UsbManager.getDeviceList() size = ${devices.size}")
    devices.forEach { (name, device) ->
      println("    $name vendorId=${device.vendorId} productId=${device.productId}")
    }
    println("===================================================")

    assertTrue(
      "this emulator reports ${devices.size} USB device(s): ${devices.keys}. The eighteen " +
        "gated destinations are classified as needing real hardware BECAUSE this list is " +
        "empty, so that classification is now wrong and has to be redone rather than left " +
        "standing.",
      devices.isEmpty(),
    )
  }
}
