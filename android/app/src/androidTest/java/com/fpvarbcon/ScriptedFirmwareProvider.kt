package com.fpvarbcon

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * A CONTENT PROVIDER THAT BEHAVES THE WAY ANDROID SAYS ONE MAY.
 *
 * The firmware-save defect this exists to reproduce is not hypothetical
 * and not a bug in anybody's provider. Android's ContentResolver reference
 * states it as permitted behaviour, twice:
 *
 *     "Synonym for openOutputStream(uri, "w"). Please note the
 *      implementation of "w" is up to each Provider implementation and it
 *      may or may not truncate."
 *
 *     "Please note "w" is write only and "wt" is write and truncate."
 *
 * So a provider that leaves the old contents in place past the end of a
 * shorter write is CONFORMING. Real ones differ, which is exactly why the
 * app cannot rely on the mode meaning what it looks like it means. This
 * provider implements the letter of that sentence: "w" opens read-write
 * with no truncation, "wt" adds MODE_TRUNCATE.
 *
 * WHAT THIS IS AND IS NOT. This is a real ContentProvider subclass, opening
 * real files on the device with real ParcelFileDescriptor modes, and the
 * tests drive it through the same provider entry points a ContentResolver
 * would call - openFile, query - with the same stream wrapper
 * ContentResolver.openOutputStream produces. It is instantiated and called
 * IN PROCESS rather than published in the test manifest, and the Binder
 * dispatch between a resolver and a provider in another process is
 * therefore NOT crossed here. That layer marshals a file descriptor; it is
 * not where truncation is decided. Truncation is decided by the MODE_
 * flags this provider passes to ParcelFileDescriptor.open, which is the
 * real platform call on the real device, and that is what these tests
 * exercise.
 *
 * It can also be told to fail an open, to refuse a size, to break a write
 * part-way through a real pipe, and to end a read early - and it counts the
 * descriptors it has handed out, so a leaked stream is observable rather
 * than assumed.
 *
 * Test-only: this class lives in androidTest and is in no shipped APK.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
class ScriptedFirmwareProvider : ContentProvider() {

  companion object {
    const val AUTHORITY = "com.fpvarbcon.test.firmware"

    /** How long a scripted stream helper may take before the test gives up. */
    private const val HELPER_TIMEOUT_SECONDS = 20L

    /** Files the provider is currently backing, by their last path segment. */
    private val backing = mutableMapOf<String, File>()

    /** Display names to report, which need not resemble the file name. */
    private val displayNames = mutableMapOf<String, String>()

    /** Names whose next open must throw, to model a provider failing. */
    private val failingOpens = mutableSetOf<String>()

    /** Names whose query() must report no size at all. */
    private val sizelessNames = mutableSetOf<String>()

    /** Names whose access has been revoked, to model a lost permission. */
    private val revokedNames = mutableSetOf<String>()

    /** Names whose write is served by a pipe that breaks after N bytes. */
    private val writeBreaks = mutableMapOf<String, Int>()

    /** Names whose read is served by a pipe that stops after N bytes. */
    private val readEnds = mutableMapOf<String, Int>()

    /** Bytes a broken-pipe write actually delivered before it broke. */
    val bytesAcceptedBeforeBreak = AtomicInteger(0)

    /** Opens the provider served, however they were served. */
    val descriptorsOpened = AtomicInteger(0)

    /** Falls when a scripted pipe has genuinely been broken or ended. */
    @Volatile
    var pipeArmed: CountDownLatch = CountDownLatch(0)
      private set

    fun reset() {
      backing.clear()
      displayNames.clear()
      failingOpens.clear()
      sizelessNames.clear()
      revokedNames.clear()
      writeBreaks.clear()
      readEnds.clear()
      bytesAcceptedBeforeBreak.set(0)
      descriptorsOpened.set(0)
      pipeArmed = CountDownLatch(0)
    }

    fun publish(name: String, file: File, displayName: String = name): Uri {
      backing[name] = file
      displayNames[name] = displayName
      return Uri.parse("content://$AUTHORITY/$name")
    }

    fun failOpenOf(name: String) = failingOpens.add(name)

    fun reportNoSizeFor(name: String) = sizelessNames.add(name)

    fun revoke(name: String) = revokedNames.add(name)

    /** After [bytes] bytes have genuinely reached the provider, the pipe dies. */
    fun breakWriteAfter(name: String, bytes: Int) {
      writeBreaks[name] = bytes
      pipeArmed = CountDownLatch(1)
    }

    /** The provider delivers only [bytes] bytes and then closes the stream. */
    fun endReadAfter(name: String, bytes: Int) {
      readEnds[name] = bytes
      pipeArmed = CountDownLatch(1)
    }

    /**
     * Blocks until the scripted pipe has actually been broken or ended, so
     * a test never has to guess whether the failure has happened yet. A
     * sleep here would be exactly the wall-clock guess this campaign is
     * meant to remove.
     */
    fun awaitScriptedPipe(): Boolean = pipeArmed.await(HELPER_TIMEOUT_SECONDS, TimeUnit.SECONDS)

    fun fileFor(name: String): File = backing.getValue(name)
  }

