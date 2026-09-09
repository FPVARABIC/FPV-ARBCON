package com.fpvarbcon.transport

/**
 * DID THE FILE END UP HOLDING WHAT WE ASKED IT TO HOLD?
 *
 * Saving firmware through the Storage Access Framework has a failure mode
 * that reports success. Android's ContentResolver reference says it twice,
 * for openOutputStream and for the descriptor it delegates to:
 *
 *   "Synonym for openOutputStream(uri, "w"). Please note the
 *    implementation of "w" is up to each Provider implementation and it
 *    may or may not truncate."
 *
 *   "Please note "w" is write only and "wt" is write and truncate."
 *
 * So a provider that leaves the old contents in place past the end of the
 * new write is not a broken provider; it is a documented, permitted one.
 * Overwrite a 2 MB firmware with a 512 KB one through such a provider and
 * the file is 2 MB afterwards: the new image, followed by 1.5 MB of the
 * previous one. Every stream call succeeded, so the promise resolves true
 * and the operator is told the file was saved.
 *
 * That file is not a curiosity. It is a firmware image the operator may
 * later flash to a flight controller, or send to somebody else to flash.
 * Nothing downstream can tell it apart from a good one by looking at the
 * first 512 KB.
 *
 * The mode is now "wt", which is the documented request for truncation.
 * This function is the second half: after the write, the provider is asked
 * how big the document actually is, and a size that is not the payload's
 * size is reported as a failure instead of a success.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is fail when the provider declines to
 * answer. A cursor with no SIZE column, a null size, or the
 * AssetFileDescriptor.UNKNOWN_LENGTH convention of a negative value all
 * mean "this provider does not know", not "the file is wrong". Failing
 * there would turn a perfectly good save into an error on any streaming
 * or cloud-backed provider. The check asserts what is knowable and stays
 * silent about what is not - it is not a claim that every save is
 * verified.
 */
internal fun firmwareSaveSizeComplaint(expectedBytes: Int, reportedSize: Long?): String? {
  if (reportedSize == null || reportedSize < 0L) return null
  if (reportedSize == expectedBytes.toLong()) return null
  if (reportedSize > expectedBytes.toLong()) {
    val stale = reportedSize - expectedBytes.toLong()
    return "The saved file is $reportedSize bytes but the firmware is $expectedBytes bytes: " +
      "$stale bytes of whatever was in that file before are still at the end of it. " +
      "The file was NOT replaced and must not be flashed. Save to a new file instead."
  }
  return "The saved file is $reportedSize bytes but the firmware is $expectedBytes bytes, " +
    "so it was written only in part. The file is incomplete and must not be flashed."
}
