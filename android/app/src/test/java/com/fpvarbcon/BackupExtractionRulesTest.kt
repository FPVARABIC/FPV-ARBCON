package com.fpvarbcon

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * NOTHING LEAVES THE DEVICE, INCLUDING TO ANOTHER DEVICE.
 *
 * android:allowBackup="false" does not carry that claim on its own for
 * this application. Android's Auto Backup guide is explicit, and this
 * app's targetSdkVersion is 36:
 *
 *   "For apps targeting Android 12 (API level 31) or higher, this
 *    behavior varies. On devices from some device manufacturers,
 *    specifying android:allowBackup="false" disables cloud-based backup
 *    and restore (such as Google Drive backups) but doesn't disable
 *    device-to-device transfers for the app."
 *
 * So the manifest's stated intent needs res/xml/data_extraction_rules.xml
 * behind it, and that file has to exclude BOTH transfer types - a rule
 * that only covers cloud-backup leaves D2D wide open while looking
 * thorough.
 *
 * This is a hermetic source contract, deliberately: an instrumentation
 * test cannot see it. The backup and transfer rules are consumed by the
 * platform's backup agent, not by anything the app can query at runtime,
 * so there is no API for an on-device test to assert against.
 */
class BackupExtractionRulesTest {

  private val appDir: File = locateAppDir()

  private fun locateAppDir(): File {
    var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (directory != null) {
      for (candidate in listOf(directory, File(directory, "android/app"))) {
        if (File(candidate, "src/main/AndroidManifest.xml").isFile) return candidate
      }
      directory = directory.parentFile
    }
    throw AssertionError("could not locate the app module from ${System.getProperty("user.dir")}")
  }

  private val manifest: String by lazy {
    File(appDir, "src/main/AndroidManifest.xml").readText()
  }

  private val rulesFile: File by lazy {
    File(appDir, "src/main/res/xml/data_extraction_rules.xml")
  }

  /** All nine domains the Android 12+ schema defines. */
  private val domains = listOf(
    "root", "file", "database", "sharedpref", "external",
    "device_root", "device_file", "device_database", "device_sharedpref",
  )

  @Test
  fun theManifestStillRefusesBackup() {
    assertTrue(
      "android:allowBackup is no longer false - the intent this whole file exists to " +
        "complete has changed",
      manifest.contains("android:allowBackup=\"false\""),
    )
  }

  @Test
  fun theManifestPointsAtTheExtractionRules() {
    assertTrue(
      "android:dataExtractionRules is absent, so on some manufacturers' devices a " +
        "device-to-device transfer would copy this app's private storage despite " +
        "allowBackup=\"false\"",
      manifest.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""),
    )
    assertTrue("res/xml/data_extraction_rules.xml is missing", rulesFile.isFile)
  }

  @Test
  fun bothTransferTypesAreCovered() {
    val rules = rulesFile.readText()
    assertTrue("<cloud-backup> section is missing", rules.contains("<cloud-backup"))
    assertTrue(
      "<device-transfer> section is missing - this is the half allowBackup=\"false\" " +
        "does not cover on Android 12 and higher",
      rules.contains("<device-transfer>"),
    )
  }

  /**
   * Every domain excluded from every section. An exclusion list that
   * misses one domain is not "nearly nothing", it is that domain being
   * transferred.
   */
  @Test
  fun everyDomainIsExcludedFromEverySection() {
    val rules = rulesFile.readText()
    val cloud = rules.substringAfter("<cloud-backup").substringBefore("</cloud-backup>")
    val transfer = rules.substringAfter("<device-transfer>").substringBefore("</device-transfer>")

    for ((label, section) in listOf("cloud-backup" to cloud, "device-transfer" to transfer)) {
      val missing = domains.filterNot { section.contains("<exclude domain=\"$it\"") }
      assertEquals("$label does not exclude every domain; missing: $missing", emptyList<String>(), missing)
      assertTrue(
        "$label contains an <include>, which would re-admit data this rule is meant to keep off " +
          "the wire",
        !section.contains("<include"),
      )
    }
  }
}
