package com.fpvarbcon.transport

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A SAVE THAT REPORTS SUCCESS MUST HAVE WRITTEN THE FILE IT SAID IT WROTE.
 *
 * The defect this pins is documented behaviour, not a hypothetical.
 * Android's ContentResolver reference:
 *
 *   "Please note the implementation of "w" is up to each Provider
 *    implementation and it may or may not truncate."
 *   "Please note "w" is write only and "wt" is write and truncate."
 *
 * UsbSerialTransportModule.completeFirmwareSave used "w". Overwriting a
 * 2048-byte document with a 512-byte firmware through a provider that
 * does not truncate leaves a 2048-byte file - the new image followed by
 * 1536 bytes of the old one - and every call in that path succeeds, so
 * the promise resolves true. The operator is told the firmware was saved.
 * It was not; what is on disk is a splice of two images, and it is a file
 * they may go on to flash.
 *
 * The mode is now "wt" and this function is the check behind it.
 */
class FirmwareSaveVerificationTest {

  /** The exact numbers from the reproduction, so the case is not abstract. */
  private val newFirmware = 512
  private val previousFirmware = 2048

  @Test
  fun `a document that is exactly the payload size is accepted`() {
    assertNull(firmwareSaveSizeComplaint(newFirmware, newFirmware.toLong()))
    assertNull(firmwareSaveSizeComplaint(1, 1L))
    assertNull(firmwareSaveSizeComplaint(16 * 1024 * 1024, 16L * 1024 * 1024))
  }

  /**
   * The reproduction itself. A larger document after the write means the
   * previous contents are still there past the end of the new ones.
   */
  @Test
  fun `stale bytes left by a non-truncating provider are a failure, not a success`() {
    val complaint = firmwareSaveSizeComplaint(newFirmware, previousFirmware.toLong())
    assertNotNull(
      "a 2048-byte file after writing 512 bytes was accepted as a good save",
      complaint,
    )
    assertTrue(
      "the complaint does not say how much stale data is there: $complaint",
      complaint!!.contains("1536 bytes"),
    )
    assertTrue(
      "the complaint does not warn against flashing the file: $complaint",
      complaint.contains("must not be flashed"),
    )
  }

  /** One stale byte is still a corrupt image and still fails. */
  @Test
  fun `even a single stale byte fails`() {
    assertNotNull(firmwareSaveSizeComplaint(newFirmware, newFirmware + 1L))
  }

  /**
   * The other direction: a short write. Different cause - a full disk, a
   * provider that dropped the tail - and a different message, because
   * "incomplete" and "spliced with an older image" are not the same thing
   * to somebody deciding what to do next.
   */
  @Test
  fun `a short write is reported as incomplete rather than as stale data`() {
    val complaint = firmwareSaveSizeComplaint(newFirmware, 100L)
    assertNotNull(complaint)
    assertTrue(
      "a short write should not be described as leftover data: $complaint",
      complaint!!.contains("only in part") && !complaint.contains("still at the end"),
    )
    assertTrue(complaint.contains("must not be flashed"))
  }

  @Test
  fun `a zero-length document after a write is a failure`() {
    assertNotNull(
      "a file the provider says is empty was accepted as a successful save",
      firmwareSaveSizeComplaint(newFirmware, 0L),
    )
  }

  /**
   * The deliberate silence. A provider that will not report a size has
   * not said the file is wrong, and turning that into a failed save would
   * break every streaming or cloud-backed destination. This is the one
   * case where the check says nothing, and it is worth a test of its own
   * so that nobody later "tightens" it into a false failure.
   *
   * The negative value is AssetFileDescriptor.UNKNOWN_LENGTH's
   * convention; null is a missing or null SIZE column.
   */
  @Test
  fun `an unknown size is not treated as a failure`() {
    assertNull("a null size was treated as a corrupt file", firmwareSaveSizeComplaint(newFirmware, null))
    assertNull("UNKNOWN_LENGTH was treated as a corrupt file", firmwareSaveSizeComplaint(newFirmware, -1L))
  }

  /**
   * The check must not overflow or wrap on the sizes this app actually
   * permits. MAX_FIRMWARE_FILE_BYTES is 16 MiB, which fits an Int; the
   * reported size is a Long and can legitimately exceed Int.MAX_VALUE if
   * the destination held something enormous.
   */
  @Test
  fun `a document far larger than any firmware is still compared correctly`() {
    val complaint = firmwareSaveSizeComplaint(newFirmware, 5_000_000_000L)
    assertNotNull(complaint)
    assertTrue(complaint!!.contains("4999999488 bytes"))
  }

  // -------------------------------------------------------------------
  // The half the assertions above cannot reach.
  //
  // Every test so far exercises firmwareSaveSizeComplaint. All of them
  // still pass if completeFirmwareSave goes back to opening the document
  // with "w" - the check would simply catch the corruption after the
  // fact, on providers that report a size, and miss it on the ones that
  // do not. The mode is the actual repair; the size check is the net
  // under it. So the mode is pinned in the shipped source, the same way
  // ProcessTerminationSourceContractTest pins its API guard after a
  // planted threshold change proved a runtime-only test insufficient.
  // -------------------------------------------------------------------

  private val moduleSource: String by lazy {
    var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (directory != null) {
      for (root in listOf(directory, File(directory, "android/app"))) {
        val candidate = File(
          root,
          "src/main/java/com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        )
        if (candidate.isFile) return@lazy candidate.readText()
      }
      directory = directory.parentFile
    }
    throw AssertionError("could not locate UsbSerialTransportModule.kt from ${System.getProperty("user.dir")}")
  }

  @Test
  fun `the firmware document is opened with the truncating mode`() {
    val opens = Regex("""openOutputStream\(\s*uri\s*,\s*"([a-z]+)"\s*\)""")
      .findAll(moduleSource)
      .map { it.groupValues[1] }
      .toList()

    assertEquals(
      "expected exactly one openOutputStream(uri, mode) call in the firmware save path, found $opens",
      1,
      opens.size,
    )
    assertTrue(
      "the firmware document is opened with mode \"${opens.first()}\". Android: \"the " +
        "implementation of \"w\" is up to each Provider implementation and it may or may not " +
        "truncate\", while \"\"wt\" is write and truncate\". Without the t, overwriting a larger " +
        "existing file leaves the tail of the previous firmware in place and the save still " +
        "reports success.",
      opens.first().contains("t"),
    )
  }

  /**
   * And the net has to actually be wired in. A size check nothing calls
   * is not a check.
   */
  @Test
  fun `the save path consults the size check and rejects on a complaint`() {
    assertTrue(
      "completeFirmwareSave does not call firmwareSaveSizeComplaint",
      moduleSource.contains("firmwareSaveSizeComplaint("),
    )
    assertTrue(
      "a size complaint does not reject the promise, so a corrupt save would still resolve true",
      moduleSource.contains("promise.reject(\"FILE_SAVE_TRUNCATION_FAILED\""),
    )
  }
}
