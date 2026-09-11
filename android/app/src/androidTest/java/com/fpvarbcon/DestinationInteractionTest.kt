package com.fpvarbcon

import android.graphics.Rect
import android.text.TextUtils
import android.view.View
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.facebook.react.modules.i18nmanager.I18nUtil
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
          if (!I18nUtil.instance.isRTL(activity)) {
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
            "I18nUtil.isRTL=${I18nUtil.instance.isRTL(activity)}\n      tagged: $tagged"
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

  @Test
  fun atFontScaleTwoNoTextIsSilentlyClipped() {
    setSystemFontScale("2.0")
    val applied = readSystemFontScale()
    println("system font_scale is now: $applied")
    assertTrue("the system font scale did not become 2.0, it is \"$applied\"", applied.startsWith("2"))

    val clipped = mutableListOf<String>()
    for (destination in REACHABLE) {
      onDestination(destination) { scenario ->
        scenario.scrollToEnd()
        val found = scenario.readMain { activity ->
          assertEquals(
            "${destination.name} did not adopt the 2.0 font scale",
            2.0f,
            activity.resources.configuration.fontScale,
            0.01f,
          )
          drawnViews(activity.window.decorView)
            .filterIsInstance<TextView>()
            .filter { !it.text.isNullOrBlank() }
            .mapNotNull { view -> clippingComplaint(destination.name, view) }
        }
        clipped += found
      }
    }
    assertTrue(
      "text is cut off at font scale 2.0:\n" + clipped.joinToString("\n"),
      clipped.isEmpty(),
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
  private fun clippingComplaint(destination: String, view: TextView): String? {
    val layout = view.layout ?: return null
    if (view.maxLines != Int.MAX_VALUE) return null
    val available = view.height - view.paddingTop - view.paddingBottom
    if (available <= 0) return null
    if (layout.height <= available) return null
    val text = view.text.toString().take(60)
    return "$destination: \"$text\" needs ${layout.height}px and has ${available}px"
  }

  /**
   * The detector is a real subject. A text view deliberately squeezed to
   * half the height its text needs must be complained about, otherwise
   * every clean result above would be meaningless.
   */
  @Test
  fun theClippingDetectorFiresOnTextThatReallyIsCut() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.awaitTag(START)
      val complaint = scenario.readMain { activity ->
        val squeezed = TextView(activity)
        squeezed.text = "سطر طويل جدًا لا يمكن أن يتسع في مربع بارتفاع سطر واحد فقط أبدًا"
        squeezed.setTextSize(20f)
        val width = View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY)
        val height = View.MeasureSpec.makeMeasureSpec(20, View.MeasureSpec.EXACTLY)
        squeezed.measure(width, height)
        squeezed.layout(0, 0, 200, 20)
        clippingComplaint("control", squeezed)
      }
      assertNotNull(
        "the clipping detector did not fire on text squeezed into a fifth of the height it " +
          "needs, so every clean result it produces is worthless",
        complaint,
      )
      println("clipping detector control: $complaint")
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
