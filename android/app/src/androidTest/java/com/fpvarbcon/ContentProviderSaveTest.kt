package com.fpvarbcon

import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.fpvarbcon.transport.IntelHexFirmware
import com.fpvarbcon.transport.firmwareSaveSizeComplaint
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE FIRMWARE-SAVE PATH, AGAINST A REAL CONTENT PROVIDER ON A DEVICE.
 *
 * FirmwareSaveVerificationTest proves the arithmetic of the size check in
 * the JVM. It cannot prove the thing the check exists for, because that is
 * a property of the platform: whether writing with mode "w" leaves the tail
 * of a longer previous file behind.
 *
 * Android says it may:
 *
 *     "Please note the implementation of "w" is up to each Provider
 *      implementation and it may or may not truncate."
 *     "Please note "w" is write only and "wt" is write and truncate."
 *
 * ScriptedFirmwareProvider implements exactly that, and these tests drive
 * it through the same provider entry points a ContentResolver calls, with
 * the same stream wrapper ContentResolver.openOutputStream builds around
 * the descriptor a provider returns.
 *
 * WHAT IS AND IS NOT CROSSED HERE. The provider is a real ContentProvider
 * opening real files with real ParcelFileDescriptor modes on the device
 * under test, and it is driven IN PROCESS. The Binder hop between a
 * resolver and a provider hosted in another process is not crossed. That
 * hop marshals a file descriptor; it does not decide truncation. Truncation
 * is decided by the MODE_ flags handed to ParcelFileDescriptor.open, and
 * those are exercised for real.
 *
 * The central assertion is byte equality, not size equality. A file of the
 * right length can still be the wrong bytes.
 *
 * NOT VERIFIED ON REAL HARDWARE: an emulator is not a flight controller,
 * and no firmware was flashed anywhere.
 */
@RunWith(AndroidJUnit4::class)
class ContentProviderSaveTest {

  private val provider = ScriptedFirmwareProvider()

  private val directory: File
    get() = File(
      InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
      "content-provider-save-test",
    ).also { it.mkdirs() }

  /** A previous, LARGER firmware already sitting at the destination. */
  private val previousFirmware = ByteArray(2048) { 0xAB.toByte() }

  /** The smaller image the operator is saving now. */
  private val newFirmware = ByteArray(512) { (it * 7 + 0x13).toByte() }

  @Before
  fun clean() {
    ScriptedFirmwareProvider.reset()
    directory.listFiles()?.forEach { it.delete() }
  }

  @After
  fun tidy() {
    directory.listFiles()?.forEach { it.delete() }
    ScriptedFirmwareProvider.reset()
  }

  private fun publish(name: String, initial: ByteArray, displayName: String = name): Uri {
    val file = File(directory, name)
    file.writeBytes(initial)
    return ScriptedFirmwareProvider.publish(name, file, displayName)
  }

  /**
   * What ContentResolver.openOutputStream(uri, mode) builds: it asks the
   * provider to open the document and wraps the returned descriptor in an
   * auto-closing stream.
   */
  private fun openOutput(uri: Uri, mode: String): OutputStream =
    ParcelFileDescriptor.AutoCloseOutputStream(provider.openFile(uri, mode))

  private fun openInput(uri: Uri): InputStream =
    ParcelFileDescriptor.AutoCloseInputStream(provider.openFile(uri, "r"))

  /** Exactly what completeFirmwareSave does to write the bytes. */
  private fun saveThrough(uri: Uri, mode: String, bytes: ByteArray) {
    openOutput(uri, mode).use { output ->
      output.write(bytes)
      output.flush()
    }
  }

