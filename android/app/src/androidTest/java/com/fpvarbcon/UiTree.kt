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
 * WHY A PRESS SCROLLS FIRST. Taking the finger's path seriously means
 * taking its reach seriously: a finger cannot press what is not on the
 * screen. Being in the view tree is not the same as being on the display,
 * and run 34544271920 measured two controls sitting hundreds of pixels
 * below the bottom of a 320x640 screen while every presence check in this
 * file was satisfied. See bringTagOnScreen for the numbers and for what
 * the harness was doing with them.
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

/** How long a scroll is given to bring a control onto the display. */
const val SCROLL_SETTLE_TIMEOUT_MILLIS = 8_000L

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

/**
 * Waits like [awaitTag] but ANSWERS instead of throwing.
 *
 * For a caller that has something to say about a false - which screen it
 * is on instead, whether the key that should have taken it there was even
 * accepted - a thrown AssertionError from inside the wait would replace
 * that report with a generic one.
 */
fun ActivityScenario<MainActivity>.awaitTagOrNull(
  testId: String,
  timeoutMillis: Long = RENDER_TIMEOUT_MILLIS,
): Boolean {
  val deadline = SystemClock.uptimeMillis() + timeoutMillis
  while (SystemClock.uptimeMillis() < deadline) {
    if (hasTag(testId)) return true
    instrumentation().waitForIdleSync()
    SystemClock.sleep(POLL_MILLIS)
  }
  return false
}

/** True if a view with this testID is drawn right now, without waiting. */
fun ActivityScenario<MainActivity>.hasTag(testId: String): Boolean =
  readMain { activity -> findByTag(activity.window.decorView, testId)?.isShown == true }

/** Untargeted injection - see the note at the top of this file. */
private fun inject(event: InputEvent): Boolean =
  instrumentation().uiAutomation.injectInputEvent(event, true)

/**
 * WHERE A VIEW IS ON THE DISPLAY: its getLocationOnScreen position and its
 * own width and height, unclipped.
 *
 * This is the right rectangle to AIM at. getLocationOnScreen reports the
 * display position, which is the space MotionEvents are injected in, so
 * taking a centre from it is correct and always was - the coordinate
 * (167.5, 910.0) that run 34544271920 rejected was a truthful answer to
 * "where is this view", asked about a view that had been scrolled off the
 * screen. See [bringTagOnScreen] for what was actually missing.
 *
 * It is the wrong rectangle to HIT-TEST with, because it does not know
 * about clipping: a scroll container's own rectangle spans its entire
 * content, far past the viewport, so a point hundreds of pixels below the
 * screen still falls inside it. [visibleScreenRectOf] is the hit-testing
 * counterpart.
 */
fun screenRectOf(view: View): Rect {
  val location = IntArray(2)
  view.getLocationOnScreen(location)
  return Rect(location[0], location[1], location[0] + view.width, location[1] + view.height)
}

/**
 * WHAT OF A VIEW IS ACTUALLY VISIBLE, in display coordinates, or null when
 * none of it is.
 *
 * getGlobalVisibleRect is the platform's own clipping answer: it intersects
 * the view with every ancestor's bounds and with the window, and returns
 * false when nothing survives. That is exactly the question a press has to
 * ask, and it is the half [screenRectOf] cannot answer - run 34548620198
 * showed a ReactViewGroup scroll container being reported as the view under
 * (167.5, 910.0) on a 320x640 display, because its unclipped rectangle
 * covers the whole scrollable content while its VISIBLE rectangle stops at
 * the viewport.
 *
 * It reports in the root view's coordinates, so the root's own screen
 * position is added to bring it into display space. On the measured device
 * that offset is (0, 0) - run 34544271920 printed "screen and root spaces
 * differ : false" - and adding it anyway means the press path does not
 * depend on that happening to be true.
 */
fun visibleScreenRectOf(root: View, view: View): Rect? {
  val rect = Rect()
  if (!view.getGlobalVisibleRect(rect)) return null
  return toDisplaySpace(rect, rootOriginOf(root))
}

/** Where the root view's own origin sits on the display. */
fun rootOriginOf(root: View): IntArray = IntArray(2).also { root.getLocationOnScreen(it) }

