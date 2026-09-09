package com.fpvarbcon.debug

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHAT THE RUNTIME TEST CANNOT SEE.
 *
 * ProcessTerminationTest runs at SDK_INT 0, so it pins the SHAPE of
 * [terminateForcibly] - that below API 26 the legacy call is used - but
 * it cannot pin the THRESHOLD. Lowering the guard from
 * `Build.VERSION_CODES.O` to 24 keeps every runtime assertion green,
 * because 0 is below both. That was found by planting exactly that
 * change, and it is the reason this file exists.
 *
 * Android Lint would also catch it, since a `>= 24` guard does not
 * satisfy NewApi for an API 26 call. But lint needs the Android SDK and
 * ~18 minutes of CI; this needs neither, and it fails on the developer's
 * own `testDebugUnitTest` run. The two are deliberately redundant: this
 * is the fast, hermetic one.
 *
 * It reads the SHIPPED SOURCE, in the same spirit as
 * nativeErrorCatalogueContract.test.ts on the JavaScript side, because a
 * hand-copied restatement of a rule is exactly what drifts.
 */
class ProcessTerminationSourceContractTest {

  private val debugPackageDir: File = locateDebugPackageDir()

  private fun locateDebugPackageDir(): File {
    val relative = "src/debug/java/com/fpvarbcon/debug"
    var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (directory != null) {
      for (candidate in listOf(File(directory, relative), File(directory, "android/app/$relative"))) {
        if (candidate.isDirectory) return candidate
      }
      directory = directory.parentFile
    }
    throw AssertionError(
      "could not locate $relative from working directory ${System.getProperty("user.dir")}",
    )
  }

  /** Comments legitimately discuss destroyForcibly; only real calls count. */
  private fun codeOf(file: File): String =
    file.readLines()
      .map { line ->
        val trimmed = line.trimStart()
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) "" else line
      }
      .joinToString("\n")

  private fun debugSources(): List<File> =
    debugPackageDir.listFiles { file -> file.isFile && file.name.endsWith(".kt") }?.sorted() ?: emptyList()

  @Test
  fun theScanIsNotVacuous() {
    val sources = debugSources()
    assertTrue(
      "expected several Kotlin files under $debugPackageDir, found ${sources.map { it.name }}",
      sources.size >= 4,
    )
    assertTrue(
      "ProcessTermination.kt is missing, so this whole contract is checking nothing",
      sources.any { it.name == "ProcessTermination.kt" },
    )
  }

  @Test
  fun theGuardIsWrittenInTheShapeLintUnderstands() {
    val source = File(debugPackageDir, "ProcessTermination.kt").readText()
    assertTrue(
      "the API guard is not the canonical `Build.VERSION.SDK_INT >= Build.VERSION_CODES.O`. " +
        "A different threshold or a helper predicate still compiles, still passes " +
        "ProcessTerminationTest at SDK_INT 0, and puts API 24/25 back on a call that " +
        "does not exist there.",
      source.contains("Build.VERSION.SDK_INT >= Build.VERSION_CODES.O"),
    )
  }

  @Test
  fun onlyTheGuardedHelperCallsDestroyForcibly() {
    val callers = debugSources()
      .filter { codeOf(it).contains("destroyForcibly(") }
      .map { it.name }
      .sorted()

    assertEquals(
      "destroyForcibly() is API 26 and this application declares minSdkVersion 24, so every " +
        "call must go through terminateForcibly(). Unguarded callers: $callers",
      listOf("ProcessTermination.kt"),
      callers,
    )
  }
}
