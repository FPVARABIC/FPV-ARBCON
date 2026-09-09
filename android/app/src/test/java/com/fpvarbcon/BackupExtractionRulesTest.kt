package com.fpvarbcon

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import org.w3c.dom.Node

/**
 * NOTHING LEAVES THE DEVICE, INCLUDING TO ANOTHER DEVICE OR TO A
 * DIFFERENT PLATFORM.
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
 * and, on what an omitted section means:
 *
 *   "If there are no rules for a particular backup mode, such as if the
 *    <device-transfer> section is missing, that mode is fully enabled for
 *    all content except for no-backup and cache directories."
 *
 * An absent section ENABLES the mode. That is the whole reason these
 * assertions are written per section and per domain rather than as a
 * single "the file exists" check: the failure mode being guarded against
 * is a rule file that looks thorough and leaves one route wide open.
 *
 * Three documents have to agree, because Android reads a different one
 * depending on where it is running:
 *
 *   res/xml/backup_rules.xml            API 24-30  (full-backup-content)
 *   res/xml/data_extraction_rules.xml   API 31-35  (data-extraction-rules)
 *   res/xml-v36/data_extraction_rules.xml  API 36+  (adds cross-platform)
 *
 * This is a hermetic source contract, deliberately: an instrumentation
 * test cannot see any of it. The backup and transfer rules are consumed
 * by the platform's backup agent, not by anything the app can query at
 * runtime, so there is no API for an on-device test to assert against.
 * Parsing rather than string-matching is also deliberate - it proves the
 * documents are well-formed, which a substring check would not.
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

  private fun resource(path: String) = File(appDir, "src/main/res/$path")

  private val legacyRules = resource("xml/backup_rules.xml")
  private val modernRules = resource("xml/data_extraction_rules.xml")
  private val api36Rules = resource("xml-v36/data_extraction_rules.xml")

  /** All nine domains the schema defines, in both formats. */
  private val domains = listOf(
    "root", "file", "database", "sharedpref", "external",
    "device_root", "device_file", "device_database", "device_sharedpref",
  )

  private fun parse(file: File): Element {
    assertTrue("${file.name} is missing at ${file.path}", file.isFile)
    val factory = DocumentBuilderFactory.newInstance()
    // No network, no local DTD lookups: these documents declare none, and
    // a test that could reach out for one would not be hermetic.
    factory.isNamespaceAware = false
    return factory.newDocumentBuilder().parse(file).documentElement
  }

  private fun childElements(parent: Element): List<Element> {
    val children = parent.childNodes
    return (0 until children.length)
      .map(children::item)
      .filter { it.nodeType == Node.ELEMENT_NODE }
      .map { it as Element }
  }

  private fun sections(root: Element): Map<String, Element> =
    childElements(root).associateBy { it.tagName }

  /**
   * The core assertion, applied to every section of every document: every
   * domain excluded, every exclusion carrying an explicit path, and no
   * <include> anywhere.
   *
   * The path check is not pedantry. Android's syntax block gives path as
   * part of the element, and the first version of these files omitted it.
   * An exclusion the parser discards is not a weaker exclusion, it is no
   * exclusion at all - while the file still reads as a refusal.
   */
  private fun assertRefusesEverything(label: String, section: Element) {
    val excludedDomains = mutableListOf<String>()
    for (child in childElements(section)) {
      when (child.tagName) {
        "exclude" -> {
          val domain = child.getAttribute("domain")
          val path = child.getAttribute("path")
          assertTrue("$label has an <exclude> with no domain", domain.isNotEmpty())
          assertEquals(
            "$label <exclude domain=\"$domain\"> does not set path=\".\"; without a path the " +
              "platform has no directory to exclude and the rule may be dropped entirely",
            ".",
            path,
          )
          excludedDomains += domain
        }
        "include" ->
          throw AssertionError(
            "$label contains an <include>, which would re-admit data this rule exists to keep " +
              "off the wire",
          )
        else ->
          throw AssertionError("$label contains an unexpected element <${child.tagName}>")
      }
    }
    val missing = domains.filterNot { it in excludedDomains }
    assertEquals("$label does not exclude every domain; missing: $missing", emptyList<String>(), missing)
  }

  @Test
  fun theManifestStillRefusesBackup() {
    assertTrue(
      "android:allowBackup is no longer false - the intent these files exist to complete has " +
        "changed",
      manifest.contains("android:allowBackup=\"false\""),
    )
  }

  @Test
  fun theManifestPointsAtBothRuleSets() {
    assertTrue(
      "android:dataExtractionRules is absent, so on some manufacturers' devices a " +
        "device-to-device transfer would copy this app's private storage despite " +
        "allowBackup=\"false\"",
      manifest.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""),
    )
    assertTrue(
      "android:fullBackupContent is absent; minSdkVersion is 24 and the data-extraction-rules " +
        "format only applies from Android 12, which is exactly what Lint's DataExtractionRules " +
        "warning says",
      manifest.contains("android:fullBackupContent=\"@xml/backup_rules\""),
    )
  }

  @Test
  fun theApi24To30RulesRefuseEveryDomain() {
    val root = parse(legacyRules)
    assertEquals(
      "the API 24-30 document must use the full-backup-content format",
      "full-backup-content",
      root.tagName,
    )
    assertRefusesEverything("backup_rules.xml", root)
  }

  @Test
  fun theApi31To35RulesRefuseCloudBackupAndDeviceTransfer() {
    val root = parse(modernRules)
    assertEquals("data-extraction-rules", root.tagName)
    val present = sections(root)
    assertEquals(
      "res/xml/data_extraction_rules.xml must declare exactly the two sections that exist " +
        "before Android 16; a missing section is not a refusal, it enables that mode",
      setOf("cloud-backup", "device-transfer"),
      present.keys,
    )
    for ((name, section) in present) {
      assertRefusesEverything("res/xml/data_extraction_rules.xml <$name>", section)
    }
  }

  /**
   * The -v36 copy exists because Android documents cross-platform
   * transfer as available "from Android 16 QPR2", and an absent section
   * is an enabled mode. Older releases keep the two-section document so
   * that a parser predating the element cannot reject the whole file and
   * take the device-transfer refusal down with it.
   */
  @Test
  fun theApi36RulesAlsoRefuseCrossPlatformTransfer() {
    val root = parse(api36Rules)
    assertEquals("data-extraction-rules", root.tagName)
    val present = sections(root)
    assertEquals(
      setOf("cloud-backup", "device-transfer", "cross-platform-transfer"),
      present.keys,
    )
    assertEquals(
      "<cross-platform-transfer> needs its platform attribute",
      "ios",
      present.getValue("cross-platform-transfer").getAttribute("platform"),
    )
    for ((name, section) in present) {
      assertRefusesEverything("res/xml-v36/data_extraction_rules.xml <$name>", section)
    }
  }

  /**
   * Two copies of a policy file is two chances to change one of them. The
   * shared sections have to stay identical, or an Android 15 device and
   * an Android 16 device would be governed by different rules for the
   * same transfer.
   */
  @Test
  fun theTwoDataExtractionDocumentsAgreeOnTheirSharedSections() {
    val base = sections(parse(modernRules))
    val v36 = sections(parse(api36Rules))
    for (name in listOf("cloud-backup", "device-transfer")) {
      val a = base.getValue(name)
      val b = v36.getValue(name)
      assertEquals(
        "<$name> differs between res/xml and res/xml-v36",
        describe(a),
        describe(b),
      )
    }
  }

  private fun describe(section: Element): String {
    val attributes = section.attributes
    val own = (0 until attributes.length)
      .map(attributes::item)
      .map { "${it.nodeName}=${it.nodeValue}" }
      .sorted()
      .joinToString(" ")
    val children = childElements(section).joinToString("\n") { child ->
      "${child.tagName} domain=${child.getAttribute("domain")} path=${child.getAttribute("path")}"
    }
    return "<${section.tagName} $own>\n$children"
  }

  /**
   * Item 13 of the audit brief: these rules must govern backup and
   * transfer only, never local user data.
   *
   * That property is structural, and this is where it is pinned. The
   * schema has no operation that removes or rewrites anything on the
   * device - <include> and <exclude> only describe what a backup or
   * transfer may carry - so the way this guarantee could be lost is by
   * some other element appearing in one of these documents. Every element
   * in every section is therefore enumerated above and anything that is
   * not an exclude fails the test. The corresponding runtime evidence is
   * LocalDataSurvivalTest in androidTest, which writes real files and
   * preferences and requires them to still be there afterwards.
   */
  @Test
  fun theRulesContainNoDirectiveThatCouldTouchLocalData() {
    for (file in listOf(legacyRules, modernRules, api36Rules)) {
      val root = parse(file)
      val everyElement = mutableListOf<String>()
      fun walk(element: Element) {
        everyElement += element.tagName
        childElements(element).forEach(::walk)
      }
      walk(root)
      val allowed = setOf(
        "full-backup-content", "data-extraction-rules",
        "cloud-backup", "device-transfer", "cross-platform-transfer",
        "exclude",
      )
      val unexpected = everyElement.filterNot { it in allowed }.distinct()
      assertEquals(
        "${file.name} contains element(s) outside the backup/transfer vocabulary: $unexpected",
        emptyList<String>(),
        unexpected,
      )
    }
  }
}