  override fun onCreate(): Boolean = true

  private fun nameOf(uri: Uri): String =
    uri.lastPathSegment ?: throw FileNotFoundException("no path segment in $uri")

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    val name = nameOf(uri)
    if (name in revokedNames) {
      throw SecurityException("permission to $uri has been revoked")
    }
    if (name in failingOpens) {
      throw FileNotFoundException("this provider was told to fail the open of $uri")
    }
    val file = backing[name] ?: throw FileNotFoundException("nothing published at $uri")

    writeBreaks[name]?.let { limit ->
      descriptorsOpened.incrementAndGet()
      return brokenWritePipe(file, limit)
    }
    readEnds[name]?.let { limit ->
      descriptorsOpened.incrementAndGet()
      return shortReadPipe(file, limit)
    }

    // THE WHOLE POINT. "w" is write-only with NO truncation, exactly as
    // Android permits; "wt" adds it. Anything with a 't' truncates.
    var flags = if (!mode.contains("w") && !mode.contains("a")) {
      ParcelFileDescriptor.MODE_READ_ONLY
    } else {
      ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_CREATE
    }
    if (mode.contains("t")) flags = flags or ParcelFileDescriptor.MODE_TRUNCATE
    if (mode.contains("a")) flags = flags or ParcelFileDescriptor.MODE_APPEND
    descriptorsOpened.incrementAndGet()
    return ParcelFileDescriptor.open(file, flags)
  }

  /**
   * A REAL BROKEN PIPE, not a thrown exception pretending to be one. The
   * caller is handed the write end; this provider reads [limit] bytes from
   * the read end, stores them, and then closes it. Every later write on
   * that descriptor fails with EPIPE from the kernel, which is what a
   * provider dying part-way through a save looks like to the app.
   */
  private fun brokenWritePipe(file: File, limit: Int): ParcelFileDescriptor {
    val pipe = try {
      ParcelFileDescriptor.createPipe()
    } catch (error: IOException) {
      throw FileNotFoundException("could not create a scripted pipe: ${error.message}")
    }
    val latch = pipeArmed
    Thread({
      val received = ByteArray(limit)
      var filled = 0
      ParcelFileDescriptor.AutoCloseInputStream(pipe[0]).use { input ->
        while (filled < limit) {
          val read = input.read(received, filled, limit - filled)
          if (read < 0) break
          filled += read
        }
      }
      // Whatever did arrive is committed, so the test can prove the write
      // was genuinely partial rather than refused outright.
      file.writeBytes(received.copyOf(filled))
      bytesAcceptedBeforeBreak.set(filled)
      latch.countDown()
    }, "ScriptedBrokenWrite").apply { isDaemon = true }.start()
    return pipe[1]
  }

  /**
   * A READ THAT ENDS EARLY. The caller is handed the read end and this
   * provider writes only [limit] bytes of the file before closing, so the
   * app sees a clean end-of-stream on an incomplete firmware - the shape of
   * a provider, a network share or a cloud document that failed mid-read
   * without saying so.
   */
  private fun shortReadPipe(file: File, limit: Int): ParcelFileDescriptor {
    val pipe = try {
      ParcelFileDescriptor.createPipe()
    } catch (error: IOException) {
      throw FileNotFoundException("could not create a scripted pipe: ${error.message}")
    }
    val latch = pipeArmed
    val prefix = file.readBytes().copyOf(minOf(limit, file.length().toInt()))
    Thread({
      ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { output ->
        output.write(prefix)
        output.flush()
      }
      latch.countDown()
    }, "ScriptedShortRead").apply { isDaemon = true }.start()
    return pipe[0]
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? {
    val name = nameOf(uri)
    if (name in revokedNames) throw SecurityException("permission to $uri has been revoked")
    val file = backing[name] ?: return null
    val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    val cursor = MatrixCursor(columns)
    cursor.addRow(
      columns.map { column ->
        when (column) {
          OpenableColumns.DISPLAY_NAME -> displayNames[name] ?: name
          OpenableColumns.SIZE -> if (name in sizelessNames) null else file.length()
          else -> null
        }
      }.toTypedArray(),
    )
    return cursor
  }

  override fun getType(uri: Uri): String = "application/octet-stream"

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0
}
