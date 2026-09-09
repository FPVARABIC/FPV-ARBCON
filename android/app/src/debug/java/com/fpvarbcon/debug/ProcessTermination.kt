package com.fpvarbcon.debug

import android.os.Build

/**
 * KILLING THE CAPTURE SUBPROCESS ON EVERY API LEVEL THIS APP CLAIMS.
 *
 * `Process.destroyForcibly()` was "Added in API level 26" (Android's own
 * java.lang.Process reference). This application declares
 * minSdkVersion 24, so on API 24 and 25 every one of these call sites was
 * a NoSuchMethodError waiting to happen - not a warning, a crash, on the
 * two oldest levels the app says it supports. Android Lint reported it as
 *
 *   Error: Call requires API level 26 (current min is 24):
 *   java.lang.Process#destroyForcibly [NewApi]
 *
 * once it was able to run at all.
 *
 * WHAT IS AND IS NOT PROMISED BELOW API 26. The reference is explicit
 * about both calls and they are not the same promise:
 *
 *   destroy()          "Kills the subprocess. Whether the subprocess
 *                       represented by this Process object is forcibly
 *                       terminated or not is implementation dependent."
 *   destroyForcibly()  "The subprocess ... is forcibly terminated ...
 *                       Invoking this method on Process objects returned
 *                       by ProcessBuilder.start and Runtime.exec will
 *                       forcibly terminate the process."
 *
 * So this is NOT a claim that the two branches are equivalent. On API 24
 * and 25 `destroy()` is the only termination the platform offers, and
 * whether it is forcible there is documented as implementation dependent.
 * That is a real, disclosed limitation of those two levels - and it is
 * strictly better than the alternative, which was to call a method that
 * does not exist. Everything the callers rely on afterwards is unchanged:
 * they still wait on the process where they waited before, and still
 * treat an already-exited process as a no-op.
 *
 * The guard is written against `Build.VERSION.SDK_INT` directly, in the
 * shape Lint understands, so `:app:lintDebug` is itself the regression
 * test: put the raw call back and NewApi returns.
 */
internal fun terminateForcibly(process: Process) {
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    process.destroyForcibly()
  } else {
    process.destroy()
  }
}