/**
 * A rectangle in the root view's (window) coordinates, expressed on the
 * DISPLAY, given where the root's origin sits.
 *
 * Split out as arithmetic on purpose. Every emulator row in this matrix so
 * far has reported a root origin of (0, 0), which makes the two spaces
 * identical and makes this conversion impossible to tell apart from doing
 * nothing at all. A conversion that is only ever exercised with a zero
 * offset has never been exercised. CoordinateSpaceTest drives this
 * function with a non-zero origin directly, so the arithmetic is proved
 * whatever the device happens to report.
 */
fun toDisplaySpace(windowRect: Rect, rootOnScreen: IntArray): Rect =
  Rect(windowRect).also { it.offset(rootOnScreen[0], rootOnScreen[1]) }

/**
 * SCROLLS THE CONTROL ONTO THE DISPLAY BEFORE ANYONE AIMS AT IT.
 *
 * awaitTag is satisfied by isShown, and isShown is true for a view that is
 * attached and visible up its whole chain - INCLUDING one scrolled far past
 * the bottom of the screen. So a control could be "there" by every check
 * this file made and still be nowhere a finger could reach.
 *
 * That is exactly what run 34544271920 found on a 320x640 display:
 *
 *   start-firmware            at y 886, centre injected at (167, 910)
 *   start-flight-style-guide  at y 1247, centre injected at (189, 1271)
 *
 * Both coordinates are below the 640-pixel bottom of the display, so the
 * events went to a coordinate no window contains and nothing happened -
 * while start-configure, at y 530, worked. The controls are not broken and
 * the product is not broken: the start screen is a ReactScrollView and a
 * user scrolls to them. The harness did not.
 *
 * requestRectangleOnScreen asks the ancestors - the ReactScrollView among
 * them - to bring the view's own rectangle into view immediately, which is
 * the same mechanism the platform uses for focus and accessibility. The
 * loop then waits for the position to STOP CHANGING and for the view to be
 * genuinely visible with its centre inside the display, because a scroll
 * that is still moving would be measured mid-flight.
 */