  /** Exactly what queryDocumentSize does to read the size back. */
  private fun sizeThrough(uri: Uri): Long? = runCatching {
    provider.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      if (!cursor.moveToFirst()) return@use null
      val column = cursor.getColumnIndex(OpenableColumns.SIZE)
      if (column < 0 || cursor.isNull(column)) null else cursor.getLong(column)
    }
  }.getOrNull()

  /** Exactly what readBoundedFile does to consume the stream. */
  private fun readThrough(uri: Uri): ByteArray {
    val output = ByteArrayOutputStream()
    openInput(uri).use { input ->
      val buffer = ByteArray(32 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        output.write(buffer, 0, read)
      }
    }
    return output.toByteArray()
  }

  // ===================================================================
  // The defect, and the repair, on a device
  // ===================================================================

  /**
   * THE REPRODUCTION. Mode "w" against a conforming non-truncating
   * provider leaves 1536 bytes of the previous firmware behind, and every
   * call in the path succeeded.
   */
  @Test
  fun modeWLeavesTheTailOfALongerPreviousFirmwareBehind() {
    val uri = publish("overwrite-w.bin", previousFirmware)
    saveThrough(uri, "w", newFirmware)

    val onDisk = ScriptedFirmwareProvider.fileFor("overwrite-w.bin").readBytes()
    assertEquals(
      "this provider truncated on \"w\", so the hazard this whole path guards was not reproduced",
      previousFirmware.size,
      onDisk.size,
    )
    assertArrayEquals(
      "the first bytes should be the new firmware",
      newFirmware,
      onDisk.copyOfRange(0, newFirmware.size),
    )
    assertArrayEquals(
      "the tail should still be the previous firmware - that is the defect",
      previousFirmware.copyOfRange(newFirmware.size, previousFirmware.size),
      onDisk.copyOfRange(newFirmware.size, onDisk.size),
    )

    // And the shipped check catches it.
    val complaint = firmwareSaveSizeComplaint(newFirmware.size, sizeThrough(uri))
    assertNotNull("the size check accepted a file with a stale tail", complaint)
    assertTrue(complaint!!.contains("1536 bytes"))
    assertTrue(complaint.contains("must not be flashed"))
  }

  /**
   * THE REPAIR. "wt" against the same provider and the same oversized
   * destination produces a file that is byte-identical to the firmware.
   */
  @Test
  fun modeWtProducesAFileByteIdenticalToTheFirmware() {
    val uri = publish("overwrite-wt.bin", previousFirmware)
    saveThrough(uri, "wt", newFirmware)

    val onDisk = ScriptedFirmwareProvider.fileFor("overwrite-wt.bin").readBytes()
    assertArrayEquals(
      "the saved file is not byte-identical to the firmware that was handed over",
      newFirmware,
      onDisk,
    )
    assertNull(
      "the size check complained about a correctly truncated save",
      firmwareSaveSizeComplaint(newFirmware.size, sizeThrough(uri)),
    )
  }

  @Test
  fun writingOverAnEmptyDestinationIsAlsoByteIdentical() {
    val uri = publish("empty-destination.bin", ByteArray(0))
    saveThrough(uri, "wt", newFirmware)
    assertArrayEquals(
      newFirmware,
      ScriptedFirmwareProvider.fileFor("empty-destination.bin").readBytes(),
    )
    assertNull(firmwareSaveSizeComplaint(newFirmware.size, sizeThrough(uri)))
  }

  @Test
  fun writingOverASmallerDestinationIsAlsoByteIdentical() {
    val uri = publish("smaller-destination.bin", ByteArray(16) { 1 })
    saveThrough(uri, "wt", newFirmware)
    assertArrayEquals(
      newFirmware,
      ScriptedFirmwareProvider.fileFor("smaller-destination.bin").readBytes(),
    )
    assertNull(firmwareSaveSizeComplaint(newFirmware.size, sizeThrough(uri)))
  }

  /**
   * A LARGE IMAGE, so the check is not only exercised on toy sizes. Two
   * megabytes is the order of a real flight-controller image.
   */
  @Test
  fun aTwoMegabyteImageOverAFourMegabyteDestinationIsByteIdentical() {
    val large = ByteArray(2 * 1024 * 1024) { (it and 0xff).toByte() }
    val uri = publish("large.bin", ByteArray(4 * 1024 * 1024) { 0x5A })
    saveThrough(uri, "wt", large)

    val onDisk = ScriptedFirmwareProvider.fileFor("large.bin").readBytes()
    assertEquals(large.size, onDisk.size)
    assertArrayEquals("a 2 MiB save over a 4 MiB destination was not byte-identical", large, onDisk)
    assertNull(firmwareSaveSizeComplaint(large.size, sizeThrough(uri)))
  }

  // ===================================================================
  // Provider faults
  // ===================================================================

  @Test
  fun aProviderThatRefusesToOpenIsAFailureRatherThanASilentSuccess() {
    val uri = publish("refused.bin", previousFirmware)
    ScriptedFirmwareProvider.failOpenOf("refused.bin")

    var failed = false
    try {
      saveThrough(uri, "wt", newFirmware)
    } catch (_: Exception) {
      failed = true
    }
    assertTrue("a provider that refused the open did not surface as a failure", failed)
    assertArrayEquals(
      "the destination was modified even though the open was refused",
      previousFirmware,
      ScriptedFirmwareProvider.fileFor("refused.bin").readBytes(),
    )
  }

  /**
   * A PROVIDER THAT DIES PART-WAY THROUGH THE WRITE. The descriptor is a
   * real pipe whose far end is closed after 128 bytes, so the next write
   * fails with EPIPE from the kernel - not a thrown exception standing in
   * for one.
   *
   * Two independent defences are asserted: the write itself raises, and
   * even if it had not, the shipped size check would have refused the
   * 128-byte remnant. A partial firmware that reported success is the
   * outcome neither of them may allow.
   */
  @Test
  fun aProviderThatBreaksMidWriteCannotProduceASilentPartialSave() {
    val accepted = 128
    val uri = publish("broken-mid-write.bin", ByteArray(0))
    ScriptedFirmwareProvider.breakWriteAfter("broken-mid-write.bin", accepted)

    var failed = false
    try {
      openOutput(uri, "wt").use { output ->
        output.write(newFirmware, 0, accepted)
        output.flush()
        assertTrue(
          "the scripted pipe never broke, so nothing below would be evidence",
          ScriptedFirmwareProvider.awaitScriptedPipe(),
        )
        output.write(newFirmware, accepted, newFirmware.size - accepted)
        output.flush()
      }
    } catch (_: IOException) {
      failed = true
    }

    assertTrue("a write into a broken pipe did not surface as a failure", failed)
    assertEquals(
      "the provider did not receive the bytes the app believed it had sent",
      accepted,
      ScriptedFirmwareProvider.bytesAcceptedBeforeBreak.get(),
    )

    val complaint = firmwareSaveSizeComplaint(newFirmware.size, sizeThrough(uri))
    assertNotNull("the size check accepted a $accepted byte remnant of a 512 byte firmware", complaint)
    assertTrue(complaint!!.contains("must not be flashed"))
  }

  /**
   * A PROVIDER THAT WILL NOT REPORT A SIZE. The check must stay silent -
   * a streaming or cloud-backed destination that does not know its own
   * length has not said the file is wrong, and failing there would break
   * every such destination.
   */
  @Test
  fun aProviderThatReportsNoSizeIsNotTreatedAsCorruption() {
    val uri = publish("sizeless.bin", ByteArray(0))
    ScriptedFirmwareProvider.reportNoSizeFor("sizeless.bin")
    saveThrough(uri, "wt", newFirmware)

    assertNull("a provider that reports no size was read as a size", sizeThrough(uri))
    assertNull(
      "an unknown size was treated as corruption, which would break streaming destinations",
      firmwareSaveSizeComplaint(newFirmware.size, sizeThrough(uri)),
    )
    assertArrayEquals(
      "the bytes were still written correctly even though the size is unknowable",
      newFirmware,
      ScriptedFirmwareProvider.fileFor("sizeless.bin").readBytes(),
    )
  }

  /**
   * PERMISSION LOST AFTER THE URI WAS HANDED OVER - the shape of a URI
   * whose grant expired because the process was recreated. It must fail,
   * and it must not leave a half-written file.
   */
  @Test
  fun aRevokedPermissionFailsAndLeavesTheDestinationUntouched() {
    val uri = publish("revoked.bin", previousFirmware)
    ScriptedFirmwareProvider.revoke("revoked.bin")

    var failed = false
    try {
      saveThrough(uri, "wt", newFirmware)
    } catch (_: Exception) {
      failed = true
    }
    assertTrue("a revoked permission did not surface as a failure", failed)
    assertArrayEquals(
      previousFirmware,
      ScriptedFirmwareProvider.fileFor("revoked.bin").readBytes(),
    )
    assertNull("a revoked URI still reported a size", sizeThrough(uri))
  }

  // ===================================================================
  // Names
  // ===================================================================

  /**
   * A UNICODE, RIGHT-TO-LEFT DISPLAY NAME must survive the round trip
   * intact. This is an Arabic-first application; a name that came back
   * mangled would be the operator's own file name.
   */
  @Test
  fun anArabicDisplayNameSurvivesTheRoundTrip() {
    val arabic = "برنامج-ثابت-٢٠٢٦.hex"
    val uri = publish("arabic.bin", newFirmware, displayName = arabic)
    val reported = provider.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
      }
    assertEquals("the Arabic display name did not survive the provider round trip", arabic, reported)
  }

  /**
   * A HOSTILE, PATH-LIKE DISPLAY NAME. A provider is free to report
   * anything as a display name, including something that looks like a
   * traversal. The important property is that the name is DATA - it never
   * decides where anything is written, because the destination is the URI
   * the picker returned and nothing else.
   */
  @Test
  fun aPathLikeDisplayNameCannotRedirectWhereTheBytesGo() {
    val hostile = "../../../../data/data/com.fpvarbcon/files/evil.hex"
    val uri = publish("hostile.bin", ByteArray(0), displayName = hostile)
    saveThrough(uri, "wt", newFirmware)

    assertArrayEquals(
      "the bytes did not go to the published destination",
      newFirmware,
      ScriptedFirmwareProvider.fileFor("hostile.bin").readBytes(),
    )
    val escaped = File(
      InstrumentationRegistry.getInstrumentation().targetContext.filesDir,
      "evil.hex",
    )
    assertTrue(
      "a path-like display name caused a write outside the destination: ${escaped.absolutePath}",
      !escaped.exists(),
    )
  }

  // ===================================================================
  // Streams and concurrency
  // ===================================================================

  /**
   * EVERY EXIT CLOSES ITS STREAM. `use` does that on the success path;
   * this checks the failure path too, by counting descriptors the
   * provider handed out and then proving the file is still writable
   * afterwards - a leaked descriptor on some filesystems would not stop a
   * write, so the count is what carries the claim.
   */
  @Test
  fun everyOpenIsAccountedForAcrossSuccessAndFailure() {
    val ok = publish("streams-ok.bin", ByteArray(0))
    val bad = publish("streams-bad.bin", ByteArray(0))
    ScriptedFirmwareProvider.failOpenOf("streams-bad.bin")

    saveThrough(ok, "wt", newFirmware)
    runCatching { saveThrough(bad, "wt", newFirmware) }

    assertEquals(
      "the provider handed out a different number of descriptors than the number of opens " +
        "that reached it",
      1,
      ScriptedFirmwareProvider.descriptorsOpened.get(),
    )

    // The destination is still usable, which a held descriptor would put
    // at risk.
    saveThrough(ok, "wt", ByteArray(8) { 9 })
    assertArrayEquals(
      ByteArray(8) { 9 },
      ScriptedFirmwareProvider.fileFor("streams-ok.bin").readBytes(),
    )
  }

  /**
   * SIMULTANEOUS OPERATIONS on DIFFERENT destinations must not interfere.
   * The module's own lock already refuses two firmware operations at
   * once; this is about the layer below it - that two concurrent writes
   * each land in their own file, byte for byte.
   */
  @Test
  fun concurrentSavesToDifferentDestinationsDoNotInterfere() {
    val count = 4
    val uris = (0 until count).map { index ->
      publish("concurrent-$index.bin", previousFirmware)
    }
    val payloads = (0 until count).map { index ->
      ByteArray(256 + index * 32) { (index * 31 + it).toByte() }
    }

    val pool = Executors.newFixedThreadPool(count)
    try {
      val results = pool.invokeAll(
        (0 until count).map { index ->
          Callable {
            saveThrough(uris[index], "wt", payloads[index])
            index
          }
        },
        60,
        TimeUnit.SECONDS,
      )
      for (result in results) result.get()
    } finally {
      pool.shutdownNow()
      pool.awaitTermination(10, TimeUnit.SECONDS)
    }

    for (index in 0 until count) {
      assertArrayEquals(
        "concurrent save $index did not land byte-identically in its own destination",
        payloads[index],
        ScriptedFirmwareProvider.fileFor("concurrent-$index.bin").readBytes(),
      )
      assertNull(
        firmwareSaveSizeComplaint(payloads[index].size, sizeThrough(uris[index])),
      )
    }
  }

  // ===================================================================
  // Reading, which is the other half of the content-URI surface
  // ===================================================================

  @Test
  fun readingBackWhatWasWrittenGivesTheSameBytes() {
    val uri = publish("readback.bin", ByteArray(0))
    saveThrough(uri, "wt", newFirmware)
    assertArrayEquals(
      "reading back through the provider did not return the bytes that were written",
      newFirmware,
      readThrough(uri),
    )
  }

  @Test
  fun aProviderThatRefusesAReadSurfacesRatherThanReturningAnEmptyFile() {
    val uri = publish("read-fail.bin", newFirmware)
    ScriptedFirmwareProvider.failOpenOf("read-fail.bin")
    var failed = false
    try {
      readThrough(uri)
    } catch (_: IOException) {
      failed = true
    } catch (_: IllegalArgumentException) {
      failed = true
    }
    assertTrue("a provider that refused a read did not surface as a failure", failed)
  }

  /**
   * A READ THAT ENDS EARLY, AND THE REASON THAT IS SURVIVABLE.
   *
   * A provider is free to close a stream part-way through - a dropped
   * network share, a cloud document that expired mid-transfer - and the
   * app sees an ordinary end-of-stream, not an error. Nothing in the read
   * loop can tell that apart from a complete short file.
   *
   * What stops a half-read image from reaching a flight controller is the
   * firmware format itself: Intel HEX ends with an end-of-file record, and
   * both parsers in this application REQUIRE it. This test proves that a
   * genuinely truncated read is refused, and the control below proves the
   * same image parses when it arrives whole - so the refusal is the
   * truncation being caught, not the fixture being unparseable.
   */
  @Test
  fun aFirmwareTruncatedByAShortReadCannotReachTheFlashPath() {
    val whole = completeIntelHexImage()
    val bytes = whole.toByteArray(Charsets.US_ASCII)
    // Cut on a record boundary, so the ONLY thing wrong with the prefix is
    // the missing end-of-file record.
    val cut = whole.indexOf('\n', whole.length / 2) + 1
    val uri = publish("truncated.hex", bytes)
    ScriptedFirmwareProvider.endReadAfter("truncated.hex", cut)

    val delivered = readThrough(uri)
    assertTrue(
      "the scripted short read never completed, so nothing below would be evidence",
      ScriptedFirmwareProvider.awaitScriptedPipe(),
    )
    assertEquals("the read was not short", cut, delivered.size)
    assertEquals(
      "the provider still claims the whole document, which is what makes this silent",
      bytes.size.toLong(),
      sizeThrough(uri),
    )

    var refused: String? = null
    try {
      IntelHexFirmware.parse(String(delivered, Charsets.US_ASCII))
    } catch (error: IllegalArgumentException) {
      refused = error.message
    }
    assertNotNull("a firmware truncated by a short read parsed as a valid image", refused)
    assertTrue(
      "the refusal was not about the missing end-of-file record: $refused",
      refused!!.contains("EOF"),
    )
  }

  /** The control: the same image, delivered whole, parses and is complete. */
  @Test
  fun theSameImageDeliveredWholeParsesAndCarriesEveryByte() {
    val whole = completeIntelHexImage()
    val uri = publish("whole.hex", whole.toByteArray(Charsets.US_ASCII))
    val delivered = readThrough(uri)
    assertEquals(whole.length, delivered.size)

    val parsed = IntelHexFirmware.parse(String(delivered, Charsets.US_ASCII))
    assertEquals(
      "the control image did not carry the firmware bytes it was built with",
      HEX_RECORDS * HEX_RECORD_BYTES,
      parsed.totalBytes,
    )
  }

  // ===================================================================

  private companion object {
    const val HEX_RECORDS = 24
    const val HEX_RECORD_BYTES = 16
    const val HEX_DIGITS = "0123456789ABCDEF"

    /**
     * Hex written by hand rather than through String.format: this
     * application forces an Arabic locale, and a locale-sensitive format
     * can render digits as Arabic-Indic, which would not be Intel HEX at
     * all.
     */
    fun twoHexDigits(value: Int): String =
      "" + HEX_DIGITS[(value shr 4) and 0xf] + HEX_DIGITS[value and 0xf]

    fun record(type: Int, address: Int, data: ByteArray): String {
      val bytes = mutableListOf(data.size, (address shr 8) and 0xff, address and 0xff, type)
      data.forEach { bytes += it.toInt() and 0xff }
      bytes += (0x100 - (bytes.sum() and 0xff)) and 0xff
      return ":" + bytes.joinToString("") { twoHexDigits(it) }
    }

    /** A small but structurally complete Intel HEX image, EOF record included. */
    fun completeIntelHexImage(): String {
      val builder = StringBuilder()
      builder.append(record(0x04, 0, byteArrayOf(0x08, 0x00))).append('\n')
      for (index in 0 until HEX_RECORDS) {
        val data = ByteArray(HEX_RECORD_BYTES) { (index * HEX_RECORD_BYTES + it).toByte() }
        builder.append(record(0x00, index * HEX_RECORD_BYTES, data)).append('\n')
      }
      builder.append(record(0x01, 0, ByteArray(0))).append('\n')
      return builder.toString()
    }
  }
}
