package com.fpvarbcon

import android.app.Activity
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
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
 * RIGHT TO LEFT, MEASURED ON THE VIEWS REACT ACTUALLY MOUNTED.
 *
 * =====================================================================
 * WHY NEITHER decorView NOR I18nUtil IS ENOUGH ON ITS OWN
 * =====================================================================
 *
 * An earlier version of this check asserted on
 * `window.decorView.layoutDirection` and failed on API 34, 35 and 36 alike
 * with `expected:<1> but was:<0>`. That was the test being wrong. The decor
 * view belongs to the framework and resolves its direction from the
 * CONFIGURATION LOCALE; the emulator runs en-US, so it is left-to-right and
 * would be left-to-right no matter what the application did.
 *
 * The opposite mistake is just as easy: `I18nUtil.isRTL(context)` reads a
 * shared preference. It says what the application ASKED FOR. A build where
 * the preference was set and the surface never picked it up would satisfy
 * it while drawing every screen left-to-right.
 *
 * So this file asserts on the views React mounted, at four levels, because
 * each one can hold while the next one fails:
 *
 *   1  the switch          I18nUtil.isRTL is true
 *   2  the resolved flag   mounted views report LAYOUT_DIRECTION_RTL
 *   3  the geometry        a mounted view sits against the RIGHT edge of
 *                          its parent, not the left
 *   4  the order           in a row of two, the FIRST child is drawn to the
 *                          RIGHT of the second
 *
 * Level 4 is the one an operator would actually notice, and the one a
 * wrongly-resolved direction cannot fake: Yoga places child 0 at the start
 * edge, and in right-to-left the start edge is on the right.
 *
 * Each level is checked after a cold launch, after a recreation, and at
 * font scale 2.0, because a direction that survives the first mount and is
 * lost on rebuild is a defect an operator meets by rotating their phone.
 *
 * theDetectorFiresWhenOneElementIsFlippedToLtr is the mutation: one mounted
 * view is forced to LAYOUT_DIRECTION_LTR and every level that can see it
 * must complain. Without that, a clean result here would only mean the
 * detector never fires.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
@RunWith(AndroidJUnit4::class)
class RightToLeftLayoutTest {

  private companion object {
    const val START = "start-screen"

    /**
     * Two views count as being in one horizontal row when their vertical
     * spans overlap by at least this fraction of the shorter one. Views
     * that merely happen to share a few pixels are not a row.
     */
    const val ROW_OVERLAP_FRACTION = 0.5
  }

  @After
  fun restoreFontScale() {
    setSystemFontScale("1.0")
  }

  /** Views React mounted that carry a testID, which are the ones the product named. */
  private fun mountedNamedViews(root: View): List<View> =
    drawnViews(root).filter { it.tag is String }

  /**
   * Rows of two or more drawn siblings side by side: vertical spans
   * overlapping, horizontal spans not. These are the groups where the
   * start edge is visible as a POSITION rather than as a flag.
   */
  private fun horizontalRows(root: View): List<Pair<ViewGroup, List<View>>> =
    everyView(root).filterIsInstance<ViewGroup>().mapNotNull { group ->
      if (!group.isShown) return@mapNotNull null
      val children = (0 until group.childCount)
        .map { group.getChildAt(it) }
        .filter { it.visibility == View.VISIBLE && it.width > 0 && it.height > 0 && it.isShown }
      if (children.size < 2) return@mapNotNull null

      val bounds = children.map { child -> child to Rect().also { child.getGlobalVisibleRect(it) } }
      val sorted = bounds.sortedBy { it.second.left }
      val sideBySide = sorted.zipWithNext().all { (first, second) ->
        val a = first.second
        val b = second.second
        val shorter = minOf(a.height(), b.height())
        val overlap = minOf(a.bottom, b.bottom) - maxOf(a.top, b.top)
        a.right <= b.left && shorter > 0 && overlap >= shorter * ROW_OVERLAP_FRACTION
      }
      if (sideBySide) group to children else null
    }