fun ActivityScenario<MainActivity>.bringTagOnScreen(testId: String) {
  val deadline = SystemClock.uptimeMillis() + SCROLL_SETTLE_TIMEOUT_MILLIS
  var previous: Rect? = null
  var lastRect = Rect()
  var lastDisplay = Rect()
  var lastVisible = false
  var firstRect: Rect? = null
  var iterations = 0
  while (SystemClock.uptimeMillis() < deadline) {
    iterations++
    val settled = readMain { activity ->
      val root = activity.window.decorView
      val view = findByTag(root, testId)
        ?: throw AssertionError("cannot locate \"$testId\": no such view")
      view.requestRectangleOnScreen(Rect(0, 0, view.width, view.height), true)
      val now = screenRectOf(view)
      val stable = now == previous
      previous = now
      lastRect = now
      if (firstRect == null) firstRect = Rect(now)
      lastDisplay = screenRectOf(root)
      lastVisible = view.getGlobalVisibleRect(Rect())
      // The centre is what gets injected, so the centre is what has to be
      // on the display - not merely some corner of the view.
      stable && lastVisible && lastDisplay.contains(now.centerX(), now.centerY())
    }
    if (settled) return
    instrumentation().waitForIdleSync()
    SystemClock.sleep(POLL_MILLIS)
  }
  // WHY THIS FAILURE PRINTS A CHAIN AND NOT JUST A RECTANGLE.
  //
  // Run 34649197028 failed here with
  //
  //   "start-flight-style-guide" could not be brought onto the display
  //   within 8000ms. It occupies Rect(-68, 29 - 0, 640)
  //
  // - 68 wide, 611 tall, entirely to the left of a 320x640 display, for a
  // control that measured 226x48 and scrolled onto the screen correctly
  // elsewhere in the SAME run. A rectangle alone cannot say whether the
  // product laid the control out there or the harness measured it during
  // a configuration change, and those need opposite repairs. So the class,
  // the ancestors with their own rectangles, the font scale and the
  // lifecycle state go with it.
  // WHAT RUN 34780928743 STILL COULD NOT ANSWER, AND WHAT WAS ADDED.
  //
  // That run printed the chain and it named a suspect precisely:
  //
  //   ReactViewGroup[start-flight-style-guide] at Rect(-68, 29 - 0, 640)
  //   ReactViewGroup                          at Rect(0, -14856 - 0, 6427)
  //   ReactScrollView[start-screen]           at Rect(0, 24 - 320, 640)
  //
  // The scroll view is the right size. Its CONTENT view is 0 wide and 21283
  // tall - which is what a text tree measured at a width of zero looks like,
  // every line one glyph - and the control inside it hangs 68px to the LEFT
  // of x=0 because an RTL child of a zero-width parent is laid out from a
  // right edge at zero. The control's real size elsewhere in the same run is
  // 226x48.
  //
  // Two explanations remain and they need OPPOSITE repairs:
  //
  //   STALE     a layout pass is pending and never completed, so these are
  //             the numbers of a tree caught mid-reconfiguration. The font
  //             scale is system state and this class changes it, so a
  //             configuration change arriving during startup is a real
  //             possibility.
  //   REAL      Android considers this layout FINISHED at width zero, and
  //             the product would look like this to an operator.
  //
  // isLayoutRequested separates them: true means a pass is still owed, false
  // means the framework thinks it is done. The size of each ancestor, whether
  // it is attached, the Activity's identity, the font scale the DEVICE
  // reports, and the first rectangle measured against the last one all go
  // with it - and then the layout is forced once and measured again, because
  // "a forced pass fixes it" is the difference between the two answers. The
  // case still fails either way; this is evidence, not a retry.
  val context = readMain { activity ->
    val view = findByTag(activity.window.decorView, testId)
    val chain = StringBuilder()
    var current: View? = view
    var depth = 0
    while (current != null && depth < 14) {
      chain.append("\n      ${current.javaClass.simpleName}")
      (current.tag as? String)?.let { chain.append("[$it]") }
      chain.append(
        " at ${screenRectOf(current)} ${current.width}x${current.height}" +
          " shown=${current.isShown} attached=${current.isAttachedToWindow}" +
          " layoutRequested=${current.isLayoutRequested}",
      )
      current = current.parent as? View
      depth++
    }
    val decor = activity.window.decorView
    "view=${view?.javaClass?.simpleName ?: "<gone>"} " +
      "fontScale=${activity.resources.configuration.fontScale} " +
      "layoutDirection=${decor.layoutDirection} " +
      "activity=${activity.javaClass.simpleName}@${Integer.toHexString(activity.hashCode())} " +
      "decor=${decor.width}x${decor.height} decorLayoutRequested=${decor.isLayoutRequested}" +
      "\n    ancestors, nearest first:$chain"
  }

  // ONE FORCED LAYOUT, MEASURED. If the rectangle becomes sane the tree was
  // stale; if it does not, the layout is what the product produced.
  val forced = readMain { activity ->
    val root = activity.window.decorView
    root.requestLayout()
    root.invalidate()
    screenRectOf(findByTag(root, testId) ?: root)
  }
  instrumentation().waitForIdleSync()
  val recheckDeadline = SystemClock.uptimeMillis() + 2_000L
  var afterForcedLayout = forced
  while (SystemClock.uptimeMillis() < recheckDeadline) {
    afterForcedLayout = readMain { activity ->
      val root = activity.window.decorView
      screenRectOf(findByTag(root, testId) ?: root)
    }
    if (afterForcedLayout != lastRect) break
    instrumentation().waitForIdleSync()
    SystemClock.sleep(POLL_MILLIS)
  }

  throw AssertionError(
    "\"$testId\" could not be brought onto the display within " +
      "${SCROLL_SETTLE_TIMEOUT_MILLIS}ms over $iterations measurement(s). It occupies " +
      "$lastRect on the display, the display area is $lastDisplay, and getGlobalVisibleRect " +
      "returned $lastVisible. A press aimed at a control in this state is injected at a " +
      "coordinate no window contains, so it would report nothing happening whether or not the " +
      "control works.\n    first measured at ${firstRect ?: "<never measured>"}, last at " +
      "$lastRect, after one forced layout at $afterForcedLayout (a change here means the tree " +
      "was stale rather than laid out this way)\n    device font_scale=" +
      "${readSystemFontScale()}\n    $context",
  )
}

