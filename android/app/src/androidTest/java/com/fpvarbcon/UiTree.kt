package com.fpvarbcon

import android.app.Activity
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyCharacterMap
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
 * here are real MotionEvents injected at the view's actual screen
 * coordinates - the same path a finger takes.
 *
 * WHY NOT Instrumentation.sendPointerSync. It injects with a TARGET UID:
 * the platform delivers the event only if the window that would receive it
 * is owned by the instrumented application, and otherwise rejects the whole
 * injection. Run 34418366288 hit that on both API 34 and API 36, seven
 * cases each, with the same message:
 *
 *   java.lang.IllegalArgumentException: Targeted input event injection
 *   from pid 5448 was not directed at a window owned by uid 10216.
 *
 * UiAutomation.injectInputEvent is the untargeted path - it is what
 * androidx.test.uiautomator's own InteractionController uses - and it is
 * not subject to that ownership check. Nothing else changes: the same
 * MotionEvents, at the same coordinates, through the same InputDispatcher.
 *
 * That mechanism is not asserted from a manual: InputInjectionControlTest
 * runs both APIs against the same coordinate on the device and records
 * which one is rejected, and a press is only believed when the app visibly
 * responds to it.
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
 * The accessibility name [view] EXPOSES: its own content description, or
 * failing that the text of the text nodes it contains. A Pressable that
 * sets accessibilityLabel gets the former; one that simply wraps a Text
 * gets the latter, and both are legitimate.
 *
 * This is the semantics a screen reader would read FROM. It is not what a
 * screen reader announced: nothing here enables TalkBack, and no result
 * derived from this function may be reported as a TalkBack measurement.
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
    "no drawn view tagged \"$testId\" within ${timeoutMillis}ms. Tags present: $lastSeen. " +
      "On top at that moment: ${activeWindowReport()}",
  )
}

/** True if a view with this testID is drawn right now, without waiting. */
fun ActivityScenario<MainActivity>.hasTag(testId: String): Boolean =
  readMain { activity -> findByTag(activity.window.decorView, testId)?.isShown == true }

/** Untargeted injection - see the note at the top of this file. */
private fun inject(event: InputEvent): Boolean =
  instrumentation().uiAutomation.injectInputEvent(event, true)

/** The centre of the view carrying [testId], in display coordinates. */
fun ActivityScenario<MainActivity>.centreOfTag(testId: String): FloatArray = readMain { activity ->
  val view = findByTag(activity.window.decorView, testId)
    ?: throw AssertionError("cannot locate \"$testId\": no such view")
  val location = IntArray(2)
  view.getLocationOnScreen(location)
  floatArrayOf(
    (location[0] + view.width / 2).toFloat(),
    (location[1] + view.height / 2).toFloat(),
  )
}

/**
 * A real press: ACTION_DOWN and ACTION_UP at [x], [y] in display
 * coordinates. Each event carries the uptime at which it is actually sent,
 * because a MotionEvent stamped with a future eventTime is not what a
 * finger produces and not what the dispatcher expects.
 */
fun tapAt(x: Float, y: Float) {
  val down = SystemClock.uptimeMillis()
  val press = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0)
  press.source = InputDevice.SOURCE_TOUCHSCREEN
  try {
    inject(press)
  } finally {
    press.recycle()
  }
  SystemClock.sleep(60)
  val release =
    MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)
  release.source = InputDevice.SOURCE_TOUCHSCREEN
  try {
    inject(release)
  } finally {
    release.recycle()
  }
  instrumentation().waitForIdleSync()
}

fun ActivityScenario<MainActivity>.tapTag(testId: String) {
  val centre = centreOfTag(testId)
  tapAt(centre[0], centre[1])
}

/**
 * The same press through Instrumentation.sendPointerSync, which injects
 * with a target UID. Returns what the platform did, so a test can record
 * it rather than a comment claiming it.
 */
fun probeTargetedInjection(x: Float, y: Float): String {
  val down = SystemClock.uptimeMillis()
  val press = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0)
  return try {
    instrumentation().sendPointerSync(press)
    // It went through, so a gesture is now open. Cancel it on the
    // untargeted path: leaving a dangling ACTION_DOWN behind would make
    // every later press in this process meaningless.
    val cancel =
      MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, x, y, 0)
    cancel.source = InputDevice.SOURCE_TOUCHSCREEN
    try {
      inject(cancel)
    } finally {
      cancel.recycle()
    }
    "ACCEPTED"
  } catch (rejected: IllegalArgumentException) {
    "REJECTED: ${rejected.message}"
  } catch (rejected: SecurityException) {
    "REJECTED: ${rejected.message}"
  } finally {
    press.recycle()
  }
}

/**
 * Which window is actually on top, and who owns it. When a press does not
 * arrive, this is the difference between "the control moved" and "something
 * else is covering the application".
 */
fun activeWindowReport(): String {
  val automation = instrumentation().uiAutomation
  val active = runCatching { automation.rootInActiveWindow }.getOrNull()
  val windows = runCatching {
    automation.windows.joinToString("; ") { window ->
      val bounds = Rect().also { window.getBoundsInScreen(it) }
      "type=${window.type} focused=${window.isFocused} active=${window.isActive} " +
        "package=${runCatching { window.root?.packageName }.getOrNull()} at $bounds"
    }
  }.getOrElse { "<windows unreadable: ${it.message}>" }
  return "activeWindow=${active?.packageName ?: "<none>"} windows=[$windows]"
}

fun pressBack() {
  val time = SystemClock.uptimeMillis()
  for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
    inject(
      KeyEvent(
        time,
        SystemClock.uptimeMillis(),
        action,
        KeyEvent.KEYCODE_BACK,
        0,
        0,
        KeyCharacterMap.VIRTUAL_KEYBOARD,
        0,
        0,
        InputDevice.SOURCE_KEYBOARD,
      ),
    )
  }
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
