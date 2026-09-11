package com.fpvarbcon

import android.graphics.Rect
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE WINDOW-TO-DISPLAY CONVERSION, PROVED WITHOUT A DEVICE THAT NEEDS IT.
 *
 * The press path measures a coordinate with getLocationOnScreen (display
 * space) and hit-tests with getGlobalVisibleRect (the root view's space),
 * and bridges the two by adding the root's own screen origin.
 *
 * Every emulator row in this matrix has reported that origin as (0, 0):
 *
 *   run 34544271920   root getLocationOnScreen : 0, 0
 *                     screen and root spaces differ : false
 *   run 34642729506   display=Rect(0, 0 - 320, 640) on every probe, whose
 *                     left and top ARE that origin
 *
 * With a zero offset the conversion is indistinguishable from doing
 * nothing. Deleting it entirely would leave every device test in this
 * suite green, which means those tests are not evidence that it is right -
 * they are evidence that it has never mattered yet. A phone with a
 * display cutout, a freeform or split-screen window, or a non-fullscreen
 * activity will not report (0, 0), and the harness would then be comparing
 * two different points while reporting confidently about one.
 *
 * So the arithmetic is driven here directly, with origins the device does
 * not supply. Nothing in this file launches an Activity or touches the
 * screen: it is a statement about a function, and it holds on every API
 * level regardless of what that level's default device looks like.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
@RunWith(AndroidJUnit4::class)
class CoordinateSpaceTest {

  @Test
  fun aZeroOriginLeavesTheRectangleWhereItIs() {
    val window = Rect(10, 20, 110, 140)
    assertEquals(
      "with the window at the display origin the two spaces are the same, so the rectangle " +
        "must come back unchanged",
      Rect(10, 20, 110, 140),
      toDisplaySpace(window, intArrayOf(0, 0)),
    )
  }

  @Test
  fun aNonZeroOriginMovesTheRectangleByExactlyThatMuch() {
    val window = Rect(10, 20, 110, 140)
    assertEquals(
      "a window whose origin is (37, 91) puts its own (10, 20) at (47, 111) on the display",
      Rect(47, 111, 147, 231),
      toDisplaySpace(window, intArrayOf(37, 91)),
    )
  }

  @Test
  fun theConversionDoesNotAlterTheRectangleItWasGiven() {
    val window = Rect(10, 20, 110, 140)
    toDisplaySpace(window, intArrayOf(37, 91))
    assertEquals(
      "toDisplaySpace moved the caller's own rectangle. getGlobalVisibleRect fills a buffer the " +
        "caller may go on to use, and a conversion that mutates it in place would corrupt " +
        "whatever reads it next",
      Rect(10, 20, 110, 140),
      window,
    )
  }

  /**
   * THE CASE THAT MAKES THE CONVERSION LOAD-BEARING.
   *
   * A control drawn at the top of a window that itself starts part-way
   * down the display. In window space the point is inside the control; on
   * the display it is further down by the window's own offset. Comparing
   * an injected DISPLAY coordinate against an unconverted WINDOW rectangle
   * gets both of these wrong, in opposite directions - which is exactly
   * the mistake that cannot be detected on a device reporting (0, 0).
   */
  @Test
  fun anInjectedDisplayPointOnlyMatchesAfterTheConversion() {
    val origin = intArrayOf(0, 120)
    val controlInWindowSpace = Rect(60, 0, 275, 48)
    val controlOnDisplay = toDisplaySpace(controlInWindowSpace, origin)

    // Where the harness would actually aim: the control's centre as
    // getLocationOnScreen reports it, which is display space.
    val injectedX = controlOnDisplay.centerX()
    val injectedY = controlOnDisplay.centerY()

    assertTrue(
      "the injected point ($injectedX, $injectedY) is not inside the control's converted " +
        "rectangle $controlOnDisplay, so the conversion is not producing the space the " +
        "coordinate is measured in",
      controlOnDisplay.contains(injectedX, injectedY),
    )
    assertFalse(
      "the injected display point ($injectedX, $injectedY) also fell inside the UNCONVERTED " +
        "window rectangle $controlInWindowSpace. This test is meant to distinguish the two " +
        "spaces and this origin does not, so it proves nothing - choose an offset larger than " +
        "the control's own height.",
      controlInWindowSpace.contains(injectedX, injectedY),
    )
  }

  @Test
  fun aNegativeOriginIsHandledLikeAnyOther() {
    // A window scrolled partly above the display - the status-bar inset
    // case reported as a negative origin rather than a positive one.
    assertEquals(
      "a negative origin must subtract, not be treated as zero",
      Rect(10, -30, 110, 90),
      toDisplaySpace(Rect(10, 20, 110, 140), intArrayOf(0, -50)),
    )
  }
}