/**
 * The centre of the view carrying [testId], in display coordinates, AFTER
 * the control has been scrolled onto the display - see [bringTagOnScreen]
 * for what happens when that step is missing.
 */
fun ActivityScenario<MainActivity>.centreOfTag(testId: String): FloatArray {
  bringTagOnScreen(testId)
  return readMain { activity ->
    val view = findByTag(activity.window.decorView, testId)
      ?: throw AssertionError("cannot locate \"$testId\": no such view")
    val rect = screenRectOf(view)
    floatArrayOf(rect.exactCenterX(), rect.exactCenterY())
  }
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
 * THE DEEPEST DRAWN VIEW UNDER A POINT, in the order the platform would
 * hand it a touch. Children are visited after their parent and later
 * siblings after earlier ones, so the LAST match in traversal order is the
 * one drawn on top - which is the one a finger would hit.
 *
 * [x] and [y] are DISPLAY coordinates, the same space centreOfTag measures
 * in and the same space the MotionEvents are injected in.
 *
 * The candidates are compared against their CLIPPED rectangles, not their
 * own bounds. Run 34548620198 showed why: at (167.5, 910.0) on a 320x640
 * display - below the bottom of the screen - hit-testing against unclipped
 * bounds returned a ReactViewGroup, because a scroll container's own
 * rectangle spans its whole content. Nothing is visible at that point, so
 * the honest answer there is no view at all, and [visibleScreenRectOf]
 * gives it by asking the platform what survives every ancestor's clip.
 */
fun viewAt(root: View, x: Float, y: Float): View? =
  everyView(root)
    .filter { view ->
      view.visibility == View.VISIBLE && view.isShown && view.alpha > 0f &&
        visibleScreenRectOf(root, view)?.contains(x.toInt(), y.toInt()) == true
    }
    .lastOrNull()

/**
 * Whether a press that resolved to [hit] is a press ON [target].
 *
 * Only two things count: the view under the point IS the control, or it is
 * genuinely INSIDE it - a Pressable's inner Text carries no testID of its
 * own, so requiring tag equality would reject real presses.
 *
 * An ANCESTOR of the control does not count, and used to. That is how run
 * 34548620198 reported a press landing on "start-firmware" at a coordinate
 * below the bottom of the screen: the view found there was the scroll
 * container the button lives in, and "the hit contains the target" accepted
 * it. A finger on the scrolling surface is not a press on a button inside
 * it, however far down that button is.
 */
fun landedOn(hit: View?, target: View?): Boolean =
  hit != null && target != null && (hit === target || everyView(target).contains(hit))

/** What a press was able to establish about itself. */
data class TapEvidence(
  val testId: String,
  val x: Float,
  val y: Float,
  /** The package owning the window the platform considers active. */
  val activeWindowPackage: String?,
  /** The testID of the topmost drawn view at the coordinate, if it has one. */
  val topmostTagAtPoint: String?,
  /** Whether the target view is the topmost one at the point, or contains it. */
  val landedOnTarget: Boolean,
  /** What UiAutomation reported for the two injections. */
  val downAccepted: Boolean,
  val upAccepted: Boolean,
) {
  override fun toString(): String =
    "press on \"$testId\" at ($x, $y): activeWindow=$activeWindowPackage " +
      "topmostTagAtPoint=$topmostTagAtPoint landedOnTarget=$landedOnTarget " +
      "down=$downAccepted up=$upAccepted"
}

/**
 * A press that records what it can prove about itself, rather than one
 * that is assumed to have happened.
 *
 * It answers three of the four questions a press has to answer - whose
 * window was in front, what was actually under the coordinate, and whether
 * the platform accepted the events. The fourth, whether the APPLICATION
 * moved, is not something a press can answer about itself: only the caller
 * can, by waiting for a production state to change afterwards.
 *
 * Nothing here calls a React handler, a navigation method or performClick.
 * The only thing it does to the application is put two MotionEvents into
 * InputDispatcher at a coordinate.
 */
fun ActivityScenario<MainActivity>.tapTagWithEvidence(testId: String): TapEvidence {
  val centre = centreOfTag(testId)
  val x = centre[0]
  val y = centre[1]

  val activePackage = runCatching {
    instrumentation().uiAutomation.rootInActiveWindow?.packageName?.toString()
  }.getOrNull()

  val (topmostTag, landed) = readMain { activity ->
    val root = activity.window.decorView
    val target = findByTag(root, testId)
    val hit = viewAt(root, x, y)
    val within = landedOn(hit, target)
    (hit?.tag as? String) to within
  }

  val down = SystemClock.uptimeMillis()
  val press = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0)
  press.source = InputDevice.SOURCE_TOUCHSCREEN
  val downAccepted = try {
    inject(press)
  } finally {
    press.recycle()
  }
  SystemClock.sleep(60)
  val release = MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)
  release.source = InputDevice.SOURCE_TOUCHSCREEN
  val upAccepted = try {
    inject(release)
  } finally {
    release.recycle()
  }
  instrumentation().waitForIdleSync()

  return TapEvidence(testId, x, y, activePackage, topmostTag, landed, downAccepted, upAccepted)
}

