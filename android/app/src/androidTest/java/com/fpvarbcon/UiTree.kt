package com.fpvarbcon

import android.app.Activity
import android.graphics.Rect
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.atomic.AtomicReference

/**
 * READING AND DRIVING THE REAL VIEW TREE OF A REACT NATIVE SCREEN.
 *
 * WHY NOT ESPRESSO MATCHERS. Espresso's idling assumes a view hierarchy
 * that settles when the main looper is idle. React Native renders from the
 * JavaScript thread and commits to the shadow tree asynchronously, so the
 * main looper can be idle with the screen not yet drawn. Everything here
 * therefore polls for a CONDITION with a deadline and asserts on the
 * condition, never on elapsed time - there is no barrier to await across
 * the bridge, and a fixed sleep would be the wall-clock guess this campaign
 * exists to remove.
 *
 * WHY NOT performClick(). React Native does not attach OnClickListeners.
 * A Pressable receives touches through the view group's own touch handling
 * and the JS touch dispatcher, so performClick() fires nothing. Presses
 * here are real MotionEvents injected through the instrumentation, at the
 * view's actual screen coordinates - the same path a finger takes.
 *
 * testID is readable from the native tree because React Native's
 * BaseViewManager sets it as the view's tag as well as an id resource, so
 * view.getTag() is the testID string.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */

/** Poll interval for the condition waits below. */
private const val POLL_MILLIS = 100L

/** How long a React Native screen is given to appear before it is a failure. */
const val RENDER_TIMEOUT_MILLIS = 40_000L

private fun instrumentation() = InstrumentationRegistry.getInstrumentation()

/** Runs [block] on the main thread and returns its result. */
fun <T> ActivityScenario<MainActivity>.readMain(block: (Activity) -> T): T {
  val slot = AtomicReference<T>()
  onActivity { activity -> slot.set(block(activity)) }
  return slot.get()
}

fun everyView(root: View, into: MutableList<View> = mutableListOf()): MutableList<View> {
  into.add(root)
  if (root is ViewGroup) {
    for (index in 0 until root.childCount) everyView(root.getChildAt(index), into)
  }
  return into
}

/** Views that are drawn: visible, non-transparent, with a real size and a real position. */
fun drawnViews(root: View): List<View> =
  everyView(root).filter { view ->
    view.visibility == View.VISIBLE &&
      view.alpha > 0f &&
      view.width > 0 &&
      view.height > 0 &&
      view.isShown &&
      view.getGlobalVisibleRect(Rect())
  }

/**
 * What TalkBack would announce for [view]: its own content description, or
 * failing that the text of the text nodes it contains. A Pressable that
 * sets accessibilityLabel gets the former; one that simply wraps a Text
 * gets the latter, and both are legitimate.
 */
fun accessibleName(view: View): String? {
  val described = view.contentDescription?.toString()?.trim()
  if (!described.isNullOrEmpty()) return described
  val text = everyView(view)
    .filterIsInstance<TextView>()
    .filter { it.visibility == View.VISIBLE }
    .mapNotNull { it.text?.toString()?.trim() }
    .filter { it.isNotEmpty() }
  return if (text.isEmpty()) null else text.joinToString(" ")
}

fun findByTag(root: View, testId: String): View? =
  everyView(root).firstOrNull { it.tag == testId }

/**
 * Waits until a view carrying [testId] is drawn, then returns nothing -
 * callers re-read it on the main thread when they need it. Fails the test
 * with the tags that WERE present, which is the difference between "the
 * screen did not open" and "the screen opened and the control is gone".
 */
fun ActivityScenario<MainActivity>.awaitTag(
  testId: String,
  timeoutMillis: Long = RENDER_TIMEOUT_MILLIS,
) {
  val deadline = SystemClock.uptimeMillis() + timeoutMillis
  var lastSeen: List<String> = emptyList()
  while (SystemClock.uptimeMillis() < deadline) {
    val found = readMain { activity ->
      val root = activity.window.decorView
      val match = findByTag(root, testId)
      lastSeen = everyView(root).mapNotNull { it.tag as? String }.sorted().distinct()
      match != null && match.isShown
    }
    if (found) return
    instrumentation().waitForIdleSync()
    SystemClock.sleep(POLL_MILLIS)
  }
  throw AssertionError(
    "no drawn view tagged \"$testId\" within ${timeoutMillis}ms. Tags present: $lastSeen",
  )
}

/** True if a view with this testID is drawn right now, without waiting. */
fun ActivityScenario<MainActivity>.hasTag(testId: String): Boolean =
  readMain { activity -> findByTag(activity.window.decorView, testId)?.isShown == true }

/**
 * A real press: ACTION_DOWN and ACTION_UP at the view's centre on screen,
 * injected through the instrumentation so React Native's touch dispatcher
 * sees exactly what a finger produces.
 */
fun ActivityScenario<MainActivity>.tapTag(testId: String) {
  val centre = readMain { activity ->
    val view = findByTag(activity.window.decorView, testId)
      ?: throw AssertionError("cannot press \"$testId\": no such view")
    val location = IntArray(2)
    view.getLocationOnScreen(location)
    floatArrayOf(
      (location[0] + view.width / 2).toFloat(),
      (location[1] + view.height / 2).toFloat(),
    )
  }
  val down = SystemClock.uptimeMillis()
  val press = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, centre[0], centre[1], 0)
  val release = MotionEvent.obtain(down, down + 60, MotionEvent.ACTION_UP, centre[0], centre[1], 0)
  try {
    instrumentation().sendPointerSync(press)
    instrumentation().sendPointerSync(release)
  } finally {
    press.recycle()
    release.recycle()
  }
  instrumentation().waitForIdleSync()
}

fun pressBack() {
  instrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
  instrumentation().waitForIdleSync()
}

/** The outermost vertical scroll container on screen, if the screen has one. */
fun outermostScroll(root: View): ScrollView? =
  everyView(root).filterIsInstance<ScrollView>().firstOrNull { it.isShown && it.childCount > 0 }

/**
 * Scrolls the screen to its very end and waits until the offset stops
 * changing, so "the bottom action" is judged after the content has
 * actually finished moving rather than mid-fling.
 */
fun ActivityScenario<MainActivity>.scrollToEnd(): Boolean {
  var moved = false
  var previous = -1
  repeat(40) {
    val offset = readMain { activity ->
      val scroll = outermostScroll(activity.window.decorView) ?: return@readMain -1
      moved = true
      scroll.scrollTo(0, scroll.getChildAt(0).height)
      scroll.scrollY
    }
    if (offset < 0) return false
    instrumentation().waitForIdleSync()
    if (offset == previous) return moved
    previous = offset
    SystemClock.sleep(POLL_MILLIS)
  }
  return moved
}

/** The display rectangle the app is allowed to draw in. */
fun ActivityScenario<MainActivity>.displayBounds(): Rect = readMain { activity ->
  val rect = Rect()
  activity.window.decorView.getGlobalVisibleRect(rect)
  rect
}

/** Sets the system font scale through the shell, as a user would in Settings. */
fun setSystemFontScale(scale: String) {
  instrumentation().uiAutomation
    .executeShellCommand("settings put system font_scale $scale")
    .close()
  instrumentation().waitForIdleSync()
  SystemClock.sleep(500)
}

fun readSystemFontScale(): String {
  val output = instrumentation().uiAutomation.executeShellCommand("settings get system font_scale")
  return output.use { descriptor ->
    android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { stream ->
      stream.readBytes().toString(Charsets.UTF_8).trim()
    }
  }
}