  /** Every complaint the four levels can make about [activity], as text. */
  private fun rightToLeftComplaints(activity: Activity, moment: String): List<String> {
    val complaints = mutableListOf<String>()
    val content = activity.findViewById<View>(android.R.id.content)
      ?: return listOf("$moment: the Activity has no content view at all")

    // 1 - the switch
    if (!!I18nUtil.instance.isRTL(activity)) {
      complaints += "$moment: I18nUtil.isRTL is false, so React Native is laying the whole " +
        "application out left to right"
    }

    // 2 - the resolved flag on the views React mounted
    val named = mountedNamedViews(content)
    if (named.isEmpty()) {
      complaints += "$moment: no mounted view carries a testID, so there is nothing to judge - " +
        "the screen did not render"
    }
    val leftToRight = named.filter { it.layoutDirection != View.LAYOUT_DIRECTION_RTL }
    for (view in leftToRight) {
      complaints += "$moment: the mounted view tagged \"${view.tag}\" resolves " +
        "layoutDirection=${view.layoutDirection}, not ${View.LAYOUT_DIRECTION_RTL}"
    }

    // 3 and 4 - geometry and order.
    //
    // WHY THIS IS NOT ASSERTED ROW BY ROW. Yoga puts child 0 at the START
    // edge, and in right-to-left the start edge is the right one, so a row
    // laid out right-to-left draws its first child to the RIGHT of its
    // second. But a screen is allowed to contain rows that legitimately do
    // the opposite - flexDirection: 'row-reverse', or children positioned
    // absolutely - and failing on those would be this test inventing a
    // product rule that does not exist.
    //
    // What a left-to-right build cannot do is produce a screen where NOT
    // ONE row puts its first child on the right. That is the claim: it
    // fails a left-to-right tree and cannot be tripped by a row that was
    // deliberately reversed.
    val rows = horizontalRows(content)
    if (rows.isEmpty()) {
      complaints += "$moment: no horizontal row of two or more drawn siblings was found, so the " +
        "POSITION half of right-to-left could not be judged at all"
      return complaints
    }
    val ordered = rows.filter { (_, children) ->
      val first = Rect().also { children.first().getGlobalVisibleRect(it) }
      val second = Rect().also { children[1].getGlobalVisibleRect(it) }
      first.left > second.left
    }
    val startAligned = rows.filter { (group, children) ->
      val first = Rect().also { children.first().getGlobalVisibleRect(it) }
      val parent = Rect().also { group.getGlobalVisibleRect(it) }
      (parent.right - first.right) <= (first.left - parent.left)
    }
    if (ordered.isEmpty()) {
      complaints += "$moment: of ${rows.size} horizontal row(s) on this screen, not one draws " +
        "its first child to the right of its second. That is a left-to-right tree. Rows seen: " +
        rows.joinToString(", ") { (group, children) ->
          val label = group.tag as? String ?: group.javaClass.simpleName
          val a = Rect().also { children.first().getGlobalVisibleRect(it) }
          val b = Rect().also { children[1].getGlobalVisibleRect(it) }
          "$label[${a.left} then ${b.left}]"
        }
    }
    if (startAligned.isEmpty()) {
      complaints += "$moment: of ${rows.size} horizontal row(s), not one has its first child " +
        "closer to the RIGHT edge of its parent than to the left, so nothing on this screen is " +
        "aligned to a right-to-left start edge"
    }
    return complaints
  }

  private fun report(moment: String, activity: Activity) {
    val content = activity.findViewById<View>(android.R.id.content)
    val named = if (content == null) emptyList() else mountedNamedViews(content)
    val rows = if (content == null) emptyList() else horizontalRows(content)
    println(
      "  $moment: I18nUtil.isRTL=${!I18nUtil.instance.isRTL(activity)} " +
        "mountedNamedViews=${named.size} rtl=${named.count { it.layoutDirection == View.LAYOUT_DIRECTION_RTL }} " +
        "rows=${rows.size}",
    )
  }