/**
 * Puts a full-screen clickable view over the application's content and
 * runs [block] with it in place, then removes it.
 *
 * This is how "the press worked because of WHERE it landed" is proved: the
 * same coordinate is pressed with something else on top of the control, and
 * nothing may happen. Changing the coordinate instead would leave open the
 * possibility that the coordinate was never what mattered.
 */
fun <T> ActivityScenario<MainActivity>.withContentOccluded(block: () -> T): T {
  val added = readMain { activity ->
    val content = activity.findViewById<ViewGroup>(android.R.id.content)
    val blocker = View(activity)
    blocker.isClickable = true
    blocker.tag = "test-only-occluder"
    content.addView(
      blocker,
      ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    blocker
  }
  instrumentation().waitForIdleSync()
  return try {
    block()
  } finally {
    readMain { activity ->
      activity.findViewById<ViewGroup>(android.R.id.content).removeView(added)
    }
    instrumentation().waitForIdleSync()
  }
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

/**
 * Sends a real BACK key, down and up, and returns whether the PLATFORM
 * accepted both injections.
 *
 * The return value matters: "back did nothing" and "back was never
 * delivered" look identical from the screen afterwards, and only one of
 * them is a fact about the application. A caller that asserts on where the
 * app ended up should report this alongside it.
 */
fun pressBack(): Boolean {
  val time = SystemClock.uptimeMillis()
  var accepted = true
  for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
    accepted = inject(
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
    ) && accepted
  }
  instrumentation().waitForIdleSync()
  return accepted
}

/** Every testID currently drawn, sorted - what the screen says it is. */
fun ActivityScenario<MainActivity>.visibleTags(): List<String> = readMain { activity ->
  everyView(activity.window.decorView)
    .filter { it.isShown }
    .mapNotNull { it.tag as? String }
    .distinct()
    .sorted()
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

/**
 * SWEEPS THE WHOLE SCREEN PAST THE VIEWPORT, running [atEachRest] once at
 * the top and once after every page of scrolling.
 *
 * A check that scrolls to the end and then measures has only measured what
 * happens to be on screen at the end. Run 34642729506 reported the firmware
 * flasher's step badges "٤" and "٥" as cut off and said nothing about "١",
 * "٢" or "٣" - not because those were fine, but because they were above the
 * fold when the one measurement was taken. Anything measured this way is
 * measured for every part of the screen an operator can reach.
 *
 * A screen with nothing to scroll gets exactly one pass, which is correct:
 * all of it was already visible.
 */
fun ActivityScenario<MainActivity>.scrollSweep(atEachRest: () -> Unit) {
  readMain { activity -> outermostScroll(activity.window.decorView)?.scrollTo(0, 0) }
  instrumentation().waitForIdleSync()
  atEachRest()

  repeat(40) {
    val moved = readMain { activity ->
      val scroll = outermostScroll(activity.window.decorView) ?: return@readMain false
      val before = scroll.scrollY
      // Four fifths of a viewport, so consecutive pages overlap and
      // nothing can fall between two measurements.
      scroll.scrollBy(0, (scroll.height * 4) / 5)
      scroll.scrollY != before
    }
    if (!moved) return
    instrumentation().waitForIdleSync()
    SystemClock.sleep(POLL_MILLIS)
    atEachRest()
  }
}

/** The display rectangle the app is allowed to draw in. */
fun ActivityScenario<MainActivity>.displayBounds(): Rect = readMain { activity ->
  val rect = Rect()
  activity.window.decorView.getGlobalVisibleRect(rect)
  rect
}

/** How long the platform is given to adopt a font scale that was written. */
const val FONT_SCALE_SETTLE_TIMEOUT_MILLIS = 15_000L

/**
 * Sets the system font scale through the shell, as a user would in
 * Settings, AND WAITS UNTIL THE DEVICE SAYS IT HAS IT.
 *
 * WHAT THIS USED TO DO, AND WHY THAT WAS WRONG. It wrote the setting,
 * called waitForIdleSync and then slept 500ms. A font scale is not a value
 * this process owns: writing it makes the platform recompute the global
 * configuration and push it to every process, and 500ms was a guess about
 * how long that takes with nothing checking the guess. A case that launched
 * an Activity immediately afterwards could therefore start it into a
 * configuration change in flight.
 *
 * That is not offered as the cause of anything. It is a wait with no
 * condition, which cannot be right whatever else is true, and run
 * 34780928743 produced the kind of failure a racing configuration change
 * would produce: a scroll view 320 wide whose content view was 0 wide and
 * 21283 tall for eight seconds.
 *
 * It now polls two sources until both agree, or fails saying what each one
 * said:
 *
 *   settings get system font_scale   the value that was written
 *   dumpsys activity config          the scale the platform has actually
 *                                    adopted for the current global
 *                                    configuration
 *
 * The second is a corroboration, not a gate: if its output shape ever
 * changes and the scale cannot be parsed from it, the parse returns empty
 * and the wait proceeds on the first source alone - and says so in the
 * failure message rather than pretending it checked two things.
 */
fun setSystemFontScale(scale: String) {
  shell("settings put system font_scale $scale")
  val deadline = SystemClock.uptimeMillis() + FONT_SCALE_SETTLE_TIMEOUT_MILLIS
  var reported = ""
  var platform = ""
  while (SystemClock.uptimeMillis() < deadline) {
    reported = readSystemFontScale()
    platform = platformFontScale()
    if (sameScale(reported, scale) && (platform.isEmpty() || sameScale(platform, scale))) {
      instrumentation().waitForIdleSync()
      return
    }
    instrumentation().waitForIdleSync()
    SystemClock.sleep(POLL_MILLIS)
  }
  throw AssertionError(
    "the device did not adopt font scale $scale within ${FONT_SCALE_SETTLE_TIMEOUT_MILLIS}ms. " +
      "`settings get system font_scale` says \"$reported\" and the platform's own " +
      "configuration says \"${platform.ifEmpty { "<could not be parsed from dumpsys>" }}\". " +
      "Nothing measured after this point would be a measurement at a known text size.",
  )
}

/** Whether two font scales written as text are the same number. */
private fun sameScale(reported: String, wanted: String): Boolean {
  val left = reported.toFloatOrNull() ?: return false
  val right = wanted.toFloatOrNull() ?: return false
  return kotlin.math.abs(left - right) < 0.01f
}

/**
 * The font scale the PLATFORM reports for the current global configuration,
 * or "" when it cannot be read.
 *
 * Configuration.toString() begins with "{" followed by the font scale, and
 * `dumpsys activity config` prints that after "config=". Parsed
 * defensively: an unparseable answer is reported as unparseable rather than
 * as a mismatch, because a dumpsys format change is not a font scale
 * failure.
 */
fun platformFontScale(): String {
  val text = shell("dumpsys activity config")
  val marker = text.indexOf("config={")
  if (marker < 0) return ""
  return text.substring(marker + "config={".length).takeWhile { !it.isWhitespace() && it != '}' }
}

/**
 * Runs a shell command through the instrumentation and returns everything
 * it printed. This is the same channel `adb shell` uses, which is how a
 * test can ask the PLATFORM a question - what it has registered, what it
 * thinks is focused - instead of asking the object under test about itself.
 */
fun shell(command: String): String =
  instrumentation().uiAutomation.executeShellCommand(command).use { descriptor ->
    android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { stream ->
      stream.readBytes().toString(Charsets.UTF_8)
    }
  }

fun readSystemFontScale(): String = shell("settings get system font_scale").trim()
