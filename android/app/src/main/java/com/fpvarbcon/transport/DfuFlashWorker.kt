package com.fpvarbcon.transport

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

internal data class DfuFlashProgress(
  val phase: String,
  val percent: Int,
  val bytesProcessed: Int,
  val totalBytes: Int,
  /** Terminal 'complete' only: whether the board's reset was OBSERVED.
   * Separate from write truth, exactly as on the web engine. */
  val resetConfirmed: Boolean? = null,
)

/** Blocking DfuSe state machine. It is always run on a dedicated background thread. */
internal class DfuFlashWorker(
  private val usbManager: UsbManager,
  private val device: UsbDevice,
  private val usbInterface: UsbInterface,
  private val firmware: IntelHexFirmware,
  private val fullErase: Boolean,
  private val cancelled: AtomicBoolean,
  private val onProgress: (DfuFlashProgress) -> Unit,
) {
  private var interfaceNumber = usbInterface.id

  fun run() {
    val connection = usbManager.openDevice(device)
      ?: throw UsbTransportException("DFU_OPEN_FAILED", "Unable to open the DFU device.")
    try {
      /* WHICH INTERFACE/ALTERNATE ACTUALLY GETS FLASHED.
       *
       * Control transfers work on an opened device, so every DFU
       * candidate's memory-layout string is read BEFORE anything is
       * claimed, and the flash target is chosen from that evidence -
       * the region NAMED Internal Flash, else External Flash, else the
       * only writable one. Taking the first DFU alternate, as this used
       * to, aims the whole flash at option bytes on any board that
       * declares them first.
       *
       * The descriptor string is read off the OPENED device FIRST and
       * UsbInterface.name is only a fallback: a real board enumerated
       * with that property empty while its string descriptor carried the
       * layout the whole time. */
      val candidates = dfuInterfaces(device).ifEmpty { listOf(usbInterface) }
      val selection = selectDfuFlashInterface(candidates) { candidate ->
        readInterfaceStringDescriptor(connection, candidate.id, candidate.alternateSetting)
          ?: runCatching { candidate.name }.getOrNull()
      } ?: throw UsbTransportException(
        "DFU_LAYOUT_MISSING",
        "DFU device did not expose a readable memory layout descriptor.",
      )
      val flashInterface = selection.first
      val layout = selection.second
      interfaceNumber = flashInterface.id
      val declaredAlternates = (0 until device.interfaceCount)
        .map(device::getInterface)
        .filter { it.id == flashInterface.id }
        .map { it.alternateSetting }
      withClaimedDfuFlashInterface(
        target = flashInterface,
        alternateSetting = flashInterface.alternateSetting,
        declaredAlternates = declaredAlternates,
        layoutName = layout.name,
        claim = { connection.claimInterface(it, true) },
        selectAlternate = { connection.setInterface(it) },
        release = { connection.releaseInterface(it) },
      ) {
        if (!layout.hasWritableSectors) {
          throw UsbTransportException(
            "DFU_MEMORY_LAYOUT_NOT_WRITABLE",
            "The ${layout.name} region advertises no writable sectors.",
          )
        }
        val transferSize = findDfuTransferSize(
          connection.rawDescriptors,
          flashInterface.id,
          flashInterface.alternateSetting,
        ) ?: DEFAULT_DFU_TRANSFER_SIZE
        // EVERY address is checked against the layout AND against the
        // WRITABLE map before the first erase command leaves the host.
        firmware.segments.forEach { segment ->
          if (!layout.contains(segment.address, segment.data.size)) {
            throw UsbTransportException(
              "DFU_ADDRESS_OUT_OF_RANGE",
              "Firmware address 0x${segment.address.toString(16)} is outside the DFU memory layout.",
            )
          }
          dfuBlockNumberOverflow(segment.data.size, transferSize, segment.address)?.let { reason ->
            throw UsbTransportException("DFU_BLOCK_NUMBER_OVERFLOW", reason)
          }
          if (!layout.containsWritable(segment.address, segment.data.size)) {
            throw UsbTransportException(
              "DFU_MEMORY_LAYOUT_NOT_WRITABLE",
              "Firmware address 0x${segment.address.toString(16)} falls in a non-writable sector.",
            )
          }
        }
        // A full erase covers only sectors the DEVICE declares erasable -
        // option-byte and OTP regions are never blindly erased.
        val sectors = if (fullErase) {
          layout.sectors.filter { it.erasable }
        } else {
          firmware.segments.flatMap { layout.sectorsOverlapping(it.address, it.data.size) }.distinctBy { it.address }
        }
        sectors.firstOrNull { !it.erasable }?.let { sector ->
          throw UsbTransportException(
            "DFU_MEMORY_LAYOUT_NOT_WRITABLE",
            "Sector at 0x${sector.address.toString(16)} is not erasable; refusing a write that could not be completed.",
          )
        }
        checkCancelled()
        ensureIdle(connection)
        onProgress(DfuFlashProgress("erasing", 0, 0, firmware.totalBytes))
        sectors.forEachIndexed { index, sector ->
          checkCancelled()
          command(connection, byteArrayOf(DFUSE_ERASE, *u32le(sector.address)))
          waitForDownloadIdle(connection)
          onProgress(
            DfuFlashProgress(
              "erasing",
              ((index + 1) * 20 / sectors.size.coerceAtLeast(1)).coerceAtMost(20),
              0,
              firmware.totalBytes,
            ),
          )
        }

        var written = 0
        for (segment in firmware.segments) {
          ensureIdle(connection)
          setAddress(connection, segment.address)
          var blockNumber = 2
          var offset = 0
          while (offset < segment.data.size) {
            checkCancelled()
            val length = minOf(transferSize, segment.data.size - offset)
            download(connection, blockNumber, segment.data.copyOfRange(offset, offset + length))
            waitForDownloadIdle(connection)
            offset += length
            written += length
            blockNumber += 1
            onProgress(
              DfuFlashProgress(
                "writing",
                20 + (written * 55 / firmware.totalBytes),
                written,
                firmware.totalBytes,
              ),
            )
          }
        }

        var verified = 0
        for (segment in firmware.segments) {
          ensureIdle(connection)
          setAddress(connection, segment.address)
          ensureIdle(connection)
          var blockNumber = 2
          var offset = 0
          while (offset < segment.data.size) {
            checkCancelled()
            val length = minOf(transferSize, segment.data.size - offset)
            val actual = upload(connection, blockNumber, length)
            if (actual.size != length) {
              throw UsbTransportException("DFU_VERIFY_FAILED", "DFU read-back returned a short block.")
            }
            for (index in actual.indices) {
              if (actual[index] != segment.data[offset + index]) {
                throw UsbTransportException(
                  "DFU_VERIFY_FAILED",
                  "DFU read-back mismatch at 0x${(segment.address + offset + index).toString(16)}.",
                )
              }
            }
            offset += length
            verified += length
            blockNumber += 1
            onProgress(
              DfuFlashProgress(
                "verifying",
                75 + (verified * 24 / firmware.totalBytes),
                verified,
                firmware.totalBytes,
              ),
            )
          }
        }

        onProgress(DfuFlashProgress("finalizing", 99, firmware.totalBytes, firmware.totalBytes))
        ensureIdle(connection)
        // DfuSe manifestation selects the beginning of the programmed image,
        // matching Betaflight Configurator. Intel HEX type-05 may contain a
        // reset-handler PC (including a Thumb bit), not a DfuSe base address.
        setAddress(connection, firmware.segments.first().address)
        onProgress(DfuFlashProgress("manifesting", 99, firmware.totalBytes, firmware.totalBytes))

        /* ---- THE FLASH IS ALREADY DECIDED FROM HERE DOWN ----
         *
         * Every byte has been written, read back and compared equal. The
         * leave command and the reset that follows are facts about USB,
         * not about flash memory, and they may not rewrite what is
         * already verified on the board. The leave DNLOAD used to sit
         * OUTSIDE this tolerance, so a board with bitWillDetach - one
         * that resets on the leave command itself and fails that very
         * transfer - reported DFU_TRANSFER_FAILED after a perfect flash.
         * It is inside now, matching the web engine exactly. */
        runCatching { download(connection, 0, ByteArray(0)) }
        onProgress(DfuFlashProgress("resetting", 99, firmware.totalBytes, firmware.totalBytes))
        runCatching { waitForManifestation(connection) }
        // The reset OBSERVATION: a real bounded wait on UsbManager's own
        // device list, reported separately and never used to invalidate
        // verified bytes.
        val resetConfirmed = awaitDeviceDetach(RESET_OBSERVATION_MS)
        onProgress(
          DfuFlashProgress(
            "complete",
            100,
            firmware.totalBytes,
            firmware.totalBytes,
            resetConfirmed,
          ),
        )
      }
    } finally {
      connection.close()
    }
  }

  private fun setAddress(connection: android.hardware.usb.UsbDeviceConnection, address: Long) {
    command(connection, byteArrayOf(DFUSE_SET_ADDRESS, *u32le(address)))
    waitForDownloadIdle(connection)
  }

  private fun command(connection: android.hardware.usb.UsbDeviceConnection, data: ByteArray) =
    download(connection, 0, data)

  private fun download(
    connection: android.hardware.usb.UsbDeviceConnection,
    blockNumber: Int,
    data: ByteArray,
  ) {
    checkCancelled()
    val result = connection.controlTransfer(
      0x21,
      DFU_DNLOAD,
      blockNumber,
      interfaceNumber,
      data,
      data.size,
      CONTROL_TIMEOUT_MS,
    )
    if (result != data.size) {
      throw UsbTransportException("DFU_TRANSFER_FAILED", "DFU download transfer failed or was incomplete.")
    }
  }

  private fun upload(
    connection: android.hardware.usb.UsbDeviceConnection,
    blockNumber: Int,
    length: Int,
  ): ByteArray {
    val buffer = ByteArray(length)
    val result = connection.controlTransfer(
      0xa1,
      DFU_UPLOAD,
      blockNumber,
      interfaceNumber,
      buffer,
      length,
      CONTROL_TIMEOUT_MS,
    )
    if (result < 0) {
      throw UsbTransportException("DFU_TRANSFER_FAILED", "DFU upload transfer failed.")
    }
    return buffer.copyOf(result)
  }

  private fun status(connection: android.hardware.usb.UsbDeviceConnection): ByteArray {
    val buffer = ByteArray(6)
    val result = connection.controlTransfer(0xa1, DFU_GETSTATUS, 0, interfaceNumber, buffer, 6, CONTROL_TIMEOUT_MS)
    if (result != 6) {
      throw UsbTransportException("DFU_STATUS_FAILED", "DFU GETSTATUS returned an invalid response.")
    }
    return buffer
  }

  private fun ensureIdle(connection: android.hardware.usb.UsbDeviceConnection) {
    repeat(MAX_STATUS_POLLS) {
      checkCancelled()
      val status = status(connection)
      sleepPoll(status)
      when (status[4].toInt() and 0xff) {
        DFU_STATE_IDLE -> return
        DFU_STATE_ERROR -> controlNoData(connection, DFU_CLRSTATUS)
        DFU_STATE_DNLOAD_IDLE, DFU_STATE_UPLOAD_IDLE -> controlNoData(connection, DFU_ABORT)
      }
    }
    throw UsbTransportException("DFU_STATUS_TIMEOUT", "DFU device did not return to idle state.")
  }

  private fun waitForDownloadIdle(connection: android.hardware.usb.UsbDeviceConnection) {
    repeat(MAX_STATUS_POLLS) {
      checkCancelled()
      val status = status(connection)
      sleepPoll(status)
      when (status[4].toInt() and 0xff) {
        DFU_STATE_DNLOAD_IDLE -> return
        DFU_STATE_ERROR -> throw UsbTransportException("DFU_DEVICE_ERROR", "DFU device reported status ${status[0].toInt() and 0xff}.")
      }
    }
    throw UsbTransportException("DFU_STATUS_TIMEOUT", "DFU write did not reach download-idle state.")
  }

  private fun waitForManifestation(connection: android.hardware.usb.UsbDeviceConnection) {
    repeat(MAX_STATUS_POLLS) {
      checkCancelled()
      val status = status(connection)
      sleepPoll(status)
      when (status[4].toInt() and 0xff) {
        DFU_STATE_IDLE, DFU_STATE_MANIFEST_WAIT_RESET -> return
        DFU_STATE_ERROR -> throw UsbTransportException("DFU_DEVICE_ERROR", "DFU manifestation failed.")
      }
    }
    throw UsbTransportException("DFU_STATUS_TIMEOUT", "DFU manifestation did not complete in time.")
  }

  private fun controlNoData(connection: android.hardware.usb.UsbDeviceConnection, request: Int) {
    val result = connection.controlTransfer(0x21, request, 0, interfaceNumber, null, 0, CONTROL_TIMEOUT_MS)
    if (result < 0) throw UsbTransportException("DFU_TRANSFER_FAILED", "DFU control request $request failed.")
  }

  private fun sleepPoll(status: ByteArray) {
    val reported = (status[1].toInt() and 0xff) or
      ((status[2].toInt() and 0xff) shl 8) or
      ((status[3].toInt() and 0xff) shl 16)
    if (reported > 0) Thread.sleep(reported.coerceAtMost(MAX_SINGLE_POLL_DELAY_MS).toLong())
  }

  private fun checkCancelled() {
    if (cancelled.get()) throw CancellationException("DFU flash cancelled.")
  }

  /**
   * WAITS - bounded - for the board to actually leave the bus after the
   * manifestation. A resetting STM32 stays in UsbManager's device list
   * for a noticeable interval, so a single sample answers "still here"
   * and says nothing true about the reset. Nothing is transmitted inside
   * this wait, and its answer only sets `resetConfirmed`.
   */
  private fun awaitDeviceDetach(timeoutMs: Long): Boolean {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    while (true) {
      val stillAttached = usbManager.deviceList.values.any {
        it.deviceId == device.deviceId &&
          it.vendorId == device.vendorId &&
          it.productId == device.productId
      }
      if (!stillAttached) return true
      if (System.nanoTime() >= deadline) return false
      try {
        Thread.sleep(RESET_POLL_INTERVAL_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        return false
      }
    }
  }

  private fun u32le(value: Long): ByteArray = byteArrayOf(
    (value and 0xff).toByte(),
    ((value ushr 8) and 0xff).toByte(),
    ((value ushr 16) and 0xff).toByte(),
    ((value ushr 24) and 0xff).toByte(),
  )
}

internal fun isSupportedDfuDevice(device: UsbDevice): Boolean =
  (device.vendorId to device.productId) in SUPPORTED_DFU_IDS

/**
 * Every DFU-class interface/alternate the device exposes, in declaration
 * order. DfuSe puts each memory region on its own alternate setting, so
 * "the first one" is a guess, not an answer.
 */
internal fun dfuInterfaces(device: UsbDevice): List<UsbInterface> =
  (0 until device.interfaceCount)
    .map(device::getInterface)
    .filter { it.interfaceClass == 0xfe && it.interfaceSubclass == 0x01 }

internal fun findDfuInterface(device: UsbDevice): UsbInterface? = dfuInterfaces(device).firstOrNull()

/**
 * Chooses the interface/alternate to FLASH by the same evidence the web
 * engine uses: the region the device NAMES "Internal Flash", else
 * "External Flash", else the only writable one. Board and vendor names
 * play no part, and a device whose first DFU alternate is option bytes
 * no longer gets flashed at option bytes.
 *
 * `layoutOf` reads a candidate's memory-layout string, and the candidate
 * type is generic, so this decision is exercised by ordinary JVM unit
 * tests with no USB connection and no Android framework classes.
 */
internal fun <T> selectDfuFlashInterface(
  candidates: List<T>,
  layoutOf: (T) -> String?,
): Pair<T, DfuMemoryLayout>? {
  val parsed = candidates.mapNotNull { candidate ->
    val text = layoutOf(candidate) ?: return@mapNotNull null
    val layout = runCatching { DfuMemoryLayout.parse(text) }.getOrNull() ?: return@mapNotNull null
    candidate to layout
  }
  if (parsed.isEmpty()) return null
  fun named(wanted: String) = parsed.firstOrNull {
    it.second.name.trim().lowercase().replace(Regex("\\s+"), " ") == wanted
  }
  named("internal flash")?.let { return it }
  named("external flash")?.let { return it }
  val writable = parsed.filter { it.second.hasWritableSectors }
  return writable.singleOrNull()
}

/**
 * CLAIM, ACTIVATE, WORK, RELEASE - the order the device has to see, in
 * one place that can be tested without a USB bus.
 *
 * DfuSe puts each memory region on its own ALTERNATE SETTING of the same
 * interface number. On Android an alternate is activated by
 * UsbDeviceConnection.setInterface - "Sets the current UsbInterface. Used
 * to select between two interfaces with the same ID but different
 * alternate setting." claimInterface does not do it: it "Claims exclusive
 * access to a UsbInterface" and says nothing about alternates.
 *
 * Until this existed the activation was simply missing, so every erase,
 * write and read-back went to whichever alternate happened to be active
 * while selectDfuFlashInterface had merely NAMED a different one - and
 * the layout bounds checks in [body] were validating addresses against a
 * region the device was never going to write. On a board whose first DFU
 * alternate is option bytes that is exactly the outcome
 * selectDfuFlashInterface exists to prevent. The web engine has always
 * done this step (webUsbDfu.web.ts calls selectAlternateInterface right
 * after its claim, for the same stated reason), and this raises the same
 * DFU_ALTERNATE_SELECTION_FAILED code so both platforms say the same
 * thing to the operator.
 *
 * FOUR GUARANTEES, each one a named case in DfuAlternateSelectionTest:
 *
 *  1. [selectAlternate] runs BEFORE [body]. Every erase and write lives
 *     in [body], so nothing can reach the device on an unselected
 *     alternate.
 *  2. A refused OR THROWN selection stops the flash, when selection is
 *     mandatory. Nothing has been erased at that point - this runs before
 *     the first erase command leaves the host.
 *  3. A refusal is survivable in exactly one case: the interface declares
 *     nothing but its default setting, so USB 2.0 section 9.4.10 permits
 *     the STALL and alternate 0 is active anyway. See
 *     [dfuAlternateSelectionIsMandatory].
 *  4. [release] is called exactly once, on the interface that was
 *     actually claimed, on every exit path - success, refusal, or a throw
 *     from [body] - and never when the claim itself failed, because
 *     nothing was claimed then. A throwing [release] cannot replace the
 *     outcome that was already decided.
 *
 * Generic in the interface type so it is exercised by ordinary JVM unit
 * tests with no USB connection and no Android framework classes - the
 * same seam [selectDfuFlashInterface] uses.
 */
/**
 * THE BLOCK NUMBER IS A 16-BIT FIELD, AND PAST THE END OF IT LIE THE
 * COMMANDS.
 *
 * The write loop numbers its data blocks from 2 and increments once per
 * transfer, then hands that number to UsbDeviceConnection.controlTransfer
 * as `value` - the USB wValue field, which is sixteen bits wide. Nothing
 * in that path reports an out-of-range block number: the upper bits are
 * simply gone.
 *
 * DfuSe reserves the low block numbers for commands. wValue 0 is a
 * command block, whose FIRST PAYLOAD BYTE selects the command - 0x21 set
 * address pointer, 0x41 erase, 0x92 read unprotect. So a wrapped block
 * does not fail and does not write to the wrong address; it presents 64
 * or more bytes of firmware to the device as a command, and whatever
 * happens next is decided by an arbitrary byte of the image.
 *
 * Reachability, measured against this application's own limits rather
 * than assumed. MAX_FIRMWARE_FILE_BYTES is 16 MiB and
 * MIN_DFU_TRANSFER_SIZE is 64, so:
 *
 *     transferSize   blocks for 16 MiB   last wValue   wraps
 *               64            262,144              1   yes
 *              128            131,072              1   yes
 *              256             65,536              1   yes
 *              512             32,768         32,769   no
 *             2048              8,192          8,193   no
 *
 * A real STM32 DfuSe bootloader reports 2048, where the field would not
 * wrap until 128 MiB, which is why this has not been seen. The exposure
 * is a device that declares a small wTransferSize - a clone, a
 * re-implemented bootloader, or a descriptor read from a device that is
 * not what it claims to be - and this code accepts any value from 64 up.
 *
 * The refusal therefore happens BEFORE the first erase command leaves the
 * host, beside the address and writability checks, for the same reason
 * those are there: a write that cannot be completed correctly must not
 * start by erasing the flash.
 *
 * Returns null when every block of the segment fits, or the reason it
 * does not.
 */
internal fun dfuBlockNumberOverflow(
  segmentBytes: Int,
  transferSize: Int,
  segmentAddress: Long,
): String? {
  if (segmentBytes <= 0) return null
  if (transferSize <= 0) {
    return "The device declared a DFU transfer size of $transferSize bytes, which cannot carry a " +
      "firmware block; refusing to erase or write."
  }
  val blocks = (segmentBytes + transferSize - 1) / transferSize
  val lastBlockNumber = blocks.toLong() + DFU_FIRST_DATA_BLOCK - 1
  if (lastBlockNumber <= USB_MAX_WVALUE) return null
  return "This firmware needs $blocks blocks of $transferSize bytes at " +
    "0x${segmentAddress.toString(16)}, so the last DFU block number would be $lastBlockNumber - " +
    "past the 16-bit limit of $USB_MAX_WVALUE. A wrapped block number is not rejected by the " +
    "device: it is read as a DfuSe command, with a byte of this firmware selecting which one. " +
    "Refusing to erase or write."
}

internal fun <I, R> withClaimedDfuFlashInterface(
  target: I,
  alternateSetting: Int,
  declaredAlternates: List<Int>,
  layoutName: String,
  claim: (I) -> Boolean,
  selectAlternate: (I) -> Boolean,
  release: (I) -> Unit,
  body: () -> R,
): R {
  if (!claim(target)) {
    throw UsbTransportException("DFU_CLAIM_FAILED", "Unable to claim the DFU interface.")
  }
  try {
    if (!selectAlternate(target) &&
      dfuAlternateSelectionIsMandatory(alternateSetting, declaredAlternates)
    ) {
      throw UsbTransportException(
        "DFU_ALTERNATE_SELECTION_FAILED",
        "Unable to select alternate setting $alternateSetting ($layoutName); " +
          "refusing to erase or write without knowing which memory region would be addressed.",
      )
    }
    return body()
  } finally {
    // Releasing must not turn a decided outcome into a different one: a
    // device that has already reset can fail this call, and that is not
    // news about the flash.
    runCatching { release(target) }
  }
}

/**
 * Whether SET_INTERFACE must have SUCCEEDED before a write may proceed.
 *
 * USB 2.0 §9.4.10 lets a device STALL SET_INTERFACE when the interface has
 * only its default setting, because there is then nothing to choose: after
 * SET_CONFIGURATION every interface is already on alternate 0. That single
 * case, and only that case, is a failure this code may proceed through -
 * the alternate it wanted is provably the active one anyway.
 *
 * Everything else is mandatory. A refused selection with more than one
 * alternate declared, or with a non-zero alternate wanted, means the
 * region that would be erased and written is unknown, and an unknown
 * region is not something to guess about on a flight controller.
 *
 * Pure, and takes plain integers rather than UsbInterface, so the policy is
 * exercised by ordinary JVM unit tests with no USB connection and no
 * Android framework classes - the same seam selectDfuFlashInterface uses.
 */
internal fun dfuAlternateSelectionIsMandatory(
  chosenAlternateSetting: Int,
  alternateSettingsOnTheSameInterface: List<Int>,
): Boolean {
  if (chosenAlternateSetting != 0) return true
  // Not "at most one": exactly the default one. An empty list proves
  // nothing, so it is treated as mandatory rather than waved through.
  return alternateSettingsOnTheSameInterface.distinct() != listOf(0)
}

private val SUPPORTED_DFU_IDS = setOf(
  0x0483 to 0xdf11,
  0x28e9 to 0x0189,
  0x2e3c to 0xdf11,
  0x314b to 0x0106,
  0x3997 to 0xdf11,
)

private const val DFU_DNLOAD = 1
private const val DFU_UPLOAD = 2
private const val DFU_GETSTATUS = 3
private const val DFU_CLRSTATUS = 4
private const val DFU_ABORT = 6
private const val DFU_STATE_IDLE = 2
private const val DFU_STATE_DNLOAD_IDLE = 5
private const val DFU_STATE_MANIFEST_WAIT_RESET = 8
private const val DFU_STATE_UPLOAD_IDLE = 9
private const val DFU_STATE_ERROR = 10
private const val DFUSE_SET_ADDRESS: Byte = 0x21
private const val DFUSE_ERASE: Byte = 0x41
private const val DEFAULT_DFU_TRANSFER_SIZE = 2048

/**
 * DfuSe numbers data blocks from 2; 0 is a command block and 1 is
 * reserved. This is the value the write and verify loops start from, and
 * it is what makes a wrapped block number land on a command rather than
 * on a harmless address.
 */
internal const val DFU_FIRST_DATA_BLOCK = 2

/** wValue in a USB control transfer is sixteen bits. */
internal const val USB_MAX_WVALUE = 0xFFFF

private const val CONTROL_TIMEOUT_MS = 5_000
/** Matches DFU_RESET_OBSERVATION_MS on the web engine. */
private const val RESET_OBSERVATION_MS = 8_000L
private const val RESET_POLL_INTERVAL_MS = 250L
private const val MAX_STATUS_POLLS = 100
private const val MAX_SINGLE_POLL_DELAY_MS = 500
