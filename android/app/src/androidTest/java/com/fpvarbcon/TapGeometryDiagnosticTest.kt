package com.fpvarbcon

import android.app.Activity
import android.graphics.Rect
import android.view.View
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PURE MEASUREMENT. THIS FILE REPAIRS NOTHING AND ASSERTS NOTHING.
 *
 * Run 34534180777 on 837c6bb established case A: the press went into the
 * right window and landed off the control.
 *
 *   at (167.0, 910.0) the topmost drawn view was "null", which is neither
 *   "start-firmware" nor inside it, so the coordinate was not on the control
 *
 * "topmostTag was null" is NOT evidence the point missed the button - an
 * unnamed inner view inside a Pressable would also report a null tag, and
 * landedOnTarget already accepts that case (it tests descendant-of-target,
 * not tag equality). So the point genuinely resolved into a different
 * subtree, and the question is which coordinate space each half was using.
 *
 * There are two candidate spaces and the harness currently mixes them:
 *
 *   getLocationOnScreen      the view's position on the DISPLAY
 *   getGlobalVisibleRect     documented as "global (root) coordinates",
 *                            which is the WINDOW's space, not the display's
 *
 * They coincide only when the window starts at the display origin. If they
 * do not, injecting at screen coordinates while hit-testing against root
 * rectangles compares two different points, and the reported miss is an
 * artefact of the harness rather than a fact about the press.
 *
 * That is a hypothesis. This file exists to replace it with numbers BEFORE
 * anything is changed, so the repair is chosen from the measurement instead
 * of the measurement being chosen to fit the repair. It asserts nothing:
 * a diagnostic that can fail is a gate, and a gate here would just be one
 * more red line hiding the numbers.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
@RunWith(AndroidJUnit4::class)
class TapGeometryDiagnosticTest {

  private companion object {
    const val START = "start-screen"
    val PROBES = listOf("start-firmware", "start-configure", "start-flight-style-guide")
  }

  /** The chain from [view] up to the root, nearest first. */
  private fun ancestry(view: View): List<View> {
    val chain = mutableListOf<View>()
    var current: View? = view
    while (current != null) {
      chain += current
      current = current.parent as? View
    }
    return chain
  }

  private fun describe(view: View): String {
    val tag = view.tag as? String
    return "${view.javaClass.simpleName}${if (tag != null) "[$tag]" else ""}"
  }

  /**
   * The deepest drawn view containing a point, judged in ROOT coordinates -
   * the space getGlobalVisibleRect reports in.
   */
  private fun deepestInRootSpace(root: View, x: Int, y: Int): View? =
    everyView(root)
      .filter { candidate ->
        val rect = Rect()
        candidate.visibility == View.VISIBLE && candidate.isShown && candidate.alpha > 0f &&
          candidate.getGlobalVisibleRect(rect) && rect.contains(x, y)
      }
      .lastOrNull()

  private fun report(activity: Activity, testId: String): String {
    val decor = activity.window.decorView
    val target = findByTag(decor, testId) ?: return "  $testId: NOT PRESENT"

    val rootOnScreen = IntArray(2).also { decor.getLocationOnScreen(it) }
    val rootInWindow = IntArray(2).also { decor.getLocationInWindow(it) }
    val visibleFrame = Rect().also { decor.getWindowVisibleDisplayFrame(it) }

    val targetOnScreen = IntArray(2).also { target.getLocationOnScreen(it) }
    val targetInWindow = IntArray(2).also { target.getLocationInWindow(it) }
    val targetGlobalRect = Rect()
    val targetHasGlobalRect = target.getGlobalVisibleRect(targetGlobalRect)

    // What the harness injects today: centre from getLocationOnScreen.
    val injectedX = targetOnScreen[0] + target.width / 2
    val injectedY = targetOnScreen[1] + target.height / 2

    // The same point expressed in root space, by removing the root's own
    // screen offset. If the two spaces coincide this is identical.
    val rootSpaceX = injectedX - rootOnScreen[0]
    val rootSpaceY = injectedY - rootOnScreen[1]

    // The target's visible rect lifted INTO screen space, which is the
    // other direction of the same conversion.
    val targetScreenRect = Rect(targetGlobalRect).also {
      it.offset(rootOnScreen[0], rootOnScreen[1])
    }

    val hitAtInjected = deepestInRootSpace(decor, injectedX, injectedY)
    val hitAtRootSpace = deepestInRootSpace(decor, rootSpaceX, rootSpaceY)

    val builder = StringBuilder()
    builder.append("  ---- $testId ----\n")
    builder.append("    root getLocationOnScreen      : ${rootOnScreen[0]}, ${rootOnScreen[1]}\n")
    builder.append("    root getLocationInWindow      : ${rootInWindow[0]}, ${rootInWindow[1]}\n")
    builder.append("    window visible display frame  : $visibleFrame\n")
    builder.append("    root size                     : ${decor.width} x ${decor.height}\n")
    builder.append("    target getLocationOnScreen    : ${targetOnScreen[0]}, ${targetOnScreen[1]}\n")
    builder.append("    target getLocationInWindow    : ${targetInWindow[0]}, ${targetInWindow[1]}\n")
    builder.append("    target size                   : ${target.width} x ${target.height}\n")
    builder.append("    target getGlobalVisibleRect   : $targetGlobalRect (returned $targetHasGlobalRect)\n")
    builder.append("    target rect + root offset     : $targetScreenRect\n")
    builder.append("    coordinate injected today     : $injectedX, $injectedY\n")
    builder.append("    same point in root space      : $rootSpaceX, $rootSpaceY\n")
    builder.append("    screen and root spaces differ : ${rootOnScreen[0] != 0 || rootOnScreen[1] != 0}\n")
    builder.append("    deepest view at INJECTED point: ${hitAtInjected?.let { describe(it) } ?: "<none>"}\n")
    builder.append("    deepest view at ROOT-SPACE pt : ${hitAtRootSpace?.let { describe(it) } ?: "<none>"}\n")

    for ((label, hit) in listOf("injected" to hitAtInjected, "root-space" to hitAtRootSpace)) {
      if (hit == null) {
        builder.append("    ancestry ($label)             : <no view>\n")
        continue
      }
      val chain = ancestry(hit)
      builder.append("    ancestry ($label)             : ${chain.joinToString(" < ") { describe(it) }}\n")
      builder.append("    ...contains \"$testId\"?        : ${chain.contains(target)}\n")
    }
    // The check the harness makes today, recomputed here so the report
    // shows it next to the geometry that produced it.
    val within = hitAtInjected != null &&
      (hitAtInjected === target ||
        everyView(target).contains(hitAtInjected) ||
        everyView(hitAtInjected).contains(target))
    builder.append("    landedOnTarget as computed now: $within\n")
    return builder.toString()
  }

  @Test
  fun printTheGeometryBehindEveryTapCoordinate() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.moveToState(Lifecycle.State.RESUMED)
      scenario.awaitTag(START)
      for (probe in PROBES) scenario.awaitTag(probe)

      val text = scenario.readMain { activity ->
        val builder = StringBuilder("===== UI-X3B TAP GEOMETRY DIAGNOSTIC =====\n")
        builder.append("  display bounds (decor global rect): ")
        builder.append(Rect().also { activity.window.decorView.getGlobalVisibleRect(it) })
        builder.append('\n')
        for (probe in PROBES) builder.append(report(activity, probe))
        builder.append("==========================================")
        builder.toString()
      }
      println(text)
    }
  }
}