  // ===================================================================

  @Test
  fun aColdLaunchMountsARightToLeftTree() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)

      val complaints = scenario.readMain { activity ->
        println("===== UI-X3B RIGHT-TO-LEFT LAYOUT =====")
        report("cold launch", activity)
        rightToLeftComplaints(activity, "cold launch")
      }
      assertTrue(complaints.joinToString("\n"), complaints.isEmpty())
    }
  }

  @Test
  fun aRecreationMountsARightToLeftTreeAgain() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      scenario.recreate()
      scenario.awaitTag(START)

      val complaints = scenario.readMain { activity ->
        report("after recreation", activity)
        rightToLeftComplaints(activity, "after recreation")
      }
      assertTrue(complaints.joinToString("\n"), complaints.isEmpty())
    }
  }

  @Test
  fun fontScaleTwoDoesNotLoseTheDirection() {
    setSystemFontScale("2.0")
    val applied = readSystemFontScale()
    assertTrue("the system font scale did not become 2.0, it is \"$applied\"", applied.startsWith("2"))

    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)

      val complaints = scenario.readMain { activity ->
        assertEquals(
          "the Activity did not adopt the 2.0 font scale",
          2.0f,
          activity.resources.configuration.fontScale,
          0.01f,
        )
        report("font scale 2.0", activity)
        rightToLeftComplaints(activity, "font scale 2.0")
      }
      assertTrue(complaints.joinToString("\n"), complaints.isEmpty())
    }
  }

  /**
   * THE MUTATION. One mounted view is forced left-to-right and the detector
   * has to say so. A clean result from the three cases above means nothing
   * unless this one fails when the tree is wrong.
   *
   * The flip is undone before the case ends, and the detector is run a
   * third time to prove the tree came back - so this case cannot leave a
   * left-to-right view behind for whatever runs next.
   */
  @Test
  fun theDetectorFiresWhenOneElementIsFlippedToLtr() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)

      val before = scenario.readMain { rightToLeftComplaints(it, "before the flip") }
      assertTrue(
        "the tree was already complaining before anything was flipped, so this control cannot " +
          "distinguish its own mutation from a pre-existing fault:\n" + before.joinToString("\n"),
        before.isEmpty(),
      )

      // The view itself is held, not looked up again: flipping a direction
      // triggers a re-layout, and re-reading "the first mounted view"
      // afterwards could return a different one and leave the real victim
      // flipped for whatever runs next.
      val victim = scenario.readMain { activity ->
        val content = activity.findViewById<View>(android.R.id.content)
        mountedNamedViews(content).firstOrNull()
      }
      assertNotNull("there was no mounted view to flip", victim)
      val flipped = scenario.readMain {
        victim!!.layoutDirection = View.LAYOUT_DIRECTION_LTR
        victim.tag as? String ?: victim.javaClass.simpleName
      }

      val during = scenario.readMain { rightToLeftComplaints(it, "with \"$flipped\" flipped") }
      println("mutation control: flipped \"$flipped\" to LTR, detector raised ${during.size} complaint(s)")
      during.forEach { println("    $it") }
      assertTrue(
        "one mounted view was forced to LAYOUT_DIRECTION_LTR and the detector said nothing. " +
          "Every clean right-to-left result in this file would therefore be worthless.",
        during.isNotEmpty(),
      )
      assertTrue(
        "the detector complained, but not about the view that was flipped (\"$flipped\"): " +
          during.joinToString("\n"),
        during.any { it.contains(flipped) },
      )

      scenario.readMain { victim!!.layoutDirection = View.LAYOUT_DIRECTION_RTL }
      val after = scenario.readMain { rightToLeftComplaints(it, "after restoring the flip") }
      assertTrue(
        "the flip was not undone, so this case has left a left-to-right view behind:\n" +
          after.joinToString("\n"),
        after.isEmpty(),
      )
    }
  }
}
