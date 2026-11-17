package com.fpvarbcon

import android.content.Context
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE BACKUP RULES GOVERN WHAT LEAVES THE DEVICE. THEY MUST NOT TOUCH
 * WHAT STAYS ON IT.
 *
 * The manifest now carries android:allowBackup="false",
 * android:dataExtractionRules and android:fullBackupContent, and all three
 * rule documents exclude every domain. Written as prose that sounds
 * absolute, and it is worth being precise about what it means: those
 * exclusions describe the contents of a backup or a transfer. They are
 * read by the platform's backup agent, during a backup or a restore. They
 * are not a retention policy and they do not reach the app's own files.
 *
 * The failure this guards against is a plausible misreading of the same
 * configuration - that "exclude domain=root" tells Android the app's data
 * directory is disposable - which would show up as the operator's board
 * configuration or their last firmware selection quietly disappearing
 * between sessions. That is a data-loss bug, not a privacy one, and it
 * would be caused by the very change made to improve privacy.
 *
 * So this writes into each domain the rules name, exercises the app the
 * way a session would (start the Activity, recreate it, stop it), and
 * requires every byte to still be there with the same contents. Nothing
 * here is a claim about backup behaviour: the on-device half of the
 * backup story cannot be observed from inside the app, and the hermetic
 * half is BackupExtractionRulesTest in the JVM suite.
 *
 * Each file is written into the app's own storage and removed afterwards,
 * so the test leaves the device as it found it.
 */
@RunWith(AndroidJUnit4::class)
class LocalDataSurvivalTest {

  private val context: Context
    get() = InstrumentationRegistry.getInstrumentation().targetContext

  private val marker = "fpvarbcon-local-data-survival"
  private val payload = "ملف إعدادات - 42"

  private val createdFiles = mutableListOf<File>()

  private fun write(directory: File?, name: String): File? {
    if (directory == null) return null
    directory.mkdirs()
    val file = File(directory, "$marker-$name.txt")
    file.writeText(payload)
    createdFiles += file
    return file
  }

  @After
  fun removeWhatThisTestCreated() {
    createdFiles.forEach { runCatching { it.delete() } }
    context.getSharedPreferences(marker, Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }

  /**
   * "file", "database", "sharedpref" and "root" are the domains the rule
   * documents name; this covers the ones an app can write to directly on
   * every API level from 24 up. Context.getDataDir() is itself "Added in
   * API level 24", which is this app's minSdkVersion exactly.
   *
   * External storage is deliberately left alone - it needs a permission
   * this app does not request, and asking for one to satisfy a test would
   * be a real change to the shipped app. The cache directory is left
   * alone too, and for a reason worth stating: Android documents that
   * "the system will automatically delete files" there, so an assertion
   * that a cache file survived would be a flake waiting to happen and
   * would prove nothing about backup rules either way.
   */
  @Test
  fun everyLocalDomainSurvivesAnOrdinarySession() {
    val written = buildMap {
      write(context.filesDir, "files")?.let { put("file domain (filesDir)", it) }
      write(context.getDatabasePath("placeholder").parentFile, "databases")
        ?.let { put("database domain (databases/)", it) }
      write(context.dataDir, "root")?.let { put("root domain (dataDir)", it) }
    }
    assertTrue(
      "the test wrote nothing, so it proved nothing",
      written.size >= 3,
    )

    val preferences = context.getSharedPreferences(marker, Context.MODE_PRIVATE)
    assertTrue(
      "could not commit a SharedPreference",
      preferences.edit().putString("payload", payload).putInt("revision", 7).commit(),
    )

    // An ordinary session: the Activity starts, is recreated the way a
    // rotation or a locale change recreates it, and goes away again.
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.recreate()
    }

    for ((label, file) in written) {
      assertTrue("$label: ${file.absolutePath} no longer exists after a normal session", file.isFile)
      assertEquals("$label: contents changed after a normal session", payload, file.readText())
    }

    val after = context.getSharedPreferences(marker, Context.MODE_PRIVATE)
    assertEquals("sharedpref domain: string value changed", payload, after.getString("payload", null))
    assertEquals("sharedpref domain: int value changed", 7, after.getInt("revision", -1))
  }

  /**
   * React Native's own right-to-left preference lives in the sharedpref
   * domain, which every rule document excludes. If an exclusion were ever
   * read as "delete this", the layout direction would silently reset and
   * an Arabic-first application would come back left-to-right - the exact
   * defect RtlBootstrap exists to prevent.
   */
  @Test
  fun theLayoutDirectionPreferenceIsNotClearedByTheBackupConfiguration() {
    applyDutchLayoutDirection(context)
    val preferences = context.getSharedPreferences(RN_RTL_PREFERENCES, Context.MODE_PRIVATE)
    assertTrue(
      "$RN_RTL_PREFERENCES does not hold $RN_RTL_KEY_FORCE after applyDutchLayoutDirection",
      preferences.contains(RN_RTL_KEY_FORCE),
    )

    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.recreate()
    }

    val after = context.getSharedPreferences(RN_RTL_PREFERENCES, Context.MODE_PRIVATE)
    assertTrue(
      "$RN_RTL_KEY_FORCE disappeared during an ordinary session",
      after.contains(RN_RTL_KEY_FORCE),
    )
    assertTrue(
      "$RN_RTL_KEY_FORCE is no longer false, so the next launch would come back right-to-left",
      !after.getBoolean(RN_RTL_KEY_FORCE, true),
    )
  }
}
